// Responses API adapter: request builder, history conversion, SSE event mapper, usage normalizer.
// PLAN-v2 §5, verified stream shape in REQUIREMENTS-v2 §7 (POST /zen/go/v1/responses).
//
// IMPORTANT: no 'electron' import and no *value* import from api.ts — this module is loaded by
// scripts/api-smoke.mjs in a plain Node process and api.ts imports it, so the only api.ts
// dependencies are erased `import type`s plus the `errorFromBody` function passed in by the caller.

import type { ChatMessage, Usage } from '../shared/types';
import type { StreamHandlers, StreamRequest, ToolDef } from './api';
import { emptyUsage, isRecord, logWarn } from './util';

// ---------------------------------------------------------------- request

/**
 * Responses body (REQUIREMENTS §7): system prompt in `instructions`, tools FLAT (no nested
 * `function` object), history as `input` items. No `reasoning` param is sent in v2.0 — the verified
 * stream produced summaries unrequested and echoing reasoning items back is not required for tool
 * loops (PLAN-v2 §5, §15).
 */
export function buildResponsesBody(req: StreamRequest): Record<string, unknown> {
  const systemText = req.messages.find((m) => m.role === 'system');
  const body: Record<string, unknown> = {
    model: req.model,
    stream: true,
    input: toResponsesInput(req.messages),
  };
  if (systemText && typeof systemText.content === 'string') body.instructions = systemText.content;
  if (req.tools && req.tools.length) {
    body.tools = req.tools.map((t: ToolDef) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    body.tool_choice = 'auto';
  }
  if (req.maxTokens !== undefined) body.max_output_tokens = req.maxTokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  return body;
}

/**
 * ChatMessage[] → Responses `input` items, order preserved (PLAN-v2 §5 table):
 *  - system    → dropped (already in `instructions`)
 *  - user      → { role:'user', content }
 *  - assistant → { role:'assistant', content } when non-empty, then one `function_call` per
 *                tool_call; `reasoning_content` is NEVER echoed back
 *  - tool      → { type:'function_call_output', call_id, output }
 * The adapter reports `item.call_id` as the tool call id, so v1 history already carries the id the
 * API expects to see again.
 */
export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content.length) out.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls ?? []) {
        out.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        });
      }
      continue;
    }
    // role 'tool'
    out.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
  }
  return out;
}

// ---------------------------------------------------------------- usage

/** `input_tokens`/`output_tokens` + the two details objects → the app's Usage (PLAN-v2 §5). */
export function normalizeResponsesUsage(raw: unknown, cost?: number): Usage {
  const u = emptyUsage();
  const r = isRecord(raw) ? raw : {};
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  u.promptTokens = n(r.input_tokens);
  u.completionTokens = n(r.output_tokens);
  const od = isRecord(r.output_tokens_details) ? r.output_tokens_details : null;
  const id = isRecord(r.input_tokens_details) ? r.input_tokens_details : null;
  u.reasoningTokens = od ? n(od.reasoning_tokens) : 0;
  u.cachedTokens = id ? n(id.cached_tokens) : 0;
  u.cost = cost ?? 0;
  u.calls = 1;
  return u;
}

// ---------------------------------------------------------------- SSE mapping

export interface ResponsesStreamState {
  /** item id → tool-call index (function_call items only). */
  byItem: Map<string, number>;
  /** tool-call index → accumulated argument JSON (for the `.done` reconciliation). */
  argsAcc: Map<number, string>;
  nextIndex: number;
  reasoningParts: number;
  finishReason: string | null;
  usage: Usage | null;
  cost: number | undefined;
  completed: boolean;
}

export function newResponsesState(): ResponsesStreamState {
  return {
    byItem: new Map(), argsAcc: new Map(), nextIndex: 0, reasoningParts: 0,
    finishReason: null, usage: null, cost: undefined, completed: false,
  };
}

type ErrorFromBody = (body: Record<string, unknown>, status: number) => Error;

/**
 * Maps one `data:` event onto StreamHandlers (PLAN-v2 §5 table). Returns the number of output
 * characters seen, so the caller can fall back to a char/4 estimate when no usage ever arrives.
 * Unknown `type`s are ignored on purpose: the gateway adds events over time.
 */
export function mapResponsesEvent(
  ev: Record<string, unknown>,
  st: ResponsesStreamState,
  h: StreamHandlers,
  errorFromBody: ErrorFromBody,
): number {
  const type = typeof ev.type === 'string' ? ev.type : '';
  let chars = 0;

  switch (type) {
    case 'response.output_item.added': {
      const item = isRecord(ev.item) ? ev.item : null;
      if (!item || item.type !== 'function_call') return 0;   // reasoning / message items: nothing to do
      const idx = indexOf(ev, item, st);
      const itemId = typeof item.id === 'string' ? item.id : '';
      if (itemId) st.byItem.set(itemId, idx);
      const args = typeof item.arguments === 'string' ? item.arguments : '';
      st.argsAcc.set(idx, args);
      const d: { index: number; id?: string; name?: string; args?: string } = { index: idx };
      if (typeof item.call_id === 'string' && item.call_id) d.id = item.call_id;
      if (typeof item.name === 'string' && item.name) d.name = item.name;
      if (args) { d.args = args; chars += args.length; }
      h.onToolCallDelta(d);
      return chars;
    }

    case 'response.function_call_arguments.delta': {
      const delta = typeof ev.delta === 'string' ? ev.delta : '';
      if (!delta) return 0;
      const idx = resolveIndex(ev, st);
      st.argsAcc.set(idx, (st.argsAcc.get(idx) ?? '') + delta);
      h.onToolCallDelta({ index: idx, args: delta });
      return delta.length;
    }

    case 'response.function_call_arguments.done': {
      const full = typeof ev.arguments === 'string' ? ev.arguments : '';
      const idx = resolveIndex(ev, st);
      const acc = st.argsAcc.get(idx) ?? '';
      if (!full) return 0;
      if (!acc) {
        st.argsAcc.set(idx, full);
        h.onToolCallDelta({ index: idx, args: full });
        return full.length;
      }
      if (full.startsWith(acc)) {
        const suffix = full.slice(acc.length);
        if (suffix) {
          st.argsAcc.set(idx, full);
          h.onToolCallDelta({ index: idx, args: suffix });
          return suffix.length;
        }
        return 0;
      }
      // Divergent: the accumulated deltas win (they are what the model actually streamed).
      logWarn(`responses: function_call_arguments.done disagrees with the deltas for index ${idx}`);
      return 0;
    }

    case 'response.output_text.delta': {
      const delta = typeof ev.delta === 'string' ? ev.delta : '';
      if (delta) { h.onText(delta); chars += delta.length; }
      return chars;
    }

    case 'response.reasoning_summary_part.added': {
      // Consecutive summary parts are separated by a blank line in the single reasoning stream.
      if (st.reasoningParts > 0) h.onReasoning('\n\n');
      st.reasoningParts += 1;
      return 0;
    }

    case 'response.reasoning_summary_text.delta': {
      const delta = typeof ev.delta === 'string' ? ev.delta : '';
      if (delta) { h.onReasoning(delta); chars += delta.length; }
      return chars;
    }

    case 'response.completed':
    case 'response.incomplete': {
      const resp = isRecord(ev.response) ? ev.response : null;
      const output = resp && Array.isArray(resp.output) ? resp.output : [];
      const hasCall = output.some((i) => isRecord(i) && i.type === 'function_call');
      st.finishReason = hasCall ? 'tool_calls' : (type === 'response.incomplete' ? 'length' : 'stop');
      const rawUsage = resp && isRecord(resp.usage) ? resp.usage : null;
      const cost = pickNum(ev.cost) ?? (rawUsage ? pickNum(rawUsage.cost) : undefined);
      if (cost !== undefined) st.cost = cost;
      st.usage = normalizeResponsesUsage(rawUsage, st.cost);
      st.completed = true;
      return 0;
    }

    case 'response.failed':
    case 'error': {
      const resp = isRecord(ev.response) ? ev.response : null;
      const err = (resp && isRecord(resp.error) ? resp.error : null) ?? (isRecord(ev.error) ? ev.error : null);
      throw errorFromBody({ error: err ?? { message: 'Responses stream failed' } }, 0);
    }

    default:
      return 0;   // response.created / in_progress / ping / *.part.done / output_item.done / unknown
  }
}

// ---------------------------------------------------------------- helpers

function indexOf(ev: Record<string, unknown>, item: Record<string, unknown>, st: ResponsesStreamState): number {
  const raw = typeof ev.output_index === 'number' ? ev.output_index
    : (typeof item.output_index === 'number' ? item.output_index : null);
  const idx = raw === null ? st.nextIndex : raw;
  st.nextIndex = Math.max(st.nextIndex, idx + 1);
  return idx;
}

function resolveIndex(ev: Record<string, unknown>, st: ResponsesStreamState): number {
  const itemId = typeof ev.item_id === 'string' ? ev.item_id : '';
  const known = itemId ? st.byItem.get(itemId) : undefined;
  if (known !== undefined) return known;
  const raw = typeof ev.output_index === 'number' ? ev.output_index : st.nextIndex;
  st.nextIndex = Math.max(st.nextIndex, raw + 1);
  if (itemId) st.byItem.set(itemId, raw);
  return raw;
}

function pickNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
