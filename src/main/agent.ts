// AgentRuntime: FIFO task queue + the streaming run loop. PLAN §5, PLAN-v2 §4 (router loop) and
// §6.2 (instance mode: in-memory history, one task, per-instance budget, `partial`).

import type {
  AgentConfig, AgentId, AgentRole, AgentStatus, AgentView, Budget, ChatMessage, RunState, Task,
  TaskResult, Tier, ToolCall, Usage,
} from '../shared/types';
import { ApiError, OpenCodeClient, StreamHandlers, ToolDef } from './api';
import type { ConfigStore } from './config';
import { roleOf } from './contracts';
import type { PermissionGate } from './permissions';
import { PromptEnv, buildRolePrompt } from './prompt';
import { ModelRouter, isSwitchable, reasonIt } from './router';
import { ConsoleBus, StateStore } from './state';
import { OrchestratorApi, execute, toolDefsFor, toolNamesFor } from './tools';
import {
  Send, addUsage, cloneUsage, emptyUsage, firstBalancedObject, fmtErr, isRecord, log, logWarn,
  newId, sleep, tokenEstimate, truncate, truncateForModel,
} from './util';

const MAX_STREAM_ATTEMPTS = 5;
const UI_OUTPUT_CAP = 32768;
const MODEL_OUTPUT_CAP = 16000;
/** delegate_tasks returns a batch of ResultContracts: it needs a bigger slice (PLAN-v2 §6.3). */
const POOL_OUTPUT_CAP = 32768;
const POOL_TOOLS = new Set(['delegate_tasks', 'run_planner', 'run_verifier', 'read_artifact']);
/** Per-call ceiling derived from the remaining instance budget (PLAN-v2 §6.2). */
// Floor for a single call's answer. A reasoning model needs several thousand tokens before it even
// starts the visible answer, so a small floor guarantees a truncated (finish_reason: length) reply.
const MIN_CALL_TOKENS = 4096;
const MAX_CALL_TOKENS = 16384;

/** What the runtime needs from the orchestrator (implemented by Orchestrator). */
export interface AgentHost extends OrchestratorApi {
  roster(): AgentView[];
  findRun(runId: string): RunState | null;
  cancelRun(runId: string, reason: string): void;
  registerRun(run: RunState, runtime: AgentRuntime): void;
  unregisterRun(runId: string): void;
  onRunFinished(run: RunState, finalText: string, taskEndEventId: string): void;
  /** Live tier of a user request — drives the orchestrator's escalation model (PLAN-v2 §4). */
  requestTier(requestId: string): Tier | null;
}

export interface AgentDeps {
  config: ConfigStore;
  state: StateStore;
  bus: ConsoleBus;
  client: OpenCodeClient;
  gate: PermissionGate;
  send: Send;
  host: AgentHost;
  router: ModelRouter;
  env: PromptEnv;
  appVersion: string;
}

/**
 * Instance mode (PLAN-v2 §6.2). Present ⇒ this runtime is a throw-away instance of `templateId`:
 * config/routing/tools come from the template, the history lives in memory only, the console id is
 * this runtime's own id (`<templateId>#<path>` for workers, the template id itself for the
 * planner/verifier, which are never concurrent), and the run is bounded by `budget`.
 */
export interface AgentRuntimeOpts {
  templateId: AgentId;
  role: AgentRole;
  budget: Budget;
  requestId: string;
  escalate: boolean;
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
  /** Instance history: never persisted, never in StateStore (PLAN-v2 §6.2). */
  private readonly local: ChatMessage[] | null;
  /** Model of the last attempt — the pool stamps it into `ResultContract.cost.model`. */
  lastModelUsed = '';
  private readonly templateId: AgentId;
  readonly opts: AgentRuntimeOpts | null;
  current: RunState | null = null;

  constructor(readonly id: AgentId, private readonly deps: AgentDeps, opts?: AgentRuntimeOpts) {
    this.opts = opts ?? null;
    this.templateId = opts?.templateId ?? id;
    const c = deps.config.agent(this.templateId);
    if (!c) throw new Error(`AgentRuntime: unknown agent ${this.templateId}`);
    this.lastKnownCfg = c;
    this.local = opts ? [] : null;
    deps.state.ensure(id);
  }

  /** Live config read (never cached — hot reload, PLAN §10). */
  cfg(): AgentConfig {
    const c = this.deps.config.agent(this.templateId);
    if (c) this.lastKnownCfg = c;
    return this.lastKnownCfg;
  }

  role(): AgentRole { return this.opts ? this.opts.role : roleOf(this.cfg()); }

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
        resolve({ status: 'cancelled', text: 'agent removed by the user', runId, usage: emptyUsage(), toolCalls: 0 });
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
          res = { status: 'error', text: `Errore interno: ${fmtErr(e)}`, runId: item.runId, usage: emptyUsage(), toolCalls: 0 };
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
      q.resolve({ status: 'cancelled', text: reason, runId: q.runId, usage: emptyUsage(), toolCalls: 0 });
    }
    this.abortCurrent(reason);
    this.emitStatus();
  }

  cancelRun(runId: string, reason: string): void {
    const i = this.queue.findIndex((q) => q.runId === runId);
    if (i >= 0) {
      const [q] = this.queue.splice(i, 1);
      q.resolve({ status: 'cancelled', text: reason, runId, usage: emptyUsage(), toolCalls: 0 });
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
    const detail = [this.statusDetail, this.budgetDetail()].filter(Boolean).join(' · ');
    this.deps.send('agent:status', {
      agentId: this.id,
      status: this.statusValue,
      runId: this.current?.runId ?? null,
      queueLength: this.queue.length,
      usage: this.usage(),
      ...(detail ? { detail } : {}),
    });
  }

  /** `tok 3.1k/8k · tool 2/10 · 41 s/180 s` while an instance is running (PLAN-v2 §6.2). */
  private budgetDetail(): string {
    const run = this.current;
    if (!this.opts || !run) return '';
    const b = this.opts.budget;
    const tok = run.usage.promptTokens + run.usage.completionTokens;
    const secs = Math.round((Date.now() - run.startedAt) / 1000);
    return `tok ${kilo(tok)}/${kilo(b.maxTokens)} · tool ${run.toolCalls ?? 0}/${b.maxToolCalls} · ${secs} s/${b.maxSeconds} s`;
  }

  // ------------------------------------------------------------ history

  private history(): ChatMessage[] {
    return this.local ?? this.deps.state.history(this.id);
  }

  private push(m: ChatMessage): void {
    if (this.local) this.local.push(m);
    else this.deps.state.pushHistory(this.id, m);
  }

  // ------------------------------------------------------------ the run loop

  private async runTask(item: QueueItem): Promise<TaskResult> {
    const { task, runId } = item;
    const deps = this.deps;
    const { bus, config, client, router } = deps;
    const startedAt = Date.now();

    const parent = task.origin.kind === 'delegation' ? deps.host.findRun(task.origin.parentRunId) : null;
    const requestId = this.opts?.requestId
      ?? (task.origin.kind === 'delegation' ? (task.origin.requestId ?? runId) : runId);
    const depth = task.origin.kind === 'delegation' ? task.origin.depth : 0;
    const run: RunState = {
      runId,
      taskId: task.id,
      agentId: this.id,
      origin: task.origin,
      status: 'running',
      iteration: 0,
      startedAt,
      usage: emptyUsage(),
      // Ancestry tracks TEMPLATES, not instances, so the v1 cycle check still works (§6.3 step 0).
      ancestry: parent ? [...parent.ancestry, this.templateId] : [this.templateId],
      childRunIds: [],
      requestId,
      role: this.role(),
      toolCalls: 0,
      ...(this.opts ? { budget: this.opts.budget } : {}),
    };
    this.current = run;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    deps.host.registerRun(run, this);

    // Per-instance wall clock (PLAN-v2 §6.2): a kill turns the run into `partial`, never an error.
    let budgetTimer: NodeJS.Timeout | null = null;
    if (this.opts) {
      budgetTimer = setTimeout(() => {
        if (run.status === 'running') { run.budgetHit = 'maxSeconds'; this.abort?.abort(); }
      }, this.opts.budget.maxSeconds * 1000);
    }

    bus.emit(this.id, runId, {
      kind: 'task_start',
      origin: task.origin,
      input: task.input,
      ...(task.context ? { context: task.context } : {}),
      ...(task.contract ? { contract: task.contract } : {}),
      ...(this.opts ? { budget: this.opts.budget } : {}),
    });
    this.setStatus('thinking');

    this.push({ role: 'user', content: this.opts ? task.input : formatTaskInput(task) });

    let finalText = '';
    let lastText = '';
    let iterations = 0;
    let errorMessage: string | null = null;
    let lastModel = this.cfg().model;

    try {
      for (let iteration = 1; iteration <= this.cfg().maxIterations; iteration++) {
        if (signal.aborted) { run.status = run.budgetHit ? 'partial' : 'cancelled'; break; }
        if (run.budgetHit) break;
        iterations = iteration;
        run.iteration = iteration;

        const liveCfg = config.get();
        const liveAgent = this.cfg();
        const roster = config.agentViews();
        const tools: ToolDef[] = toolDefsFor(this.role(), liveCfg, roster, depth);
        const system = buildRolePrompt(liveAgent, liveCfg, roster, deps.env, {
          toolNames: tools.map((t) => t.function.name),
        });
        const trimmed = trimHistory(this.history(), client.contextLimit(liveAgent.model));
        const messages: ChatMessage[] = [{ role: 'system', content: system }, ...trimmed];
        const maxTokens = this.callTokenCap(run);
        const escalate = this.shouldEscalate(run);

        let picked = router.pick(liveAgent, 0, { escalate });
        lastModel = picked.model;
        this.lastModelUsed = picked.model;
        const llmEv = bus.emit(this.id, runId, {
          kind: 'llm_call',
          model: picked.model,
          format: picked.format,
          iteration,
          messageCount: messages.length,
          status: 'streaming',
        });
        const callStart = Date.now();
        const callUsage = emptyUsage();
        let acc = newAcc();
        let finishReason: string | null = null;
        let streamFailed = false;
        let modelAttempt = 0;
        let backoff = 0;

        for (;;) {
          try {
            const r = await client.streamChat(
              {
                model: picked.model,
                format: picked.format,
                messages,
                tools,
                sessionId: requestId,
                ...(maxTokens !== undefined ? { maxTokens } : {}),
                ...(liveAgent.temperature !== undefined ? { temperature: liveAgent.temperature } : {}),
              },
              this.handlers(runId, iteration, () => acc, callUsage, run),
              signal,
            );
            finishReason = r.finishReason;
            if (r.finishReason === 'length') run.truncated = true;
            break;
          } catch (e) {
            const err = e instanceof ApiError ? e : new ApiError('Unknown', fmtErr(e));
            if (err.type === 'Abort' || signal.aborted) {
              run.status = run.budgetHit ? 'partial' : 'cancelled';
              streamFailed = true;
              break;
            }
            // `next` is computed BEFORE marking the model unavailable, otherwise the shortened
            // chain would shift the index and skip the very next fallback (PLAN-v2 §4).
            const next = router.pick(liveAgent, modelAttempt + 1, { escalate });
            const switchable = isSwitchable(err.type) && !picked.last;
            if (err.type === 'ModelError' || err.type === 'DataPolicyError') {
              router.markUnavailable(picked.model, err);
            }
            if (switchable) {
              bus.emit(this.id, runId, {
                kind: 'info',
                message: `Fallback: ${picked.model} → ${next.model} (${reasonIt(err)})`,
              });
              if (acc.reasoning || acc.text || acc.calls.size) acc = newAcc();
              modelAttempt += 1;
              picked = next;
              lastModel = picked.model;
              this.lastModelUsed = picked.model;
              bus.patch(this.id, llmEv.id, { set: { model: picked.model, format: picked.format } });
              this.setStatus('thinking', `fallback ${picked.model}`);
              if (err.type === 'RateLimit') {
                try { await sleep(300, signal); } catch { run.status = 'cancelled'; streamFailed = true; break; }
              }
              continue;
            }
            if (err.retryable && backoff < MAX_STREAM_ATTEMPTS - 1) {
              const wait = err.retryAfterMs ?? Math.min(5000 * 2 ** backoff, 60000) + Math.floor(Math.random() * 500);
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
              backoff += 1;
              this.setStatus('thinking', 'nuovo tentativo');
              try {
                await sleep(wait, signal);
              } catch {
                run.status = run.budgetHit ? 'partial' : 'cancelled'; streamFailed = true; break;
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
        if (signal.aborted) { run.status = run.budgetHit ? 'partial' : 'cancelled'; break; }

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
        this.push(assistant);
        if (acc.text) lastText = acc.text;

        bus.patch(this.id, llmEv.id, {
          set: {
            status: 'done',
            finishReason,
            usage: cloneUsage(callUsage),
            durationMs: Date.now() - callStart,
          },
        });
        // Token budget is checked after every call, before deciding to continue (PLAN-v2 §6.2).
        if (this.opts && !run.budgetHit) {
          const used = run.usage.promptTokens + run.usage.completionTokens;
          if (used > this.opts.budget.maxTokens) run.budgetHit = 'maxTokens';
        }
        this.emitStatus();

        if (!calls.length) {
          if (acc.textEvId) bus.patch(this.id, acc.textEvId, { set: { final: true } });
          run.status = run.budgetHit ? 'partial' : 'done';
          finalText = acc.text;
          break;
        }

        if (this.opts && !run.budgetHit) {
          const cap = this.opts.budget.maxToolCalls;
          if ((run.toolCalls ?? 0) + calls.length > cap) run.budgetHit = 'maxToolCalls';
        }
        if (run.budgetHit) {
          // Keep the history API-valid even though this instance is done (PLAN-v2 §6.2).
          for (const c of calls) {
            this.push({ role: 'tool', tool_call_id: c.id, content: '[budget exhausted]' });
            if (c.evId) bus.patch(this.id, c.evId, { set: { status: 'error' } });
          }
          break;
        }

        this.setStatus('tool');
        const results = await this.executeToolCalls(calls, run, iteration, signal);
        run.toolCalls = (run.toolCalls ?? 0) + calls.length;
        for (const c of calls) {
          this.push({
            role: 'tool',
            tool_call_id: c.id,
            content: truncateForModel(
              results.get(c.id) ?? '[cancelled by user]',
              POOL_TOOLS.has(c.name) ? POOL_OUTPUT_CAP : MODEL_OUTPUT_CAP,
            ),
          });
        }
        if (signal.aborted) { run.status = run.budgetHit ? 'partial' : 'cancelled'; break; }
        if (iteration === this.cfg().maxIterations) {
          run.status = 'error';
          errorMessage = 'Limite di iterazioni raggiunto';
          bus.emit(this.id, runId, { kind: 'error', message: errorMessage, retryable: false, code: 'MaxIterations' });
          finalText = acc.text || '';
        }
      }
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
      bus.flushAgent(this.id);
    }

    if (run.status === 'running') {
      if (run.budgetHit) run.status = 'partial';
      else { run.status = 'error'; errorMessage = errorMessage ?? 'Esecuzione interrotta'; }
    }
    run.finishedAt = Date.now();
    const status: TaskResult['status'] = run.status === 'done'
      ? 'done'
      : (run.status === 'cancelled' ? 'cancelled' : (run.status === 'partial' ? 'partial' : 'error'));

    const taskEnd = bus.emit(this.id, runId, {
      kind: 'task_end',
      status,
      durationMs: run.finishedAt - startedAt,
      usage: cloneUsage(run.usage),
      iterations,
      ...(run.budgetHit ? { budgetHit: run.budgetHit } : {}),
      ...(this.opts ? { toolCalls: run.toolCalls ?? 0 } : {}),
    });

    const text = status === 'done'
      ? finalText
      : (status === 'partial'
        ? (finalText || lastText || errorMessage || 'parziale')
        : (errorMessage ?? (status === 'cancelled' ? 'annullato' : 'errore')));
    const isUserRun = task.origin.kind === 'user';
    deps.send('run:finished', {
      runId,
      agentId: this.id,
      status,
      isUserRun,
      finalText: text,
      usage: cloneUsage(run.usage),
      // T0 unless the turn actually delegated (PLAN-v2 §6.1); read before the ctx is recycled.
      ...(isUserRun ? { tier: deps.host.requestTier(requestId) ?? 'T0' } : {}),
    });
    deps.host.onRunFinished(run, text, taskEnd.id);
    deps.host.unregisterRun(runId);
    this.current = null;
    this.abort = null;
    this.setStatus(status === 'error' ? 'error' : 'idle');

    return {
      status,
      text,
      runId,
      usage: cloneUsage(run.usage),
      toolCalls: run.toolCalls ?? 0,
      ...(run.budgetHit ? { budgetHit: run.budgetHit } : {}),
      ...(run.truncated ? { truncated: true } : {}),
    };
  }

  /**
   * `max_tokens` for one call (PLAN-v2 §6.2). Only *completion* tokens are subtracted: the prompt is
   * re-sent and re-counted at every iteration, so charging it against the answer allowance made the
   * room to reply collapse after the first iteration — measured: a Planner with a 6000-token budget
   * got 4500 tokens on iteration 2 and was cut off (`finish_reason: length`) before writing its JSON.
   * The cost budget still stops the run through the cumulative check in the loop.
   */
  private callTokenCap(run: RunState): number | undefined {
    if (!this.opts) return undefined;
    const left = this.opts.budget.maxTokens - run.usage.completionTokens;
    return Math.max(MIN_CALL_TOKENS, Math.min(MAX_CALL_TOKENS, left));
  }

  /** Orchestrator escalates on T3; instances carry the flag decided at spawn (PLAN-v2 §4). */
  private shouldEscalate(run: RunState): boolean {
    if (this.opts) return this.opts.escalate;
    if (this.role() !== 'orchestrator') return false;
    return this.deps.host.requestTier(run.requestId ?? run.runId) === 'T3';
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

  /** Strictly sequential in v2: batching now lives inside delegate_tasks (PLAN-v2 §8). */
  private async executeToolCalls(
    calls: AccCall[],
    run: RunState,
    iteration: number,
    signal: AbortSignal,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    for (const c of calls) {
      if (signal.aborted) break;
      results.set(c.id, await this.runOneCall(c, run, iteration, signal));
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
    const depth = run.origin.kind === 'delegation' ? run.origin.depth : 0;
    const allowed = toolNamesFor(this.role(), this.deps.config.get(), this.deps.host.roster(), depth);
    if (!allowed.includes(c.name)) {
      const msg = `ERROR: unknown tool ${c.name}. Available: ${allowed.join(', ')}`;
      patch({ status: 'error', args });
      return msg;
    }

    this.setStatus('tool', c.name);
    patch({ status: 'running', args });

    const t0 = Date.now();
    const template = this.cfg();
    const view = this.deps.config.agentView(template);
    const r = await execute(c.name, args, {
      // The permission modal shows the TEMPLATE name/colour but the INSTANCE id, so
      // gate.cancelRun/cancelAgent still match the running instance (PLAN-v2 §8).
      agent: { ...template, id: this.id },
      agentView: { ...view, id: this.id },
      run,
      signal,
      cfg: () => this.deps.config.get(),
      roster: () => this.deps.host.roster(),
      role: this.role(),
      depth,
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
    log(`tool ${c.name} for ${template.name}: ok=${r.ok} ${durationMs}ms (iter ${iteration})`);
    return r.output;
  }
}

// ================================================================ helpers

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function newAcc(): Acc {
  return { reasoning: '', text: '', reasoningEvId: null, textEvId: null, calls: new Map() };
}

function toWire(c: AccCall): ToolCall {
  return { id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } };
}

/** User input goes verbatim; v1 delegations get a framed header (PLAN §5.2). v2 instances receive
 *  an already-complete contract message and bypass this (PLAN-v2 §9). */
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

export { firstBalancedObject };

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
    case 'DataPolicyError': return `Data policy non accettata per questo modello: ${err.message}`;
    case 'RateLimit': return `Limite di utilizzo del piano raggiunto: ${err.message}`;
    case 'Network': return `Errore di rete: ${err.message}`;
    case 'Server': return `Errore del servizio (${err.status}): ${err.message}`;
    case 'Protocol': return `Risposta inattesa dal servizio: ${err.message}`;
    default: return err.message;
  }
}
