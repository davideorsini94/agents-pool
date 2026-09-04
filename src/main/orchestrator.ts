// Orchestrator: owns the agent runtimes, the user turn and delegation. PLAN §8, §10, §11.

import type {
  AgentId, AgentStatus, AgentView, ConfigChanged, RunState, RuntimeSnapshot, Task,
} from '../shared/types';
import { AgentHost, AgentRuntime } from './agent';
import { OpenCodeClient } from './api';
import { ConfigStore } from './config';
import { PermissionGate } from './permissions';
import { PromptEnv } from './prompt';
import { ConsoleBus, StateStore } from './state';
import { Send, log, logWarn, newId } from './util';

const MAX_DELEGATIONS_PER_RUN = 20;

export interface OrchestratorDeps {
  config: ConfigStore;
  state: StateStore;
  bus: ConsoleBus;
  client: OpenCodeClient;
  gate: PermissionGate;
  send: Send;
  env: PromptEnv;
  appVersion: string;
}

interface DelegationLink { agentId: AgentId; eventId: string }

export class Orchestrator implements AgentHost {
  private readonly runtimes = new Map<AgentId, AgentRuntime>();
  private readonly runs = new Map<string, { run: RunState; runtime: AgentRuntime }>();
  private readonly delegationCounts = new Map<string, number>();
  private readonly delegationLinks = new Map<string, DelegationLink>();
  private activeUserRun: { runId: string; agentId: AgentId; startedAt: number } | null = null;

  constructor(private readonly deps: OrchestratorDeps) {}

  // ------------------------------------------------------------ lifecycle

  /** Creates a runtime per configured agent and runs the resume repair (PLAN §11). */
  start(): void {
    for (const a of this.deps.config.get().agents) this.ensureRuntime(a.id);
    log(`orchestrator: ${this.runtimes.size} runtimes ready`);
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
    for (const msg of this.deps.state.repair(id)) {
      this.deps.bus.emit(id, null, { kind: 'info', message: msg });
    }
    rt.emitStatus();
    return rt;
  }

  runtime(id: AgentId): AgentRuntime | undefined { return this.runtimes.get(id); }

  mainRuntime(): AgentRuntime | undefined {
    const main = this.deps.config.mainAgent();
    return main ? this.runtimes.get(main.id) : undefined;
  }

  /** Hot reload: create/destroy runtimes, surface info events (PLAN §10). */
  applyConfig(changed: ConfigChanged): void {
    const { diff } = changed;
    if (diff.fields.includes('reset')) {
      for (const rt of this.runtimes.values()) rt.destroy('configurazione azzerata');
      this.runtimes.clear();
      this.runs.clear();
      this.activeUserRun = null;
      this.deps.state.resetAll();
      return;
    }
    for (const id of diff.removed) {
      const rt = this.runtimes.get(id);
      if (rt) rt.destroy('agent removed by the user');
      this.runtimes.delete(id);
      this.deps.state.removeAgent(id);
      log(`orchestrator: agent ${id} removed`);
    }
    for (const id of diff.added) {
      this.ensureRuntime(id);
      this.deps.bus.emit(id, null, { kind: 'info', message: 'Agente creato' });
    }
    for (const id of diff.updated) {
      this.deps.bus.emit(id, null, { kind: 'info', message: 'Configurazione aggiornata' });
    }
    if (diff.fields.includes('interactionPrompt') || diff.fields.includes('workspacePath') || diff.fields.includes('permissionMode')) {
      const label = diff.fields.includes('workspacePath')
        ? `Cartella di lavoro aggiornata: ${this.deps.config.get().workspacePath ?? '—'}`
        : 'Configurazione aggiornata';
      for (const id of this.runtimes.keys()) this.deps.bus.emit(id, null, { kind: 'info', message: label });
    }
  }

  // ------------------------------------------------------------ user turn

  /** chat:send — always routed to the current main agent (PLAN §8.1). */
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
    const q = main.enqueue(task);
    q.result.catch((e) => logWarn('user run rejected', e));
    return { runId: q.runId, queued: wasBusy };
  }

  // ------------------------------------------------------------ delegation

  async delegate(
    from: { agent: { id: AgentId; name: string }; run: RunState },
    ref: string,
    task: string,
    context: string | undefined,
    callId: string,
  ): Promise<string> {
    const cfg = this.deps.config.get();
    const fromRun = from.run;
    const needle = String(ref ?? '').trim().toLowerCase();
    const target = cfg.agents.find((a) => a.id === ref || a.name.toLowerCase() === needle);

    const reject = (reason: string, toName: string, toAgentId: AgentId | null): string => {
      this.deps.bus.emit(from.agent.id, fromRun.runId, {
        kind: 'delegation', callId, toAgentId, toName, task, status: 'rejected', resultPreview: reason,
      });
      return reason;
    };

    if (!target) {
      return reject(`Unknown agent '${ref}'. Known: ${cfg.agents.map((a) => a.name).join(', ')}`, String(ref), null);
    }
    if (target.id === from.agent.id) {
      return reject('You cannot delegate to yourself', target.name, target.id);
    }
    if (fromRun.ancestry.includes(target.id)) {
      const chain = fromRun.ancestry
        .map((id) => cfg.agents.find((a) => a.id === id)?.name ?? id)
        .join(' → ');
      return reject(`Cycle: ${target.name} is above you in the delegation chain (${chain}); return your result instead`, target.name, target.id);
    }
    const depth = fromRun.origin.kind === 'delegation' ? fromRun.origin.depth : 0;
    if (depth + 1 > cfg.maxDelegationDepth) {
      return reject(`Max delegation depth reached (${cfg.maxDelegationDepth})`, target.name, target.id);
    }
    const used = this.delegationCounts.get(fromRun.runId) ?? 0;
    if (used >= MAX_DELEGATIONS_PER_RUN) {
      return reject('Too many delegations in this task', target.name, target.id);
    }
    const rt = this.ensureRuntime(target.id);
    if (!rt) return reject(`Agent ${target.name} is not available`, target.name, target.id);
    this.delegationCounts.set(fromRun.runId, used + 1);

    const ev = this.deps.bus.emit(from.agent.id, fromRun.runId, {
      kind: 'delegation',
      callId,
      toAgentId: target.id,
      toName: target.name,
      task,
      status: rt.busy ? 'queued' : 'running',
    });

    const childTask: Task = {
      id: newId('task'),
      agentId: target.id,
      origin: {
        kind: 'delegation',
        fromAgentId: from.agent.id,
        fromName: from.agent.name,
        parentRunId: fromRun.runId,
        callId,
        depth: depth + 1,
      },
      input: task,
      ...(context ? { context } : {}),
      createdAt: Date.now(),
    };

    const q = rt.enqueue(childTask);
    fromRun.childRunIds.push(q.runId);
    this.delegationLinks.set(q.runId, { agentId: from.agent.id, eventId: ev.id });
    this.setAgentStatus(from.agent.id, 'waiting_delegate', target.name);
    const t0 = Date.now();

    const r = await q.result;
    this.delegationLinks.delete(q.runId);
    this.deps.bus.patch(from.agent.id, ev.id, {
      set: {
        status: r.status,
        childRunId: q.runId,
        resultPreview: (r.text ?? '').slice(0, 300),
        durationMs: Date.now() - t0,
      },
    });
    if (this.runtimes.get(from.agent.id)?.busy) this.setAgentStatus(from.agent.id, 'tool');

    if (r.status === 'done') return `Result from ${target.name}:\n${r.text}`;
    return `Delegation to ${target.name} ${r.status}: ${r.text || 'no output'}`;
  }

  // ------------------------------------------------------------ AgentHost

  roster(): AgentView[] { return this.deps.config.agentViews(); }

  rosterInfo(): Array<{ id: string; name: string; description: string; model: string; status: AgentStatus; isMain: boolean }> {
    return this.roster().map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      model: a.model,
      status: this.runtimes.get(a.id)?.status ?? 'idle',
      isMain: a.isMain,
    }));
  }

  findRun(runId: string): RunState | null { return this.runs.get(runId)?.run ?? null; }

  registerRun(run: RunState, runtime: AgentRuntime): void {
    this.runs.set(run.runId, { run, runtime });
    if (run.origin.kind === 'user') {
      this.activeUserRun = { runId: run.runId, agentId: run.agentId, startedAt: run.startedAt };
    }
    const link = this.delegationLinks.get(run.runId);
    if (link) this.deps.bus.patch(link.agentId, link.eventId, { set: { status: 'running', childRunId: run.runId } });
  }

  unregisterRun(runId: string): void {
    this.runs.delete(runId);
    this.delegationCounts.delete(runId);
  }

  onRunFinished(run: RunState): void {
    if (this.activeUserRun?.runId === run.runId) this.activeUserRun = null;
  }

  setAgentStatus(agentId: AgentId, status: AgentStatus, detail?: string): void {
    this.runtimes.get(agentId)?.setStatus(status, detail);
  }

  // ------------------------------------------------------------ cancellation

  cancelRun(runId: string, reason: string): void {
    const entry = this.runs.get(runId);
    if (entry) { entry.runtime.cancelRun(runId, reason); return; }
    for (const rt of this.runtimes.values()) rt.cancelRun(runId, reason);
  }

  cancelAgent(agentId: AgentId, reason = 'annullato dall\'utente'): void {
    this.deps.gate.cancelAgent(agentId);
    this.runtimes.get(agentId)?.cancel(reason);
  }

  /** chat:cancel with no argument — stop everything and clear all queues. */
  cancelAll(reason = 'annullato dall\'utente'): void {
    this.deps.gate.cancelAll();
    for (const rt of this.runtimes.values()) rt.cancel(reason);
    this.activeUserRun = null;
  }

  // ------------------------------------------------------------ misc

  clearHistory(agentId: AgentId): void {
    const rt = this.runtimes.get(agentId);
    if (!rt) throw new Error('Agente inesistente');
    if (rt.busy) throw new Error('L\'agente è al lavoro: fermalo prima di cancellare la cronologia');
    this.deps.state.clearHistory(agentId);
    this.deps.bus.emit(agentId, null, { kind: 'info', message: 'Cronologia cancellata: nuova sessione' });
  }

  snapshot(): RuntimeSnapshot {
    const agents: RuntimeSnapshot['agents'] = {};
    for (const [id, rt] of this.runtimes) {
      agents[id] = {
        status: rt.status,
        runId: rt.current?.runId ?? null,
        queueLength: rt.queueLength,
        usage: rt.usage(),
        lastSeq: rt.lastSeq(),
      };
    }
    return {
      agents,
      pendingPermissions: this.deps.gate.pending(),
      pendingAsks: this.deps.gate.pendingAsks(),
      activeUserRun: this.activeUserRun,
      queuedUserMessages: this.mainRuntime()?.queuedUserTasks() ?? 0,
    };
  }

  anyRunning(): boolean {
    for (const rt of this.runtimes.values()) if (rt.busy) return true;
    return false;
  }
}
