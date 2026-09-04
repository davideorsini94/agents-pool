// Orchestrator: owns the orchestrator runtime, the user turn and the InstancePool.
// PLAN §8, §10, §11 + PLAN-v2 §6 (RequestCtx, cascade, snapshot).

import type {
  AgentId, AgentStatus, AgentView, ConfigChanged, RunState, RuntimeSnapshot, Task, Tier,
} from '../shared/types';
import { AgentHost, AgentRuntime } from './agent';
import { OpenCodeClient } from './api';
import { ArtifactStore } from './artifacts';
import { ConfigStore } from './config';
import { ContractsLog, roleOf } from './contracts';
import { PermissionGate } from './permissions';
import { PromptEnv } from './prompt';
import { InstancePool } from './pool';
import { ModelRouter } from './router';
import { ConsoleBus, StateStore, isEphemeralId } from './state';
import type { ToolCaller } from './tools';
import { Send, log, logWarn, newId } from './util';

export interface OrchestratorDeps {
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
}

export class Orchestrator implements AgentHost {
  /** Only the orchestrator template runs as a persistent runtime; the rest are instances (§0). */
  private readonly runtimes = new Map<AgentId, AgentRuntime>();
  private readonly runs = new Map<string, { run: RunState; runtime: AgentRuntime }>();
  private readonly pendingUserText = new Map<string, string>();
  private activeUserRun: { runId: string; agentId: AgentId; startedAt: number } | null = null;
  private lastTier: Tier | null = null;
  readonly pool: InstancePool;

  constructor(private readonly deps: OrchestratorDeps) {
    this.pool = new InstancePool({
      config: deps.config,
      state: deps.state,
      bus: deps.bus,
      client: deps.client,
      gate: deps.gate,
      send: deps.send,
      env: deps.env,
      appVersion: deps.appVersion,
      router: deps.router,
      artifacts: deps.artifacts,
      contracts: deps.contracts,
      host: this,
      setAgentStatus: (id, status, detail) => this.setAgentStatus(id, status, detail),
    });
  }

  // ------------------------------------------------------------ lifecycle

  /** Console state for every template, a runtime for the orchestrator, resume repair (PLAN §11). */
  start(): void {
    for (const a of this.deps.config.get().agents) {
      this.deps.state.ensure(a.id);
      for (const msg of this.deps.state.repair(a.id)) {
        this.deps.bus.emit(a.id, null, { kind: 'info', message: msg });
      }
    }
    const main = this.deps.config.orchestrator();
    if (main) this.ensureRuntime(main.id);
    log(`orchestrator: ready (${this.deps.config.get().agents.length} templates, ${this.runtimes.size} persistent runtime)`);
  }

  private ensureRuntime(id: AgentId): AgentRuntime | undefined {
    const existing = this.runtimes.get(id);
    if (existing) return existing;
    if (!this.deps.config.agent(id)) return undefined;
    this.deps.state.ensure(id);
    let rt: AgentRuntime;
    try {
      rt = new AgentRuntime(id, { ...this.deps, host: this });
    } catch (e) {
      logWarn('orchestrator: cannot create runtime', e);
      return undefined;
    }
    this.runtimes.set(id, rt);
    rt.emitStatus();
    return rt;
  }

  runtime(id: AgentId): AgentRuntime | undefined {
    return this.runtimes.get(id) ?? this.pool.liveRuntime(id);
  }

  mainRuntime(): AgentRuntime | undefined {
    const main = this.deps.config.orchestrator();
    return main ? this.ensureRuntime(main.id) : undefined;
  }

  /** Hot reload: keep the orchestrator runtime in sync, surface info events (PLAN §10, §12). */
  applyConfig(changed: ConfigChanged): void {
    const { diff } = changed;
    if (diff.fields.includes('reset')) {
      this.pool.resetAll();
      for (const rt of this.runtimes.values()) rt.destroy('configurazione azzerata');
      this.runtimes.clear();
      this.runs.clear();
      this.activeUserRun = null;
      this.lastTier = null;
      this.deps.router.clear();
      this.deps.state.resetAll();
      return;
    }
    for (const id of diff.removed) {
      // Live instances of the template die with a `partial` result for their caller (§12).
      this.pool.templateRemoved(id);
      const rt = this.runtimes.get(id);
      if (rt) rt.destroy('agent removed by the user');
      this.runtimes.delete(id);
      this.deps.state.removeAgent(id);
      log(`orchestrator: template ${id} removed`);
    }
    for (const id of diff.added) {
      this.deps.state.ensure(id);
      this.deps.bus.emit(id, null, { kind: 'info', message: 'Agente creato' });
    }
    for (const id of diff.updated) {
      this.deps.bus.emit(id, null, { kind: 'info', message: 'Configurazione aggiornata' });
    }
    if (diff.mainChanged) {
      const main = this.deps.config.orchestrator();
      if (main) this.ensureRuntime(main.id);
      // The demoted template stops being a persistent runtime and becomes an instance template —
      // but its in-flight user run finishes normally (§12), so a busy runtime is left alone.
      for (const [id, rt] of [...this.runtimes]) {
        if (main && id === main.id) continue;
        if (rt.busy) continue;
        rt.destroy('non è più l\'orchestratore');
        this.runtimes.delete(id);
      }
    }
    if (diff.fields.includes('interactionPrompt') || diff.fields.includes('workspacePath') || diff.fields.includes('permissionMode')) {
      const label = diff.fields.includes('workspacePath')
        ? `Cartella di lavoro aggiornata: ${this.deps.config.get().workspacePath ?? '—'}`
        : 'Configurazione aggiornata';
      for (const a of this.deps.config.get().agents) this.deps.bus.emit(a.id, null, { kind: 'info', message: label });
    }
  }

  // ------------------------------------------------------------ user turn

  /** chat:send — always routed to the current orchestrator template (PLAN §8.1). */
  userMessage(text: string): { runId: string; queued: boolean } {
    const main = this.mainRuntime();
    if (!main) throw new Error('Nessun agente configurato');
    if (!this.deps.config.getApiKey()) throw new Error('Nessuna API key configurata');
    const wasBusy = main.busy;
    this.deps.bus.emit(main.id, null, { kind: 'user_input', text });
    const task: Task = {
      id: newId('task'),
      agentId: main.id,
      origin: { kind: 'user' },
      input: text,
      createdAt: Date.now(),
    };
    // The RequestCtx is created when the task actually starts (queued messages wait, §6.1).
    this.pendingUserText.set(task.id, text);
    const q = main.enqueue(task);
    q.result.catch((e) => logWarn('user run rejected', e));
    return { runId: q.runId, queued: wasBusy };
  }

  // ------------------------------------------------------------ OrchestratorApi (tools → pool)

  delegateTasks(from: ToolCaller, args: Record<string, unknown>, callId: string): Promise<string> {
    return this.pool.delegateTasks(from, args, callId);
  }
  runPlanner(from: ToolCaller, args: Record<string, unknown>, callId: string): Promise<string> {
    return this.pool.runPlanner(from, args, callId);
  }
  runVerifier(from: ToolCaller, args: Record<string, unknown>, callId: string): Promise<string> {
    return this.pool.runVerifier(from, args, callId);
  }
  readArtifact(args: Record<string, unknown>): Promise<string> {
    return this.pool.readArtifact(args);
  }

  // ------------------------------------------------------------ AgentHost

  roster(): AgentView[] { return this.deps.config.agentViews(); }

  requestTier(requestId: string): Tier | null { return this.pool.requestTier(requestId); }

  findRun(runId: string): RunState | null { return this.runs.get(runId)?.run ?? null; }

  registerRun(run: RunState, runtime: AgentRuntime): void {
    this.runs.set(run.runId, { run, runtime });
    if (run.origin.kind === 'user') {
      this.activeUserRun = { runId: run.runId, agentId: run.agentId, startedAt: run.startedAt };
      const text = this.pendingUserText.get(run.taskId) ?? '';
      this.pendingUserText.delete(run.taskId);
      this.pool.startRequest(run.runId, text);
    }
  }

  unregisterRun(runId: string): void {
    this.runs.delete(runId);
  }

  onRunFinished(run: RunState, _finalText: string, taskEndEventId: string): void {
    if (run.origin.kind !== 'user') return;
    if (this.activeUserRun?.runId === run.runId) this.activeUserRun = null;
    // T0 = the turn made no delegate_tasks call at all (REQUIREMENTS §2 "zero-agent path").
    const summary = this.pool.requestSummary(run.runId);
    const tier: Tier = summary?.tier ?? 'T0';
    this.lastTier = tier;
    this.deps.bus.patch(run.agentId, taskEndEventId, {
      set: {
        tier,
        instances: summary?.instances ?? 0,
        agentsUsed: summary?.agentsUsed ?? [],
      },
    });
  }

  setAgentStatus(agentId: AgentId, status: AgentStatus, detail?: string): void {
    const rt = this.runtimes.get(agentId) ?? this.pool.liveRuntime(agentId);
    rt?.setStatus(status, detail);
  }

  // ------------------------------------------------------------ cancellation (§6.5)

  cancelRun(runId: string, reason: string): void {
    const entry = this.runs.get(runId);
    if (entry) { entry.runtime.cancelRun(runId, reason); return; }
    for (const rt of this.runtimes.values()) rt.cancelRun(runId, reason);
  }

  cancelAgent(agentId: AgentId, reason = 'annullato dall\'utente'): void {
    this.deps.gate.cancelAgent(agentId);
    const rt = this.runtimes.get(agentId);
    if (rt) { rt.cancel(reason); return; }
    if (!this.pool.cancelInstance(agentId, reason)) {
      logWarn(`orchestrator: cancelAgent for unknown id ${agentId}`);
    }
  }

  /** chat:cancel with no argument — stop everything (instances included) and clear all queues. */
  cancelAll(reason = 'annullato dall\'utente'): void {
    this.deps.gate.cancelAll();
    this.pool.cancelAll(reason);
    for (const rt of this.runtimes.values()) rt.cancel(reason);
    this.activeUserRun = null;
  }

  /** instance:close (§3, §6.5). */
  closeInstance(instanceId: AgentId): void {
    if (!isEphemeralId(instanceId)) throw new Error('Non è una console di istanza');
    this.deps.gate.cancelAgent(instanceId);
    this.pool.closeInstance(instanceId);
  }

  hasConsole(id: AgentId): boolean {
    return !!this.deps.config.agent(id) || this.pool.hasInstanceConsole(id);
  }

  // ------------------------------------------------------------ misc

  clearHistory(agentId: AgentId): void {
    const a = this.deps.config.agent(agentId);
    if (!a) throw new Error('Agente inesistente');
    if (roleOf(a) !== 'orchestrator') {
      throw new Error('Solo l\'orchestratore ha una cronologia: le istanze partono sempre da zero');
    }
    const rt = this.runtimes.get(agentId);
    if (rt?.busy) throw new Error('L\'agente è al lavoro: fermalo prima di cancellare la cronologia');
    this.deps.state.clearHistory(agentId);
    this.deps.bus.emit(agentId, null, { kind: 'info', message: 'Cronologia cancellata: nuova sessione' });
  }

  snapshot(): RuntimeSnapshot {
    const agents: RuntimeSnapshot['agents'] = {};
    // Every template gets an entry (the renderer keys its consoles by template id), plus every
    // live instance so a reload restores the ephemeral consoles (§10.2 applyRuntime).
    for (const a of this.deps.config.get().agents) {
      const rt = this.runtimes.get(a.id) ?? this.pool.liveRuntime(a.id);
      agents[a.id] = {
        status: rt?.status ?? 'idle',
        runId: rt?.current?.runId ?? null,
        queueLength: rt?.queueLength ?? 0,
        usage: rt ? rt.usage() : { ...this.deps.state.usage(a.id) },
        lastSeq: this.deps.state.lastSeq(a.id),
      };
    }
    for (const view of this.pool.instances()) {
      const rt = this.pool.liveRuntime(view.id);
      agents[view.id] = {
        status: rt?.status ?? 'idle',
        runId: rt?.current?.runId ?? null,
        queueLength: rt?.queueLength ?? 0,
        usage: { ...this.deps.state.usage(view.id) },
        lastSeq: this.deps.state.lastSeq(view.id),
      };
    }
    return {
      agents,
      pendingPermissions: this.deps.gate.pending(),
      pendingAsks: this.deps.gate.pendingAsks(),
      activeUserRun: this.activeUserRun,
      queuedUserMessages: this.mainRuntime()?.queuedUserTasks() ?? 0,
      instances: this.pool.instances(),
      unavailableModels: this.deps.router.unavailableModels(),
      currentTier: this.activeUserRun
        ? this.pool.requestTier(this.activeUserRun.runId)
        : this.lastTier,
    };
  }

  anyRunning(): boolean {
    for (const rt of this.runtimes.values()) if (rt.busy) return true;
    return this.pool.anyRunning();
  }
}
