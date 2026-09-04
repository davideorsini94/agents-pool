// ConfigStore — owns config.json (the only place the API key lives). PLAN §2, §2.5, §10, §11.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeStorage } from 'electron';
import type {
  AgentConfig, AgentId, AgentInput, AgentView, AppConfig, ConfigChanged,
  ConfigPatch, ConfigSnapshot, PermissionMode, SetupPayload,
} from '../shared/types';
import {
  PALETTE, atomicWriteSync, isRecord, log, logWarn, maskKey, newAgentId, readJsonSync,
} from './util';

export { PALETTE };
export const DEFAULT_MODEL = 'deepseek-v4-flash';
export const PROBE_MODEL = 'glm-5.3-flash';
export const DEFAULT_MAX_ITERATIONS = 40;

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
