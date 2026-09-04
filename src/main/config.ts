// ConfigStore — owns config.json (the only place the API key lives). PLAN §2, §2.5, §10, §11.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type {
  AgentConfig, AgentId, AgentInput, AgentView, AppConfig, Budget, ConfigChanged,
  ConfigPatch, ConfigSnapshot, ModelFormat, ModelPrivacy, PermissionMode, PoolRanges, SetupPayload,
} from '../shared/types';
import { DEFAULT_PROMPTS } from './prompt';
import {
  PALETTE, atomicWriteSync, isRecord, log, logWarn, maskKey, newAgentId, readJsonSync,
} from './util';

export { PALETTE };
export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const PROBE_MODEL = 'glm-5.3-flash';
export const DEFAULT_MAX_ITERATIONS = 40;

// ---------------------------------------------------------------------------------------------
// v2 shared constants (PLAN-v2 §11.3). Data only: the ConfigStore below is still v1 —
// TODO(v2-A): version 2 migration, POOL_RANGES clamps, per-template maxConcurrent, the role
// invariant (exactly one orchestrator) and the removal of the 10-agent cap (§11.1, §11.2).
// ---------------------------------------------------------------------------------------------

/** Pool limits are settings, not constants: `default` reproduces the lead's design, the UI warns
 *  above `recommendedMax` and clamps to [min, max]. Exposed as `AppInfo.poolRanges`. */
export const POOL_RANGES: PoolRanges = {
  maxParallelWorkers:     { min: 1,    max: 16,    default: 4,    recommendedMax: 8 },
  maxWorkersPerRequest:   { min: 1,    max: 32,    default: 8,    recommendedMax: 8 },
  correctionRounds:       { min: 0,    max: 3,     default: 1,    recommendedMax: 1 },
  maxDepth:               { min: 2,    max: 4,     default: 2,    recommendedMax: 2 },   // only with allowWorkerDelegation
  artifactThresholdChars: { min: 1000, max: 20000, default: 4000, recommendedMax: 8000 },
};

/** Per-task budget when neither the TaskContract nor the template sets one (§11.3). */
export const DEFAULT_BUDGET: Budget = { maxTokens: 8000, maxToolCalls: 10, maxSeconds: 180 };

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
    budget: { maxTokens: 6000, maxToolCalls: 6, maxSeconds: 120 },
    prompt: DEFAULT_PROMPTS.planner, color: '#8B5CF6',
  },
  {
    name: 'Worker', role: 'worker', model: 'deepseek-v4-flash',
    fallbacks: ['kimi-k2.7-code', 'glm-5.3-flash'], escalation: 'deepseek-v4-pro',
    budget: { maxTokens: 8000, maxToolCalls: 10, maxSeconds: 180 },
    prompt: DEFAULT_PROMPTS.worker, color: '#10B981',
  },
  {
    name: 'Worker Flash', role: 'worker', model: 'longcat-2.0',
    fallbacks: ['glm-5.3-flash', 'hy3'],
    budget: { maxTokens: 4000, maxToolCalls: 6, maxSeconds: 120 },
    prompt: DEFAULT_PROMPTS.worker, color: '#F59E0B',
  },
  {
    name: 'Verificatore', role: 'verifier', model: 'qwen3.7-plus',
    fallbacks: ['minimax-m3', 'glm-5.3-flash'], escalation: 'glm-5.3',        // escalation: critical only
    budget: { maxTokens: 8000, maxToolCalls: 8, maxSeconds: 150 },
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

/** One row of MODEL_TABLE: measured facts models.dev does not carry. Price/context from models.dev
 *  win when present; unknown ids default to `chat` / `zdr` with no badges (§1 api.ts, §11.3). */
export interface ModelTableEntry {
  format: ModelFormat;
  privacy: ModelPrivacy;
  costIn?: number;                 // USD per 1M input tokens
  costOut?: number;                // USD per 1M output tokens
  bucketUsd?: number;              // quota bucket the model draws from
  reqPer5h?: number;               // requests per 5 h window
  jsonStrict?: boolean;            // emits the requested JSON with no prose around it
  notes?: string;                  // shown as tooltip / badge (Italian, user-visible)
}

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

const MODES: PermissionMode[] = ['strict', 'balanced', 'relaxed'];

function defaults(): AppConfig {
  return {
    version: 1,
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
    maxDelegationDepth: 3,
    setupComplete: false,
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
      maxDelegationDepth: c.maxDelegationDepth,
      setupComplete: c.setupComplete,
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
    if (patch.maxDelegationDepth !== undefined) {
      const v = clamp(Math.round(patch.maxDelegationDepth), 1, 6);
      if (v !== this.cfg.maxDelegationDepth) { this.cfg.maxDelegationDepth = v; fields.push('maxDelegationDepth'); }
    }
    if (patch.mainAgentId !== undefined && patch.mainAgentId !== this.cfg.mainAgentId) {
      if (!this.cfg.agents.some((a) => a.id === patch.mainAgentId)) {
        throw new Error('Agente principale inesistente');
      }
      this.cfg.mainAgentId = patch.mainAgentId; mainChanged = true; fields.push('mainAgentId');
    }

    if (!fields.length && !mainChanged) return this.snapshot();
    this.save();
    return this.emitChange({ added: [], removed: [], updated: [], mainChanged, fields });
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
    this.cfg.mainAgentId = created[mainIndex].id;
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

  addAgent(input: AgentInput): ConfigSnapshot {
    if (this.cfg.agents.length >= 10) throw new Error('Numero massimo di agenti raggiunto (10)');
    const a = this.makeAgent(input);
    this.cfg.agents.push(a);
    if (!this.cfg.mainAgentId) this.cfg.mainAgentId = a.id;
    this.save();
    return this.emitChange({ added: [a.id], removed: [], updated: [], mainChanged: false, fields: ['agents'] });
  }

  updateAgent(id: AgentId, patch: Partial<AgentInput>): ConfigSnapshot {
    const a = this.cfg.agents.find((x) => x.id === id);
    if (!a) throw new Error('Agente inesistente');
    const fields: string[] = [];
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) throw new Error('Il nome non può essere vuoto');
      if (this.cfg.agents.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) {
        throw new Error('Esiste già un agente con questo nome');
      }
      if (name !== a.name) { a.name = name; fields.push('name'); }
    }
    if (patch.model !== undefined) {
      const model = String(patch.model).trim() || DEFAULT_MODEL;
      if (model !== a.model) { a.model = model; fields.push('model'); }
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
    this.save();
    return this.emitChange({ added: [], removed: [], updated: [id], mainChanged: false, fields });
  }

  removeAgent(id: AgentId): ConfigSnapshot {
    if (this.cfg.agents.length <= 1) throw new Error('Deve restare almeno un agente');
    if (id === this.cfg.mainAgentId) throw new Error("Non puoi rimuovere l'agente principale");
    const i = this.cfg.agents.findIndex((a) => a.id === id);
    if (i < 0) throw new Error('Agente inesistente');
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
    return {
      id: newAgentId(),
      name,
      model: String(input?.model ?? '').trim() || DEFAULT_MODEL,
      prompt: String(input?.prompt ?? ''),
      color: normalizeColor(input?.color) ?? this.nextColor(siblings),
      maxIterations: clamp(Math.round(input?.maxIterations ?? DEFAULT_MAX_ITERATIONS), 1, 200),
      createdAt: Date.now(),
    };
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

/** Tolerant loader: unknown/broken fields fall back to defaults instead of crashing. */
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
      agents.push({
        id,
        name,
        model: str(a.model, DEFAULT_MODEL) as string,
        prompt: typeof a.prompt === 'string' ? a.prompt : '',
        color: normalizeColor(a.color) ?? PALETTE[agents.length % PALETTE.length],
        maxIterations: typeof a.maxIterations === 'number' ? clamp(Math.round(a.maxIterations), 1, 200) : DEFAULT_MAX_ITERATIONS,
        createdAt: typeof a.createdAt === 'number' ? a.createdAt : Date.now(),
      });
    }
  }
  const mainAgentId = typeof raw.mainAgentId === 'string' && agents.some((a) => a.id === raw.mainAgentId)
    ? raw.mainAgentId
    : (agents[0]?.id ?? null);
  const win = isRecord(raw.window) && typeof raw.window.width === 'number' && typeof raw.window.height === 'number'
    ? {
        width: raw.window.width,
        height: raw.window.height,
        ...(typeof raw.window.x === 'number' ? { x: raw.window.x } : {}),
        ...(typeof raw.window.y === 'number' ? { y: raw.window.y } : {}),
      }
    : undefined;
  return {
    version: 1,
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
    maxDelegationDepth: typeof raw.maxDelegationDepth === 'number' ? clamp(Math.round(raw.maxDelegationDepth), 1, 6) : 3,
    setupComplete: raw.setupComplete === true && agents.length > 0,
    ...(win ? { window: win } : {}),
  };
}
