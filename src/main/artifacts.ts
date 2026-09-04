// ArtifactStore — the blackboard for payloads too large to travel inside a ResultContract.
// PLAN-v2 §7.6. IMPORTANT: no 'electron' import (scripts/api-smoke.mjs builds one on a temp dir).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ArtifactIndex, ArtifactMeta, ArtifactRecord, TaskInput } from '../shared/types';
import { resolvePath } from './permissions';
import {
  atomicWrite, isRecord, logWarn, randomHex, readJson, truncateForModel,
} from './util';

const KEEP_REQUESTS = 20;
const DEFAULT_SLICE = 6000;
const MAX_SLICE = 20000;
/** Per-input cap when a payload is inlined into a contract message (§7.2). */
export const INLINE_CAP = 12000;
/** Whole "## Input inclusi" section cap (§7.2). */
export const MESSAGE_CAP = 48000;

export interface PutResult { id: string; chars: number; summary: string }

export class ArtifactStore {
  private readonly dir: string;
  private readonly indexFile: string;
  private index: ArtifactIndex | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.dir = path.join(userDataPath, 'state', 'artifacts');
    this.indexFile = path.join(this.dir, 'index.json');
  }

  get root(): string { return this.dir; }

  private async loadIndex(): Promise<ArtifactIndex> {
    if (this.index) return this.index;
    const raw = await readJson<unknown>(this.indexFile);
    const out: ArtifactIndex = {};
    if (isRecord(raw)) {
      for (const [id, m] of Object.entries(raw)) {
        if (!isRecord(m) || typeof m.requestId !== 'string') continue;
        out[id] = {
          requestId: m.requestId,
          taskId: typeof m.taskId === 'string' ? m.taskId : '',
          chars: typeof m.chars === 'number' ? m.chars : 0,
          summary: typeof m.summary === 'string' ? m.summary : '',
          createdAt: typeof m.createdAt === 'number' ? m.createdAt : Date.now(),
        };
      }
    }
    this.index = out;
    return out;
  }

  private async saveIndex(): Promise<void> {
    const idx = this.index ?? {};
    // Serialize writes so two concurrent put() calls cannot lose each other's entry.
    this.writing = this.writing
      .then(() => atomicWrite(this.indexFile, JSON.stringify(idx)))
      .catch((e) => logWarn('artifacts: index write failed', e));
    await this.writing;
  }

  private file(requestId: string, id: string): string {
    return path.join(this.dir, safeSeg(requestId), `${id}.json`);
  }

  /** Stores a payload and returns the reference the ResultContract carries instead (§7.3 step 6). */
  async put(requestId: string, taskId: string, content: string): Promise<PutResult> {
    const id = `art_${randomHex(3)}`;
    const chars = content.length;
    const summary = content.slice(0, 400);
    const record: ArtifactRecord = { id, requestId, taskId, chars, createdAt: Date.now(), content };
    await atomicWrite(this.file(requestId, id), JSON.stringify(record));
    const idx = await this.loadIndex();
    idx[id] = { requestId, taskId, chars, summary, createdAt: record.createdAt };
    await this.saveIndex();
    return { id, chars, summary };
  }

  async meta(id: string): Promise<ArtifactMeta | undefined> {
    const idx = await this.loadIndex();
    return idx[id];
  }

  /** `read_artifact` backing call: a character slice plus a header line (§7.6). */
  async get(id: string, offset = 0, limit = DEFAULT_SLICE): Promise<{ header: string; slice: string } | null> {
    const m = await this.meta(id);
    if (!m) return null;
    const rec = await readJson<ArtifactRecord>(this.file(m.requestId, id));
    if (!rec || typeof rec.content !== 'string') return null;
    const from = Math.max(0, Math.round(offset) || 0);
    const size = Math.min(MAX_SLICE, Math.max(1, Math.round(limit) || DEFAULT_SLICE));
    const slice = rec.content.slice(from, from + size);
    const to = Math.min(rec.content.length, from + size);
    return { header: `[${id} · ${rec.content.length} chars · ${from}–${to}]`, slice };
  }

  /** Raw content, capped — used when inlining an artifact into a contract or a verifier message. */
  async content(id: string, cap = INLINE_CAP): Promise<string | null> {
    const m = await this.meta(id);
    if (!m) return null;
    const rec = await readJson<ArtifactRecord>(this.file(m.requestId, id));
    if (!rec || typeof rec.content !== 'string') return null;
    return rec.content.length > cap ? truncateForModel(rec.content, cap) : rec.content;
  }

  /**
   * Renders the `## Input inclusi` body of a contract message (§7.2): `text` verbatim,
   * `artifact_ref` from the store, `file` read inside the workspace with no permission prompt
   * (reads are side-effect free and the path sandbox still applies). Later inputs are dropped with
   * an explicit marker once the whole section passes MESSAGE_CAP.
   */
  async inline(inputs: TaskInput[], workspacePath: string | null): Promise<string[]> {
    const out: string[] = [];
    let budget = MESSAGE_CAP;
    for (const inp of inputs) {
      let head = '';
      let body = '';
      if (inp.type === 'text') {
        head = '### [text]';
        body = cap(inp.content ?? '');
      } else if (inp.type === 'artifact_ref') {
        head = `### [artifact_ref ${inp.id}]`;
        const c = await this.content(inp.id);
        body = c === null ? `[artefatto sconosciuto: ${inp.id}]` : c;
        head = `${head} (${body.length} caratteri)`;
      } else {
        head = `### [file ${inp.path}]`;
        const r = resolvePath(inp.path ?? '', workspacePath);
        if (!r.inside || r.isProtected) {
          body = '[input omesso: percorso fuori dalla cartella di lavoro]';
        } else {
          try {
            body = cap(await fsp.readFile(r.real, 'utf8'));
          } catch (e) {
            body = `[file non leggibile: ${(e as Error).message}]`;
          }
        }
        head = `${head} (${body.length} caratteri)`;
      }
      const block = `${head}\n${body}`;
      if (block.length > budget) {
        out.push(`${head}\n[input omitted: too large — ask for a smaller slice]`);
        budget = 0;
        continue;
      }
      budget -= block.length;
      out.push(block);
    }
    return out;
  }

  /** Keeps the 20 most recent request directories; called from pool.startRequest (§7.6). */
  async prune(keep = KEEP_REQUESTS): Promise<void> {
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(this.dir, { withFileTypes: true }); } catch { return; }
    const dirs: Array<{ name: string; mtime: number }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const st = await fsp.stat(path.join(this.dir, e.name));
        dirs.push({ name: e.name, mtime: st.mtimeMs });
      } catch { /* vanished */ }
    }
    if (dirs.length <= keep) return;
    dirs.sort((a, b) => b.mtime - a.mtime);
    const drop = dirs.slice(keep).map((d) => d.name);
    const idx = await this.loadIndex();
    for (const name of drop) {
      await fsp.rm(path.join(this.dir, name), { recursive: true, force: true }).catch(() => {});
      for (const [id, m] of Object.entries(idx)) if (safeSeg(m.requestId) === name) delete idx[id];
    }
    await this.saveIndex();
  }
}

function cap(s: string): string {
  return s.length > INLINE_CAP ? truncateForModel(s, INLINE_CAP) : s;
}

/** Request ids are `run_<hex>`; still, never let one become a path traversal. */
function safeSeg(s: string): string {
  return String(s || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
}
