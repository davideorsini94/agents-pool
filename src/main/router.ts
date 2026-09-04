// ModelRouter: wire format per model, the fallback chain and the session-wide "unavailable" set.
// PLAN-v2 §4. IMPORTANT: no 'electron' import — scripts/api-smoke.mjs builds one directly.

import type { AgentConfig, AppConfig, ModelFormat } from '../shared/types';
import type { ApiError, ApiErrorType, ModelTable } from './api';
import { Send, log } from './util';

/** Model families that only answer on /responses (REQUIREMENTS §7, measured 2026-09-04). */
export const FORMAT_PREFIXES: Array<[RegExp, ModelFormat]> = [
  [/^grok-/, 'responses'],
  [/^gpt-/, 'responses'],
  [/^muse-spark-/, 'responses'],
];

export interface UnavailableEntry { reason: string; url?: string; type: ApiErrorType }

export interface RouterDeps {
  cfg: () => AppConfig;
  send: Send;
  modelTable?: ModelTable;
}

export interface Pick { model: string; format: ModelFormat; last: boolean }

export class ModelRouter {
  private readonly unavailable = new Map<string, UnavailableEntry>();

  constructor(private readonly deps: RouterDeps) {}

  /** cfg.modelFormats[model] → MODEL_TABLE → prefix map → 'chat'. Read live (hot reload §12). */
  formatOf(model: string): ModelFormat {
    const override = this.deps.cfg().modelFormats?.[model];
    if (override === 'chat' || override === 'responses') return override;
    const table = this.deps.modelTable?.[model]?.format;
    if (table) return table;
    for (const [re, fmt] of FORMAT_PREFIXES) if (re.test(model)) return fmt;
    return 'chat';
  }

  /**
   * `[escalation?, primary, ...fallbacks]` deduped, minus the models marked unavailable this
   * session. Never empty: when everything is marked we still try the primary (PLAN-v2 §4).
   */
  chain(t: AgentConfig, o: { escalate?: boolean } = {}): string[] {
    const raw = [
      ...(o.escalate && t.escalation ? [t.escalation] : []),
      t.model,
      ...(t.fallbacks ?? []),
    ];
    const seen = new Set<string>();
    const list: string[] = [];
    for (const m of raw) {
      const id = typeof m === 'string' ? m.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      list.push(id);
    }
    const live = list.filter((m) => !this.unavailable.has(m));
    if (live.length) return live;
    return list.length ? [list[0]] : [t.model];
  }

  pick(t: AgentConfig, attempt: number, o: { escalate?: boolean } = {}): Pick {
    const c = this.chain(t, o);
    const i = Math.min(Math.max(0, attempt), c.length - 1);
    const model = c[i];
    return { model, format: this.formatOf(model), last: i === c.length - 1 };
  }

  /** ModelError / DataPolicyError only; one toast per model per app session. */
  markUnavailable(model: string, err: ApiError): void {
    if (!model || this.unavailable.has(model)) return;
    const url = /https?:\/\/\S+/.exec(err.message)?.[0]?.replace(/[).,;'"]+$/, '');
    const entry: UnavailableEntry = { reason: err.message, type: err.type };
    if (url) entry.url = url;
    this.unavailable.set(model, entry);
    log(`router: ${model} marked unavailable for this session (${err.type})`);
    this.deps.send('app:toast', {
      level: 'warn',
      message: err.type === 'DataPolicyError'
        ? `Modello ${model} non disponibile finché non accetti la data policy nel workspace OpenCode`
        : `Modello ${model} non disponibile: ${err.message}`,
      ...(url ? { url } : {}),
    });
  }

  unavailableModels(): string[] { return [...this.unavailable.keys()]; }
  isUnavailable(model: string): boolean { return this.unavailable.has(model); }
  reasonFor(model: string): UnavailableEntry | undefined { return this.unavailable.get(model); }
  /** config:resetAll / key:clear: forget the session marks. */
  clear(): void { this.unavailable.clear(); }
}

/** Italian reason shown in the "Fallback: X → Y (motivo)" console line (PLAN-v2 §4). */
export function reasonIt(err: ApiError): string {
  switch (err.type) {
    case 'RateLimit': return 'limite di richieste';
    case 'ModelError': return 'modello non disponibile';
    case 'DataPolicyError': return 'data policy non accettata';
    default: return err.message;
  }
}

/** The three error types that make the router switch model instead of retrying the same one. */
export function isSwitchable(type: ApiErrorType): boolean {
  return type === 'RateLimit' || type === 'ModelError' || type === 'DataPolicyError';
}
