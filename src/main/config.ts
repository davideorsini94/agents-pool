// ConfigStore — owns config.json (the only place the API key lives). PLAN §2, §2.5, §10, §11.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type {
  AgentConfig, AgentId, AgentInput, AgentRole, AgentView, AppConfig, Budget, ConfigChanged,
  ConfigPatch, ConfigSnapshot, ModelFormat, PermissionMode, SetupPayload,
} from '../shared/types';
import type { ModelTableEntry } from './api';
import { DEFAULT_BUDGET, POOL_RANGES, clampRange, roleOf } from './contracts';
import { DEFAULT_PROMPTS, defaultPrompt } from './prompt';
import {
  PALETTE, atomicWriteSync, clampInt, isRecord, log, logWarn, maskKey, newAgentId, readJsonSync,
} from './util';

export { PALETTE };
/** POOL_RANGES / DEFAULT_BUDGET are defined in contracts.ts (electron-free, PLAN-v2 §13.1) and
 *  re-exported here because PLAN-v2 §11.3 documents them as config constants. */
export { DEFAULT_BUDGET, POOL_RANGES };
export type { ModelTableEntry };
export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const PROBE_MODEL = 'glm-5.3-flash';
export const DEFAULT_MAX_ITERATIONS = 40;
export const ROLES: AgentRole[] = ['orchestrator', 'planner', 'worker', 'verifier'];

/** Wizard preset "Pool consigliato" — a preset, not a schema: quota buckets are per model, so each
 *  role sits on a different bucket and every primary was verified for its exact job (§11.3). */
export const RECOMMENDED_POOL: AgentInput[] = [
  {
    name: 'Orchestratore', role: 'orchestrator', model: 'minimax-m3',
    fallbacks: ['qwen3.7-plus', 'deepseek-v4-flash'], escalation: 'glm-5.3',   // escalation: T3 only
    prompt: DEFAULT_PROMPTS.orchestrator, color: '#3B82F6', maxIterations: DEFAULT_MAX_ITERATIONS,
  },
  {
    name: 'Planner', role: 'planner', model: 'glm-5.3',
    fallbacks: ['kimi-k2.7-code', 'minimax-m3'],
    budget: { maxTokens: 16000, maxToolCalls: 8, maxSeconds: 60 },
    prompt: DEFAULT_PROMPTS.planner, color: '#8B5CF6',
  },
  {
    name: 'Worker', role: 'worker', model: 'deepseek-v4-flash',
    fallbacks: ['kimi-k2.7-code', 'glm-5.3-flash'], escalation: 'deepseek-v4-pro',
    budget: { maxTokens: 24000, maxToolCalls: 12, maxSeconds: 60 },
    prompt: DEFAULT_PROMPTS.worker, color: '#10B981',
  },
  {
    name: 'Worker Flash', role: 'worker', model: 'longcat-2.0',
    fallbacks: ['glm-5.3-flash', 'hy3'],
    budget: { maxTokens: 12000, maxToolCalls: 8, maxSeconds: 60 },
    prompt: DEFAULT_PROMPTS.worker, color: '#F59E0B',
  },
  {
    name: 'Verificatore', role: 'verifier', model: 'qwen3.7-plus',
    fallbacks: ['minimax-m3', 'glm-5.3-flash'], escalation: 'glm-5.3',        // escalation: critical only
    budget: { maxTokens: 16000, maxToolCalls: 8, maxSeconds: 60 },
    prompt: DEFAULT_PROMPTS.verifier, color: '#EF4444',
  },
];

const ECONOMY_MODEL = 'muse-spark-1.3-contributor';

/** Wizard preset "Pool economico (Muse Spark)" — RECOMMENDED_POOL with both worker templates on
 *  `muse-spark-1.3-contributor` so a 403 self-heals through the router chain. Cheapest and by far
 *  the largest allowance, but it needs the OpenCode workspace opt-in AND its prompts/completions
 *  train Meta models: never a default, never for proprietary or clinical content (§11.3). */
export const ECONOMY_POOL: AgentInput[] = RECOMMENDED_POOL.map((t) => {
  if (t.name === 'Worker') return { ...t, model: ECONOMY_MODEL, fallbacks: ['deepseek-v4-flash', 'kimi-k2.7-code'] };
  if (t.name === 'Worker Flash') return { ...t, model: ECONOMY_MODEL, fallbacks: ['longcat-2.0', 'glm-5.3-flash'] };
  return { ...t };
});

/** Wizard preset "Vuoto" — the single invariant of a pool: one orchestrator (§11.3). */
export const EMPTY_POOL: AgentInput[] = [
  {
    name: 'Orchestratore', role: 'orchestrator', model: 'minimax-m3', fallbacks: ['qwen3.7-plus'],
    prompt: DEFAULT_PROMPTS.orchestrator, color: '#3B82F6', maxIterations: DEFAULT_MAX_ITERATIONS,
  },
];

/** Static model facts, measured 2026-09-04 (§11.3); injected into OpenCodeClient and ModelRouter,
 *  which both stay electron-free. */
export const MODEL_TABLE: Record<string, ModelTableEntry> = {
  'minimax-m3': {
    format: 'chat', privacy: 'zdr', costIn: 0.30, costOut: 1.20, bucketUsd: 60, reqPer5h: 3200, jsonStrict: false,
    notes: 'ottimo orchestratore (tool call); JSON avvolto in prosa',
  },
  'qwen3.7-plus': {
    format: 'chat', privacy: 'zdr', costIn: 0.40, costOut: 1.60, bucketUsd: 60, reqPer5h: 4300, jsonStrict: true,
    notes: 'tool call ok',
  },
  'qwen3.8-flash': { format: 'chat', privacy: 'zdr', costIn: 0.15, costOut: 0.47, bucketUsd: 30, reqPer5h: 5400 },
  'deepseek-v4-flash': {
    format: 'chat', privacy: 'zdr_verify', costIn: 0.22, costOut: 0.66, bucketUsd: 30, reqPer5h: 7600, jsonStrict: true,
    notes: '1M ctx; ZDR fino al 2026-08-31: conferma rinnovo',
  },
  'deepseek-v4-pro': {
    format: 'chat', privacy: 'zdr_verify', costIn: 0.66, costOut: 1.98, bucketUsd: 15, reqPer5h: 1050,
    notes: 'escalation worker; stesso avviso ZDR',
  },
  'kimi-k2.7-code': {
    format: 'chat', privacy: 'zdr', costIn: 0.95, costOut: 4.00, bucketUsd: 60, reqPer5h: 1350, jsonStrict: true,
    notes: 'tool call più efficiente (62 tok)',
  },
  'kimi-k3': {
    format: 'chat', privacy: 'zdr', costIn: 3.00, costOut: 15.00, bucketUsd: 15, reqPer5h: 110,
    notes: 'quota minima: escluso dai preset',
  },
  'glm-5.3-flash': {
    format: 'chat', privacy: 'zdr', costIn: 0.15, costOut: 0.50, bucketUsd: 15, reqPer5h: 1580, jsonStrict: true,
    notes: 'probe model',
  },
  'glm-5.3': { format: 'chat', privacy: 'zdr', costIn: 1.40, costOut: 4.40, bucketUsd: 15, reqPer5h: 220, notes: 'escalation' },
  'glm-5.2': { format: 'chat', privacy: 'zdr', costIn: 1.40, costOut: 4.40, bucketUsd: 60, reqPer5h: 880, notes: 'escalation' },
  hy3: {
    format: 'chat', privacy: 'zdr', costIn: 0.14, costOut: 0.58, bucketUsd: 60, reqPer5h: 4300, jsonStrict: true,
    notes: 'reasoning in delta.reasoning',
  },
  'longcat-2.0': {
    format: 'chat', privacy: 'zdr', costIn: 0.30, costOut: 1.20, bucketUsd: 60, reqPer5h: 11400, jsonStrict: true,
    notes: 'tool call in 71 tok; cache $0.006',
  },
  'mimo-v2.5': {
    format: 'chat', privacy: 'zdr', costIn: 0.14, costOut: 0.28, bucketUsd: 60, reqPer5h: 30100, jsonStrict: true,
    notes: 'token-hungry: nulla sotto ~700 token di budget → mai come predefinito',
  },
  'muse-spark-1.3-contributor': {
    format: 'responses', privacy: 'training', costIn: 0.10, costOut: 0.20, bucketUsd: 60, reqPer5h: 45300,
    notes: "403 fino all'opt-in; addestramento dati",
  },
  'grok-4.6': {
    format: 'responses', privacy: 'retention_30d', costIn: 2.00, costOut: 6.00, bucketUsd: 15, reqPer5h: 169,
    notes: 'escluso dai preset',
  },
  'gpt-5.6-luna': {
    format: 'responses', privacy: 'retention_30d', costIn: 0.20, costOut: 1.20, bucketUsd: 15, reqPer5h: 2050,
    notes: 'escluso dai preset',
  },
};

const MODES: PermissionMode[] = ['strict', 'balanced', 'relaxed', 'bypass'];

function defaults(): AppConfig {
  return {
    version: 2,
    apiKey: null,
    apiKeyEnc: null,
    workspacePath: null,
    agents: [],
    mainAgentId: null,
    interactionPrompt: '',
    permissionMode: 'balanced',
    commandAllowlist: [],
    showReasoning: true,
    permissionTimeoutMs: 300000,
    setupComplete: false,
    // v2 pool limits (§11.1): every value comes from POOL_RANGES so defaults and clamps agree.
    maxParallelWorkers: POOL_RANGES.maxParallelWorkers.default,
    maxWorkersPerRequest: POOL_RANGES.maxWorkersPerRequest.default,
    correctionRounds: POOL_RANGES.correctionRounds.default,
    allowWorkerDelegation: false,
    maxDepth: POOL_RANGES.maxDepth.default,
    artifactThresholdChars: POOL_RANGES.artifactThresholdChars.default,
    modelFormats: {},
  };
}

/** Derived console subtitle (PLAN §2.5). */
export function deriveDescription(prompt: string): string {
  const m = /^(description|descrizione)\s*:\s*(.+)$/im.exec(prompt);
  let text = m ? m[2] : '';
  if (!text) {
    for (const raw of prompt.split(/\r?\n/)) {
      const line = raw.replace(/^[#*>\-\s]+/, '').trim();
      if (line) { text = line; break; }
    }
  }
  text = text.replace(/^[#*>\-\s]+/, '').trim();
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

export class ConfigStore {
  private cfg: AppConfig = defaults();
  private readonly file: string;
  private keyCache: string | null = null;
  /** true when the key had to be stored in clear text (safeStorage unavailable). */
  keyStoredPlain = false;
  private listeners: Array<(c: ConfigChanged) => void> = [];

  constructor(private readonly userDataPath: string) {
    this.file = path.join(userDataPath, 'config.json');
  }

  // ------------------------------------------------------------ load / save

  load(): void {
    const raw = readJsonSync<unknown>(this.file);
    this.cfg = raw ? sanitize(raw) : defaults();
    this.keyCache = this.decryptKey();
    if (!raw) log('config: no config.json, starting with defaults');
    else log(`config: loaded ${this.cfg.agents.length} agents, mode=${this.cfg.permissionMode}, setup=${this.cfg.setupComplete}`);
  }

  private save(): void {
    atomicWriteSync(this.file, `${JSON.stringify(this.cfg, null, 2)}\n`);
  }

  get(): AppConfig { return this.cfg; }
  get configFile(): string { return this.file; }
  get userData(): string { return this.userDataPath; }

  onChange(cb: (c: ConfigChanged) => void): void { this.listeners.push(cb); }

  private emitChange(diff: ConfigChanged['diff']): ConfigSnapshot {
    const snapshot = this.snapshot();
    for (const l of this.listeners) {
      try { l({ snapshot, diff }); } catch (e) { logWarn('config listener failed', e); }
    }
    return snapshot;
  }

  // ------------------------------------------------------------ api key

  private decryptKey(): string | null {
    if (this.cfg.apiKeyEnc) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          return safeStorage.decryptString(Buffer.from(this.cfg.apiKeyEnc, 'base64'));
        }
        logWarn('config: encrypted key present but safeStorage unavailable');
      } catch (e) {
        logWarn('config: cannot decrypt api key', e);
      }
    }
    if (this.cfg.apiKey) { this.keyStoredPlain = true; return this.cfg.apiKey; }
    return null;
  }

  getApiKey(): string | null { return this.keyCache; }
  hasApiKey(): boolean { return !!this.keyCache; }
  maskedKey(): string | null { return this.keyCache ? maskKey(this.keyCache) : null; }

  setApiKey(key: string): void {
    const k = key.trim();
    this.keyCache = k;
    let encrypted = false;
    try {
      if (safeStorage.isEncryptionAvailable()) {
        this.cfg.apiKeyEnc = safeStorage.encryptString(k).toString('base64');
        this.cfg.apiKey = null;
        encrypted = true;
      }
    } catch (e) {
      logWarn('config: safeStorage.encryptString failed', e);
    }
    if (!encrypted) {
      this.cfg.apiKeyEnc = null;
      this.cfg.apiKey = k;
      logWarn('config: safeStorage unavailable — API key stored in clear text');
    }
    this.keyStoredPlain = !encrypted;
    this.save();
    this.emitChange(emptyDiff(['apiKey']));
  }

  clearApiKey(): void {
    this.keyCache = null;
    this.cfg.apiKey = null;
    this.cfg.apiKeyEnc = null;
    this.keyStoredPlain = false;
    this.save();
    this.emitChange(emptyDiff(['apiKey']));
  }

  // ------------------------------------------------------------ views

  agentView(a: AgentConfig): AgentView {
    return { ...a, description: deriveDescription(a.prompt), isMain: a.id === this.cfg.mainAgentId };
  }
  agentViews(): AgentView[] { return this.cfg.agents.map((a) => this.agentView(a)); }
  agent(id: AgentId): AgentConfig | undefined { return this.cfg.agents.find((a) => a.id === id); }
  mainAgent(): AgentConfig | undefined {
    return this.cfg.agents.find((a) => a.id === this.cfg.mainAgentId) ?? this.cfg.agents[0];
  }

  /** Templates of a role, in config order (§6.3 step 4, §8 tool exposure). */
  templatesOfRole(role: AgentRole): AgentConfig[] {
    return this.cfg.agents.filter((a) => roleOf(a) === role);
  }
  firstOfRole(role: AgentRole): AgentConfig | undefined { return this.templatesOfRole(role)[0]; }
  orchestrator(): AgentConfig | undefined {
    return this.cfg.agents.find((a) => a.id === this.cfg.mainAgentId) ?? this.firstOfRole('orchestrator');
  }

  snapshot(): ConfigSnapshot {
    const c = this.cfg;
    return {
      hasApiKey: this.hasApiKey(),
      apiKeyMasked: this.maskedKey(),
      workspacePath: c.workspacePath,
      agents: this.agentViews(),
      mainAgentId: c.mainAgentId,
      interactionPrompt: c.interactionPrompt,
      permissionMode: c.permissionMode,
      commandAllowlist: [...c.commandAllowlist],
      showReasoning: c.showReasoning,
      permissionTimeoutMs: c.permissionTimeoutMs,
      setupComplete: c.setupComplete,
      maxParallelWorkers: clampRange(c.maxParallelWorkers, POOL_RANGES.maxParallelWorkers),
      maxWorkersPerRequest: clampRange(c.maxWorkersPerRequest, POOL_RANGES.maxWorkersPerRequest),
      correctionRounds: clampRange(c.correctionRounds, POOL_RANGES.correctionRounds),
      allowWorkerDelegation: c.allowWorkerDelegation === true,
      maxDepth: clampRange(c.maxDepth, POOL_RANGES.maxDepth),
      artifactThresholdChars: clampRange(c.artifactThresholdChars, POOL_RANGES.artifactThresholdChars),
      modelFormats: { ...(c.modelFormats ?? {}) },
    };
  }

  // ------------------------------------------------------------ mutations

  update(patch: ConfigPatch): ConfigSnapshot {
    const fields: string[] = [];
    let mainChanged = false;

    if (patch.workspacePath !== undefined) {
      const p = patch.workspacePath;
      if (p !== null) {
        if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
          throw new Error('La cartella di lavoro indicata non esiste');
        }
      }
      if (p !== this.cfg.workspacePath) { this.cfg.workspacePath = p; fields.push('workspacePath'); }
    }
    if (patch.interactionPrompt !== undefined && patch.interactionPrompt !== this.cfg.interactionPrompt) {
      this.cfg.interactionPrompt = String(patch.interactionPrompt); fields.push('interactionPrompt');
    }
    if (patch.permissionMode !== undefined && MODES.includes(patch.permissionMode) && patch.permissionMode !== this.cfg.permissionMode) {
      this.cfg.permissionMode = patch.permissionMode; fields.push('permissionMode');
    }
    if (patch.commandAllowlist !== undefined) {
      const list = patch.commandAllowlist.map((s) => String(s).trim()).filter(Boolean);
      this.cfg.commandAllowlist = list; fields.push('commandAllowlist');
    }
    if (patch.showReasoning !== undefined && patch.showReasoning !== this.cfg.showReasoning) {
      this.cfg.showReasoning = !!patch.showReasoning; fields.push('showReasoning');
    }
    if (patch.permissionTimeoutMs !== undefined) {
      const v = clamp(Math.round(patch.permissionTimeoutMs), 10000, 3600000);
      if (v !== this.cfg.permissionTimeoutMs) { this.cfg.permissionTimeoutMs = v; fields.push('permissionTimeoutMs'); }
    }
    // v2 pool limits, clamped to POOL_RANGES (§3, §11.2). Legacy maxDelegationDepth is ignored.
    for (const key of ['maxParallelWorkers', 'maxWorkersPerRequest', 'correctionRounds', 'maxDepth', 'artifactThresholdChars'] as const) {
      if (patch[key] === undefined) continue;
      const v = clampRange(patch[key], POOL_RANGES[key]);
      if (v !== this.cfg[key]) { this.cfg[key] = v; fields.push(key); }
    }
    if (patch.allowWorkerDelegation !== undefined) {
      const v = patch.allowWorkerDelegation === true;
      if (v !== (this.cfg.allowWorkerDelegation === true)) { this.cfg.allowWorkerDelegation = v; fields.push('allowWorkerDelegation'); }
    }
    if (patch.modelFormats !== undefined) {
      this.cfg.modelFormats = sanitizeModelFormats(patch.modelFormats);
      fields.push('modelFormats');
    }
    let updated: AgentId[] = [];
    if (patch.mainAgentId !== undefined && patch.mainAgentId !== this.cfg.mainAgentId) {
      if (!this.cfg.agents.some((a) => a.id === patch.mainAgentId)) {
        throw new Error('Agente principale inesistente');
      }
      updated = this.promote(patch.mainAgentId as AgentId);
      mainChanged = true; fields.push('mainAgentId');
    }

    if (!fields.length && !mainChanged) return this.snapshot();
    this.save();
    return this.emitChange({ added: [], removed: [], updated, mainChanged, fields });
  }

  /**
   * The pool's single invariant: exactly one orchestrator, and it is `mainAgentId` (§0, §11.2).
   * Promoting a template demotes the previous orchestrator to `worker` (its prompt falls back to
   * the worker default only when it was never edited). Returns the ids that changed.
   */
  private promote(id: AgentId): AgentId[] {
    const next = this.cfg.agents.find((a) => a.id === id);
    if (!next) throw new Error('Agente principale inesistente');
    const touched: AgentId[] = [];
    for (const a of this.cfg.agents) {
      if (a.id === id) continue;
      if (roleOf(a) !== 'orchestrator') continue;
      a.role = 'worker';
      if (isDefaultPrompt(a.prompt, 'orchestrator')) a.prompt = DEFAULT_PROMPTS.worker;
      touched.push(a.id);
    }
    if (roleOf(next) !== 'orchestrator') {
      const old = roleOf(next);
      next.role = 'orchestrator';
      if (isDefaultPrompt(next.prompt, old)) next.prompt = DEFAULT_PROMPTS.orchestrator;
    }
    this.cfg.mainAgentId = id;
    if (!touched.includes(id)) touched.push(id);
    return touched;
  }

  completeSetup(p: SetupPayload): ConfigSnapshot {
    if (!p || !Array.isArray(p.agents) || p.agents.length === 0) {
      throw new Error('Serve almeno un agente');
    }
    if (!p.workspacePath || !fs.existsSync(p.workspacePath) || !fs.statSync(p.workspacePath).isDirectory()) {
      throw new Error('Cartella di lavoro non valida');
    }
    const removed = this.cfg.agents.map((a) => a.id);
    this.cfg.agents = [];
    const created: AgentConfig[] = [];
    for (const input of p.agents) created.push(this.makeAgent(input, created));
    this.cfg.agents = created;
    const mainIndex = clamp(Math.round(p.mainIndex ?? 0), 0, created.length - 1);
    // mainIndex forces that template's role to orchestrator; everyone else keeps input.role
    // (default 'worker') and the invariant is repaired in one pass (§11.2).
    this.cfg.mainAgentId = created[mainIndex].id;
    this.promote(created[mainIndex].id);
    this.cfg.workspacePath = p.workspacePath;
    this.cfg.interactionPrompt = String(p.interactionPrompt ?? '');
    this.cfg.setupComplete = true;
    this.save();
    return this.emitChange({
      added: created.map((a) => a.id),
      removed: removed.filter((id) => !created.some((a) => a.id === id)),
      updated: [],
      mainChanged: true,
      fields: ['workspacePath', 'interactionPrompt', 'setupComplete', 'agents'],
    });
  }

  /** No count cap in v2 (§11.2): any number of templates, any mix of roles. */
  addAgent(input: AgentInput): ConfigSnapshot {
    const a = this.makeAgent(input);
    this.cfg.agents.push(a);
    let mainChanged = false;
    if (!this.cfg.mainAgentId || !this.cfg.agents.some((x) => x.id === this.cfg.mainAgentId)) {
      this.promote(a.id);
      mainChanged = true;
    } else if (roleOf(a) === 'orchestrator') {
      // A second orchestrator would break the invariant: the new one wins and the old is demoted.
      this.promote(a.id);
      mainChanged = true;
    }
    this.save();
    return this.emitChange({ added: [a.id], removed: [], updated: [], mainChanged, fields: ['agents'] });
  }

  updateAgent(id: AgentId, patch: Partial<AgentInput>): ConfigSnapshot {
    const a = this.cfg.agents.find((x) => x.id === id);
    if (!a) throw new Error('Agente inesistente');
    const fields: string[] = [];
    const updated = new Set<AgentId>();
    let mainChanged = false;

    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error('Il nome non può essere vuoto');
      if (this.cfg.agents.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Esiste già un agente con questo nome');
      }
      if (name !== a.name) { a.name = name; fields.push('name'); }
    }
    // Role changes carry the invariant (§11.2): promoting demotes the previous orchestrator, and the
    // orchestrator itself cannot be demoted directly (something has to stay the user's counterpart).
    if (patch.role !== undefined && ROLES.includes(patch.role)) {
      const oldRole = roleOf(a);
      if (patch.role !== oldRole) {
        if (patch.role === 'orchestrator') {
          for (const touched of this.promote(id)) updated.add(touched);
          mainChanged = true;
          fields.push('role', 'mainAgentId');
        } else if (a.id === this.cfg.mainAgentId || oldRole === 'orchestrator') {
          throw new Error('Promuovi prima un altro template a orchestratore');
        } else {
          a.role = patch.role;
          if (patch.prompt === undefined && isDefaultPrompt(a.prompt, oldRole)) a.prompt = DEFAULT_PROMPTS[patch.role];
          fields.push('role');
        }
      }
    }
    if (patch.model !== undefined) {
      const model = String(patch.model).trim() || DEFAULT_MODEL;
      if (model !== a.model) { a.model = model; fields.push('model'); }
    }
    if (patch.fallbacks !== undefined) {
      const list = sanitizeFallbacks(patch.fallbacks, a.model);
      a.fallbacks = list; fields.push('fallbacks');
    }
    if (patch.escalation !== undefined) {
      const v = patch.escalation === null ? undefined : (String(patch.escalation).trim() || undefined);
      if (v === undefined) delete a.escalation; else a.escalation = v;
      fields.push('escalation');
    }
    if (patch.temperature !== undefined) {
      const v = patch.temperature === null ? undefined : clampNumOrUndef(patch.temperature, 0, 2);
      if (v === undefined) delete a.temperature; else a.temperature = v;
      fields.push('temperature');
    }
    if (patch.budget !== undefined) {
      const v = patch.budget === null ? undefined : sanitizeBudget(patch.budget);
      if (v === undefined) delete a.budget; else a.budget = v;
      fields.push('budget');
    }
    if (patch.maxConcurrent !== undefined) {
      const v = patch.maxConcurrent === null ? undefined : clampInt(patch.maxConcurrent, 1, 32, 1);
      if (v === undefined) delete a.maxConcurrent; else a.maxConcurrent = v;
      fields.push('maxConcurrent');
    }
    if (patch.prompt !== undefined && String(patch.prompt) !== a.prompt) {
      a.prompt = String(patch.prompt); fields.push('prompt');
    }
    if (patch.color !== undefined) {
      const color = normalizeColor(patch.color) ?? a.color;
      if (color !== a.color) { a.color = color; fields.push('color'); }
    }
    if (patch.maxIterations !== undefined) {
      const v = clamp(Math.round(patch.maxIterations), 1, 200);
      if (v !== a.maxIterations) { a.maxIterations = v; fields.push('maxIterations'); }
    }
    if (!fields.length) return this.snapshot();
    updated.add(id);
    this.save();
    return this.emitChange({ added: [], removed: [], updated: [...updated], mainChanged, fields });
  }

  /** Any template except the orchestrator; the last planner/verifier/worker may go (§11.2). */
  removeAgent(id: AgentId): ConfigSnapshot {
    const i = this.cfg.agents.findIndex((a) => a.id === id);
    if (i < 0) throw new Error('Agente inesistente');
    if (id === this.cfg.mainAgentId || roleOf(this.cfg.agents[i]) === 'orchestrator') {
      throw new Error("Non puoi rimuovere l'orchestratore: promuovi prima un altro template");
    }
    this.cfg.agents.splice(i, 1);
    this.save();
    return this.emitChange({ added: [], removed: [id], updated: [], mainChanged: false, fields: ['agents'] });
  }

  /** Wipes everything except the API key (PLAN §3 config:resetAll). */
  resetAll(): ConfigSnapshot {
    const removed = this.cfg.agents.map((a) => a.id);
    const key = this.cfg.apiKey;
    const keyEnc = this.cfg.apiKeyEnc;
    const win = this.cfg.window;
    this.cfg = { ...defaults(), apiKey: key, apiKeyEnc: keyEnc, window: win };
    this.save();
    return this.emitChange({ added: [], removed, updated: [], mainChanged: true, fields: ['reset'] });
  }

  setWindowBounds(b: { width: number; height: number; x?: number; y?: number }): void {
    this.cfg.window = b;
    try { this.save(); } catch { /* bounds are not critical */ }
  }

  // ------------------------------------------------------------ helpers

  /** `siblings` = the agents the new one must be unique against (defaults to the current list;
   *  completeSetup passes the batch being built so names/colours are checked within the batch). */
  private makeAgent(input: AgentInput, siblings: AgentConfig[] = this.cfg.agents): AgentConfig {
    const name = String(input?.name ?? '').trim();
    if (!name) throw new Error('Il nome dell\'agente è obbligatorio');
    if (siblings.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Esiste già un agente chiamato "${name}"`);
    }
    const role: AgentRole = input?.role && ROLES.includes(input.role) ? input.role : 'worker';
    const model = String(input?.model ?? '').trim() || DEFAULT_MODEL;
    const a: AgentConfig = {
      id: newAgentId(),
      name,
      model,
      prompt: String(input?.prompt ?? '') || DEFAULT_PROMPTS[role],
      color: normalizeColor(input?.color) ?? this.nextColor(siblings),
      maxIterations: clamp(Math.round(input?.maxIterations ?? DEFAULT_MAX_ITERATIONS), 1, 200),
      createdAt: Date.now(),
      role,
      fallbacks: sanitizeFallbacks(input?.fallbacks, model),
    };
    const esc = input?.escalation;
    if (typeof esc === 'string' && esc.trim() && esc.trim() !== model) a.escalation = esc.trim();
    const temp = clampNumOrUndef(input?.temperature, 0, 2);
    if (temp !== undefined) a.temperature = temp;
    const budget = sanitizeBudget(input?.budget);
    if (budget) a.budget = budget;
    if (input?.maxConcurrent !== undefined && input.maxConcurrent !== null) {
      a.maxConcurrent = clampInt(input.maxConcurrent, 1, 32, 1);
    }
    return a;
  }

  /** First unused palette colour, else index by count (PLAN §2.5). */
  private nextColor(siblings: AgentConfig[] = this.cfg.agents): string {
    const used = new Set(siblings.map((a) => a.color.toLowerCase()));
    for (const c of PALETTE) if (!used.has(c.toLowerCase())) return c;
    return PALETTE[siblings.length % PALETTE.length];
  }
}

function emptyDiff(fields: string[]): ConfigChanged['diff'] {
  return { added: [], removed: [], updated: [], mainChanged: false, fields };
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function normalizeColor(c: unknown): string | null {
  if (typeof c !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? `#${m[1].toUpperCase()}` : null;
}

function clampNumOrUndef(v: unknown, lo: number, hi: number): number | undefined {
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number.parseFloat(v) : NaN);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(hi, Math.max(lo, n));
}

/** Deduped, non-empty, never equal to the primary (§11.1). */
function sanitizeFallbacks(raw: unknown, model: string): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>([model]);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function sanitizeBudget(raw: unknown): Budget | undefined {
  if (!isRecord(raw)) return undefined;
  const t = clampNumOrUndef(raw.maxTokens, 500, 60000);
  const c = clampNumOrUndef(raw.maxToolCalls, 1, 40);
  const s = clampNumOrUndef(raw.maxSeconds, 10, 600);
  if (t === undefined && c === undefined && s === undefined) return undefined;
  return {
    maxTokens: Math.round(t ?? DEFAULT_BUDGET.maxTokens),
    maxToolCalls: Math.round(c ?? DEFAULT_BUDGET.maxToolCalls),
    maxSeconds: Math.round(s ?? DEFAULT_BUDGET.maxSeconds),
  };
}

function sanitizeModelFormats(raw: unknown): Record<string, ModelFormat> {
  const out: Record<string, ModelFormat> = {};
  if (!isRecord(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!id.trim()) continue;
    if (v === 'chat' || v === 'responses') out[id.trim()] = v;
  }
  return out;
}

/** True when the prompt is empty or still byte-identical to a role default (§11.2). */
function isDefaultPrompt(prompt: string, role: AgentRole): boolean {
  const p = (prompt ?? '').trim();
  return !p || p === DEFAULT_PROMPTS[role].trim();
}

/**
 * Tolerant loader + the v1 → v2 migration in one pass (§11.1); the result is saved on the first
 * mutation. Unknown/broken fields fall back to defaults instead of crashing, `maxDelegationDepth`
 * is ignored and dropped, and the "exactly one orchestrator = mainAgentId" invariant is repaired.
 */
function sanitize(raw: unknown): AppConfig {
  const d = defaults();
  if (!isRecord(raw)) return d;
  const str = (v: unknown, f: string | null): string | null => (typeof v === 'string' && v ? v : f);
  const agents: AgentConfig[] = [];
  if (Array.isArray(raw.agents)) {
    for (const a of raw.agents) {
      if (!isRecord(a)) continue;
      const id = typeof a.id === 'string' && a.id ? a.id : newAgentId();
      const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'Agente';
      const model = str(a.model, DEFAULT_MODEL) as string;
      const agent: AgentConfig = {
        id,
        name,
        model,
        prompt: typeof a.prompt === 'string' ? a.prompt : '',
        color: normalizeColor(a.color) ?? PALETTE[agents.length % PALETTE.length],
        maxIterations: typeof a.maxIterations === 'number' ? clamp(Math.round(a.maxIterations), 1, 200) : DEFAULT_MAX_ITERATIONS,
        createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
        // v1 configs have no role: the main agent becomes the orchestrator, everyone else a worker.
        role: typeof a.role === 'string' && ROLES.includes(a.role as AgentRole)
          ? a.role as AgentRole
          : (a.id === raw.mainAgentId ? 'orchestrator' : 'worker'),
        fallbacks: sanitizeFallbacks(a.fallbacks, model),
      };
      const esc = typeof a.escalation === 'string' ? a.escalation.trim() : '';
      if (esc && esc !== model) agent.escalation = esc;
      const temp = clampNumOrUndef(a.temperature, 0, 2);
      if (temp !== undefined) agent.temperature = temp;
      const budget = sanitizeBudget(a.budget);
      if (budget) agent.budget = budget;
      const mc = clampNumOrUndef(a.maxConcurrent, 1, 32);
      if (mc !== undefined) agent.maxConcurrent = Math.round(mc);
      agents.push(agent);
    }
  }

  let mainAgentId = typeof raw.mainAgentId === 'string' && agents.some((a) => a.id === raw.mainAgentId)
    ? raw.mainAgentId
    : null;
  // Invariant repair: exactly one orchestrator, and it is mainAgentId.
  const orchestrators = agents.filter((a) => roleOf(a) === 'orchestrator');
  if (!mainAgentId) mainAgentId = orchestrators[0]?.id ?? agents[0]?.id ?? null;
  const main = agents.find((a) => a.id === mainAgentId);
  if (main) {
    for (const a of orchestrators) if (a.id !== main.id) a.role = 'worker';
    main.role = 'orchestrator';
  }

  const win = isRecord(raw.window) && typeof raw.window.width === 'number' && typeof raw.window.height === 'number'
    ? {
        width: raw.window.width,
        height: raw.window.height,
        ...(typeof raw.window.x === 'number' ? { x: raw.window.x } : {}),
        ...(typeof raw.window.y === 'number' ? { y: raw.window.y } : {}),
      }
    : undefined;
  return {
    version: 2,
    apiKey: str(raw.apiKey, null),
    apiKeyEnc: str(raw.apiKeyEnc, null),
    workspacePath: str(raw.workspacePath, null),
    agents,
    mainAgentId,
    interactionPrompt: typeof raw.interactionPrompt === 'string' ? raw.interactionPrompt : '',
    permissionMode: MODES.includes(raw.permissionMode as PermissionMode) ? raw.permissionMode as PermissionMode : 'balanced',
    commandAllowlist: Array.isArray(raw.commandAllowlist)
      ? raw.commandAllowlist.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((s) => s.trim())
      : [],
    showReasoning: typeof raw.showReasoning === 'boolean' ? raw.showReasoning : true,
    permissionTimeoutMs: typeof raw.permissionTimeoutMs === 'number' ? clamp(Math.round(raw.permissionTimeoutMs), 10000, 3600000) : 300000,
    setupComplete: raw.setupComplete === true && agents.length > 0,
    maxParallelWorkers: clampRange(raw.maxParallelWorkers, POOL_RANGES.maxParallelWorkers),
    maxWorkersPerRequest: clampRange(raw.maxWorkersPerRequest, POOL_RANGES.maxWorkersPerRequest),
    correctionRounds: clampRange(raw.correctionRounds, POOL_RANGES.correctionRounds),
    allowWorkerDelegation: raw.allowWorkerDelegation === true,
    maxDepth: clampRange(raw.maxDepth, POOL_RANGES.maxDepth),
    artifactThresholdChars: clampRange(raw.artifactThresholdChars, POOL_RANGES.artifactThresholdChars),
    modelFormats: sanitizeModelFormats(raw.modelFormats),
    ...(win ? { window: win } : {}),
  };
}

/** `config:defaultPrompt` (§3) — re-exported so ipc.ts has a single import surface. */
export { defaultPrompt, DEFAULT_PROMPTS };
