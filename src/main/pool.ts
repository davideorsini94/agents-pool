// InstancePool: the scheduler behind delegate_tasks / run_planner / run_verifier / read_artifact.
// PLAN-v2 §6 (request context, instance lifecycle, scheduler, cancellation) and §7 (contracts).
//
// Every limit is read from the LIVE AppConfig through poolLimits(): no literal 4/8/1 appears in the
// algorithms, so raising a setting mid-request applies to the next batch (PLAN-v2 §0, §12).
// IMPORTANT: no 'electron' import — scripts/api-smoke.mjs §12 drives this class with a fake client.

import type {
  AgentConfig, AgentId, AgentRole, AgentStatus, AgentView, AppConfig, Budget, ResultContract,
  ResultStatus, Task, TaskContract, TaskResult, Tier, Verdict,
} from '../shared/types';
import { AgentDeps, AgentHost, AgentRuntime } from './agent';
import { OpenCodeClient } from './api';
import { ArtifactStore, INLINE_CAP } from './artifacts';
import type { ConfigStore } from './config';
import {
  ContractsLog, effectiveBudget, parsePlan, parseResultContract, parseVerdict, poolLimits, roleOf,
  syntheticResult, validateBatch, validateTaskContract,
} from './contracts';
import type { PermissionGate } from './permissions';
import { PromptEnv, VerifierItem, buildContractMessage, buildPlannerMessage, buildVerifierMessage } from './prompt';
import { ModelRouter } from './router';
import { ConsoleBus, StateStore } from './state';
import type { ToolCaller } from './tools';
import {
  Mutex, Semaphore, Send, logWarn, newId, normalizeKey, truncateForModel,
} from './util';

const TIER_ORDER: Tier[] = ['T0', 'T1', 'T2', 'T3'];
// Fallbacks when a template carries no budget. Sized on measured runs: a planner writing a 6-task
// plan spends 10k+ tokens of reasoning before the JSON, a verifier reads several results.
const PLANNER_BUDGET: Budget = { maxTokens: 20000, maxToolCalls: 8, maxSeconds: 240 };
const VERIFIER_BUDGET: Budget = { maxTokens: 20000, maxToolCalls: 8, maxSeconds: 240 };
/** Requests whose artifact directories are kept on disk (§7.6). */
const KEEP_ARTIFACT_REQUESTS = 20;

interface RunRecord {
  instanceId: AgentId;
  contract: TaskContract;
  result: ResultContract;
  status: ResultStatus;
  finishedAt: number;
  attempt: number;
  correction: boolean;
  blockedContinuation: boolean;
}

/** One user request: the unit of tier, instance budget, artifacts and ephemeral consoles (§6.1). */
export interface RequestCtx {
  requestId: string;
  userText: string;
  startedAt: number;
  tier: Tier | null;
  instancesSpawned: number;
  runs: Map<string, RunRecord[]>;
  verifierCalledAt: number | null;
  verified: Set<string>;
  planCalled: boolean;
  live: Map<AgentId, AgentRuntime>;
  sideEffectMutex: Mutex;
  globalSem: Semaphore;
  templateSem: Map<AgentId, Semaphore>;
  ephemeral: AgentView[];
  agentsUsed: Set<string>;
}

export interface PoolDeps {
  config: ConfigStore;
  state: StateStore;
  bus: ConsoleBus;
  client: OpenCodeClient;
  gate: PermissionGate;
  send: Send;
  env: PromptEnv;
  appVersion: string;
  router: ModelRouter;
  artifacts: ArtifactStore;
  contracts: ContractsLog;
  host: AgentHost;
  setAgentStatus: (agentId: AgentId, status: AgentStatus, detail?: string) => void;
}

export class InstancePool {
  private readonly requests = new Map<string, RequestCtx>();

  constructor(private readonly deps: PoolDeps) {}

  private cfg(): AppConfig { return this.deps.config.get(); }
  private limits(): ReturnType<typeof poolLimits> { return poolLimits(this.cfg()); }

  // ------------------------------------------------------------ request lifecycle

  /**
   * Called from Orchestrator.registerRun for a user run (§6.1): drops the previous request's
   * ephemeral consoles, prunes old artifact directories and resets the per-request bookkeeping.
   */
  startRequest(requestId: string, userText: string): RequestCtx {
    for (const [id, ctx] of [...this.requests]) {
      if (id === requestId) continue;
      this.disposeRequest(ctx, 'next_request');
      this.requests.delete(id);
    }
    void this.deps.artifacts.prune(KEEP_ARTIFACT_REQUESTS).catch((e) => logWarn('artifacts prune', e));
    const ctx: RequestCtx = {
      requestId,
      userText,
      startedAt: Date.now(),
      tier: null,
      instancesSpawned: 0,
      runs: new Map(),
      verifierCalledAt: null,
      verified: new Set(),
      planCalled: false,
      live: new Map(),
      sideEffectMutex: new Mutex(),
      // Sizes are FUNCTIONS: a lowered maxParallelWorkers applies at the next acquire (§12).
      globalSem: new Semaphore(() => this.limits().maxParallelWorkers),
      templateSem: new Map(),
      ephemeral: [],
      agentsUsed: new Set(),
    };
    this.requests.set(requestId, ctx);
    return ctx;
  }

  private disposeRequest(ctx: RequestCtx, reason: 'next_request' | 'reset'): void {
    for (const rt of ctx.live.values()) rt.destroy('nuova richiesta');
    ctx.live.clear();
    for (const view of ctx.ephemeral) this.removeConsole(view.id, reason);
    ctx.ephemeral = [];
  }

  private removeConsole(agentId: AgentId, reason: 'closed' | 'next_request' | 'template_removed' | 'reset'): void {
    this.deps.state.drop(agentId);
    this.deps.send('console:remove', { agentId, reason });
  }

  ctxFor(requestId: string | undefined): RequestCtx | undefined {
    return requestId ? this.requests.get(requestId) : undefined;
  }

  requestTier(requestId: string): Tier | null {
    return this.requests.get(requestId)?.tier ?? null;
  }

  /** `{tier, instances, agentsUsed}` for the orchestrator's task_end patch (§6.1). */
  requestSummary(requestId: string): { tier: Tier; instances: number; agentsUsed: string[] } | null {
    const ctx = this.requests.get(requestId);
    if (!ctx) return null;
    return { tier: ctx.tier ?? 'T0', instances: ctx.instancesSpawned, agentsUsed: [...ctx.agentsUsed] };
  }

  instances(): AgentView[] {
    const out: AgentView[] = [];
    for (const ctx of this.requests.values()) out.push(...ctx.ephemeral);
    return out;
  }

  hasInstanceConsole(id: AgentId): boolean {
    for (const ctx of this.requests.values()) if (ctx.ephemeral.some((v) => v.id === id)) return true;
    return false;
  }

  liveRuntime(id: AgentId): AgentRuntime | undefined {
    for (const ctx of this.requests.values()) {
      const rt = ctx.live.get(id);
      if (rt) return rt;
    }
    return undefined;
  }

  anyRunning(): boolean {
    for (const ctx of this.requests.values()) for (const rt of ctx.live.values()) if (rt.busy) return true;
    return false;
  }

  // ------------------------------------------------------------ cancellation (§6.5)

  cancelAll(reason: string): void {
    for (const ctx of this.requests.values()) {
      for (const rt of ctx.live.values()) rt.cancel(reason);
    }
  }

  cancelInstance(id: AgentId, reason: string): boolean {
    const rt = this.liveRuntime(id);
    if (!rt) return false;
    rt.cancel(reason);
    return true;
  }

  /** `instance:close` (§6.5): cancel if live, drop the console, tell the renderer. */
  closeInstance(id: AgentId): void {
    this.cancelInstance(id, 'console chiusa dall\'utente');
    for (const ctx of this.requests.values()) {
      const i = ctx.ephemeral.findIndex((v) => v.id === id);
      if (i >= 0) ctx.ephemeral.splice(i, 1);
    }
    this.removeConsole(id, 'closed');
  }

  /** Template removed in Settings while its instances run (§12). */
  templateRemoved(templateId: AgentId): void {
    for (const ctx of this.requests.values()) {
      for (const [id, rt] of [...ctx.live]) {
        if (!id.startsWith(`${templateId}#`) && id !== templateId) continue;
        rt.cancel('template removed by the user');
        ctx.live.delete(id);
      }
      for (const view of [...ctx.ephemeral]) {
        if (view.parentId !== templateId) continue;
        ctx.ephemeral.splice(ctx.ephemeral.indexOf(view), 1);
        this.removeConsole(view.id, 'template_removed');
      }
    }
  }

  /** config:resetAll (§12). */
  resetAll(): void {
    for (const [id, ctx] of [...this.requests]) {
      this.disposeRequest(ctx, 'reset');
      this.requests.delete(id);
    }
  }

  // ------------------------------------------------------------ read_artifact

  async readArtifact(args: Record<string, unknown>): Promise<string> {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return 'ERROR: missing artifact id';
    const offset = numArg(args.offset, 0);
    const limit = numArg(args.limit, 6000);
    const r = await this.deps.artifacts.get(id, offset, limit);
    if (!r) return `ERROR: unknown artifact ${id}`;
    return `${r.header}\n${r.slice}`;
  }

  // ------------------------------------------------------------ delegate_tasks (§6.3)

  async delegateTasks(from: ToolCaller, args: Record<string, unknown>, callId: string): Promise<string> {
    const cfg = this.cfg();
    const l = poolLimits(cfg);
    const fromRun = from.run;
    const requestId = fromRun.requestId ?? '';
    const ctx = this.requests.get(requestId);
    if (!ctx) return 'ERROR: no active user request — answer the user directly';

    const depth = fromRun.origin.kind === 'delegation' ? fromRun.origin.depth : 0;
    const reject = (reason: string, toName = 'worker'): string => {
      this.deps.bus.emit(from.agent.id, fromRun.runId, {
        kind: 'delegation', callId, toAgentId: null, toName, task: reason,
        status: 'rejected', resultPreview: reason, depth: depth + 1,
      });
      this.deps.contracts.append({ requestId, kind: 'rejected', data: { reason, args } });
      return `ERROR: ${reason}`;
    };

    // 0 — caller and depth. Levels: orchestrator 1, its instances 2, nested 3…
    if (depth > 0 && !l.allowWorkerDelegation) {
      return reject('worker delegation is disabled in the settings; return your result instead');
    }
    if (depth + 2 > l.maxDepth) {
      return reject(`max depth reached (maxDepth=${l.maxDepth})`);
    }

    // 1 — validate
    const tier = String(args.tier ?? '').trim().toUpperCase();
    if (tier !== 'T1' && tier !== 'T2' && tier !== 'T3') {
      return reject('tier must be one of T1, T2, T3');
    }
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (!rawTasks.length) return reject('tasks must contain at least one TaskContract');
    const contracts: TaskContract[] = [];
    for (let i = 0; i < rawTasks.length; i++) {
      const v = validateTaskContract(rawTasks[i], i, { workspacePath: cfg.workspacePath });
      if ('error' in v) return reject(v.error);
      contracts.push(v.ok);
    }

    // 2 — caps. Every message names the rule AND the live setting so the model can adapt.
    if (contracts.length > l.maxParallelWorkers) {
      return reject(`batch too large: ${contracts.length} > maxParallelWorkers=${l.maxParallelWorkers}; split into batches`);
    }
    const left = l.maxWorkersPerRequest - ctx.instancesSpawned;
    if (contracts.length > left) {
      return reject(`instance cap: maxWorkersPerRequest=${l.maxWorkersPerRequest} (used ${ctx.instancesSpawned}, left ${Math.max(0, left)})`);
    }
    const dup = validateBatch(contracts);
    if (dup) return reject(dup);

    // per task path: is this a first run, a blocked continuation, or a correction round?
    const parentPath = fromRun.origin.kind === 'delegation' ? (fromRun.origin.taskId ?? '') : '';
    interface Planned {
      contract: TaskContract; path: string; attempt: number; correction: boolean;
      blockedContinuation: boolean; previous: ResultContract | null; template: AgentConfig;
    }
    const planned: Planned[] = [];
    for (const c of contracts) {
      const path = parentPath ? `${parentPath}.${c.task_id}` : c.task_id;
      const history = ctx.runs.get(path) ?? [];
      let attempt = 1;
      let correction = false;
      let blockedContinuation = false;
      let previous: ResultContract | null = null;
      if (history.length) {
        const prev = history[history.length - 1];
        previous = prev.result;
        const corrections = history.filter((r) => r.correction).length;
        const continuationUsed = history.some((r) => r.blockedContinuation);
        const canContinue = prev.status === 'blocked' && !continuationUsed;
        const canCorrect = ctx.verifierCalledAt !== null
          && ctx.verifierCalledAt > prev.finishedAt
          && corrections < l.correctionRounds;
        if (canContinue) blockedContinuation = true;
        else if (canCorrect) correction = true;
        else {
          return reject(`${c.task_id} already ran: a correction needs run_verifier first / correctionRounds=${l.correctionRounds} exhausted`);
        }
        attempt = history.length + 1;
      }
      // 4 — resolve the template that will execute the task
      const template = this.resolveTemplate(c.role);
      if (!template) return reject('no worker template configured — answer the user directly');
      // Cycle / self-delegation check on TEMPLATES (v1 orchestrator.ts L154-158, §6.3 step 0).
      if (fromRun.ancestry.includes(template.id)) {
        const chain = fromRun.ancestry
          .map((id) => this.deps.config.agent(id)?.name ?? id)
          .join(' → ');
        return reject(`cycle: ${template.name} is above you in the delegation chain (${chain}); return your result instead`, template.name);
      }
      planned.push({ contract: c, path, attempt, correction, blockedContinuation, previous, template });
    }

    // 3 — tier never goes down; instances are counted before running
    ctx.tier = maxTier(ctx.tier, tier as Tier);
    ctx.instancesSpawned += planned.length;

    // 5 — one delegation card per task on the CALLER's console
    const cards = new Map<string, string>();
    for (const p of planned) {
      const ev = this.deps.bus.emit(from.agent.id, fromRun.runId, {
        kind: 'delegation',
        callId,
        toAgentId: p.template.id,
        toName: p.template.name,
        task: p.contract.objective,
        status: 'queued',
        taskId: p.path,
        tier: tier as Tier,
        attempt: p.attempt,
        depth: depth + 1,
        contract: p.contract,
      });
      cards.set(p.path, ev.id);
      this.deps.contracts.append({
        requestId, kind: 'task', taskId: p.path, template: p.template.name,
        attempt: p.attempt, data: p.contract,
      });
    }
    this.deps.setAgentStatus(from.agent.id, 'waiting_delegate', `${planned.length} istanze`);

    // 6 — read-only tasks in parallel, side-effect tasks one at a time; both groups start together
    const results = new Map<string, ResultContract>();
    const readOnly = planned.filter((p) => !p.contract.side_effects);
    const sideEffects = planned.filter((p) => p.contract.side_effects);

    const runOne = async (p: Planned): Promise<void> => {
      const release = await ctx.globalSem.acquire();
      const tRelease = await this.templateSem(ctx, p.template).acquire();
      try {
        const r = await this.spawnInstance(ctx, from, p, tier as Tier, cards.get(p.path) ?? '', depth, callId);
        results.set(p.path, r);
      } finally {
        tRelease();
        release();
      }
    };

    const readOnlyAll = Promise.all(readOnly.map((p) => runOne(p)));
    const sideEffectsSeq = (async () => {
      for (const p of sideEffects) {
        // Never two side-effect instances at once, at any depth (REQUIREMENTS §3).
        await ctx.sideEffectMutex.run(() => runOne(p));
      }
    })();
    await Promise.all([readOnlyAll, sideEffectsSeq]);

    if (this.deps.config.agent(from.agent.id) || from.agent.id.includes('#')) {
      this.deps.setAgentStatus(from.agent.id, 'tool');
    }

    // 8 — the tool result the caller sees
    const ordered = planned.map((p) => results.get(p.path)).filter((r): r is ResultContract => !!r);
    return JSON.stringify({
      tier,
      results: ordered,
      instances_used: ctx.instancesSpawned,
      instances_left: Math.max(0, l.maxWorkersPerRequest - ctx.instancesSpawned),
      limits: {
        maxParallelWorkers: l.maxParallelWorkers,
        maxWorkersPerRequest: l.maxWorkersPerRequest,
        correctionRounds: l.correctionRounds,
      },
    });
  }

  private templateSem(ctx: RequestCtx, template: AgentConfig): Semaphore {
    const existing = ctx.templateSem.get(template.id);
    if (existing) return existing;
    // Size is re-read live: `maxConcurrent` may change between acquires (§12).
    const sem = new Semaphore(() => {
      const t = this.deps.config.agent(template.id);
      return t?.maxConcurrent ?? this.limits().maxParallelWorkers;
    });
    ctx.templateSem.set(template.id, sem);
    return sem;
  }

  /**
   * (a) exact template name, case/accents-insensitive → (b) a template whose role equals the string
   * → (c) the first worker template in config order → (d) none (§6.3 step 4).
   */
  private resolveTemplate(role: string): AgentConfig | undefined {
    const agents = this.cfg().agents;
    const needle = normalizeKey(role);
    const byName = agents.find((a) => normalizeKey(a.name) === needle);
    if (byName && roleOf(byName) !== 'orchestrator') return byName;
    const asRole = agents.find((a) => roleOf(a) === needle && roleOf(a) !== 'orchestrator');
    if (asRole) return asRole;
    return agents.find((a) => roleOf(a) === 'worker');
  }

  // ------------------------------------------------------------ spawnInstance (§6.3)

  private async spawnInstance(
    ctx: RequestCtx,
    from: ToolCaller,
    p: {
      contract: TaskContract; path: string; attempt: number; correction: boolean;
      blockedContinuation: boolean; previous: ResultContract | null; template: AgentConfig;
    },
    tier: Tier,
    evId: string,
    depth: number,
    callId: string,
  ): Promise<ResultContract> {
    const cfg = this.cfg();
    const { bus, send, state } = this.deps;
    const template = p.template;
    const role: AgentRole = roleOf(template);
    const instanceId = `${template.id}#${p.path}${p.attempt > 1 ? `-r${p.attempt}` : ''}`;
    const budget = effectiveBudget(p.contract.budget, template.budget);
    // Correction re-runs use the escalation model; a blocked continuation does not (§4).
    const escalate = p.attempt >= 2 && !p.blockedContinuation;

    const view: AgentView = {
      ...template,
      id: instanceId,
      name: `${template.name} · ${p.path}`,
      description: p.contract.objective.slice(0, 80),
      isMain: false,
      ephemeral: true,
      parentId: template.id,
      taskId: p.path,
      objective: p.contract.objective,
      requestId: ctx.requestId,
    };
    // console:add is sent BEFORE state.ensure/first emit so the renderer never drops an event (§15).
    send('console:add', view);
    ctx.ephemeral.push(view);
    state.ensure(instanceId);
    ctx.agentsUsed.add(template.name);

    const inputBlocks = await this.deps.artifacts.inline(p.contract.inputs, cfg.workspacePath)
      .catch((e) => { logWarn('pool: input inlining failed', e); return [] as string[]; });
    const message = buildContractMessage(cfg, this.deps.env, {
      contract: p.contract,
      inputBlocks,
      budget,
      attempt: p.attempt,
      previous: p.previous,
    });

    bus.emit(template.id, null, {
      kind: 'info',
      message: `Istanza ${p.path} avviata (${role}, tentativo ${p.attempt})`,
    });
    bus.patch(from.agent.id, evId, { set: { status: 'running', instanceId } });

    let rt: AgentRuntime;
    try {
      rt = new AgentRuntime(instanceId, this.agentDeps(), {
        templateId: template.id,
        role,
        budget,
        requestId: ctx.requestId,
        escalate,
      });
    } catch (e) {
      logWarn('pool: cannot create instance', e);
      const failed = syntheticResult(p.contract.task_id, 'partial', '', `instance not available: ${String(e)}`);
      this.record(ctx, p, instanceId, failed);
      bus.patch(from.agent.id, evId, { set: { status: 'error', result: failed, resultPreview: 'istanza non disponibile' } });
      return failed;
    }
    ctx.live.set(instanceId, rt);

    const task: Task = {
      id: newId('task'),
      agentId: instanceId,
      origin: {
        kind: 'delegation',
        fromAgentId: from.agent.id,
        fromName: from.agent.name,
        parentRunId: from.run.runId,
        callId,
        depth: depth + 1,
        requestId: ctx.requestId,
        taskId: p.path,
        role,
        attempt: p.attempt,
      },
      input: message,
      contract: p.contract,
      createdAt: Date.now(),
    };
    const startedAt = Date.now();
    const q = rt.enqueue(task);
    from.run.childRunIds.push(q.runId);
    const r: TaskResult = await q.result;
    ctx.live.delete(instanceId);
    const durationMs = Date.now() - startedAt;

    const parsed = await parseResultContract(r.text, p.contract, r, {
      requestId: ctx.requestId,
      model: rt.lastModelUsed || template.model,
      durationMs,
      artifactThresholdChars: poolLimits(this.cfg()).artifactThresholdChars,
      artifacts: this.deps.artifacts,
    });
    rt.destroy('istanza completata');
    if (parsed.stage === 2) {
      bus.emit(instanceId, null, { kind: 'info', message: 'ResultContract estratto da testo' });
    }
    const result = parsed.result;
    this.record(ctx, p, instanceId, result);

    const usd = result.cost.usd ? ` · $${result.cost.usd.toFixed(4)}` : '';
    bus.emit(template.id, null, {
      kind: 'info',
      message: `Istanza ${p.path} completata: ${result.status} · ${kilo(result.cost.tokens)} tok${usd}`,
    });
    bus.patch(from.agent.id, evId, {
      set: {
        status: delegationStatus(result.status, r.status),
        instanceId,
        durationMs,
        result,
        resultPreview: previewOf(result),
        tier,
      },
    });
    this.deps.contracts.append({
      requestId: ctx.requestId,
      kind: 'result',
      taskId: p.path,
      instanceId,
      template: template.name,
      model: result.cost.model,
      attempt: p.attempt,
      data: result,
    });
    return result;
  }

  private record(
    ctx: RequestCtx,
    p: { contract: TaskContract; path: string; attempt: number; correction: boolean; blockedContinuation: boolean },
    instanceId: AgentId,
    result: ResultContract,
  ): void {
    const list = ctx.runs.get(p.path) ?? [];
    list.push({
      instanceId,
      contract: p.contract,
      result,
      status: result.status,
      finishedAt: Date.now(),
      attempt: p.attempt,
      correction: p.correction,
      blockedContinuation: p.blockedContinuation,
    });
    ctx.runs.set(p.path, list);
  }

  // ------------------------------------------------------------ run_planner (§6.4)

  async runPlanner(from: ToolCaller, args: Record<string, unknown>, callId: string): Promise<string> {
    const ctx = this.requests.get(from.run.requestId ?? '');
    if (!ctx) return 'ERROR: no active user request — plan inline';
    const l = this.limits();
    const template = this.pickRoleTemplate('planner', args.template);
    if (!template) return 'ERROR: no planner template configured — plan inline';
    if (ctx.instancesSpawned + 1 > l.maxWorkersPerRequest) {
      return `ERROR: instance cap: maxWorkersPerRequest=${l.maxWorkersPerRequest} (used ${ctx.instancesSpawned}, left 0) — plan inline`;
    }
    const objective = typeof args.objective === 'string' ? args.objective.trim() : '';
    if (!objective) return 'ERROR: objective is required';
    const context = typeof args.context === 'string' ? args.context : undefined;

    ctx.tier = 'T3';
    ctx.planCalled = true;
    ctx.instancesSpawned += 1;
    ctx.agentsUsed.add(template.name);

    const cfg = this.cfg();
    const workers = this.deps.config.agentViews().filter((a) => roleOf(a) === 'worker');
    const message = buildPlannerMessage(cfg, this.deps.env, { objective, ...(context ? { context } : {}), workers });
    const r = await this.runRoleInstance(ctx, from, template, 'planner',
      effectiveBudget(undefined, template.budget ?? PLANNER_BUDGET), true, message, callId);
    if (!r) return 'ERROR: no planner template configured — plan inline';

    const plan = parsePlan(r.text, { workspacePath: cfg.workspacePath, truncated: r.truncated });
    this.deps.contracts.append({
      requestId: ctx.requestId, kind: 'plan', template: template.name, data: plan,
    });
    // An empty plan is a failure, not a result: returning it as-is made the orchestrator retry the
    // identical call (measured: two 3-minute planner runs wasted before it decomposed by itself).
    if (!plan.tasks.length) {
      const why = plan.warnings[0] ?? 'nessun task prodotto';
      logWarn(`planner produced no tasks (${why})`);
      return `ERROR: il Planner non ha prodotto task (${why}) — non richiamare run_planner con lo stesso obiettivo: scomponi tu il lavoro e delega con delegate_tasks`;
    }
    return JSON.stringify(plan);
  }

  // ------------------------------------------------------------ run_verifier (§6.4)

  async runVerifier(from: ToolCaller, args: Record<string, unknown>, callId: string): Promise<string> {
    const ctx = this.requests.get(from.run.requestId ?? '');
    if (!ctx) return 'ERROR: no active user request — verify inline';
    const l = this.limits();
    const template = this.pickRoleTemplate('verifier', args.template);
    if (!template) return 'ERROR: no verifier template configured — verify inline';
    if (ctx.instancesSpawned + 1 > l.maxWorkersPerRequest) {
      return `ERROR: instance cap: maxWorkersPerRequest=${l.maxWorkersPerRequest} (used ${ctx.instancesSpawned}, left 0) — verify inline`;
    }
    const requested = Array.isArray(args.task_ids)
      ? args.task_ids.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
      : [];
    const ids = requested.length ? requested.filter((id) => ctx.runs.has(id)) : [...ctx.runs.keys()];
    if (!ids.length) return 'ERROR: no task of this request has produced a result yet — nothing to verify';
    const critical = args.critical === true;

    const items: VerifierItem[] = [];
    for (const id of ids) {
      const history = ctx.runs.get(id);
      if (!history || !history.length) continue;
      const last = history[history.length - 1];
      items.push({ taskId: id, contract: last.contract, output: await this.outputOf(last.result) });
    }

    ctx.instancesSpawned += 1;
    ctx.agentsUsed.add(template.name);

    const message = buildVerifierMessage(this.cfg(), this.deps.env, { userText: ctx.userText, items });
    const r = await this.runRoleInstance(ctx, from, template, 'verifier',
      effectiveBudget(undefined, template.budget ?? VERIFIER_BUDGET), critical, message, callId);
    if (!r) return 'ERROR: no verifier template configured — verify inline';

    const verdict: Verdict = parseVerdict(r.text);
    this.deps.bus.emit(template.id, null, {
      kind: 'verdict', taskIds: ids, verdict, critical,
    });
    ctx.verifierCalledAt = Date.now();
    for (const id of ids) ctx.verified.add(id);
    this.deps.contracts.append({
      requestId: ctx.requestId, kind: 'verifier', template: template.name, data: { taskIds: ids, verdict },
    });
    return JSON.stringify(verdict);
  }

  /** Result text as the verifier sees it: artifacts are inlined up to the per-input cap (§6.4). */
  private async outputOf(result: ResultContract): Promise<string> {
    if (typeof result.result === 'string') return truncateForModel(result.result, INLINE_CAP);
    const content = await this.deps.artifacts.content(result.result.artifact_ref, INLINE_CAP);
    return content ?? `[artifact ${result.result.artifact_ref}] ${result.result.summary}`;
  }

  /**
   * Planner / verifier instance: one run on the TEMPLATE's own console (they are never concurrent,
   * since the orchestrator's tool calls are sequential), fresh in-memory history, no console:add.
   */
  private async runRoleInstance(
    ctx: RequestCtx,
    from: ToolCaller,
    template: AgentConfig,
    role: AgentRole,
    budget: Budget,
    escalate: boolean,
    message: string,
    callId: string,
  ): Promise<TaskResult | null> {
    const instanceId = template.id;
    this.deps.state.ensure(instanceId);
    let rt: AgentRuntime;
    try {
      rt = new AgentRuntime(instanceId, this.agentDeps(), {
        templateId: template.id, role, budget, requestId: ctx.requestId, escalate,
      });
    } catch (e) {
      logWarn('pool: cannot create role instance', e);
      return null;
    }
    ctx.live.set(instanceId, rt);
    const task: Task = {
      id: newId('task'),
      agentId: instanceId,
      origin: {
        kind: 'delegation',
        fromAgentId: from.agent.id,
        fromName: from.agent.name,
        parentRunId: from.run.runId,
        callId,
        depth: 1,
        requestId: ctx.requestId,
        taskId: role,
        role,
        attempt: 1,
      },
      input: message,
      createdAt: Date.now(),
    };
    const q = rt.enqueue(task);
    from.run.childRunIds.push(q.runId);
    const r = await q.result;
    ctx.live.delete(instanceId);
    rt.destroy('istanza completata');
    return r;
  }

  private pickRoleTemplate(role: AgentRole, name: unknown): AgentConfig | undefined {
    const list = this.deps.config.templatesOfRole(role);
    if (!list.length) return undefined;
    if (typeof name === 'string' && name.trim()) {
      const needle = normalizeKey(name);
      const found = list.find((a) => normalizeKey(a.name) === needle);
      if (found) return found;
    }
    return list[0];
  }

  // ------------------------------------------------------------ deps for instances

  private agentDeps(): AgentDeps {
    const d = this.deps;
    return {
      config: d.config,
      state: d.state,
      bus: d.bus,
      client: d.client,
      gate: d.gate,
      send: d.send,
      host: d.host,
      router: d.router,
      env: d.env,
      appVersion: d.appVersion,
    };
  }
}

// ================================================================ helpers

function maxTier(a: Tier | null, b: Tier): Tier {
  if (!a) return b;
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

function delegationStatus(status: ResultStatus, runStatus: TaskResult['status']): string {
  if (runStatus === 'cancelled') return 'cancelled';
  if (status === 'ok') return 'done';
  if (status === 'blocked') return 'blocked';
  return 'partial';
}

function previewOf(result: ResultContract): string {
  const body = typeof result.result === 'string' ? result.result : result.result.summary;
  return body.slice(0, 300);
}

function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number.parseInt(v, 10) : NaN);
  return Number.isFinite(n) ? n : dflt;
}
