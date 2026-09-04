// Small utilities shared by the whole main process.
// IMPORTANT: this module must NOT import 'electron' — it is loaded by scripts/api-smoke.mjs
// (through api.js and permissions.js) inside a plain Node process.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ChatMessage, EventMap, Usage } from '../shared/types';

/** Typed main -> renderer sender (implemented in main.ts over the BrowserWindow). */
export type Send = <K extends keyof EventMap>(channel: K, payload: EventMap[K]) => void;

/** Agent colour palette (PLAN §2.5). */
export const PALETTE = [
  '#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6',
  '#EC4899', '#14B8A6', '#F97316', '#84CC16', '#06B6D4',
];

// ---------------------------------------------------------------- ids

export function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}
export function newId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomHex(bytes)}`;
}
export function newAgentId(): string {
  return `a_${randomHex(4)}`; // "a_" + 8 hex (PLAN §2)
}
export function uuid(): string {
  return crypto.randomUUID();
}

/** "sk-…a1b2" — the only form of the key the renderer ever sees. */
export function maskKey(key: string): string {
  const t = key.trim();
  return `sk-…${t.slice(-4)}`;
}

// ---------------------------------------------------------------- usage

export function emptyUsage(): Usage {
  return {
    promptTokens: 0, completionTokens: 0, reasoningTokens: 0,
    cachedTokens: 0, cost: 0, calls: 0, estimated: false,
  };
}
export function cloneUsage(u: Usage): Usage {
  return { ...u };
}
/** Accumulates `add` into `target` (mutates and returns target). */
export function addUsage(target: Usage, add: Partial<Usage> | null | undefined): Usage {
  if (!add) return target;
  target.promptTokens += add.promptTokens ?? 0;
  target.completionTokens += add.completionTokens ?? 0;
  target.reasoningTokens += add.reasoningTokens ?? 0;
  target.cachedTokens += add.cachedTokens ?? 0;
  target.cost += add.cost ?? 0;
  target.calls += add.calls ?? 0;
  if (add.estimated) target.estimated = true;
  return target;
}

// ---------------------------------------------------------------- text

export interface Truncated { text: string; truncated: boolean; fullLength: number }

/** Head truncation with an explicit marker — used for what the UI stores. */
export function truncate(s: string, max: number): Truncated {
  if (s.length <= max) return { text: s, truncated: false, fullLength: s.length };
  return {
    text: `${s.slice(0, max)}\n… [${s.length - max} caratteri troncati]`,
    truncated: true,
    fullLength: s.length,
  };
}

/** Head 75% + tail 25% with a marker — used for what the model sees (PLAN §14). */
export function truncateForModel(s: string, max = 16000): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.75);
  const tail = Math.max(0, max - head - 120);
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… [${omitted} characters omitted, ${s.length} total] …\n\n${tail > 0 ? s.slice(-tail) : ''}`;
}

/** Rough token estimate: chars/4 plus 200 per tool call (PLAN §5.4). */
export function tokenEstimate(messages: ChatMessage[]): number {
  let chars = 0;
  let calls = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    if (m.role === 'assistant') {
      if (m.reasoning_content) chars += m.reasoning_content.length;
      for (const tc of m.tool_calls ?? []) {
        calls++;
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4) + calls * 200;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function fmtErr(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

// ---------------------------------------------------------------- async

export function abortError(message = 'Aborted'): Error {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** Promise-based sleep that rejects with an AbortError when the signal fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Links `outer` into a fresh controller (we avoid AbortSignal.any for portability). */
export function linkSignal(outer: AbortSignal | undefined): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  if (!outer) return { controller, dispose: () => {} };
  if (outer.aborted) { controller.abort(); return { controller, dispose: () => {} }; }
  const onAbort = () => controller.abort();
  outer.addEventListener('abort', onAbort, { once: true });
  return { controller, dispose: () => outer.removeEventListener('abort', onAbort) };
}

/** Trailing debounce with a hard "at most once per maxIntervalMs" cap. */
export class DebouncedWriter {
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt = 0;
  private dirty = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly maxIntervalMs: number,
    private readonly fn: () => Promise<void>,
  ) {}

  schedule(): void {
    this.dirty = true;
    if (this.timer) return;
    const since = Date.now() - this.lastRunAt;
    const delay = since >= this.maxIntervalMs
      ? this.delayMs
      : Math.max(this.delayMs, this.maxIntervalMs - since);
    this.timer = setTimeout(() => { this.timer = null; void this.run(); }, delay);
  }

  private async run(): Promise<void> {
    if (!this.dirty) return;
    if (this.running) { await this.running.catch(() => {}); }
    this.dirty = false;
    this.lastRunAt = Date.now();
    this.running = this.fn().catch((e) => { logError('write failed', fmtErr(e)); });
    await this.running;
    this.running = null;
  }

  /** Runs any pending write now and waits for it. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.run();
    if (this.running) await this.running.catch(() => {});
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = false;
  }
}

// ---------------------------------------------------------------- files

export async function atomicWrite(file: string, data: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomHex(4)}.tmp`;
  try {
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export function atomicWriteSync(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomHex(4)}.tmp`;
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

export function readJsonSync<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- logging

const MAX_LOG_BYTES = 5 * 1024 * 1024;
let logFile: string | null = null;
let devMode = false;

/** Called once from main.ts with app.getPath('userData'). */
export function initLog(userDataPath: string, dev: boolean): void {
  devMode = dev;
  try {
    const dir = path.join(userDataPath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'main.log');
    rotateIfNeeded();
  } catch (e) {
    logFile = null;
    // eslint-disable-next-line no-console
    console.error('[log] cannot open log file:', fmtErr(e));
  }
}

export function isDev(): boolean { return devMode; }
export function logFilePath(): string | null { return logFile; }

function rotateIfNeeded(): void {
  if (!logFile) return;
  try {
    const st = fs.statSync(logFile);
    if (st.size > MAX_LOG_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch { /* no file yet */ }
}

function write(level: string, parts: unknown[]): void {
  const line = `${new Date().toISOString()} [${level}] ${parts.map(one).join(' ')}\n`;
  if (devMode || !logFile) {
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : console.log)(line.trimEnd());
  }
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line);
  } catch { /* never throw from the logger */ }
}

function one(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export function log(...parts: unknown[]): void { write('info', parts); }
export function logWarn(...parts: unknown[]): void { write('warn', parts); }
export function logError(...parts: unknown[]): void { write('error', parts); }
