// OpenCodeClient — thin OpenAI-compatible client for the OpenCode Go gateway. PLAN §4, RESEARCH.md.
// IMPORTANT: no 'electron' import — scripts/api-smoke.mjs loads this file in a plain Node process.

import * as path from 'node:path';
import type {
  ChatMessage, KeyValidationResult, ModelFormat, ModelInfo, ModelPrivacy, Usage,
} from '../shared/types';
import { buildResponsesBody, mapResponsesEvent, newResponsesState, ResponsesStreamState } from './responses';
import {
  addUsage, atomicWrite, emptyUsage, isRecord, linkSignal, logWarn, readJson,
} from './util';

export const BASE_URL = 'https://opencode.ai/zen/go/v1';
export const MODELS_DEV_URL = 'https://models.dev/api.json';
export const PROBE_MODEL = 'glm-5.3-flash';
const DEFAULT_CONTEXT_LIMIT = 128000;
const IDLE_TIMEOUT_MS = 120000;
const MODELS_CACHE_TTL_MS = 24 * 3600 * 1000;

export type ApiErrorType =
  | 'AuthError' | 'ModelError' | 'DataPolicyError' | 'RateLimit' | 'Server' | 'Network' | 'Abort'
  | 'Protocol' | 'Unknown';

export class ApiError extends Error {
  readonly status: number;
  readonly type: ApiErrorType;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(type: ApiErrorType, message: string, status = 0, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.type = type;
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    this.retryable = type === 'RateLimit' || type === 'Server' || type === 'Network';
  }
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ToolCallDelta { index: number; id?: string; name?: string; args?: string }

export interface StreamHandlers {
  onReasoning(t: string): void;
  onText(t: string): void;
  onToolCallDelta(d: ToolCallDelta): void;
  onUsage(u: Partial<Usage>, cost?: number): void;
}

export interface StreamResult { finishReason: string | null; usage: Usage | null }

export interface StreamRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  sessionId: string;
  maxTokens?: number;
  /** Wire format of this model; default 'chat'. Chosen by ModelRouter (PLAN-v2 §4, §5). */
  format?: ModelFormat;
  temperature?: number;
  /** Silence tolerance for this call in ms — no SSE data at all for this long aborts it as a
   *  retryable Network error (§ idle watchdog). Defaults to IDLE_TIMEOUT_MS when omitted. */
  idleTimeoutMs?: number;
}

/**
 * One row of the static MODEL_TABLE (PLAN-v2 §11.3): measured facts models.dev does not carry.
 * Declared here (electron-free) and populated in config.ts, which injects it into OpenCodeClient
 * and ModelRouter so both stay loadable from scripts/api-smoke.mjs.
 */
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
export type ModelTable = Record<string, ModelTableEntry>;

interface ModelsCacheFile { fetchedAt: number; models: ModelInfo[] }

export class OpenCodeClient {
  private models: ModelInfo[] = [];
  private modelsFetchedAt = 0;
  private modelsById = new Map<string, ModelInfo>();
  private readonly cacheFile: string | null;
  private readonly modelTable: ModelTable;
  private inFlightModels: Promise<ModelInfo[]> | null = null;

  constructor(
    private readonly getKey: () => string | null,
    private readonly version: string,
    opts?: { cacheDir?: string; modelTable?: ModelTable },
  ) {
    this.cacheFile = opts?.cacheDir ? path.join(opts.cacheDir, 'models-cache.json') : null;
    this.modelTable = opts?.modelTable ?? {};
  }

  // ------------------------------------------------------------ headers

  private headers(sessionId: string | null, keyOverride?: string): Record<string, string> {
    const key = keyOverride ?? this.getKey();
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `agents-pool/${this.version}`,
    };
    if (key) h.Authorization = `Bearer ${key}`;
    if (sessionId) h['x-opencode-session'] = sessionId;
    return h;
  }

  // ------------------------------------------------------------ validateKey

  /** POST a 1-token completion on the cheapest model: the only endpoint that checks the key. */
  async validateKey(key: string): Promise<KeyValidationResult> {
    const trimmed = (key ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'auth', message: 'Chiave vuota' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(null, trimmed),
        body: JSON.stringify({
          model: PROBE_MODEL,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw await httpError(res);
      await res.text().catch(() => '');
      return { ok: true, masked: `sk-…${trimmed.slice(-4)}` };
    } catch (e) {
      const err = toApiError(e);
      return { ok: false, reason: reasonOf(err), message: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------ listModels

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (!refresh && this.models.length && Date.now() - this.modelsFetchedAt < MODELS_CACHE_TTL_MS) {
      return this.models;
    }
    if (!refresh && !this.models.length && this.cacheFile) {
      const cached = await readJson<ModelsCacheFile>(this.cacheFile);
      if (cached && Array.isArray(cached.models) && cached.models.length
        && Date.now() - (cached.fetchedAt ?? 0) < MODELS_CACHE_TTL_MS) {
        this.setModels(cached.models, cached.fetchedAt);
        return this.models;
      }
    }
    if (this.inFlightModels) return this.inFlightModels;
    this.inFlightModels = this.fetchModels().finally(() => { this.inFlightModels = null; });
    return this.inFlightModels;
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    const ids = await this.fetchModelIds();
    const meta = await fetchModelsDev();
    const list: ModelInfo[] = ids.map((id) => {
      const m = meta.get(id);
      return m ? { ...m, id } : { id, name: id };
    });
    list.sort((a, b) => a.id.localeCompare(b.id));
    this.setModels(list, Date.now());
    if (this.cacheFile) {
      await atomicWrite(this.cacheFile, JSON.stringify({ fetchedAt: this.modelsFetchedAt, models: list }))
        .catch((e) => logWarn('models cache write failed', e));
    }
    return this.models;
  }

  private async fetchModelIds(): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${BASE_URL}/models`, { headers: this.headers(null), signal: controller.signal });
      if (!res.ok) throw await httpError(res);
      const body = await res.json() as unknown;
      const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
      const ids: string[] = [];
      for (const m of data) {
        if (isRecord(m) && typeof m.id === 'string') ids.push(m.id);
        else if (typeof m === 'string') ids.push(m);
      }
      if (!ids.length) throw new ApiError('Protocol', 'Elenco modelli vuoto');
      return ids;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * MODEL_TABLE over models.dev (PLAN-v2 §1 api.ts): models.dev wins for price/context when it
   * has them, the table adds format/privacy/bucket/req-per-5h/jsonStrict/notes, and unknown ids
   * fall back to `chat` / `zdr` with no badges. Applied on every setModels() so a models-cache.json
   * written before the table existed still gets the badges.
   */
  private mergeTable(list: ModelInfo[]): ModelInfo[] {
    return list.map((m) => {
      const t = this.modelTable[m.id];
      const out: ModelInfo = { ...m, format: t?.format ?? 'chat', privacy: t?.privacy ?? 'zdr' };
      if (!t) return out;
      if (out.costIn === undefined && t.costIn !== undefined) out.costIn = t.costIn;
      if (out.costOut === undefined && t.costOut !== undefined) out.costOut = t.costOut;
      if (t.bucketUsd !== undefined) out.bucketUsd = t.bucketUsd;
      if (t.reqPer5h !== undefined) out.reqPer5h = t.reqPer5h;
      if (t.jsonStrict !== undefined) out.jsonStrict = t.jsonStrict;
      if (t.notes !== undefined) out.notes = t.notes;
      return out;
    });
  }

  private setModels(list: ModelInfo[], fetchedAt: number): void {
    this.models = this.mergeTable(list);
    this.modelsFetchedAt = fetchedAt;
    this.modelsById = new Map(this.models.map((m) => [m.id, m]));
  }

  /** Format hint from the static table only (the router adds prefixes and user overrides). */
  tableFormat(model: string): ModelFormat | undefined { return this.modelTable[model]?.format; }

  modelInfo(id: string): ModelInfo | undefined { return this.modelsById.get(id); }

  contextLimit(model: string): number {
    return this.modelsById.get(model)?.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  }

  /** Cost in dollars from cached models.dev prices (per million tokens). */
  estimateCost(model: string, promptTokens: number, completionTokens: number): number {
    const m = this.modelsById.get(model);
    if (!m) return 0;
    const inCost = ((m.costIn ?? 0) * promptTokens) / 1e6;
    const outCost = ((m.costOut ?? 0) * completionTokens) / 1e6;
    return inCost + outCost;
  }

  // ------------------------------------------------------------ streamChat

  /** Single entry point for both wire formats (PLAN-v2 §5 "Dispatch"). */
  async streamChat(req: StreamRequest, h: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    return req.format === 'responses'
      ? this.streamResponses(req, h, signal)
      : this.streamChatCompletions(req, h, signal);
  }

  private async streamChatCompletions(req: StreamRequest, h: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    const { controller, dispose } = linkSignal(signal);
    const sse: SseState = { sawDone: false, idleTimedOut: false };

    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools && req.tools.length) { body.tools = req.tools; body.tool_choice = 'auto'; }

    let finishReason: string | null = null;
    let rawUsage: Record<string, unknown> | null = null;
    let cost: number | undefined;
    let promptChars = 0;
    let outChars = 0;
    for (const m of req.messages) if (typeof m.content === 'string') promptChars += m.content.length;

    try {
      const res = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: this.headers(req.sessionId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw await httpError(res);
      if (!res.body) throw new ApiError('Protocol', 'Risposta senza corpo');

      await readSse(res, controller, sse, req.idleTimeoutMs ?? IDLE_TIMEOUT_MS, (payload) => {
        let ev: unknown;
        try {
          ev = JSON.parse(payload);
        } catch {
          return 'continue'; // ignore unparseable keep-alive noise
        }
        if (!isRecord(ev)) return 'continue';
        if (isRecord(ev.error)) throw errorFromBody(ev, 0);

        const choices = Array.isArray(ev.choices) ? ev.choices : [];
        const first = choices.length && isRecord(choices[0]) ? choices[0] as Record<string, unknown> : null;
        if (first) {
          if (typeof first.finish_reason === 'string') finishReason = first.finish_reason;
          const delta = isRecord(first.delta) ? first.delta : null;
          if (delta) {
            const reasoning = pickString(delta.reasoning_content) ?? pickString(delta.reasoning);
            if (reasoning) { outChars += reasoning.length; h.onReasoning(reasoning); }
            const content = pickString(delta.content);
            if (content) { outChars += content.length; h.onText(content); }
            if (Array.isArray(delta.tool_calls)) {
              for (let i = 0; i < delta.tool_calls.length; i++) {
                const raw = delta.tool_calls[i];
                if (!isRecord(raw)) continue;
                const fn = isRecord(raw.function) ? raw.function : null;
                const d: ToolCallDelta = {
                  index: typeof raw.index === 'number' ? raw.index : i,
                };
                if (typeof raw.id === 'string' && raw.id) d.id = raw.id;
                if (fn && typeof fn.name === 'string' && fn.name) d.name = fn.name;
                if (fn && typeof fn.arguments === 'string' && fn.arguments) d.args = fn.arguments;
                if (d.args) outChars += d.args.length;
                h.onToolCallDelta(d);
              }
            }
          }
        }
        if (isRecord(ev.usage)) rawUsage = ev.usage;
        cost = pickCost(ev.cost)
          ?? (isRecord(ev.usage) ? pickCost((ev.usage as Record<string, unknown>).cost) : undefined)
          ?? cost;
        return (sse.sawDone && rawUsage && cost !== undefined) ? 'stop' : 'continue';
      });
    } catch (e) {
      if (sse.idleTimedOut) throw new ApiError('Network', `Nessuna risposta dal modello per ${Math.round((req.idleTimeoutMs ?? IDLE_TIMEOUT_MS) / 1000)} secondi`);
      const err = toApiError(e);
      // An abort we caused ourselves while waiting for the post-[DONE] cost chunk is not an error.
      if (!(sse.sawDone && err.type === 'Abort' && !signal.aborted)) throw err;
    } finally {
      dispose();
    }

    // Usage is reported once, complete with cost (PLAN §4 reports it per usage chunk; the
    // gateway splits tokens and cost across two chunks, so a single call avoids double counting).
    let usage: Usage;
    if (rawUsage) {
      usage = normalizeUsage(rawUsage, cost);
    } else {
      usage = emptyUsage();
      usage.promptTokens = Math.ceil(promptChars / 4);
      usage.completionTokens = Math.ceil(outChars / 4);
      usage.cost = cost ?? this.estimateCost(req.model, usage.promptTokens, usage.completionTokens);
      usage.calls = 1;
      usage.estimated = true;
    }
    h.onUsage(usage);
    return { finishReason, usage };
  }

  // ------------------------------------------------------------ streamResponses

  /** POST /responses with the same StreamHandlers contract (PLAN-v2 §5, REQUIREMENTS §7). */
  private async streamResponses(req: StreamRequest, h: StreamHandlers, signal: AbortSignal): Promise<StreamResult> {
    const { controller, dispose } = linkSignal(signal);
    const sse: SseState = { sawDone: false, idleTimedOut: false };
    const st: ResponsesStreamState = newResponsesState();
    let promptChars = 0;
    let outChars = 0;
    for (const m of req.messages) if (typeof m.content === 'string') promptChars += m.content.length;

    try {
      const res = await fetch(`${BASE_URL}/responses`, {
        method: 'POST',
        headers: this.headers(req.sessionId),
        body: JSON.stringify(buildResponsesBody(req)),
        signal: controller.signal,
      });
      if (!res.ok) throw await httpError(res);
      if (!res.body) throw new ApiError('Protocol', 'Risposta senza corpo');

      await readSse(res, controller, sse, req.idleTimeoutMs ?? IDLE_TIMEOUT_MS, (payload) => {
        let ev: unknown;
        try {
          ev = JSON.parse(payload);
        } catch {
          return 'continue';
        }
        if (!isRecord(ev)) return 'continue';
        const chars = mapResponsesEvent(ev, st, h, errorFromBody);
        outChars += chars;
        return st.completed ? 'stop' : 'continue';
      });
    } catch (e) {
      if (sse.idleTimedOut) throw new ApiError('Network', `Nessuna risposta dal modello per ${Math.round((req.idleTimeoutMs ?? IDLE_TIMEOUT_MS) / 1000)} secondi`);
      const err = toApiError(e);
      if (!(st.completed && err.type === 'Abort' && !signal.aborted)) throw err;
    } finally {
      dispose();
    }

    let usage: Usage;
    if (st.usage) {
      usage = st.usage;
      if (st.cost !== undefined) usage.cost = st.cost;
      else if (!usage.cost) {
        usage.cost = this.estimateCost(req.model, usage.promptTokens, usage.completionTokens);
        usage.estimated = true;
      }
    } else {
      usage = emptyUsage();
      usage.promptTokens = Math.ceil(promptChars / 4);
      usage.completionTokens = Math.ceil(outChars / 4);
      usage.cost = st.cost ?? this.estimateCost(req.model, usage.promptTokens, usage.completionTokens);
      usage.calls = 1;
      usage.estimated = true;
    }
    h.onUsage(usage);
    return { finishReason: st.finishReason, usage };
  }
}

// ---------------------------------------------------------------- SSE reader

export type SseDisposition = 'continue' | 'stop';
export interface SseState { sawDone: boolean; idleTimedOut: boolean }

/**
 * Shared SSE loop for both formats (PLAN-v2 §5): line buffering across chunk boundaries, a 120 s
 * idle watchdog, and the gateway's habit of emitting `{"choices":[],"cost":"…"}` AFTER
 * `data: [DONE]` (so `[DONE]` only arms a 2 s cap instead of ending the loop). `onData` receives
 * every non-empty `data:` payload except `[DONE]` and decides when to stop; `event:` lines are
 * ignored (the payload carries its own `type`).
 */
export async function readSse(
  res: Response,
  controller: AbortController,
  state: SseState,
  idleMs: number,
  onData: (payload: string) => SseDisposition,
): Promise<void> {
  let idleTimer: NodeJS.Timeout | null = null;
  let postDoneTimer: NodeJS.Timeout | null = null;
  const bumpIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { state.idleTimedOut = true; controller.abort(); }, idleMs);
  };
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    bumpIdle();
    readLoop: for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bumpIdle();
      buffer += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') {
          state.sawDone = true;
          if (!postDoneTimer) postDoneTimer = setTimeout(() => controller.abort(), 2000);
          continue;
        }
        if (onData(payload) === 'stop') break readLoop;
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (postDoneTimer) clearTimeout(postDoneTimer);
    // The responses branch stops on `response.completed` without an abort: release the socket.
    // `void` only swallows a SYNCHRONOUS throw; cancel() on a reader whose stream is already
    // errored (e.g. we just errored it ourselves via an abort listener) rejects ASYNCHRONOUSLY, and
    // an unhandled rejection crashes the whole process — so the promise itself needs its own catch.
    try { reader.cancel().catch(() => { /* already closed/errored */ }); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------- helpers

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.length ? v : null;
}

export function pickCost(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function normalizeUsage(raw: Record<string, unknown>, cost?: number): Usage {
  const u = emptyUsage();
  u.promptTokens = num(raw.prompt_tokens);
  u.completionTokens = num(raw.completion_tokens);
  const pd = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : null;
  const cd = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : null;
  u.cachedTokens = pd ? num(pd.cached_tokens) : 0;
  u.reasoningTokens = cd ? num(cd.reasoning_tokens) : 0;
  u.cost = cost ?? 0;
  u.calls = 1;
  return u;
}

async function httpError(res: Response): Promise<ApiError> {
  let bodyText = '';
  try { bodyText = await res.text(); } catch { /* ignore */ }
  let parsed: unknown = null;
  try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { /* not json */ }
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  if (isRecord(parsed)) return errorFromBody(parsed, res.status, retryAfter, bodyText);
  return mapStatus(res.status, bodyText || res.statusText || `HTTP ${res.status}`, retryAfter);
}

/** Exported for responses.ts, which maps `response.failed` / `error` events through it. */
export function errorFromBody(body: Record<string, unknown>, status: number, retryAfter?: number, fallback = ''): ApiError {
  const err = isRecord(body.error) ? body.error : null;
  const type = err && typeof err.type === 'string' ? err.type : '';
  const message = (err && typeof err.message === 'string' && err.message) || fallback || 'Errore API';
  // Data-policy opt-in (muse-spark-*): HTTP 403 with the workspace URL in the message (PLAN-v2 §5).
  if (type === 'DataPolicyError' || /data ?policy/i.test(type) || (!type && /data ?policy/i.test(message))) {
    return new ApiError('DataPolicyError', message, status || 403);
  }
  if (type === 'AuthError') return new ApiError('AuthError', message, status || 401);
  if (type === 'ModelError') return new ApiError('ModelError', message, status || 401);
  if (type === 'RateLimit' || type === 'RateLimitError') {
    return new ApiError('RateLimit', message, status || 429, retryAfter ?? 20000);
  }
  if (status) return mapStatus(status, message, retryAfter);
  return new ApiError('Protocol', message, 0);
}

function mapStatus(status: number, message: string, retryAfter?: number): ApiError {
  if (status === 401 || status === 403) return new ApiError('AuthError', message, status);
  if (status === 429) return new ApiError('RateLimit', message, status, retryAfter ?? 20000);
  // The gateway answers 500 "not supported for format oa-compat" when a /responses-only model is
  // called on /chat/completions: a model problem, so the router switches model instead of retrying.
  if (status >= 500 && /not supported for format/i.test(message)) return new ApiError('ModelError', message, status);
  if (status >= 500) return new ApiError('Server', message, status, retryAfter);
  return new ApiError('Unknown', message, status);
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number.parseFloat(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(v);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof Error) {
    if (e.name === 'AbortError') return new ApiError('Abort', 'Operazione annullata');
    const msg = e.message || e.name;
    if (e.name === 'TypeError' || /fetch failed|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|socket hang up|network/i.test(msg)) {
      const cause = (e as { cause?: unknown }).cause;
      const detail = cause instanceof Error ? `: ${cause.message}` : '';
      return new ApiError('Network', `Errore di rete${detail}`);
    }
    return new ApiError('Unknown', msg);
  }
  return new ApiError('Unknown', String(e));
}

export function reasonOf(e: ApiError): 'auth' | 'network' | 'model' | 'rate_limit' | 'unknown' {
  switch (e.type) {
    case 'AuthError': return 'auth';
    case 'Network': return 'network';
    case 'ModelError': return 'model';
    case 'DataPolicyError': return 'model';
    case 'RateLimit': return 'rate_limit';
    default: return 'unknown';
  }
}

/** Optional metadata enrichment; failures are silent (PLAN §4). */
async function fetchModelsDev(): Promise<Map<string, ModelInfo>> {
  const out = new Map<string, ModelInfo>();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: controller.signal });
    if (!res.ok) return out;
    const body = await res.json() as unknown;
    if (!isRecord(body)) return out;
    const provider = isRecord(body['opencode-go']) ? body['opencode-go'] : null;
    const models = provider && isRecord(provider.models) ? provider.models : null;
    if (!models) return out;
    for (const [id, m] of Object.entries(models)) {
      if (!isRecord(m)) continue;
      const cost = isRecord(m.cost) ? m.cost : null;
      const limit = isRecord(m.limit) ? m.limit : null;
      const info: ModelInfo = { id, name: typeof m.name === 'string' && m.name ? m.name : id };
      if (cost && typeof cost.input === 'number') info.costIn = cost.input;
      if (cost && typeof cost.output === 'number') info.costOut = cost.output;
      if (limit && typeof limit.context === 'number') info.contextLimit = limit.context;
      if (typeof m.reasoning === 'boolean') info.reasoning = m.reasoning;
      if (typeof m.tool_call === 'boolean') info.toolCall = m.tool_call;
      out.set(id, info);
    }
  } catch {
    // offline / unreachable — raw ids are fine
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/** Re-exported for the agent loop's usage bookkeeping. */
export { addUsage };
