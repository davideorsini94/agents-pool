# agents-pool v2 — Requirements: "4 roles, N instances" pool (2026-09-04)

Source: user's design brief (condensed, translated). All items are mandatory unless marked optional.

## 1. Roles instead of a fixed crowd
| Role | Instances | Runs when |
|---|---|---|
| Orchestrator | exactly 1 (the "main" agent; the only one talking to the user) | every request |
| Planner | 1, on demand | only broad/ambiguous objectives (T3) |
| Worker (generic or specialized: researcher, coder, analyst, writer…) | 1–5 per request, dynamic instances | the actual work |
| Verifier | 1, on demand | when ≥2 workers ran or output is critical |

The user configures role *templates* (name, role, prompt, model routing). Worker **instances** are spawned per TaskContract with a **fresh context** (no conversation history). Parallel instances of the same worker template must be possible.

## 2. Hard limits — enforced in CODE, not in prompts
- Fan-out: 3–5 parallel workers by default (configurable), **hard cap 8** per user request (total spawned workers, incl. corrections).
- Depth 2: orchestrator delegates; workers/planner/verifier **cannot delegate** (no delegation tools exposed to them).
- Exactly **1 correction round** after the verifier: a task may be re-run at most once with the verifier's feedback; a 2nd attempt is rejected by code.
- Per-task budget: `max_tokens` (prompt+completion of the instance), `max_tool_calls`, `max_seconds` — with kill → status `partial` + what was produced.
- **Zero-agent path (T0)**: conversational/factual requests are answered by the orchestrator alone with no delegation; must be the natural default (no extra classification call).

## 3. Interaction model
- **Hub-and-spoke only**: workers talk only to the orchestrator; never peer-to-peer.
- **Contracts, not prose**: worker sees only the TaskContract (never the conversation). Orchestrator receives a ResultContract.
```json
// TaskContract (orchestrator → worker)
{ "task_id": "t3", "role": "researcher|coder|analyst|writer|<worker template name>",
  "objective": "one self-contained sentence, no pronouns",
  "inputs": [{"type": "text", "content": "..."}, {"type": "artifact_ref", "id": "art_12"}, {"type": "file", "path": "relative/in/workspace"}],
  "constraints": ["..."], "deliverable": "expected format/schema", "acceptance": "one-line verifiable criterion",
  "side_effects": false, "budget": {"max_tokens": 8000, "max_tool_calls": 10, "max_seconds": 180} }
// ResultContract (worker → orchestrator)
{ "task_id": "t3", "status": "ok|blocked|partial", "result": "... or artifact_ref if large",
  "assumptions": ["..."], "unverified": ["..."], "blocking_question": null,
  "cost": {"tokens": 6100, "tool_calls": 4, "seconds": 41} }   // cost filled by the SYSTEM from real usage, never by the model
```
- **Blackboard** for large payloads: results above a size threshold are stored as artifacts (userData state, per user-request), messages carry only `artifact_ref` + short summary; orchestrator can `read_artifact`; artifacts can be passed as `inputs` to other workers (content inlined into the worker's contract by the system).
- **Parallel only for read-only, disjoint tasks**: tasks with `side_effects: true` are serialized (never two side-effect tasks concurrently); read-only ones run in parallel. Orchestrator must produce disjoint tasks; code rejects duplicate objectives / identical deliverables within a batch.
- **Model routing per role**: each template has `model` (primary), `fallbacks[]`, `escalation?` (used for T3 / critical). On **429 or model-unavailable errors the retry switches model** along the fallback chain (not the same model). 5xx/network errors keep the same model with backoff.
- `x-opencode-session`: **one session id per user request**, shared by the orchestrator call and all instances spawned for that request (prompt caching). Role system prompts must be **byte-identical between calls** (dynamic data goes into the user/contract message, not the system prompt).
- Log every TaskContract and ResultContract to a JSONL file (`userData/logs/contracts.jsonl`) for later manual review; expose "open contracts log" in settings.

## 4. Default role prompts (Italian, editable per template; "reset to default" available)
Orchestrator: sole speaker to the user; RULE ZERO: never does domain work itself → delegate. Per request: 1) classify tier T0 (answer alone) / T1 (1 worker) / T2 (2–4 parallel workers) / T3 (planner first, then execute plan) and state the tier; 2) decompose into disjoint tasks; 3) delegate with TaskContracts executable by someone who never read the conversation (no pronouns, no "as said above"); 4) synthesize a single answer, never paste raw outputs; 5) if the verifier flags a blocker, re-run the affected worker ONCE with the feedback. Budget: ≤5 workers, depth 2, 1 correction round; if over budget, deliver the best and state what is missing. If an ambiguity changes the result, ask the user ONE question before delegating.
Planner: receives a broad objective, produces an ordered task list (≤6) with objective, inputs, deliverable, one-line acceptance, dependencies (parallel vs sequential); merges tasks sharing an output; ends with assumptions and what would change if false.
Worker: executes exactly one TaskContract; no access to the conversation; if something essential is missing → `status="blocked"` with a precise question (never invent); scope = objective only; separates verified from inferred (→ assumptions/unverified); output = ResultContract JSON only.
Verifier: adversarial; does not improve, finds what is wrong. Receives original request, TaskContracts, outputs. Checks in order: answers the original request (not a convenient version), unsupported/invented facts, calculation/logic/code errors, ignored contract requirements, contradictions (internal or between workers). Output: findings with severity blocker/major/minor + required fix; if no blocker, say so in one line; never rewrites the output.

## 5. Model routing (OpenCode Go) — cost-first, verified 2026-09-04
Verified live: MiniMax/Qwen/MiMo/Hy3/LongCat/GLM/Kimi/DeepSeek work on `/chat/completions`; **grok-4.6, gpt-5.6-luna, muse-spark-* require `/responses`** (oa-compat → "not supported for format oa-compat" / 500). **muse-spark-1.3-contributor returns HTTP 403 `DataPolicyError`** until the user opts in at their OpenCode workspace page (link is in the error message); its prompts/completions train Meta models. Docs pricing/quotas per model (5-hour requests, monthly bucket): mimo-v2.5 $0.14/$0.28, $60, 30,100 · minimax-m3 $0.30/$1.20, $60, 3,200 · qwen3.7-plus $0.40/$1.60, $60, 4,300 · qwen3.8-flash $0.15/$0.47, $30, 5,400 · deepseek-v4-flash $0.22/$0.66, $30, 7,600 · deepseek-v4-pro $0.66/$1.98, $15, 1,050 · kimi-k2.7-code $0.95/$4, $60, 1,350 · glm-5.3-flash $0.15/$0.50, $15, 1,580 · glm-5.3 $1.40/$4.40, $15, 220 · glm-5.2 $1.40/$4.40, $60, 880 · hy3 $0.14/$0.58, $60, 4,300 · longcat-2.0 $0.30/$1.20, $60, 11,400 · kimi-k3 $3/$15, $15, 110 · muse-spark-1.3 $0.10/$0.20, $60, 45,300 (responses, opt-in) · grok-4.6 $2/$6, $15, 169 (responses, 30-day retention) · gpt-5.6-luna $0.20/$1.20, $15, 2,050 (responses, 30-day retention).
Privacy flags to show in the model picker: `training` (muse-spark-*), `retention_30d` (grok-4.6, gpt-5.6-luna), `zdr_verify` (deepseek-* — ZDR agreement listed as valid through 2026-08-31, confirm renewal), everything else `zdr`.

Default template (wizard "Pool consigliato"):
| Template | Role | Primary | Fallbacks | Escalation |
|---|---|---|---|---|
| Orchestratore | orchestrator | minimax-m3 | mimo-v2.5, qwen3.7-plus | glm-5.3 (T3 only) |
| Planner | planner | glm-5.3 | kimi-k2.7-code, minimax-m3 | — |
| Worker | worker (generic: coder/researcher/analyst/writer) | muse-spark-1.3-contributor (auto-skipped until opt-in) | deepseek-v4-flash, kimi-k2.7-code | deepseek-v4-pro |
| Worker Flash | worker (mechanical, wide fan-out) | mimo-v2.5 | glm-5.3-flash, hy3 | — |
| Verificatore | verifier | minimax-m3 | qwen3.7-plus | glm-5.3 (critical only) |
Unavailable models (403 DataPolicyError / ModelError) are remembered for the session and skipped directly (one toast with the opt-in link).

## 6. UI
- Consoles: one per template + **ephemeral consoles for parallel worker instances** (title "Worker · t3", template colour, auto-removed when the next user request starts or on close). Orchestrator console shows the tier badge (T0…T3), agents used, total cost; instance consoles show the TaskContract at start, budget usage (tokens / tool calls / seconds) and the ResultContract at the end; verifier findings rendered by severity.
- Settings/wizard: role selector per template, model routing editor (primary / fallbacks / escalation) with cost + privacy badges, temperature, per-task default budget, pool limits (max parallel workers ≤ 8, correction rounds = 1 read-only, depth = 2 read-only), "reset prompt to role default", "open contracts log".
- Hot reload semantics preserved (v1 §10).

## 7. Responses API adapter — verified stream shape (2026-09-04, `POST /zen/go/v1/responses`, gpt-5.6-luna + grok-4.6)
Request: `{ model, stream: true, max_output_tokens, instructions: <system>, input: [ {role:'user'|'assistant', content: string}, {type:'function_call', call_id, name, arguments}, {type:'function_call_output', call_id, output} ], tools: [ {type:'function', name, description, parameters} ] }` (note: tools are FLAT, not nested under `function`; system prompt goes in `instructions`; optional `reasoning: {effort}`, `temperature`).
SSE events (`event:` line + `data:` JSON with `type`): `response.created`, `response.in_progress`, `ping`, `response.output_item.added` (`item: {id, type:'function_call'|'reasoning'|'message', name?, call_id?, arguments:''}`), `response.function_call_arguments.delta` (`item_id, output_index, delta`), `response.function_call_arguments.done` (`arguments` full string), `response.output_text.delta` (`delta`) for assistant text, `response.reasoning_summary_part.added/done`, `response.reasoning_summary_text.delta` (`delta`) / `.done`, `response.output_item.done`, `response.completed` (`response.usage: {input_tokens, output_tokens, output_tokens_details.reasoning_tokens, input_tokens_details.cached_tokens}`, `response.output[]` final items), `response.failed`/`error`. Echo `reasoning` items back only if the API requires it (it does not for tool loops: send prior function_call + function_call_output items and assistant message text).
Model → format map (code, overridable in settings): `responses` for `grok-*`, `gpt-*`, `muse-spark-*`; everything else `chat/completions`. `hy3` streams reasoning in `delta.reasoning` (+ `reasoning_details`) instead of `reasoning_content` — already handled defensively.
