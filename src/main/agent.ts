// AgentRuntime: FIFO task queue + the streaming run loop. PLAN §5.

import type {
  AgentConfig, AgentId, AgentStatus, AgentView, ChatMessage, RunState, Task, TaskResult, ToolCall, Usage,
} from '../shared/types';
import { ApiError, OpenCodeClient, StreamHandlers, ToolDef } from './api';
import { ConfigStore } from './config';
import { PermissionGate } from './permissions';
import { PromptEnv, buildSystemPrompt } from './prompt';
import { ConsoleBus, StateStore } from './state';
import { OrchestratorApi, execute, toolDefs, toolNames } from './tools';
import {
  Send, addUsage, cloneUsage, emptyUsage, fmtErr, isRecord, log, logWarn,
  newId, sleep, tokenEstimate, truncate, truncateForModel,
} from './util';

const MAX_STREAM_ATTEMPTS = 5;
const UI_OUTPUT_CAP = 32768;
const MODEL_OUTPUT_CAP = 16000;

/** What the runtime needs from the orchestrator (implemented by Orchestrator). */
export interface AgentHost extends OrchestratorApi {
  roster(): AgentView[];
  findRun(runId: string): RunState | null;
  cancelRun(runId: string, reason: string): void;
  registerRun(run: RunState, runtime: AgentRuntime): void;
  unregisterRun(runId: string): void;
  onRunFinished(run: RunState, finalText: string): void;
}

export interface AgentDeps {
  config: ConfigStore;
  state: StateStore;
  bus: ConsoleBus;
  client: OpenCodeClient;
  gate: PermissionGate;
  send: Send;
  host: AgentHost;
  env: PromptEnv;
  appVersion: string;
}

interface QueueItem { task: Task; runId: string; resolve: (r: TaskResult) => void }
interface AccCall { index: number; id: string; name: string; args: string; evId: string | null }
interface Acc {
  reasoning: string;
  text: string;
  reasoningEvId: string | null;
  textEvId: string | null;
  calls: Map<number, AccCall>;
}

export interface QueuedRun { runId: string; result: Promise<TaskResult> }

export class AgentRuntime {
  private queue: QueueItem[] = [];
  private pumping = false;
  private abort: AbortController | null = null;
  private statusValue: AgentStatus = 'idle';
  private statusDetail: string | undefined;
  private destroyed = false;
  private lastKnownCfg: AgentConfig;
  current: RunState | null = null;

  constructor(readonly id: AgentId, private readonly deps: AgentDeps) {
    const c = deps.config.agent(id);
    if (!c) throw new Error(`AgentRuntime: unknown agent ${id}`);
    this.lastKnownCfg = c;
    deps.state.ensure(id);
  }

  /** Live config read (never cached — hot reload, PLAN §10). */
  cfg(): AgentConfig {
    const c = this.deps.config.agent(this.id);
    if (c) this.lastKnownCfg = c;
    return this.lastKnownCfg;
  }

  get status(): AgentStatus { return this.statusValue; }
  get queueLength(): number { return this.queue.length; }
  get busy(): boolean { return this.current !== null; }
  usage(): Usage { return cloneUsage(this.deps.state.usage(this.id)); }
  queuedUserTasks(): number { return this.queue.filter((q) => q.task.origin.kind === 'user').length; }
  lastSeq(): number { return this.deps.state.lastSeq(this.id); }

  // ------------------------------------------------------------ queue

  enqueue(task: Task): QueuedRun {
    const runId = newId('run');
    const result = new Promise<TaskResult>((resolve) => {
      if (this.destroyed) {
        resolve({ status: 'cancelled', text: 'agent removed by the user', runId, usage: emptyUsage() });
        return;
      }
      this.queue.push({ task, runId, resolve });
    });
    this.emitStatus();
    void this.pump();
    return { runId, result };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const item = this.queue.shift();
        if (!item) break;
        this.emitStatus();
        let res: TaskResult;
        try {
          res = await this.runTask(item);
        } catch (e) {
          logWarn(`agent ${this.id}: run crashed`, e);
          res = { status: 'error', text: `Errore interno: ${fmtErr(e)}`, runId: item.runId, usage: emptyUsage() };
        }
        item.resolve(res);
      }
    } finally {
      this.pumping = false;
      this.current = null;
      this.abort = null;
      this.setStatus('idle');
    }
  }

  // ------------------------------------------------------------ cancellation

  cancel(reason: string): void {
    const queued = this.queue.splice(0);
    for (const q of queued) {
      q.resolve({ status: 'cancelled', text: reason, runId: q.runId, usage: emptyUsage() });
    }
    this.abortCurrent(reason);
    this.emitStatus();
  }

  cancelRun(runId: string, reason: string): void {
    const i = this.queue.findIndex((q) => q.runId === runId);
    if (i >= 0) {
      const [q] = this.queue.splice(i, 1);
      q.resolve({ status: 'cancelled', text: reason, runId, usage: emptyUsage() });
      this.emitStatus();
      return;
    }
    if (this.current?.runId === runId) this.abortCurrent(reason);
  }

  private abortCurrent(reason: string): void {
    const run = this.current;
    if (!run) return;
    run.status = 'cancelled';
    for (const child of run.childRunIds) this.deps.host.cancelRun(child, reason);
    this.deps.gate.cancelRun(run.runId);
    this.abort?.abort();
  }

  destroy(reason: string): void {
    this.destroyed = true;
    this.cancel(reason);
  }

  // ------------------------------------------------------------ status

  setStatus(status: AgentStatus, detail?: string): void {
    this.statusValue = status;
    this.statusDetail = detail;
    this.emitStatus();
  }

  emitStatus(): void {
    this.deps.send('agent:status', {
      agentId: this.id,
      status: this.statusValue,
      runId: this.current?.runId ?? null,
      queueLength: this.queue.length,
      usage: this.usage(),
      ...(this.statusDetail ? { detail: this.statusDetail } : {}),
    });
  }

  // ------------------------------------------------------------ the run loop

  private async runTask(item: QueueItem): Promise<TaskResult> {
    const { task, runId } = item;
    const deps = this.deps;
    const { bus, state, config, client } = deps;
    const startedAt = Date.now();

    const parent = task.origin.kind === 'delegation' ? deps.host.findRun(task.origin.parentRunId) : null;
    const run: RunState = {
      runId,
      taskId: task.id,
      agentId: this.id,
      origin: task.origin,
      status: 'running',
      iteration: 0,
      startedAt,
      usage: emptyUsage(),
      ancestry: parent ? [...parent.ancestry, this.id] : [this.id],
      childRunIds: [],
    };
    this.current = run;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    deps.host.registerRun(run, this);

    bus.emit(this.id, runId, {
      kind: 'task_start',
      origin: task.origin,
      input: task.input,
      ...(task.context ? { context: task.context } : {}),
    });
    this.setStatus('thinking');

    state.pushHistory(this.id, { role: 'user', content: formatTaskInput(task) });

    let finalText = '';
    let iterations = 0;
    let errorMessage: string | null = null;

    try {
      for (let iteration = 1; iteration <= this.cfg().maxIterations; iteration++) {
        if (signal.aborted) { run.status = 'cancelled'; break; }
        iterations = iteration;
        run.iteration = iteration;

        const liveCfg = config.get();
        const liveAgent = this.cfg();
        const system = buildSystemPrompt(liveAgent, liveCfg, config.agentViews(), deps.env);
        const trimmed = trimHistory(state.history(this.id), client.contextLimit(liveAgent.model));
        const messages: ChatMessage[] = [{ role: 'system', content: system }, ...trimmed];
        const tools: ToolDef[] = toolDefs();

        const llmEv = bus.emit(this.id, runId, {
          kind: 'llm_call',
          model: liveAgent.model,
          iteration,
          messageCount: messages.length,
          status: 'streaming',
        });
        const callStart = Date.now();
        const callUsage = emptyUsage();
        let acc = newAcc();
        let finishReason: string | null = null;
        let streamFailed = false;

        for (let attempt = 0; ; attempt++) {
          try {
            const r = await client.streamChat(
              { model: liveAgent.model, messages, tools, sessionId: state.sessionId(this.id) },
              this.handlers(runId, iteration, () => acc, callUsage, run),
              signal,
            );
            finishReason = r.finishReason;
            break;
          } catch (e) {
            const err = e instanceof ApiError ? e : new ApiError('Unknown', fmtErr(e));
            if (err.type === 'Abort' || signal.aborted) { run.status = 'cancelled'; streamFailed = true; break; }
            if (err.retryable && attempt < MAX_STREAM_ATTEMPTS - 1) {
              const wait = err.retryAfterMs ?? Math.min(5000 * 2 ** attempt, 60000) + Math.floor(Math.random() * 500);
              bus.emit(this.id, runId, {
                kind: 'error',
                message: err.type === 'RateLimit'
                  ? `Limite di utilizzo raggiunto (${err.message}). Riprovo automaticamente.`
                  : `Errore temporaneo: ${err.message}. Riprovo automaticamente.`,
                retryable: true,
                retryInMs: wait,
                code: err.type,
              });
              if (acc.reasoning || acc.text || acc.calls.size) {
                bus.emit(this.id, runId, { kind: 'info', message: 'Risposta parziale scartata prima di riprovare' });
                acc = newAcc();
              }
              this.setStatus('thinking', 'nuovo tentativo');
              try {
                await sleep(wait, signal);
              } catch {
                run.status = 'cancelled'; streamFailed = true; break;
              }
              continue;
            }
            bus.patch(this.id, llmEv.id, { set: { status: 'error', durationMs: Date.now() - callStart } });
            bus.emit(this.id, runId, {
              kind: 'error',
              message: describeApiError(err),
              retryable: false,
              code: err.type,
            });
            run.status = 'error';
            errorMessage = describeApiError(err);
            streamFailed = true;
            break;
          }
        }

        bus.flushAgent(this.id);
        if (streamFailed) break;
        if (signal.aborted) { run.status = 'cancelled'; break; }

        // ---- assistant message complete
        const calls = [...acc.calls.values()].sort((a, b) => a.index - b.index);
        for (const c of calls) {
          if (!c.id) c.id = `call_${runId}_${iteration}_${c.index}`;
          if (c.evId) bus.patch(this.id, c.evId, { set: { callId: c.id, name: c.name, argsRaw: c.args } });
        }
        const assistant: Extract<ChatMessage, { role: 'assistant' }> = {
          role: 'assistant',
          content: acc.text || null,
        };
        if (acc.reasoning) assistant.reasoning_content = acc.reasoning;
        if (calls.length) assistant.tool_calls = calls.map(toWire);
        state.pushHistory(this.id, assistant);

        bus.patch(this.id, llmEv.id, {
          set: {
            status: 'done',
            finishReason,
            usage: cloneUsage(callUsage),
            durationMs: Date.now() - callStart,
          },
        });
        this.emitStatus();

        if (!calls.length) {
          if (acc.textEvId) bus.patch(this.id, acc.textEvId, { set: { final: true } });
          run.status = 'done';
          finalText = acc.text;
          break;
        }

        this.setStatus('tool');
        const results = await this.executeToolCalls(calls, run, iteration, signal);
        for (const c of calls) {
          state.pushHistory(this.id, {
            role: 'tool',
            tool_call_id: c.id,
            content: truncateForModel(results.get(c.id) ?? '[cancelled by user]', MODEL_OUTPUT_CAP),
          });
        }
        if (signal.aborted) { run.status = 'cancelled'; break; }
        if (iteration === this.cfg().maxIterations) {
          run.status = 'error';
          errorMessage = 'Limite di iterazioni raggiunto';
          bus.emit(this.id, runId, { kind: 'error', message: errorMessage, retryable: false, code: 'MaxIterations' });
          finalText = acc.text || '';
        }
      }
    } finally {
      bus.flushAgent(this.id);
    }

    if (run.status === 'running') {
      run.status = 'error';
      errorMessage = errorMessage ?? 'Esecuzione interrotta';
    }
    run.finishedAt = Date.now();
    const status: TaskResult['status'] = run.status === 'done' ? 'done' : (run.status === 'cancelled' ? 'cancelled' : 'error');

    bus.emit(this.id, runId, {
      kind: 'task_end',
      status,
      durationMs: run.finishedAt - startedAt,
      usage: cloneUsage(run.usage),
      iterations,
    });

    const text = status === 'done' ? finalText : (errorMessage ?? (status === 'cancelled' ? 'annullato' : 'errore'));
    deps.send('run:finished', {
      runId,
      agentId: this.id,
      status,
      isUserRun: task.origin.kind === 'user',
      finalText: text,
      usage: cloneUsage(run.usage),
    });
    deps.host.onRunFinished(run, text);
    deps.host.unregisterRun(runId);
    this.current = null;
    this.abort = null;
    this.setStatus(status === 'error' ? 'error' : 'idle');

    return { status, text, runId, usage: cloneUsage(run.usage) };
  }

  // ------------------------------------------------------------ stream handlers

  private handlers(
    runId: string,
    iteration: number,
    getAcc: () => Acc,
    callUsage: Usage,
    run: RunState,
  ): StreamHandlers {
    const { bus, state } = this.deps;
    return {
      onReasoning: (t) => {
        const acc = getAcc();
        if (!acc.reasoningEvId) acc.reasoningEvId = bus.emit(this.id, runId, { kind: 'reasoning', text: '' }).id;
        acc.reasoning += t;
        bus.append(this.id, acc.reasoningEvId, t);
        if (this.statusValue !== 'streaming') this.setStatus('streaming');
      },
      onText: (t) => {
        const acc = getAcc();
        if (!acc.textEvId) acc.textEvId = bus.emit(this.id, runId, { kind: 'text', text: '', final: false }).id;
        acc.text += t;
        bus.append(this.id, acc.textEvId, t);
        if (this.statusValue !== 'streaming') this.setStatus('streaming');
      },
      onToolCallDelta: (d) => {
        const acc = getAcc();
        let tc = acc.calls.get(d.index);
        if (!tc) {
          tc = { index: d.index, id: '', name: '', args: '', evId: null };
          acc.calls.set(d.index, tc);
        }
        if (d.id) tc.id = d.id;
        // Providers send the name once; guard against a repeated full name.
        if (d.name && tc.name !== d.name) tc.name += d.name;
        if (d.args) tc.args += d.args;
        if (!tc.evId && tc.name) {
          tc.evId = bus.emit(this.id, runId, {
            kind: 'tool_call',
            callId: tc.id || `call_${runId}_${iteration}_${tc.index}`,
            name: tc.name,
            argsRaw: '',
            status: 'streaming',
          }).id;
        }
      },
      onUsage: (u) => {
        addUsage(callUsage, u);
        addUsage(run.usage, u);
        state.addUsage(this.id, u);
        this.emitStatus();
      },
    };
  }

  // ------------------------------------------------------------ tool calls

  private async executeToolCalls(
    calls: AccCall[],
    run: RunState,
    iteration: number,
    signal: AbortSignal,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    // Consecutive delegate_task calls run in parallel; everything else is sequential (PLAN §5.3).
    const groups: AccCall[][] = [];
    for (const c of calls) {
      const last = groups[groups.length - 1];
      if (c.name === 'delegate_task' && last && last[0].name === 'delegate_task') last.push(c);
      else groups.push([c]);
    }
    for (const group of groups) {
      if (signal.aborted) break;
      const done = await Promise.all(group.map((c) => this.runOneCall(c, run, iteration, signal)));
      for (let i = 0; i < group.length; i++) results.set(group[i].id, done[i]);
    }
    return results;
  }

  private async runOneCall(
    c: AccCall,
    run: RunState,
    iteration: number,
    signal: AbortSignal,
  ): Promise<string> {
    const { bus } = this.deps;
    const evId = c.evId;
    const patch = (set: Record<string, unknown>): void => { if (evId) bus.patch(this.id, evId, { set }); };

    const parsed = parseArgs(c.args);
    if (parsed.error) {
      const msg = `ERROR: invalid JSON arguments: ${parsed.error}. Resend the call with valid JSON.`;
      patch({ status: 'error', parseError: parsed.error, argsRaw: c.args });
      return msg;
    }
    const args = parsed.args as Record<string, unknown>;
    if (!toolNames().includes(c.name)) {
      const msg = `ERROR: unknown tool ${c.name}. Available: ${toolNames().join(', ')}`;
      patch({ status: 'error', args });
      return msg;
    }

    this.setStatus('tool', c.name);
    patch({ status: 'running', args });

    const t0 = Date.now();
    const view = this.deps.config.agentView(this.cfg());
    const r = await execute(c.name, args, {
      agent: this.cfg(),
      agentView: view,
      run,
      signal,
      cfg: () => this.deps.config.get(),
      gate: this.deps.gate,
      orchestrator: this.deps.host,
      callId: c.id,
      setStatus: (s, d) => this.setStatus(s, d),
      appVersion: this.deps.appVersion,
    });
    const durationMs = Date.now() - t0;
    const ui = truncate(r.output, UI_OUTPUT_CAP);
    patch({
      status: r.ok ? 'done' : (r.denied ? 'denied' : 'error'),
      result: {
        ok: r.ok,
        output: ui.text,
        truncated: ui.truncated,
        fullLength: ui.fullLength,
        durationMs,
      },
    });
    log(`tool ${c.name} for ${this.cfg().name}: ok=${r.ok} ${durationMs}ms (iter ${iteration})`);
    return r.output;
  }
}

// ================================================================ helpers

function newAcc(): Acc {
  return { reasoning: '', text: '', reasoningEvId: null, textEvId: null, calls: new Map() };
}

function toWire(c: AccCall): ToolCall {
  return { id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } };
}

/** User input goes verbatim; delegations get a framed header (PLAN §5.2). */
export function formatTaskInput(task: Task): string {
  if (task.origin.kind === 'user') return task.input;
  const head = `[Task delegated by ${task.origin.fromName}]\n${task.input}`;
  return task.context ? `${head}\n\n[Context]\n${task.context}` : head;
}

/** JSON.parse with progressive repairs (PLAN §5.3). */
export function parseArgs(raw: string): { args?: Record<string, unknown>; error?: string } {
  const text = (raw ?? '').trim();
  if (!text) return { args: {} };
  const candidates = [
    text,
    text.replace(/,(\s*[}\]])/g, '$1'),
    firstBalancedObject(text),
    text.replace(/'/g, '"').replace(/,(\s*[}\]])/g, '$1'),
  ];
  let lastError = 'unknown parse error';
  for (const cand of candidates) {
    if (!cand) continue;
    try {
      const v = JSON.parse(cand) as unknown;
      if (isRecord(v)) return { args: v };
      lastError = 'arguments must be a JSON object';
    } catch (e) {
      lastError = fmtErr(e);
    }
  }
  return { error: lastError };
}

function firstBalancedObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** Drops oldest whole turns until the estimate fits 70% of the context (PLAN §5.4). */
export function trimHistory(history: ChatMessage[], contextLimit: number): ChatMessage[] {
  const budget = Math.floor(contextLimit * 0.7);
  if (tokenEstimate(history) <= budget) return history;
  const marker: ChatMessage = { role: 'user', content: '[Earlier conversation truncated for length]' };
  const userIdx: number[] = [];
  for (let i = 0; i < history.length; i++) if (history[i].role === 'user') userIdx.push(i);
  const lastUser = userIdx.length ? userIdx[userIdx.length - 1] : 0;
  for (const cut of userIdx) {
    if (cut === 0) continue;
    if (cut > lastUser) break;
    const kept = history.slice(cut);
    if (tokenEstimate(kept) <= budget || cut === lastUser) return [marker, ...kept];
  }
  return history.length > 1 ? [marker, ...history.slice(lastUser)] : history;
}

function describeApiError(err: ApiError): string {
  switch (err.type) {
    case 'AuthError': return `Chiave API non valida o non autorizzata: ${err.message}`;
    case 'ModelError': return `Modello non disponibile: ${err.message}`;
    case 'RateLimit': return `Limite di utilizzo del piano raggiunto: ${err.message}`;
    case 'Network': return `Errore di rete: ${err.message}`;
    case 'Server': return `Errore del servizio (${err.status}): ${err.message}`;
    case 'Protocol': return `Risposta inattesa dal servizio: ${err.message}`;
    default: return err.message;
  }
}
