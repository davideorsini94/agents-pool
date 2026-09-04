// StateStore (per-agent history + console log, debounced atomic writes, resume repair)
// and ConsoleBus (event/patch emission with delta coalescing). PLAN §11, §3.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AgentId, AgentState, ChatMessage, ConsoleEvent, ConsolePatch, EventBase, Usage,
} from '../shared/types';
import {
  DebouncedWriter, Send, addUsage, atomicWrite, cloneUsage, emptyUsage, isRecord,
  log, logWarn, newId, readJsonSync, uuid,
} from './util';

const CONSOLE_CAP = 1500;
const TOOL_OUTPUT_STORE_CAP = 32768;
const APPEND_FLUSH_MS = 30;

type DistribOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
/** A ConsoleEvent without the envelope fields the bus fills in. */
export type ConsoleEventBody = DistribOmit<ConsoleEvent, keyof EventBase>;

interface AgentEntry {
  id: AgentId;
  sessionId: string;
  history: ChatMessage[];
  usage: Usage;
  events: ConsoleEvent[];
  seq: number;
  /** Worker-instance consoles (`<templateId>#<path>`): memory only, never a file (PLAN-v2 §15). */
  ephemeral: boolean;
  historyWriter: DebouncedWriter;
  consoleWriter: DebouncedWriter;
}

/** `#` marks an instance console id; such ids must never reach a file name (PLAN-v2 §0, §15). */
export function isEphemeralId(id: AgentId): boolean { return id.includes('#'); }

export class StateStore {
  private readonly dir: string;
  private readonly agents = new Map<AgentId, AgentEntry>();

  constructor(userDataPath: string) {
    this.dir = path.join(userDataPath, 'state');
  }

  private agentFile(id: AgentId): string { return path.join(this.dir, 'agents', `${id}.json`); }
  private consoleFile(id: AgentId): string { return path.join(this.dir, 'console', `${id}.json`); }

  /** Loads (or creates) the persisted state for an agent. Idempotent. */
  ensure(id: AgentId): void {
    if (this.agents.has(id)) return;
    const ephemeral = isEphemeralId(id);
    const st = ephemeral ? null : readJsonSync<unknown>(this.agentFile(id));
    const cs = ephemeral ? null : readJsonSync<unknown>(this.consoleFile(id));
    const entry: AgentEntry = {
      id,
      sessionId: isRecord(st) && typeof st.sessionId === 'string' && st.sessionId ? st.sessionId : uuid(),
      history: isRecord(st) && Array.isArray(st.history) ? sanitizeHistory(st.history) : [],
      usage: isRecord(st) && isRecord(st.usage) ? sanitizeUsage(st.usage) : emptyUsage(),
      events: isRecord(cs) && Array.isArray(cs.events) ? sanitizeEvents(cs.events) : [],
      seq: 0,
      ephemeral,
      historyWriter: new DebouncedWriter(500, 5000, () => this.writeHistory(id)),
      consoleWriter: new DebouncedWriter(1000, 5000, () => this.writeConsole(id)),
    };
    entry.seq = entry.events.length ? entry.events[entry.events.length - 1].seq : 0;
    this.agents.set(id, entry);
  }

  has(id: AgentId): boolean { return this.agents.has(id); }

  /** Forgets an ephemeral console (instance:close / next request / template removed, §6.5).
   *  Never touches the filesystem: these entries were never on disk. */
  drop(id: AgentId): void {
    const e = this.agents.get(id);
    if (!e) return;
    e.historyWriter.dispose();
    e.consoleWriter.dispose();
    this.agents.delete(id);
    if (!e.ephemeral) logWarn(`state: drop() called on a persistent entry ${id} — files kept`);
  }

  private entry(id: AgentId): AgentEntry {
    this.ensure(id);
    return this.agents.get(id) as AgentEntry;
  }

  // ------------------------------------------------------------ history

  history(id: AgentId): ChatMessage[] { return this.entry(id).history; }
  sessionId(id: AgentId): string { return this.entry(id).sessionId; }
  usage(id: AgentId): Usage { return this.entry(id).usage; }

  pushHistory(id: AgentId, m: ChatMessage): void {
    this.entry(id).history.push(m);
    this.entry(id).historyWriter.schedule();
  }

  setHistory(id: AgentId, h: ChatMessage[]): void {
    const e = this.entry(id);
    e.history = h;
    e.historyWriter.schedule();
  }

  addUsage(id: AgentId, u: Partial<Usage>): Usage {
    const e = this.entry(id);
    addUsage(e.usage, u);
    e.historyWriter.schedule();
    return e.usage;
  }

  /** agent:clearHistory — fresh session, empty history, cumulative usage kept. */
  clearHistory(id: AgentId): void {
    const e = this.entry(id);
    e.history = [];
    e.sessionId = uuid();
    e.historyWriter.schedule();
  }

  /** Drops every trace of an agent (config removal). */
  removeAgent(id: AgentId): void {
    const e = this.agents.get(id);
    if (e && e.ephemeral) { this.drop(id); return; }
    if (e) {
      e.historyWriter.dispose();
      e.consoleWriter.dispose();
      this.agents.delete(id);
    }
    try { fs.rmSync(this.agentFile(id), { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(this.consoleFile(id), { force: true }); } catch { /* ignore */ }
  }

  /** config:resetAll — wipe all state files and in-memory entries. */
  resetAll(): void {
    for (const e of this.agents.values()) { e.historyWriter.dispose(); e.consoleWriter.dispose(); }
    this.agents.clear();
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch (e) { logWarn('state reset failed', e); }
  }

  /**
   * Resume repair (PLAN §11): closes dangling tool_calls so the history stays API-valid.
   * Returns info messages the orchestrator should surface on the console.
   */
  repair(id: AgentId): string[] {
    const e = this.entry(id);
    const info: string[] = [];
    const last = e.history[e.history.length - 1];
    if (last && last.role === 'assistant' && last.tool_calls && last.tool_calls.length) {
      for (const tc of last.tool_calls) {
        e.history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: '[interrupted: the app was restarted before this tool finished]',
        });
      }
      e.historyWriter.schedule();
      info.push('Sessione ripristinata: l\'attività precedente è stata interrotta dal riavvio');
    } else if (e.events.length) {
      const lastEv = e.events[e.events.length - 1];
      if (lastEv.kind !== 'task_end' && lastEv.kind !== 'info') {
        info.push('Sessione ripristinata: l\'attività precedente è stata interrotta dal riavvio');
      }
    }
    return info;
  }

  private async writeHistory(id: AgentId): Promise<void> {
    const e = this.agents.get(id);
    if (!e || e.ephemeral) return;
    const data: AgentState = {
      sessionId: e.sessionId,
      history: e.history,
      usage: cloneUsage(e.usage),
      updatedAt: Date.now(),
    };
    await atomicWrite(this.agentFile(id), JSON.stringify(data));
  }

  // ------------------------------------------------------------ console log

  nextSeq(id: AgentId): number {
    const e = this.entry(id);
    e.seq += 1;
    return e.seq;
  }

  lastSeq(id: AgentId): number { return this.entry(id).seq; }

  appendConsole(ev: ConsoleEvent): void {
    const e = this.entry(ev.agentId);
    e.events.push(capEvent(ev));
    if (e.events.length > CONSOLE_CAP) e.events.splice(0, e.events.length - CONSOLE_CAP);
    e.consoleWriter.schedule();
  }

  /** Applies a patch to the stored copy so a reload shows the final state. */
  patchConsole(p: ConsolePatch): void {
    const e = this.agents.get(p.agentId);
    if (!e) return;
    const ev = findLast(e.events, (x) => x.id === p.eventId);
    if (!ev) return;
    const target = ev as unknown as Record<string, unknown>;
    if (p.append) {
      const prev = typeof target.text === 'string' ? target.text : '';
      target.text = prev.length > TOOL_OUTPUT_STORE_CAP ? prev : prev + p.append;
    }
    if (p.set) {
      for (const [k, v] of Object.entries(p.set)) target[k] = v;
      capEvent(ev);
    }
    e.consoleWriter.schedule();
  }

  /** Ascending by seq; `beforeSeq` pages backwards (PLAN §3). */
  getConsole(id: AgentId, opts: { beforeSeq?: number; limit: number }): ConsoleEvent[] {
    const e = this.entry(id);
    const limit = Math.max(1, Math.min(2000, Math.round(opts?.limit ?? 400)));
    const pool = opts?.beforeSeq !== undefined
      ? e.events.filter((x) => x.seq < (opts.beforeSeq as number))
      : e.events;
    return pool.slice(Math.max(0, pool.length - limit));
  }

  clearConsole(id: AgentId): void {
    const e = this.entry(id);
    e.events = [];
    e.consoleWriter.schedule();
  }

  private async writeConsole(id: AgentId): Promise<void> {
    const e = this.agents.get(id);
    if (!e || e.ephemeral) return;
    await atomicWrite(this.consoleFile(id), JSON.stringify({ events: e.events }));
  }

  // ------------------------------------------------------------ flush

  async flushAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const e of this.agents.values()) {
      if (e.ephemeral) continue;              // instance consoles are dropped, never flushed
      tasks.push(e.historyWriter.flush());
      tasks.push(e.consoleWriter.flush());
    }
    await Promise.all(tasks.map((p) => p.catch((err) => logWarn('flush failed', err))));
    log('state: flushed');
  }
}

// ---------------------------------------------------------------- ConsoleBus

interface PendingAppend { text: string; timer: NodeJS.Timeout }

/**
 * Emits console events / patches to the renderer and to the store.
 * Streaming deltas are coalesced per event with a 30 ms flush so the renderer
 * gets one patch per frame instead of one per token (PLAN §5.2).
 */
export class ConsoleBus {
  private appends = new Map<string, PendingAppend>();

  constructor(private readonly state: StateStore, private readonly send: Send) {}

  emit(agentId: AgentId, runId: string | null, body: ConsoleEventBody): ConsoleEvent {
    this.flushAgent(agentId);
    const ev = {
      id: newId('e', 8),
      agentId,
      runId,
      seq: this.state.nextSeq(agentId),
      ts: Date.now(),
      ...body,
    } as ConsoleEvent;
    this.state.appendConsole(ev);
    this.send('console:event', ev);
    return ev;
  }

  /** Immediate patch (ordered after any pending appends for the same agent). */
  patch(agentId: AgentId, eventId: string, p: { append?: string; set?: Record<string, unknown> }): void {
    if (p.set) this.flushEvent(agentId, eventId);
    const payload: ConsolePatch = { agentId, eventId };
    if (p.append !== undefined) payload.append = p.append;
    if (p.set !== undefined) payload.set = p.set;
    if (payload.append === undefined && payload.set === undefined) return;
    this.state.patchConsole(payload);
    this.send('console:patch', payload);
  }

  /** Coalesced text append for streaming reasoning/text blocks. */
  append(agentId: AgentId, eventId: string, text: string): void {
    if (!text) return;
    const key = `${agentId} ${eventId}`;
    const pending = this.appends.get(key);
    if (pending) { pending.text += text; return; }
    const timer = setTimeout(() => this.flushEvent(agentId, eventId), APPEND_FLUSH_MS);
    this.appends.set(key, { text, timer });
  }

  flushEvent(agentId: AgentId, eventId: string): void {
    const key = `${agentId} ${eventId}`;
    const pending = this.appends.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.appends.delete(key);
    const payload: ConsolePatch = { agentId, eventId, append: pending.text };
    this.state.patchConsole(payload);
    this.send('console:patch', payload);
  }

  /** Flushes every pending append for one agent (keeps per-agent ordering). */
  flushAgent(agentId: AgentId): void {
    const prefix = `${agentId} `;
    for (const key of [...this.appends.keys()]) {
      if (key.startsWith(prefix)) this.flushEvent(agentId, key.slice(prefix.length));
    }
  }

  flushAll(): void {
    for (const key of [...this.appends.keys()]) {
      const i = key.indexOf(' ');
      this.flushEvent(key.slice(0, i), key.slice(i + 1));
    }
  }
}

// ---------------------------------------------------------------- sanitizers

function capEvent(ev: ConsoleEvent): ConsoleEvent {
  if (ev.kind === 'tool_call' && ev.result && ev.result.output.length > TOOL_OUTPUT_STORE_CAP) {
    ev.result.output = ev.result.output.slice(0, TOOL_OUTPUT_STORE_CAP);
    ev.result.truncated = true;
  }
  return ev;
}

function findLast<T>(arr: T[], pred: (x: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return arr[i];
  return undefined;
}

function sanitizeUsage(raw: Record<string, unknown>): Usage {
  const u = emptyUsage();
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  u.promptTokens = n(raw.promptTokens);
  u.completionTokens = n(raw.completionTokens);
  u.reasoningTokens = n(raw.reasoningTokens);
  u.cachedTokens = n(raw.cachedTokens);
  u.cost = n(raw.cost);
  u.calls = n(raw.calls);
  u.estimated = raw.estimated === true;
  return u;
}

function sanitizeHistory(raw: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of raw) {
    if (!isRecord(m) || typeof m.role !== 'string') continue;
    if (m.role === 'user' || m.role === 'system') {
      if (typeof m.content === 'string') out.push({ role: m.role, content: m.content });
    } else if (m.role === 'assistant') {
      const msg: Extract<ChatMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : null,
      };
      if (typeof m.reasoning_content === 'string' && m.reasoning_content) msg.reasoning_content = m.reasoning_content;
      if (Array.isArray(m.tool_calls)) {
        const calls = m.tool_calls
          .filter(isRecord)
          .filter((tc) => typeof tc.id === 'string' && isRecord(tc.function))
          .map((tc) => {
            const fn = tc.function as Record<string, unknown>;
            return {
              id: tc.id as string,
              type: 'function' as const,
              function: {
                name: typeof fn.name === 'string' ? fn.name : '',
                arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
              },
            };
          });
        if (calls.length) msg.tool_calls = calls;
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      if (typeof m.tool_call_id === 'string' && typeof m.content === 'string') {
        out.push({ role: 'tool', tool_call_id: m.tool_call_id, content: m.content });
      }
    }
  }
  return out;
}

function sanitizeEvents(raw: unknown[]): ConsoleEvent[] {
  const out: ConsoleEvent[] = [];
  for (const ev of raw) {
    if (!isRecord(ev)) continue;
    if (typeof ev.id !== 'string' || typeof ev.agentId !== 'string' || typeof ev.kind !== 'string') continue;
    if (typeof ev.seq !== 'number' || typeof ev.ts !== 'number') continue;
    out.push(ev as unknown as ConsoleEvent);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.slice(Math.max(0, out.length - CONSOLE_CAP));
}
