# Agents Pool v2 — Delta Plan: "4 roles, N instances"

Delta over `docs/PLAN.md` (v1, shipped) implementing `docs/REQUIREMENTS-v2.md` in full. Everything not mentioned here keeps v1 behaviour and code
(permissions modal flow, key screen, path sandbox, command classifier, persistence, app:// scheme, hot reload mechanics). Electron 44 + plain `tsc`,
zero runtime deps, no bundler. UI strings Italian, code/comments English, **role prompts Italian** (req §4). Line refs point at current v1 sources.

---

## 0. Key decisions

| Topic | Decision |
|---|---|
| Pool shape is configuration, not structure | **Any number of templates, any mix of roles** (0..n planners, 0..n verifiers, n worker specializations); v1 `config:addAgent/updateAgent/removeAgent` semantics preserved, the v1 cap of 10 agents removed. The **only invariant is exactly one orchestrator** (= `mainAgentId`, the agent the user talks to); promoting another template to orchestrator demotes the previous one to `worker`. "4 roles / 5 templates" is just the wizard preset "Pool consigliato". |
| Templates vs instances | `agents[]` stays and becomes **role templates** (`role`, routing, budget, `maxConcurrent`). The orchestrator template runs as the v1 persistent `AgentRuntime` (history kept). Planner/worker/verifier runs are **stateless instances**: a throw-away `AgentRuntime` in *instance mode* (in-memory history, one task, fresh messages) created per TaskContract/planner call/verifier call. |
| Tool exposure follows the live pool | `toolDefsFor(role, cfg, roster)` is computed **every iteration**: `run_planner`/`run_verifier` appear only while ≥1 template of that role exists (optional `template` argument picks one; default = first of that role in config order); `delegate_tasks` appears on workers only when `cfg.allowWorkerDelegation`. Missing tools never stall a run: the orchestrator prompt says how to proceed without them. |
| Where instances render | Worker instances get **ephemeral consoles** `"<templateId>#<taskId>[-r2]"` announced with two new events `console:add`/`console:remove` (AgentView flagged `ephemeral:true`). Planner and verifier instances (never concurrent: orchestrator tool calls are sequential) write into their **template console** (fresh history each run). Worker template consoles only receive `info` lines ("Istanza t3 avviata…/completata…") so a trace survives restarts. |
| Depth 2 by default, editable | Default `allowWorkerDelegation:false` → only the orchestrator has `delegate_tasks`/`run_planner`/`run_verifier`; workers get the v1 tools minus delegation/`list_agents`/`ask_user`; planner+verifier read-only. Hub-and-spoke is then structural. When the user turns `allowWorkerDelegation` on, workers also get `delegate_tasks`, bounded by `cfg.maxDepth` (default 2) and the v1 ancestry/cycle checks (`orchestrator.ts` L154-163 reused). v1 `maxDelegationDepth` is replaced by `maxDepth`. |
| Orchestrator file tools | Orchestrator gets **read-only** `read_file`/`list_directory` (no writes, no commands): a T0 factual question about the workspace ("che file ci sono?") must not cost a worker spawn, reads are side-effect free, and RULE ZERO in the prompt limits them to lookups. |
| Caps in code, values from config | `pool.ts` enforces, reading **live** `AppConfig` (no literal 4/8/1 in the algorithms): tasks/batch ≤ `cfg.maxParallelWorkers`; instances/request ≤ `cfg.maxWorkersPerRequest` (planner/verifier count too); corrections per task_id ≤ `cfg.correctionRounds` and only after `run_verifier` (a `blocked` continuation is allowed once regardless); duplicate objective/deliverable → error tool result; planner >6 tasks → truncated; per-instance budget kill → `partial`. Defaults (4 / 8 / 1 / depth 2) reproduce the lead's design; higher values are reachable only by the user in Settings, with inline warnings above the recommended range. |
| Byte-identical system prompts | `buildRolePrompt(template, cfg, roster, env)` has **no date / no per-request data**. Orchestrator: role prompt + fixed rules + Pool roster + Limits + Environment + user notes (changes only on config edit — accepted). Instances: role prompt + fixed rules only; environment + contract + inlined inputs go in the single user message. |
| Session header | `x-opencode-session = requestId` (= orchestrator runId of the user turn) for the orchestrator call and every instance of that request. `AgentState.sessionId` stays on disk but is no longer sent. |
| Routing | `ModelRouter.pick(template, attempt, {escalate})` over `[escalation?, primary, ...fallbacks]` minus session-unavailable models. 429 / `ModelError` / `DataPolicyError` (new 403 type) → next model + `info` "Fallback: X → Y (motivo)"; 5xx/network → v1 same-model backoff. |
| API formats | `api.ts` dispatches on `ModelFormat` (`'chat'|'responses'`): prefix map `grok-*`, `gpt-*`, `muse-spark-*` → responses, overridable by `cfg.modelFormats`. New `responses.ts` converts history ↔ Responses `input` items and maps SSE events onto the same `StreamHandlers`. |
| Result handling | `parseResultContract`: strict JSON → first balanced `{…}` → wrap free text as `partial`. `cost` always overwritten from real usage. Results > `artifactThresholdChars` (4000) go to the blackboard (`state/artifacts/<requestId>/<artId>.json`) and are replaced by `{artifact_ref, summary, chars}`. |
| Persistence | Orchestrator history/console as v1. Ephemeral console logs are in-memory only (dropped on removal). The orchestrator's `delegation` card carries `taskId/tier/contract/result` so it stays meaningful after restart. Contracts log `userData/logs/contracts.jsonl`. |
| Events | Extend `task_start`, `task_end`, `delegation`, `llm_call` with optional fields; add one new kind `verdict` (verifier findings by severity). `task_end.status`/`TaskResult.status` gain `'partial'`. |
| `interactionPrompt` | Kept, renamed in UI "Indicazioni per l'orchestratore": appended only to the orchestrator system prompt. Workers never see it (contracts only). |

---

## 1. File-level change list

| File | Action | What changes | ~lines |
|---|---|---|---|
| `src/shared/types.d.ts` | extend | §2 delta: roles, routing, budget, contracts, pool limits, events, IPC | +150 / −6 |
| `src/main/util.ts` | extend | `Semaphore` (acquire/release), `normalizeKey(s)` (lowercase, collapse ws, strip punctuation), `appendLine(file, text)` with 20 MB rotate, `Mutex` | +60 |
| `src/main/api.ts` | extend | `ApiErrorType` + `'DataPolicyError'` (403 body type or `/DataPolicy/i`); 5xx whose message matches `/not supported for format/i` → `ModelError`; `StreamRequest` gains `format`, `temperature`; `streamChat()` splits into `readSse(res, onData, signal)` (v1 loop, idle watchdog, post-[DONE] cost wait) + `streamChatCompletions` + dispatch to `streamResponses`; `listModels()` merges the injected `opts.modelTable` (static table from `config.ts`, §11.3: format, privacy, bucketUsd, reqPer5h, jsonStrict, notes) over models.dev data (unknown ids → `chat`/`zdr`/no badges); `estimateCost` unchanged | +120 / −40 |
| `src/main/responses.ts` | **new** | Responses API adapter: body builder, history→input conversion, SSE event mapper, usage normalizer (electron-free, smoke-testable) | ~220 |
| `src/main/router.ts` | **new** | `ModelRouter`: formats (prefix map + injected `modelTable.format` + `cfg.modelFormats`), chain, pick, unavailable set, opt-in link parsing, one toast per model | ~120 |
| `src/main/contracts.ts` | **new** | TS types, `validateTaskContract`, `validateBatch`, `parseResultContract`, `parsePlan`, `parseVerdict`, `ContractsLog` | ~260 |
| `src/main/artifacts.ts` | **new** | `ArtifactStore`: put/get/inline, per-request dir, global index, prune (keep 20 requests) | ~140 |
| `src/main/pool.ts` | **new** | `InstancePool`: `RequestCtx`, `delegateTasks` (caller may be the orchestrator or, when `allowWorkerDelegation`, a worker instance: depth/ancestry checks), `runPlanner`, `runVerifier`, `readArtifact`, scheduler, budget, ephemeral console lifecycle, cancel cascade — every limit read from live `cfg` | ~440 |
| `src/main/prompt.ts` | replace | `DEFAULT_PROMPTS[role]`, `buildRolePrompt`, `buildContractMessage`, `buildPlannerMessage`, `buildVerifierMessage` (v1 `buildSystemPrompt` removed) | ~230 |
| `src/main/tools.ts` | extend | `toolDefsFor(role, cfg, roster, depth)` / `toolNamesFor(...)` (dynamic: planner/verifier tools only if such templates exist, worker delegation only if enabled, `tasks.maxItems = cfg.maxParallelWorkers`); new executors `delegate_tasks`, `run_planner`, `run_verifier`, `read_artifact` calling `ctx.orchestrator`; remove `delegate_task`, `list_agents`; `OrchestratorApi` re-shaped | +170 / −50 |
| `src/main/agent.ts` | extend | instance mode (`AgentRuntimeOpts`), router-driven model pick + fallback loop, budget enforcement, `partial`, `requestId` session header, `toolDefsFor(role)`, `maxTokens/temperature`, sequential tool groups, `MODEL_OUTPUT_CAP` 32 k for pool tools | +170 / −40 |
| `src/main/orchestrator.ts` | extend | owns `InstancePool`; `userMessage` → `RequestCtx`; `registerRun` (user run) clears previous ephemeral consoles; `applyConfig` handles role/removed templates with live instances; `cancelAll/cancelAgent/cancelRun` include instances; `snapshot().instances/unavailableModels/tier`; `delegate()` removed | +150 / −90 |
| `src/main/config.ts` | extend | `version:2` migration, pool fields (`maxParallelWorkers`, `maxWorkersPerRequest`, `correctionRounds`, `maxDepth`, `allowWorkerDelegation`, `artifactThresholdChars`, `modelFormats`) with `POOL_RANGES` clamps, per-template `maxConcurrent`, role invariant (exactly one orchestrator = main; promotion demotes), removal of the 10-agent cap (L251), `DEFAULT_BUDGET`, presets `RECOMMENDED_POOL` / `ECONOMY_POOL` / `EMPTY_POOL`, static `MODEL_TABLE` (§11.3 measured facts), `defaultPrompt(role)` | +240 / −12 |
| `src/main/state.ts` | extend | ephemeral entries (`id.includes('#')`: no disk I/O, `drop(id)`), `flushAll` skips them | +40 |
| `src/main/ipc.ts`, `preload.ts` | extend | channels `config:defaultPrompt`, `instance:close`, `logs:openContracts`, `shell:openExternal`; events `console:add`, `console:remove` | +55 |
| `src/main/main.ts` | extend | construct `ModelRouter`, `ArtifactStore`, `ContractsLog`; inject `MODEL_TABLE` into `OpenCodeClient` and `ModelRouter` (both stay electron-free); pass to orchestrator; `appInfo.poolRanges/recommendedPool/economyPool/emptyPool` | +30 |
| `src/renderer/dom.ts` | extend | `modelLabel` + `privacyBadge(m)`, `formatBadge(m)`, `fmtBudget(u, b, s)` | +45 |
| `src/renderer/console.ts` | extend | render `verdict`; extended `task_start/task_end/delegation/llm_call`; header tier badge (orchestrator), budget line + close button (ephemeral), `partial` status | +190 |
| `src/renderer/workbench.ts` | extend | `instances: Map`, `onConsoleAdd/Remove`, ordering + auto-collapse, `applyRuntime(instances)`, tier on `run:finished` | +120 |
| `src/renderer/settings.ts` | extend | role selector, routing editor, temperature, budget, `maxConcurrent`, **editable Pool section** (all limits with ranges from `AppInfo.poolRanges` + inline warnings above the recommended range, `allowWorkerDelegation` toggle revealing `maxDepth`), "Ripristina prompt del ruolo", "Apri log contratti" | +250 / −20 |
| `src/renderer/wizard.ts` | extend | preset buttons "Pool consigliato" (5 templates) / "Vuoto" (1 orchestrator), unrestricted add/remove/duplicate of cards (no slot count, v1 "max 10" removed), role + routing per card, step 3 = orchestrator radio + notes | +180 / −30 |
| `src/renderer/index.ts` | extend | 2 subscriptions | +4 |
| `src/renderer/styles.css` | extend | ephemeral console, tier badge, verdict severities, budget line, routing editor chips | +90 |
| `scripts/api-smoke.mjs` | extend | §13: Responses offline parser + live call, router, contracts, scheduler with fake model | +230 |
| `scripts/e2e-smoke.mjs` | replace | §13 scenario list (T0, T2 fan-out, caps, fallback, hot reload, permission) | ~330 |

---

## 2. `types.d.ts` delta

Additive unless marked **BREAKING**. Existing lines referenced as `L<n>`.

```ts
// ---------- roles / routing / budget (new) ----------
export type AgentRole = 'orchestrator' | 'planner' | 'worker' | 'verifier';
export type ModelFormat = 'chat' | 'responses';
export type Tier = 'T0' | 'T1' | 'T2' | 'T3';
export type ModelPrivacy = 'zdr' | 'zdr_verify' | 'retention_30d' | 'training';
export interface Budget { maxTokens: number; maxToolCalls: number; maxSeconds: number }
export interface Range { min: number; max: number; default: number; recommendedMax: number }   // UI warns above recommendedMax
export interface PoolRanges { maxParallelWorkers: Range; maxWorkersPerRequest: Range; correctionRounds: Range; maxDepth: Range; artifactThresholdChars: Range }

export interface AgentConfig {                 // L23: add
  id: AgentId; name: string; model: string; prompt: string; color: string; maxIterations: number; createdAt: number;
  role: AgentRole; fallbacks: string[]; escalation?: string; temperature?: number; budget?: Budget;
  maxConcurrent?: number;                      // parallel instances of THIS template (default = cfg.maxParallelWorkers)
}
export interface AgentInput {                  // L28: add optional fields (null = clear)
  name: string; model: string; prompt: string; color?: string; maxIterations?: number;
  role?: AgentRole; fallbacks?: string[]; escalation?: string | null; temperature?: number | null; budget?: Budget | null; maxConcurrent?: number | null;
}
export interface AppConfig {                   // L29 — pool limits are SETTINGS (defaults = lead's design; ranges in §11.3 POOL_RANGES)
  version: 2;                                  // BREAKING: was 1 (migration §11)
  /* …v1 fields unchanged… */                  // maxDelegationDepth REMOVED (BREAKING) → maxDepth
  maxParallelWorkers: number;                  // default 4,  1..16  (tasks per delegate_tasks batch / global instance semaphore)
  maxWorkersPerRequest: number;                // default 8,  1..32  (instances per user request, incl. planner/verifier/corrections)
  correctionRounds: number;                    // default 1,  0..3   (re-runs of a task_id after run_verifier)
  allowWorkerDelegation: boolean;              // default false      (false → hub-and-spoke, depth exactly 2)
  maxDepth: number;                            // default 2,  2..4   (used only when allowWorkerDelegation)
  artifactThresholdChars: number;              // default 4000, 1000..20000
  modelFormats: Record<string, ModelFormat>;   // overrides of the prefix map
}
export interface AgentView extends AgentConfig {           // L45: add
  description: string; isMain: boolean;
  ephemeral?: true; parentId?: AgentId; taskId?: string; objective?: string; requestId?: string;
}
export interface ConfigSnapshot {              // L46: add / remove
  /* …v1 minus maxDelegationDepth… */ maxParallelWorkers: number; maxWorkersPerRequest: number; correctionRounds: number;
  allowWorkerDelegation: boolean; maxDepth: number; artifactThresholdChars: number; modelFormats: Record<string, ModelFormat>;
}
export type ConfigPatch = Partial<Pick<AppConfig,'workspacePath'|'interactionPrompt'|'permissionMode'|'commandAllowlist'|'showReasoning'|'permissionTimeoutMs'
  |'mainAgentId'|'maxParallelWorkers'|'maxWorkersPerRequest'|'correctionRounds'|'allowWorkerDelegation'|'maxDepth'|'artifactThresholdChars'|'modelFormats'>>;   // BREAKING: maxDelegationDepth gone
export interface AppInfo { /* v1 */ poolRanges: PoolRanges; recommendedPool: AgentInput[]; emptyPool: AgentInput[]; defaultBudget: Budget }
export interface ModelInfo { id: string; name: string; costIn?: number; costOut?: number; contextLimit?: number; reasoning?: boolean; toolCall?: boolean;
  format: ModelFormat; privacy: ModelPrivacy;             // L62: add — always filled (defaults 'chat' / 'zdr' for unknown models)
  bucketUsd?: number; reqPer5h?: number; jsonStrict?: boolean; notes?: string; unavailable?: boolean }   // from MODEL_TABLE (§11.3) + session state

// ---------- contracts (new; mirrored in main/contracts.ts validators) ----------
export type TaskInput = { type: 'text'; content: string } | { type: 'artifact_ref'; id: string } | { type: 'file'; path: string };
export interface TaskContract {
  task_id: string; role: string; objective: string; inputs: TaskInput[]; constraints: string[]; deliverable: string;
  acceptance: string; side_effects: boolean; budget?: Partial<Budget>;
}
export type ResultStatus = 'ok' | 'blocked' | 'partial';
export interface ResultContract {
  task_id: string; status: ResultStatus; result: string | { artifact_ref: string; summary: string; chars: number };
  assumptions: string[]; unverified: string[]; blocking_question: string | null;
  cost: { tokens: number; tool_calls: number; seconds: number; usd: number; model: string };   // system-filled
}
export type Severity = 'blocker' | 'major' | 'minor';
export interface VerifierFinding { severity: Severity; task_id?: string; issue: string; fix: string }
export interface Verdict { findings: VerifierFinding[]; verdict: 'blocker' | 'no_blocker'; summary: string }

// ---------- runs (L78+) ----------
export type TaskOrigin = { kind: 'user' }
  | { kind: 'delegation'; fromAgentId: AgentId; fromName: string; parentRunId: string; callId: string; depth: number;
      requestId: string; taskId?: string; role: AgentRole; attempt: number };                 // add requestId/taskId/role/attempt (1 = first run); depth reused when allowWorkerDelegation
export interface Task { /* v1 */ contract?: TaskContract }
export type RunStatus = /* v1 */ | 'partial';
export interface RunState { /* v1 */ requestId: string; role: AgentRole; budget?: Budget; toolCalls: number; budgetHit?: keyof Budget }
export interface TaskResult { status: 'done'|'error'|'cancelled'|'partial'; text: string; runId: string; usage: Usage; budgetHit?: keyof Budget; toolCalls: number }
export interface RunFinished { /* v1 */ status: 'done'|'error'|'cancelled'|'partial'; tier?: Tier }
export interface RuntimeSnapshot { /* v1 */ instances: AgentView[]; unavailableModels: string[]; currentTier: Tier | null }

// ---------- console events (L111) : extend members, add one ----------
  | { kind: 'task_start'; origin: TaskOrigin; input: string; context?: string; contract?: TaskContract; budget?: Budget }
  | { kind: 'task_end'; status: 'done'|'error'|'cancelled'|'partial'; durationMs: number; usage: Usage; iterations: number;
      tier?: Tier; instances?: number; agentsUsed?: string[]; result?: ResultContract; budgetHit?: keyof Budget; toolCalls?: number }
  | { kind: 'llm_call'; model: string; format?: ModelFormat; /* v1 rest */ }
  | { kind: 'delegation'; callId: string; toAgentId: AgentId | null; toName: string; task: string; childRunId?: string;
      status: 'queued'|'running'|'done'|'error'|'cancelled'|'rejected'|'partial'|'blocked'; resultPreview?: string; durationMs?: number;
      taskId?: string; tier?: Tier; attempt?: number; depth?: number; instanceId?: AgentId; contract?: TaskContract; result?: ResultContract }
  | { kind: 'verdict'; taskIds: string[]; verdict: Verdict; critical: boolean }
export interface ConsolePatch { /* unchanged */ }
```

**Ephemeral instance view** (built in `pool.ts`): `{...template, id: instanceId, name: \`${template.name} · ${taskId}\`, description: objective (80 chars),
isMain:false, ephemeral:true, parentId: template.id, taskId, objective, requestId }`.

---

## 3. IPC delta

```ts
export interface InvokeMap {                                   // add
  'config:defaultPrompt':  (role: AgentRole) => string;        // Italian default text for the role (§9)
  'instance:close':        (instanceId: AgentId) => void;      // cancel if running, drop console, console:remove{reason:'closed'}
  'logs:openContracts':    () => void;                         // shell.openPath(userData/logs/contracts.jsonl); creates the file if absent
  'shell:openExternal':    (url: string) => void;              // only https://opencode.ai/** (opt-in link from DataPolicyError toast)
}
// changed: 'config:update' accepts the pool fields (clamped to POOL_RANGES; unknown maxDelegationDepth ignored); 'config:addAgent' has no count cap;
//          'config:removeAgent' removes any template except the orchestrator (last planner/verifier included); 'config:updateAgent' {role:'orchestrator'} promotes+demotes;
//          'agent:cancel' also accepts instance ids; 'console:getEvents' works for instance ids (in-memory); 'agent:clearHistory' throws for non-orchestrator ids.
export interface EventMap {                                    // add
  'console:add':    AgentView;                                 // ephemeral view; ALWAYS sent before its first console:event
  'console:remove': { agentId: AgentId; reason: 'closed'|'next_request'|'template_removed'|'reset' };
  'app:toast':      { level: 'info'|'warn'|'error'; message: string; url?: string };   // url → renderer button "Apri" → shell:openExternal
}
```
Preload: add the 4 invoke channels and 2 event channels to `INVOKE`/`EVENTS` (`preload.ts` L7-44); `ipc.ts::INVOKE_CHANNELS` likewise.
Ordering guarantee kept: per console id `seq` is strictly increasing; the renderer ignores events for unknown ids, hence `console:add` first.

---

## 4. `ModelRouter` + fallback algorithm (`router.ts`, electron-free)

```ts
const FORMAT_PREFIXES: Array<[RegExp, ModelFormat]> = [[/^grok-/, 'responses'], [/^gpt-/, 'responses'], [/^muse-spark-/, 'responses']];
export class ModelRouter {
  private unavailable = new Map<string, { reason: string; url?: string; type: ApiErrorType }>();
  constructor(private deps: { cfg: () => AppConfig; send: Send });
  formatOf(model: string): ModelFormat        // cfg.modelFormats[model] ?? modelTable[model]?.format ?? prefix match ?? 'chat'
  chain(t: AgentConfig, o: { escalate?: boolean }): string[] {
    const raw = [...(o.escalate && t.escalation ? [t.escalation] : []), t.model, ...t.fallbacks];
    const seen = new Set<string>(); const list = raw.filter(m => m && !seen.has(m) && seen.add(m));
    const live = list.filter(m => !this.unavailable.has(m));
    return live.length ? live : [t.model];    // never empty: if everything is marked, try the primary anyway
  }
  pick(t, attempt, o): { model: string; format: ModelFormat; last: boolean } {
    const c = this.chain(t, o); const i = Math.min(attempt, c.length - 1);
    return { model: c[i], format: this.formatOf(c[i]), last: i === c.length - 1 };
  }
  markUnavailable(model, err: ApiError): void { // ModelError | DataPolicyError only
    if (this.unavailable.has(model)) return;
    const url = /https?:\/\/\S+/.exec(err.message)?.[0]?.replace(/[).,]+$/, '');
    this.unavailable.set(model, { reason: err.message, url, type: err.type });
    this.deps.send('app:toast', { level: 'warn', message: err.type === 'DataPolicyError'
      ? `Modello ${model} non disponibile finché non accetti la data policy nel workspace OpenCode` : `Modello ${model} non disponibile: ${err.message}`, url });
  }
  unavailableModels(): string[]; isUnavailable(m): boolean;
}
```
**Attempt loop in `AgentRuntime.runTask`** (replaces `agent.ts` L248-295):
```
modelAttempt = 0; backoff = 0
for (;;):
  {model, format, last} = router.pick(template, modelAttempt, {escalate: run.escalate})
  emit/patch llm_call {model, format}
  try: r = await client.streamChat({model, format, messages, tools, sessionId: run.requestId, maxTokens, temperature}); break
  catch err:
    Abort or signal.aborted → cancelled (or partial if run.budgetHit)          [v1]
    if err.type in (ModelError, DataPolicyError): router.markUnavailable(model, err)
    switchable = err.type in (RateLimit, ModelError, DataPolicyError) && !last
    if switchable: next = router.pick(template, modelAttempt+1).model
       emit info `Fallback: ${model} → ${next} (${reasonIt(err)})`; discard partial acc; modelAttempt++; continue   (no sleep; 300 ms on RateLimit)
    if err.retryable && backoff < 5: v1 backoff on the SAME model (Retry-After ?? 5s·2^n ≤ 60s + jitter); backoff++; continue
    fatal → v1 error path
```
`reasonIt`: RateLimit → "limite di richieste", ModelError → "modello non disponibile", DataPolicyError → "data policy non accettata".
Escalation flags: orchestrator `escalate = req.tier === 'T3'` (re-evaluated every iteration); planner always `escalate:true` (it only runs for T3);
verifier `escalate = args.critical === true`; worker `escalate = attempt >= 2 && previous.status !== 'blocked'` (correction re-run, any round).
The chain is re-read from live config at every `pick` (hot reload §12); `unavailable` lives for the app session only.

---

## 5. Responses adapter (`responses.ts`)

**Dispatch** (`api.ts`): `streamChat(req)` → `req.format === 'responses' ? streamResponses(...) : streamChatCompletions(...)`; both share
`readSse(res, onData: (payload: string) => 'continue'|'stop', signal)` extracted from v1 L236-302 (line buffering, idle watchdog 120 s, `[DONE]`
+ 2 s post-DONE cost wait — the responses branch simply returns `'stop'` on `response.completed`/`failed`). Headers/error mapping unchanged.

**Request builder** `buildResponsesBody(req)`:
```ts
{ model, stream: true, instructions: systemText /* the single role:'system' message */, input: toResponsesInput(messages),
  ...(tools?.length ? { tools: tools.map(t => ({ type:'function', name: t.function.name, description: t.function.description, parameters: t.function.parameters })), tool_choice: 'auto' } : {}),
  ...(maxTokens ? { max_output_tokens: maxTokens } : {}), ...(temperature !== undefined ? { temperature } : {}) }
```
No `reasoning` param is sent in v2.0 (summaries arrived unrequested in the verified stream; see risks).

**History conversion** `toResponsesInput(messages: ChatMessage[]): unknown[]` (order preserved):

| ChatMessage | Responses input item(s) |
|---|---|
| `system` | dropped (already in `instructions`) |
| `user` | `{ role:'user', content }` |
| `assistant` | if `content` non-empty → `{ role:'assistant', content }`; then per `tool_calls[i]` → `{ type:'function_call', call_id: tc.id, name, arguments }`; `reasoning_content` **never echoed** |
| `tool` | `{ type:'function_call_output', call_id: tool_call_id, output: content }` |

Tool ids: the adapter reports `item.call_id` as the tool call `id`, so v1 history/`tool` messages already carry the id the API expects back.

**SSE event → `StreamHandlers` mapping** (`data` JSON `type`; `event:` lines ignored by `readSse`):

| `type` | Action |
|---|---|
| `response.created` / `in_progress` / `ping` / `*.part.done` / `output_item.done` | ignore (bump idle) |
| `response.output_item.added` item.type=`function_call` | `idx = item.output_index ?? next++`; `byItem.set(item.id, idx)`; `onToolCallDelta({index: idx, id: item.call_id, name: item.name, args: item.arguments || ''})`; `argsAcc[idx] = item.arguments||''` |
| `response.function_call_arguments.delta` | `onToolCallDelta({index: byItem.get(item_id), args: delta})`; `argsAcc += delta` |
| `response.function_call_arguments.done` | if `argsAcc[idx] === ''` → emit whole `arguments` as delta; if `arguments.startsWith(argsAcc)` → emit the missing suffix; else `logWarn` (accumulated wins) |
| `response.output_text.delta` | `onText(delta)` |
| `response.reasoning_summary_part.added` | if a previous part exists → `onReasoning('\n\n')` |
| `response.reasoning_summary_text.delta` | `onReasoning(delta)` (same `reasoning` console stream) |
| `response.completed` / `response.incomplete` | `finishReason = output.some(i=>i.type==='function_call') ? 'tool_calls' : (type==='incomplete' ? 'length' : 'stop')`; `usage = normalizeResponsesUsage(response.usage)`; stop |
| `response.failed` / `error` | `throw errorFromBody({error: ev.response?.error ?? ev.error}, 0)` |
| unknown `type` | ignore |

`normalizeResponsesUsage`: `input_tokens→promptTokens`, `output_tokens→completionTokens`, `output_tokens_details.reasoning_tokens→reasoningTokens`,
`input_tokens_details.cached_tokens→cachedTokens`, `calls:1`. Cost: `pickCost(ev.cost ?? response.usage?.cost)` if present, else `estimateCost(model, …)`
with `estimated:true`. If no `response.completed` arrives (stream closed early) → v1 estimate path. `finish_reason` for `chat` unchanged.
**`api.ts` error mapping additions**: `errorFromBody` → `type==='DataPolicyError'` (or `/data ?policy/i`) → `ApiError('DataPolicyError', msg, 403)` (not retryable);
`mapStatus(403)` without body type stays `AuthError`; `mapStatus(5xx)` with `/not supported for format/i` → `ModelError`.
**Measured today (real key)**: `grok-4.6` and `gpt-5.6-luna` reject `/chat/completions` (500 "not supported for format oa-compat") and stream correctly on `/responses`
with the event shape above; `muse-spark-1.3-contributor` answers HTTP 403 `DataPolicyError` with the workspace opt-in URL in the body until the user accepts;
all other pool models (`minimax-m3`, `qwen3.7-plus`, `deepseek-v4-flash`, `longcat-2.0`, `kimi-k2.7-code`, `mimo-v2.5`, `glm-*`, `hy3`) complete tool calls on `/chat/completions`.

---

## 6. Instance lifecycle (`pool.ts` + `agent.ts` instance mode)

### 6.1 Request context
```ts
interface RequestCtx { requestId: string; userText: string; startedAt: number; tier: Tier | null; instancesSpawned: number;
  runs: Map<string /*task path*/, Array<{ instanceId; contract; result: ResultContract; status; finishedAt; correction: boolean }>>;
  verifierCalledAt: number | null; verified: Set<string>; planCalled: boolean; live: Map<AgentId /*instanceId*/, AgentRuntime>;
  sideEffectMutex: Mutex; globalSem: Semaphore /* size re-read from cfg.maxParallelWorkers at every acquire */;
  templateSem: Map<AgentId, Semaphore> /* size = template.maxConcurrent ?? cfg.maxParallelWorkers */; ephemeral: AgentView[] }
```
Created in `Orchestrator.registerRun(run)` when `run.origin.kind==='user'` (queued user messages start their request only when they actually run):
`pool.startRequest(run.runId, text)` → removes the previous request's ephemeral consoles (`console:remove{reason:'next_request'}` + `state.drop(id)`),
prunes artifacts (keep 20 requests), resets `runs/verified`. Ends in `onRunFinished` → `task_end` on the orchestrator is patched with
`{tier: ctx.tier ?? 'T0', instances: ctx.instancesSpawned, agentsUsed}`; `run:finished.tier` likewise. **T0 = no `delegate_tasks` call happened.**

### 6.2 `AgentRuntime` instance mode (`agent.ts`)
`new AgentRuntime(instanceId, deps, opts?: { templateId: AgentId; role: AgentRole; budget: Budget; requestId: string; escalate: boolean; consoleId: AgentId })`.
Differences from v1 (all behind `this.opts`): `cfg()` reads `config.agent(opts.templateId)`; `state.ensure(consoleId)` (ephemeral when `#`);
history = a **private in-memory array on the runtime** (`this.localHistory`, never `state.pushHistory`) seeded with the contract message; system prompt =
`buildRolePrompt(template, cfg, roster, env)`; tools = `toolDefsFor(role)`; `sessionId = opts.requestId`; `maxTokens = clamp(budget.maxTokens − used, 512, 8192)`;
`temperature = template.temperature`. Console events go to `consoleId`: the ephemeral entry for workers, the template's persistent entry for planner/verifier
(so only their console log is persisted, never a history). `trimHistory` still applies (instances rarely exceed it).
**Budget enforcement** (instances only): `run.budget`; a `setTimeout(maxSeconds)` sets `run.budgetHit='maxSeconds'` and aborts;
after each `llm_call` if `run.usage.promptTokens+completionTokens > maxTokens` → `budgetHit='maxTokens'`; before executing tool calls if
`run.toolCalls + calls.length > maxToolCalls` → `budgetHit='maxToolCalls'` (pending calls get tool results `"[budget exhausted]"` so history stays valid).
Any `budgetHit` → loop exits with `run.status='partial'`, `finalText = acc.text`, `task_end{status:'partial', budgetHit, toolCalls}`,
`TaskResult{status:'partial', budgetHit}`. `agent:status.detail` shows `tok 3.1k/8k · tool 2/10 · 41 s/180 s` while running.

### 6.3 Scheduler (`pool.delegateTasks(from, args, callId)`)
```
0 caller: from = orchestrator run (origin depth 0, level 1) or, iff cfg.allowWorkerDelegation, a worker instance run (origin depth d ≥ 1). ctx = requests.get(from.run.requestId).
   Levels: orchestrator 1, its instances 2, nested 3… `maxDepth` = max level; new instances would be level d+2 → reject iff d+2 > cfg.maxDepth → "ERROR: max depth reached (maxDepth=M)".
   (Default maxDepth 2 + allowWorkerDelegation false ⇒ hub-and-spoke; the tool is simply absent for workers, §8.) Cycle check per task (v1 L154-158): target template ∈ from.run.ancestry → "ERROR: cycle: <name> is above you".
1 validate: tier ∈ T1|T2|T3; tasks 1..N; each validateTaskContract (§7) → on any error return "ERROR: …" (rejected delegation card, log kind 'rejected')
2 caps (whole batch rejected, error text lists the rule AND the current setting so the model can adapt; nothing stalls):
   tasks.length > cfg.maxParallelWorkers                    → "batch too large: N > maxParallelWorkers=K; split into batches"
   ctx.instancesSpawned + tasks.length > cfg.maxWorkersPerRequest → "instance cap: maxWorkersPerRequest=M (used U, left L)"
   validateBatch duplicates (normalizeKey(objective) or normalizeKey(deliverable) equal) → "duplicate tasks: t2 ≈ t4"
   per task path already run: prev = runs.get(path).at(-1); corrections = runs.filter(r=>r.correction).length
     allowed iff (prev.status==='blocked' && !runs.some(r=>r.blockedContinuation))                        → continuation (not a correction)
             or (ctx.verifierCalledAt > prev.finishedAt && corrections < cfg.correctionRounds)              → correction round corrections+1
             else → "t3 already ran: a correction needs run_verifier first / correctionRounds=C exhausted"
3 ctx.tier = max(ctx.tier, tier) (T3 never lowered); ctx.instancesSpawned += tasks.length
4 resolve template per task (contract.role): (a) exact template name, case/accents-insensitive; (b) else a template whose `role` equals the string (e.g. "worker") → first in config order;
   (c) else default worker = first template with role 'worker' in config order; (d) none exists → "ERROR: no worker template configured — answer the user directly" (run continues, T0/T1 answer)
5 emit one `delegation` event per task on the CALLER's console {taskId, tier, attempt, depth, contract, toName, status:'queued'}; from.status('waiting_delegate', `${n} istanze`)
6 run: readOnly = tasks.filter(!side_effects) → Promise.all(spawn) under ctx.globalSem (cfg.maxParallelWorkers, live) + ctx.templateSem(template) (template.maxConcurrent ?? cfg.maxParallelWorkers);
        sideEffects = tasks.filter(side_effects) → for-of sequential under ctx.sideEffectMutex (also gated by the same semaphores);
        both groups start together; await Promise.all([readOnlyAll, sideEffectsSeq])   // never two side-effect instances at once, at any depth
7 per task result: ResultContract (§7.3) → artifacts → ContractsLog → patch delegation {status, result, resultPreview, instanceId, durationMs}
   → info line on the template console "Istanza t3 completata: ok · 6.1k tok · $0.002"
8 return JSON string { tier, results: ResultContract[], instances_used, instances_left, limits: { maxParallelWorkers, maxWorkersPerRequest, correctionRounds } }  (MODEL_OUTPUT_CAP 32 k)
```
`spawnInstance(template, contract, attempt, path)`: task path = `t3` at depth 1, `t3.t1` for a nested batch (parent path + `.` + task_id, so ids never collide across depths);
`instanceId = \`${template.id}#${path}${attempt>1?'-r'+attempt:''}\``; `send('console:add', view)`; `state.ensure(instanceId)`;
`rt = new AgentRuntime(instanceId, deps, {…})`; `ctx.live.set(instanceId, rt)`; `q = rt.enqueue({origin:{kind:'delegation', requestId, taskId, role:'worker', attempt, …}, input: contractMessage, contract})`;
`fromRun.childRunIds.push(q.runId)`; `r = await q.result`; `ctx.live.delete(instanceId)`; `rt.destroy()`. The console stays until next request/close.

### 6.4 Planner / verifier runs
Template choice for both: `args.template` (name, case-insensitive) must be a template of the right role, else the **first template of that role in config order**.
With zero templates of the role the tool is not in the orchestrator's toolset that iteration (§8); if the template disappears between exposure and call →
`"ERROR: no planner/verifier template configured — plan/verify inline"` (run continues). `runPlanner({objective, context, template?})`: counts as 1 instance
(`maxWorkersPerRequest` cap applies: over cap → error text, no stall); `ctx.tier = 'T3'`; instance on the template console, `escalate:true`, budget = template.budget ?? `{6000, 6, 120}`;
user message = `buildPlannerMessage(objective, context, workerRoster, env)`; result → `parsePlan` (§7.4) → JSON string to the orchestrator.
`runVerifier({task_ids, critical, template?})`: ids default = all task paths run in this request (error text if none);
system builds `buildVerifierMessage(userText, contracts, results(with artifacts inlined ≤ 12 k chars each), env)`; instance on the template console,
`escalate: critical===true`; result → `parseVerdict` → emit `verdict` event on the verifier console; `ctx.verifierCalledAt = now`; `verified ∪= ids`;
log kind `verifier`; returns the Verdict JSON. Both use `attempt:1`, `x-opencode-session = requestId`.

### 6.5 Cancellation cascade & console lifecycle
- `chat:cancel()` → `orchestrator.cancelAll()` → v1 runtimes + every `ctx.live` instance (`rt.cancel`) → each pending `delegate_tasks` resolves with
  `ResultContract{status:'partial', unverified:['cancelled by user']}`; orchestrator run itself is aborted (v1).
- Orchestrator run aborted (`agent:cancel(main)`) → v1 `childRunIds` cascade reaches instances via `host.cancelRun(runId)` (pool registers instance runs in `runs`).
- `agent:cancel(instanceId)` → only that instance → its result becomes `partial` ("cancelled by user"); the batch continues.
- `instance:close(id)` → cancel if live, `state.drop(id)`, `console:remove{reason:'closed'}`; the orchestrator card keeps the contract/result.
- Template removed (§12) → live instances cancelled with "template removed by the user" → `partial`; their consoles removed (`template_removed`).
- Quit: `before-quit` → `cancelAll` (v1); ephemeral entries are not flushed.

---

## 7. Contracts (`contracts.ts`)

### 7.1 Validation (`validateTaskContract(raw, i): { ok: TaskContract } | { error: string }`)
| Field | Rule (normalize → then check) |
|---|---|
| `task_id` | string trimmed; empty → `t${i+1}`; must match `/^[A-Za-z0-9_-]{1,24}$/` |
| `role` | non-empty string (resolved to a template in §6.3 step 4) |
| `objective` | string, 10..1200 chars; contains no unresolved pronoun-only start (`/^(questo|quello|it|this|that)\b/i`) → error "objective must be self-contained" |
| `inputs` | array (default `[]`), ≤ 12 items; each `type` ∈ text/artifact_ref/file with the matching field; `file` path must resolve `inside` the workspace (`resolvePath`) |
| `constraints` | string[] (default `[]`), each ≤ 400 chars, ≤ 12 items |
| `deliverable`, `acceptance` | non-empty strings ≤ 600 chars |
| `side_effects` | boolean (strings `"true"/"false"` coerced; default `false`) |
| `budget` | optional partial; effective = `min(contract[k] ?? template[k] ?? DEFAULT[k], HARD_MAX[k])`, HARD_MAX `{maxTokens:60000, maxToolCalls:40, maxSeconds:600}` |
`validateBatch(tasks)`: duplicate `task_id`, `normalizeKey(objective)` or `normalizeKey(deliverable)` collision → error naming both ids.

### 7.2 Inlining inputs (`ArtifactStore.inline`, used by `buildContractMessage`)
`text` verbatim (≤ 12 k chars, then `truncateForModel`); `artifact_ref` → stored content (≤ 12 k); `file` → read via `tools.readFile` semantics, no gate prompt
(inside workspace only, ≤ 12 k). Whole message capped at 48 k chars; overflow → later inputs replaced by `[input omitted: too large — ask for a smaller slice]`.

### 7.3 `parseResultContract(text, contract, run: TaskResult): ResultContract`
```
1 candidates = [text.trim(), stripFences(text), firstBalancedObject(text)]  (reuse agent.ts firstBalancedObject, exported)
2 first JSON.parse → isRecord → normalize: status ∈ ok|blocked|partial else 'partial'; result: string | object→JSON.stringify; arrays coerced (strings only);
  blocking_question string|null; task_id := contract.task_id (never trust the model)
3 no JSON → { status:'partial', result: text, assumptions:[], unverified:['output not in ResultContract format'], blocking_question:null }
  Measured (system "solo JSON", one arithmetic task): STRICT at stage 1 → deepseek-v4-flash (78 tok), glm-5.3-flash (81), kimi-k2.7-code (141), longcat-2.0 (209), hy3 (495),
  qwen3.7-plus (588), mimo-v2.5 (948 tok, and NOTHING under a ~700-token budget: all reasoning); **minimax-m3 wraps the JSON in prose → stage 2 (lenient)** — fine as
  orchestrator (tool-driven), not as a JSON worker. Stage 2 must therefore be considered the normal path for minimax-m3 workers, not an anomaly; the `info` line "ResultContract estratto da testo" is emitted once per instance.
4 run.status !== 'done' → status:'partial'; unverified += `run ${run.status}${run.budgetHit ? ` (budget ${run.budgetHit})` : ''}`
   status 'blocked' with empty blocking_question → status 'partial', unverified += 'blocked without question'
5 cost := { tokens: usage.promptTokens+completionTokens, tool_calls: run.toolCalls, seconds: round(durationMs/1000), usd: usage.cost, model: lastModel }  (always overwritten)
6 if typeof result==='string' && result.length > cfg.artifactThresholdChars → art = artifacts.put(requestId, taskId, result) → result = { artifact_ref: art.id, summary: result.slice(0,400), chars }
```
### 7.4 `parsePlan(text)` → `{ tasks: TaskContract[]; assumptions: string[]; if_false: string[]; warnings: string[] }`
Same JSON extraction; each task through `validateTaskContract` (invalid → dropped + warning); `depends_on?: string[]` kept as extra field;
`tasks.length > 6` → truncate to 6 + warning "plan truncated to 6 tasks"; no JSON → `{tasks:[], warnings:['plan not in JSON format'], raw: text}`.
### 7.5 `parseVerdict(text)` → `Verdict`: findings array (severity coerced to minor when unknown, `issue` required), `verdict` derived
(`'blocker'` iff any blocker finding), `summary` ≤ 400 chars; free text → `{findings:[], verdict:'no_blocker', summary: text.slice(0,400)}` + `unverified` note in the tool result.
### 7.6 Artifact store (`artifacts.ts`)
Files: `userData/state/artifacts/<requestId>/<artId>.json` = `{ id, requestId, taskId, chars, createdAt, content }`; `userData/state/artifacts/index.json`
= `{ [artId]: { requestId, taskId, chars, summary, createdAt } }` (atomic writes). `id = 'art_' + 6 hex`. `get(id, offset=0, limit=6000)` → slice.
Prune on `startRequest`: keep the 20 most recent request dirs. `read_artifact` tool output: `[art_x · 9800 chars · 0–6000]\n<slice>` or `ERROR: unknown artifact`.
### 7.7 Contracts log (`ContractsLog`, `userData/logs/contracts.jsonl`)
One JSON line per record: `{ ts, requestId, kind: 'task'|'result'|'rejected'|'plan'|'verifier', taskId?, instanceId?, template?, model?, attempt?, data }`.
`appendFile` (fire-and-forget, errors logged); rotate at 20 MB → `.1`. `logs:openContracts` opens the file with `shell.openPath`.

---

## 8. Tools per role (`tools.ts`)

| Role | Tools (`toolDefsFor(role, cfg, roster, depth)`, recomputed every iteration from live config) |
|---|---|
| orchestrator | `delegate_tasks` (only if ≥1 worker template), `run_planner` (only if ≥1 planner template), `run_verifier` (only if ≥1 verifier template), `read_artifact`, `ask_user`, `read_file`, `list_directory` |
| worker | `read_file`, `write_file`, `edit_file`, `delete_path`, `list_directory`, `search_files`, `run_command`, `system_info`, `network_info`; **+ `delegate_tasks`, `read_artifact`** iff `cfg.allowWorkerDelegation && origin.depth + 2 <= cfg.maxDepth` (i.e. a level-2 worker needs maxDepth ≥ 3; Settings hint says so) |
| planner, verifier | `read_file`, `list_directory`, `search_files` |

`execute()` re-checks `toolNamesFor(ctx.run.role, cfg, roster, depth).includes(name)` (defence in depth: a worker calling `delegate_tasks` while delegation is
off gets `ERROR: unknown tool`). Removed: `delegate_task`, `list_agents`. Schemas are built per call so `tasks.maxItems = cfg.maxParallelWorkers` and the
descriptions quote the live limits. Permission gating for the v1 tools unchanged (instances show the template name+colour in the modal via `who(ctx)`;
`agentId` = instance id so `gate.cancelRun/cancelAgent` still match).

```ts
def('delegate_tasks', `Run one batch of TaskContracts on worker instances and wait for all ResultContracts. Read-only tasks run in parallel, side_effects tasks one at a time. Limits (from settings): ${cfg.maxParallelWorkers} tasks per call, ${cfg.maxWorkersPerRequest} instances per request, ${cfg.correctionRounds} correction round(s) per task.`, {
  type:'object', required:['tier','tasks'], properties: {
    tier: { type:'string', enum:['T1','T2','T3'] },
    tasks: { type:'array', minItems:1, maxItems: cfg.maxParallelWorkers, items: { type:'object', required:['task_id','role','objective','deliverable','acceptance','side_effects'], properties: {
      task_id: { type:'string', description:'t1, t2, … unique in the request; reuse an id only for a correction re-run after run_verifier (or to continue a blocked task)' },
      role: { type:'string', description:'worker template name from the Pool section (or a role name; falls back to the default worker)' },
      objective: { type:'string', description:'one self-contained sentence, no pronouns, no references to the conversation' },
      inputs: { type:'array', items: { type:'object', properties: { type:{type:'string',enum:['text','artifact_ref','file']}, content:{type:'string'}, id:{type:'string'}, path:{type:'string'} }, required:['type'] } },
      constraints: { type:'array', items:{type:'string'} }, deliverable: { type:'string' }, acceptance: { type:'string' },
      side_effects: { type:'boolean', description:'true if the task writes files or runs commands' },
      budget: { type:'object', properties: { max_tokens:{type:'integer'}, max_tool_calls:{type:'integer'}, max_seconds:{type:'integer'} } } } } } } })
def('run_planner', 'Ask a planner for an ordered task list (≤6) for a broad objective. Use only for T3.', { type:'object', required:['objective'],
  properties: { objective:{type:'string'}, context:{type:'string', description:'facts already known; no pronouns'},
    template:{type:'string', description:`planner template name; default ${firstOfRole('planner').name}`} } })
def('run_verifier', 'Adversarial check of the results of this request. The system supplies the original request, the TaskContracts and the outputs.', { type:'object',
  properties: { task_ids:{type:'array', items:{type:'string'}, description:'default: all tasks of this request'}, critical:{type:'boolean', description:'true → stronger model'},
    template:{type:'string', description:`verifier template name; default ${firstOfRole('verifier').name}`} } })
def('read_artifact', 'Read a stored artifact by id (artifact_ref in a ResultContract).', { type:'object', required:['id'],
  properties: { id:{type:'string'}, offset:{type:'integer', description:'char offset, default 0'}, limit:{type:'integer', description:'chars, default 6000, max 20000'} } })
```
`budget` keys in the contract accept both snake_case (`max_tokens`) and camelCase; normalized to `Budget`. Executors call
`ctx.orchestrator.delegateTasks/runPlanner/runVerifier/readArtifact(from, args, callId)`; `OrchestratorApi` in `tools.ts` is replaced accordingly.
`executeToolCalls` (agent.ts L455) becomes strictly sequential (batching is now inside `delegate_tasks`).

---

## 9. Prompts (`prompt.ts`, Italian, final form)

Each template stores its `prompt` (editable). `DEFAULT_PROMPTS[role]` below; `config:defaultPrompt(role)` returns it; the first line keeps the v1
`descrizione:` convention (console subtitle). System prompt = `prompt.trim()` + `\n\n` + fixed block for the role (below). No dynamic data except the
orchestrator's Pool/Limits/Environment/Notes sections (config-only). `{locale}` is fixed per app run.

**Orchestratore**
```
descrizione: coordina il pool di agenti e parla con l'utente

Sei l'ORCHESTRATORE: l'unico che parla con l'utente. REGOLA ZERO: non svolgi mai lavoro di dominio (ricerca, codice, analisi, scrittura): lo deleghi ai worker con delegate_tasks. Puoi solo leggere il workspace con read_file e list_directory per rispondere a domande fattuali immediate.

Per ogni richiesta:
1. Classifica il livello e dichiaralo nella prima riga della risposta finale: T0 = rispondi da solo (conversazione, domanda fattuale, chiarimento) ed è il caso normale: non delegare se non serve; T1 = 1 worker; T2 = 2-4 worker paralleli e disgiunti; T3 = obiettivo ampio o ambiguo: se hai lo strumento run_planner usalo prima, altrimenti scomponi tu; poi esegui il piano con delegate_tasks(tier "T3"), un batch per gruppo di task indipendenti.
2. Scomponi in task disgiunti: nessuna sovrapposizione di obiettivo o deliverable. I task che scrivono file o eseguono comandi hanno side_effects true.
3. Delega con TaskContract eseguibili da chi non ha letto la conversazione: objective in una frase autosufficiente, senza pronomi né "come detto sopra"; passa i dati con inputs (text, artifact_ref, file), indica deliverable e un acceptance verificabile in una riga. Usa come role il nome di un template della sezione Pool.
4. Sintetizza una sola risposta finale nella lingua dell'utente: non incollare mai output grezzi; se ti serve il contenuto completo di un artefatto usa read_artifact.
5. Se hanno lavorato almeno 2 worker o il risultato è critico e hai lo strumento run_verifier, chiamalo; se non lo hai, rileggi tu i risultati cercando contraddizioni e requisiti ignorati. Se emerge un blocker, ri-esegui il task interessato con delegate_tasks (stesso task_id, feedback del verificatore negli inputs) restando nei round di correzione indicati nei Limiti. Se un worker risponde blocked, rispondi alla sua domanda (chiedendo all'utente con ask_user se necessario) e ri-esegui il task con la risposta negli inputs.
Budget: rispetta i Limiti indicati sotto (worker paralleli per chiamata, istanze per richiesta, round di correzione). Se il budget non basta, consegna il meglio ottenuto e dichiara cosa manca. Se la sezione Pool non contiene worker, rispondi direttamente e dichiaralo. Se un'ambiguità cambia il risultato, fai UNA sola domanda con ask_user prima di delegare.
```
Fixed block (orchestrator):
```
## Regole fisse
- Agisci solo tramite strumenti; non affermare mai di aver fatto ciò che non hai fatto. Un rifiuto di autorizzazione da parte dell'utente è definitivo.
- Il tuo messaggio finale senza chiamate a strumenti è la risposta mostrata all'utente: inizia con il livello (es. "T2 ·") e chiudi sempre con una risposta completa.
- delegate_tasks accetta al massimo il numero di task indicato nei Limiti; task duplicati o con lo stesso deliverable vengono rifiutati dal sistema; un task_id può essere ri-eseguito solo dopo run_verifier e al massimo per i round di correzione indicati nei Limiti (continuare un task blocked non conta come correzione).
- I worker non vedono questa conversazione: ogni contratto deve bastare da solo.
- Rispondi nella lingua dell'utente ({locale}); codice, comandi e contenuti dei file restano nella loro lingua.
## Pool
- {name} — {role} — {description} [modello {model}{, fallback a, b}{, escalation c}]        (one line per non-orchestrator template, config order)
- (nessun template planner: pianifica tu) / (nessun template verificatore: verifica tu) / (nessun template worker: rispondi direttamente)   (only the missing ones)
## Limiti
worker paralleli per chiamata: {maxParallelWorkers} · istanze per richiesta: {maxWorkersPerRequest} · round di correzione: {correctionRounds} · profondità: {allowWorkerDelegation ? maxDepth + ' (i worker possono delegare)' : 2} · soglia artefatti: {artifactThresholdChars} caratteri · budget predefinito per task: {tokens}/{tool}/{s}
## Ambiente
OS {platform} {release} ({arch}) · shell {shell} · workspace {workspacePath} (i percorsi relativi partono da qui)
## Indicazioni dell'utente
{interactionPrompt || '(nessuna)'}
```
**Planner**
```
descrizione: trasforma un obiettivo ampio in un piano di task

Sei il PLANNER. Ricevi un obiettivo ampio e produci un piano di al massimo 6 task ordinati. Per ogni task indica: task_id (t1, t2, …), role (nome di un template worker tra quelli elencati nel messaggio), objective (una frase autosufficiente, senza pronomi), inputs, constraints, deliverable, acceptance (criterio verificabile in una riga), side_effects (true se scrive file o esegue comandi) e depends_on (task_id da cui dipende; i task senza dipendenze si eseguono in parallelo). Unisci i task che producono lo stesso output. Puoi leggere il workspace (read_file, list_directory, search_files) ma non modificarlo. Chiudi con le assunzioni fatte e con cosa cambierebbe se fossero false.
Rispondi SOLO con JSON: {"tasks":[{"task_id":"t1","role":"…","objective":"…","inputs":[],"constraints":[],"deliverable":"…","acceptance":"…","side_effects":false,"depends_on":[]}],"assumptions":["…"],"if_false":["…"]}
```
**Worker**
```
descrizione: esegue un singolo TaskContract e restituisce un ResultContract

Sei un WORKER. Esegui esattamente il TaskContract che ricevi: non hai accesso alla conversazione con l'utente e non puoi fargli domande. L'ambito è solo l'objective: niente extra, niente miglioramenti non richiesti. Se manca qualcosa di essenziale non inventare: rispondi con status "blocked" e una blocking_question precisa. Agisci solo tramite strumenti e non dichiarare mai fatto ciò che non hai fatto. Separa ciò che hai verificato da ciò che hai dedotto: le deduzioni vanno in assumptions, ciò che non hai potuto controllare in unverified. Rispetta constraints e deliverable.
Chiudi con un solo messaggio che contiene SOLO il ResultContract JSON: {"task_id":"…","status":"ok|blocked|partial","result":"…","assumptions":[],"unverified":[],"blocking_question":null}
```
**Verificatore**
```
descrizione: verifica avversariale dei risultati, non li corregge

Sei il VERIFICATORE, avversariale: non migliori il lavoro, trovi ciò che non va. Ricevi la richiesta originale, i TaskContract e gli output. Controlla nell'ordine: 1) l'insieme risponde alla richiesta originale, non a una versione comoda; 2) fatti non supportati o inventati; 3) errori di calcolo, logica o codice; 4) requisiti del contratto ignorati (deliverable, constraints, acceptance); 5) contraddizioni interne o tra worker. Puoi leggere il workspace (read_file, list_directory, search_files) per controllare, ma non modificarlo. Non riscrivere mai l'output.
Rispondi SOLO con JSON: {"findings":[{"severity":"blocker|major|minor","task_id":"t2","issue":"…","fix":"…"}],"verdict":"blocker|no_blocker","summary":"una riga"}. Se non ci sono blocker, dillo in una riga in summary.
```
Fixed block (worker / planner / verifier, same text; the tool list is role-specific):
```
## Regole fisse
- Agisci solo tramite gli strumenti disponibili ({toolList}); i percorsi relativi partono dal workspace indicato nel messaggio.
- run_command: solo comandi non interattivi. Alcune azioni richiedono l'autorizzazione dell'utente, gestita dall'app: un rifiuto è definitivo, riportalo in unverified.   (worker only)
- delegate_tasks: puoi delegare sotto-task disgiunti a un template worker della sezione Pool ({worker names}); mai a te stesso né a chi ti ha delegato; al massimo {maxParallelWorkers} per chiamata, profondità massima {maxDepth}.   (worker, only when the tool is exposed — config-dependent, still static per call)
- Il tuo ultimo messaggio deve contenere solo il JSON richiesto, senza testo attorno. Il campo cost lo compila il sistema.
- Rispondi nella lingua della richiesta ({locale}); codice, comandi e contenuti dei file restano nella loro lingua.
```
**Instance user message** (`buildContractMessage`): `## Ambiente\nOS … · shell … · workspace … · data {ISO} · lingua utente {locale}\n\n## TaskContract\n```json\n{contract without inline content}\n```\n\n## Input inclusi\n### [text]\n…\n### [artifact_ref art_x] (3812 caratteri)\n…\n### [file rel/path] (1200 caratteri)\n…\n\n## Risposta attesa\nSolo il ResultContract JSON con task_id "{task_id}".`
`buildPlannerMessage`: Ambiente + `## Obiettivo` + `## Contesto` + `## Template worker disponibili` (name — description) + `## Risposta attesa` (JSON schema).
`buildVerifierMessage`: Ambiente + `## Richiesta originale dell'utente` + per task `## t2 — TaskContract` (json) + `## t2 — Output` (result inlined ≤ 12 k) + `## Risposta attesa`.
Correction re-run: the orchestrator adds `{type:'text', content:'Feedback del verificatore: …'}` to `inputs`; the system also appends `## Tentativo 2` with the previous `result` summary.

---

## 10. Renderer delta

### 10.1 `console.ts`
| Event / element | Render rule |
|---|---|
| header (orchestrator, `agent.role==='orchestrator'`) | new `badge tier` after the model badge: text `T0…T3` of the last finished request (from `task_end.tier`, or `run:finished.tier`); `data-tier` for colour; tooltip "livello dell'ultima richiesta · N istanze · agenti: …" |
| header (ephemeral view) | title `Worker · t3` = `agent.name`; subtitle = objective; extra `budget-line` under the head: `tok 3.1k/8k · strumenti 2/10 · 41 s/180 s` (tokens from `agent:status.usage`, tool calls counted from this console's `tool_call` nodes, seconds from `task_start.ts`, limits from `task_start.budget`); button `✕ Chiudi` → `instance:close`; no collapse/clear buttons; `.console.ephemeral` dashed border in template colour |
| `task_start` (+`contract`) | v1 banner; when `contract` present the collapsible block shows the pretty-printed TaskContract (`pre task`) with a caption `TaskContract · t3 · {role}` and chips `side_effects` / `budget 8k·10·180s`; instances: banner text "Incarico da **Orchestratore** · t3 · tentativo 2" when `attempt===2` |
| `task_end` | `partial` → icon `◐`, label `parziale` (amber); `budgetHit` → suffix `· budget {tokens|strumenti|secondi} esaurito`; `tier` → chip `T2 · 3 istanze` (orchestrator); `result` → collapsible pretty JSON `ResultContract` with status chip (ok green / blocked violet / partial amber) |
| `llm_call` | append `· responses` when `format==='responses'` |
| `delegation` (extended) | card title `⇢ t3 → **Worker** · T2` (+ `· tentativo 2`); status chips add `partial` (amber "Parziale") and `blocked` (violet "Bloccato"); body: collapsible TaskContract (from `contract`, replaces v1 `task`) and, when `result`, collapsible ResultContract + `cost` line `6.1k tok · 4 strumenti · 41 s · $0.002 · mimo-v2.5`; "Vai alla console" only if `host.hasConsole(instanceId)`; `resultPreview` shown when `result` absent (rejections) |
| `verdict` (new) | card `⚖ Verifica · t1, t2` + chip `blocker` (red) / `nessun blocker` (green); list of findings grouped by severity (`data-severity`): `■ blocker · t2 — issue → fix`; summary line; `critical` → chip `critico` |
| `info` "Fallback: …" | v1 grey line; renderer adds class `fallback` when message starts with `Fallback:` (amber dot) |
| `tool_call` icons | `delegate_tasks ⇶`, `run_planner 🗺`, `run_verifier ⚖`, `read_artifact 📎` |
`ConsoleHost` gains `hasConsole(id)` and `closeInstance(id)`. `STATUS_LABEL` unchanged; `TASK_END` gets `partial`.

### 10.2 `workbench.ts`
- `instances = new Map<AgentId, AgentView>()` (insertion order). `onConsoleAdd(v)` → create `ConsoleView` (ephemeral), insert into grid after templates,
  keep focus where it is, `renderDock`. `onConsoleRemove({agentId})` → destroy view, delete from `instances/collapsed`, re-layout.
- `orderedAgents()` = templates (orchestrator first) + `[...instances.values()]`; `layout()` cols formula unchanged (13 consoles → 4 cols).
  **Flood guard**: if visible instances > `snapshot.maxParallelWorkers`, the oldest instances beyond that count are auto-collapsed into the dock (chips
  keep name + status + unseen). `toggleCollapse` rule "at least one visible" unchanged.
- `applyRuntime(snap)`: create views for `snap.instances`, then `loadHistories` includes them; `snap.currentTier` → header badge on the orchestrator.
- `onRunFinished(r)` → `views.get(r.agentId)?.setTier(r.tier)` when `r.isUserRun`. `agentMeta(id)` also resolves instances (template colour).
- Header totals unchanged (instance usage arrives via `agent:status` keyed by instance id → included in the sum; removed instances keep their last usage in `this.usage`).

### 10.3 `settings.ts`
- **Agent row**: role chip (`Orchestratore/Planner/Worker/Verificatore`), routing summary `minimax-m3 → mimo-v2.5, qwen3.7-plus ↑ glm-5.3`, privacy badge of the primary.
- **Form**: `Ruolo` select (changing to `orchestrator` shows hint "diventa l'agente principale; l'attuale orchestratore torna worker"); `Modello primario`
  (select with cost/privacy/format badges via `modelLabel`+`privacyBadge`, unavailable-this-session models greyed with title); `Fallback` = ordered chip list
  (add from select, ✕ remove, ◂▸ reorder), `Escalation` select (optional, "—"); `Temperatura` number 0–2 step 0.1 (empty = default); `Budget per task`
  three numbers (token / strumenti / secondi; hidden for orchestrator); `Prompt` textarea + button `Ripristina prompt del ruolo` → `config:defaultPrompt(role)` fills the textarea (confirm if edited).
- Form also gets `Istanze parallele max` (`maxConcurrent`, empty = "come il pool"), hidden for the orchestrator.
- **Section "Pool"** (new, replaces "Profondità delega"; every field editable, bounds and warnings from `AppInfo.poolRanges`, saved on change via `config:update`):
  `Worker paralleli per chiamata` (`maxParallelWorkers`, 1–16), `Istanze per richiesta` (`maxWorkersPerRequest`, 1–32), `Round di correzione` (`correctionRounds`, 0–3),
  `Soglia artefatti (caratteri)` (1000–20000), toggle `I worker possono delegare` (`allowWorkerDelegation`) revealing `Profondità massima` (`maxDepth`, 2–4, hint "con 2 i worker
  non possono comunque delegare: serve 3 o 4"); above `recommendedMax` an inline amber warning: "oltre 8 worker paralleli il costo e il rischio di rate limit crescono molto" /
  "oltre 8 istanze per richiesta il costo per richiesta cresce molto" / "più di 1 round di correzione raddoppia i costi nei casi peggiori" / "profondità > 2 rende il flusso difficile da seguire".
  `Formati modello` mini-editor (`model → chat|responses`), button `Apri log contratti` → `logs:openContracts`.
- "Protocollo di interazione" → "Indicazioni per l'orchestratore" (same field). Data section: "Cancella cronologia" only for the orchestrator.
- Badges (from `ModelInfo`, both settings and wizard): privacy `zdr` green "ZDR", `zdr_verify` amber "ZDR fino al 31/08/2026 · conferma rinnovo", `retention_30d` amber
  "conservazione 30 gg", `training` red "addestramento dati"; format `responses` grey chip; `jsonStrict===false` amber "JSON non stretto" (hidden for orchestrator role);
  `notes` as tooltip; `mimo-v2.5` note renders as amber "molti token" chip; `unavailable` (session) grey strike-through with the reason. Selecting a model with
  `training` or `retention_30d` as a **worker/verifier primary** shows an inline confirm text under the select (no blocking).

### 10.4 `wizard.ts`
Step 2 starts with three preset buttons: **"Pool consigliato"** (§11.3, 5 cards) — the default, applied on first render —, **"Pool economico (Muse Spark)"** (same 5 cards,
Muse Spark workers; the button carries the note "più economico e con la quota più ampia, ma richiede l'opt-in OpenCode e i prompt addestrano modelli Meta: non usarlo
con contenuti proprietari o clinici") and **"Vuoto"** (a single orchestrator card); all fully editable afterwards. Because the default Worker is `deepseek-v4-flash`,
the wizard shows the `zdr_verify` notice **once** as an info line under the cards ("DeepSeek: accordo ZDR indicato fino al 31/08/2026, verifica il rinnovo") — never blocking. Cards can be added (`+ Aggiungi template`), duplicated (`⧉`, copies routing/prompt with name suffix " 2") and removed without any slot
limit (v1 "max 10" removed; only the orchestrator card cannot be removed). Card fields: Nome, Ruolo, Modello primario, Fallback chips, Escalation, Descrizione,
Comportamento (prefilled with the role default when empty; changing role replaces the prompt if it still equals a default), Budget, Colore. Validation: exactly one
`orchestrator` (radio in step 3 sets it), names unique; zero workers/planners/verifiers is valid (the review step shows an info line "senza worker l'orchestratore risponde da solo").
Step 3 "Orchestratore e indicazioni": radio over cards (sets role orchestrator), textarea "Indicazioni per l'orchestratore (opzionale)". Step 4 table adds
Ruolo + Routing columns. `SetupPayload` unchanged in shape (`mainIndex` kept; `agents[i].role/fallbacks/escalation/budget` added via `AgentInput`).

### 10.5 `modals.ts` / `index.ts` / `dom.ts` / `styles.css`
`toast(level, message, url?)` renders an "Apri" button → `shell:openExternal(url)`. `index.ts` subscribes `console:add`/`console:remove`. `dom.ts`:
`privacyBadge(m)`, `formatBadge(m)`, `fmtBudget()`, `routingSummary(a)`. CSS: `.console.ephemeral`, `.badge.tier[data-tier]`, `.budget-line`, `.ev-verdict .finding[data-severity]`,
`.ev-task_end[data-status="partial"]`, `.chips` (routing editor), `.infoline.fallback`.

---

## 11. Config migration, defaults, recommended template (`config.ts`)

### 11.1 Migration (`sanitize`, L362): v1 → v2 in one pass, saved on first mutation
- `version: 2`; per agent: `role = typeof a.role valid ? a.role : (a.id === mainAgentId ? 'orchestrator' : 'worker')`; `fallbacks = string[] (dedup, ≠ model) ?? []`;
  `escalation` string|undefined (≠ model); `temperature` number 0..2|undefined; `budget` sanitized `{maxTokens 500..60000, maxToolCalls 1..40, maxSeconds 10..600}`|undefined.
- Invariant repair: exactly one orchestrator: if none → `mainAgentId`'s agent becomes orchestrator; if several → the one equal to `mainAgentId` stays, others → worker;
  `mainAgentId` := the orchestrator's id.
- pool fields via `POOL_RANGES` (`clampRange(raw, range) ?? range.default`): `maxParallelWorkers`, `maxWorkersPerRequest`, `correctionRounds`, `maxDepth`; `allowWorkerDelegation = raw === true`;
  `artifactThresholdChars`; `modelFormats` = record of valid entries ?? `{}`; `maxConcurrent` per agent clamped 1..32 | undefined; `maxDelegationDepth` ignored and dropped on save.
  Old prompts are kept verbatim (the orchestrator gets the v2 fixed block appended at runtime anyway).
### 11.2 Mutations
`updateAgent(id, {role:'orchestrator'})` ≡ `update({mainAgentId:id})`: new orchestrator, previous → `worker` (its prompt → worker default only if untouched), `diff.mainChanged=true`, `updated=[both]`.
`updateAgent(main, {role: other})` → throws "Promuovi prima un altro template a orchestratore" (the single remaining error: the invariant needs one orchestrator).
`removeAgent(id)`: any template except the orchestrator, no minimum count of other roles (v1 L292 "at least one agent" becomes "the orchestrator stays"). `addAgent`: no count cap (v1 L251 removed), role default `worker`.
`update({...pool fields})` → clamped to `POOL_RANGES`, `fields` entries per key; `completeSetup`: `mainIndex` forces that agent's role to orchestrator, others keep `input.role ?? 'worker'`.
When `role` changes and `prompt` is empty or equals `DEFAULT_PROMPTS[oldRole]` → `prompt = DEFAULT_PROMPTS[newRole]`.
### 11.3 Defaults and ranges
`POOL_RANGES` (main constant, exposed as `AppInfo.poolRanges`; defaults reproduce the lead's design exactly):

| Field | default | min | max | recommendedMax (UI warning above) |
|---|---|---|---|---|
| `maxParallelWorkers` | 4 | 1 | 16 | 8 |
| `maxWorkersPerRequest` | 8 | 1 | 32 | 8 |
| `correctionRounds` | 1 | 0 | 3 | 1 |
| `maxDepth` (only with `allowWorkerDelegation`) | 2 | 2 | 4 | 2 |
| `artifactThresholdChars` | 4000 | 1000 | 20000 | 8000 |
`allowWorkerDelegation` default `false`. `DEFAULT_BUDGET = { maxTokens: 8000, maxToolCalls: 10, maxSeconds: 180 }`; `DEFAULT_MODEL` stays `deepseek-v4-flash` for hand-made
templates. `EMPTY_POOL` = one `Orchestratore` (`minimax-m3`, fallbacks `qwen3.7-plus`, role default prompt). Recommended pool (`RECOMMENDED_POOL: AgentInput[]`, wizard preset via `AppInfo.recommendedPool`; a preset, not a schema):

Rationale: quota buckets are **per model**, so each role sits on a different bucket, and every primary was verified live today for its exact job (tool calls for the
orchestrator, strict JSON for workers/verifier). Rationale per row in the last column.

| Nome | role | model (price in/out per M · bucket · req/5h) | fallbacks | escalation | budget | color | why |
|---|---|---|---|---|---|---|---|
| Orchestratore | orchestrator | `minimax-m3` ($0.30/$1.20 · $60 · 3.200) | `qwen3.7-plus`, `deepseek-v4-flash` | `glm-5.3` (T3 only) | — (maxIterations 40) | `#3B82F6` | verified tier choice + tool calls; lenient JSON is irrelevant here |
| Planner | planner | `glm-5.3` ($1.40/$4.40 · $15 · 220) | `kimi-k2.7-code`, `minimax-m3` | — | 6000 / 6 / 120 | `#8B5CF6` | rare role, strong model; 220 req/5h is plenty for T3 only |
| Worker | worker | `deepseek-v4-flash` ($0.22/$0.66 · $30 · 7.600 · 1M ctx) | `kimi-k2.7-code`, `glm-5.3-flash` | `deepseek-v4-pro` | 8000 / 10 / 180 | `#10B981` | strict JSON in 78 tokens, big context, own bucket |
| Worker Flash | worker | `longcat-2.0` ($0.30/$1.20 · cache $0.006 · $60 · 11.400) | `glm-5.3-flash`, `hy3` | — | 4000 / 6 / 120 | `#F59E0B` | tool call in 71 tokens, huge allowance for wide fan-out |
| Verificatore | verifier | `qwen3.7-plus` ($0.40/$1.60 · $60 · 4.300) | `minimax-m3`, `glm-5.3-flash` | `glm-5.3` (critical only) | 8000 / 8 / 150 | `#EF4444` | strict JSON, different bucket from both workers |

**Second preset "Pool economico (Muse Spark)"** (`ECONOMY_POOL`): identical, but both worker templates use `muse-spark-1.3-contributor` as primary
(Worker fallbacks `deepseek-v4-flash`, `kimi-k2.7-code`; Worker Flash fallbacks `longcat-2.0`, `glm-5.3-flash`) so a 403 self-heals through the router. Offered in the
wizard behind an explicit note: cheapest ($0.10/$0.20), by far the largest allowance (45.300 req/5h, 1M ctx), but requires the OpenCode workspace opt-in AND its
prompts/completions train Meta models → never for proprietary or clinical content. Never a default.

`MODEL_TABLE` (**`config.ts`**, static, measured 2026-09-04; injected into `OpenCodeClient`/`ModelRouter`; models.dev wins for price/context when present; unknown ids → `chat`/`zdr`/no badges):

| id | format | privacy | $in/$out | bucket | req/5h | jsonStrict | notes (shown as tooltip / badge) |
|---|---|---|---|---|---|---|---|
| `minimax-m3` | chat | zdr | 0.30/1.20 | 60 | 3.200 | **false** (lenient) | ottimo orchestratore (tool call); JSON avvolto in prosa |
| `qwen3.7-plus` | chat | zdr | 0.40/1.60 | 60 | 4.300 | true (588 tok) | tool call ok |
| `qwen3.8-flash` | chat | zdr | 0.15/0.47 | 30 | 5.400 | — | |
| `deepseek-v4-flash` | chat | zdr_verify | 0.22/0.66 | 30 | 7.600 | true (78 tok) | 1M ctx; ZDR fino al 2026-08-31: conferma rinnovo |
| `deepseek-v4-pro` | chat | zdr_verify | 0.66/1.98 | 15 | 1.050 | — | escalation worker; stesso avviso ZDR |
| `kimi-k2.7-code` | chat | zdr | 0.95/4.00 | 60 | 1.350 | true (141 tok) | tool call più efficiente (62 tok) |
| `kimi-k3` | chat | zdr | 3.00/15.00 | 15 | 110 | — | quota minima: escluso dai preset |
| `glm-5.3-flash` | chat | zdr | 0.15/0.50 | 15 | 1.580 | true (81 tok) | probe model |
| `glm-5.3` / `glm-5.2` | chat | zdr | 1.40/4.40 | 15 / 60 | 220 / 880 | — | escalation |
| `hy3` | chat | zdr | 0.14/0.58 | 60 | 4.300 | true (495 tok) | reasoning in `delta.reasoning` |
| `longcat-2.0` | chat | zdr | 0.30/1.20 | 60 | 11.400 | true (209 tok) | tool call in 71 tok; cache $0.006 |
| `mimo-v2.5` | chat | zdr | 0.14/0.28 | 60 | 30.100 | true (948 tok) | **token-hungry**: nulla sotto ~700 token di budget → warning badge, mai default |
| `muse-spark-1.3-contributor` | responses | training | 0.10/0.20 | 60 | 45.300 | — | 403 fino all'opt-in; badge "addestramento dati" |
| `grok-4.6` | responses | retention_30d | 2.00/6.00 | 15 | 169 | — | escluso dai preset |
| `gpt-5.6-luna` | responses | retention_30d | 0.20/1.20 | 15 | 2.050 | — | escluso dai preset |

---

## 12. Hot reload table additions (v1 §10 rows still apply)

| Change | In-flight | Effect |
|---|---|---|
| template `role` changed while it has running instances | running instances keep role/toolset/budget captured at spawn and finish normally; their results still reach the caller | next spawn uses the new role; the orchestrator's toolset and Pool section update at its next iteration (e.g. worker→verifier makes `run_verifier` appear); `info` "Configurazione aggiornata" on the template console |
| last planner / verifier template removed mid-run | its running instance (if any) cancelled → tool result `ERROR: template removed — plan/verify inline`; the orchestrator continues | `run_planner`/`run_verifier` disappear from the toolset at the next iteration; Pool section shows "(nessun template …)" |
| last worker template removed mid-run | running instances cancelled → `partial` results returned | `delegate_tasks` disappears next iteration; the orchestrator answers directly |
| `maxParallelWorkers` lowered below the running count | running instances continue; `globalSem` re-reads the size on the next `acquire`, so new spawns queue until running ones finish | next batch validated against the new value |
| `maxParallelWorkers` / `maxWorkersPerRequest` / `correctionRounds` raised | — | applies to the next `delegate_tasks` (instances already counted stay counted) |
| `allowWorkerDelegation` / `maxDepth` toggled mid-request | running instances keep the toolset captured at spawn (a worker mid-loop gains/loses `delegate_tasks` only at its next iteration, since `toolDefsFor` is per iteration) | next delegation applies the new depth rule; nested batches in flight finish |
| template `maxConcurrent` | current semaphore holders unaffected | next acquire uses the new size |
| `role → orchestrator` (= main change) | old orchestrator's user run finishes normally (v1) and its request keeps its `RequestCtx` | `chat:send` targets the new orchestrator; old one's history stays on disk; its prompt gets the worker default only if it was untouched |
| routing (`model`, `fallbacks`, `escalation`, `modelFormats`) | current HTTP call continues | next `router.pick` (next attempt or iteration) uses the new chain; session `unavailable` marks persist |
| `temperature`, `budget` | instance keeps the budget captured at spawn | next spawn |
| template removed while its instances run | instances cancelled ("template removed by the user") → `ResultContract partial` returned to the orchestrator; ephemeral consoles removed (`template_removed`) | roster updated; `role` names in later contracts → "unknown role" error |
| planner/verifier template removed mid-run | its instance cancelled → tool result `ERROR: template removed` | orchestrator continues |
| `artifactThresholdChars` | — | applied to the next result parsed |
| `interactionPrompt` | — | orchestrator's next iteration (system prompt changes only here) |
| `config:resetAll` | every instance cancelled, ephemeral consoles removed (`reset`), artifacts dir and contracts log kept (logs are user data) | v1 |

---

## 13. Verification

### 13.1 `scripts/api-smoke.mjs` — new sections (7–12), all electron-free (`config.ts` is never loaded; a plain `AppConfig` object is passed)
7. **Responses parser (offline)**: mock `fetch` streaming these `data:` payloads split at odd byte boundaries: `response.created`; `output_item.added{item:{id:'rs1',type:'reasoning'}}`;
   `reasoning_summary_part.added`; `reasoning_summary_text.delta{delta:'Pens'}`, `{delta:'o…'}`; `output_item.added{output_index:0,item:{id:'fc1',type:'function_call',call_id:'call_1',name:'get_time',arguments:''}}`;
   `function_call_arguments.delta{item_id:'fc1',delta:'{"tz":'}`, `{delta:'"Europe/Rome"}'}`; `function_call_arguments.done{item_id:'fc1',arguments:'{"tz":"Europe/Rome"}'}`;
   `output_item.added{item:{id:'m1',type:'message'}}`; `output_text.delta{delta:'Ciao '}`, `{delta:'mondo'}`; `response.completed{response:{output:[{type:'function_call'}],usage:{input_tokens:11,output_tokens:7,output_tokens_details:{reasoning_tokens:5},input_tokens_details:{cached_tokens:3}}}}`.
   Assert: reasoning `'Penso…'`, text `'Ciao mondo'`, one call `{id:'call_1', name:'get_time', args:'{"tz":"Europe/Rome"}'}` (no duplication from `.done`), `finishReason==='tool_calls'`,
   usage `11/7/5/3`, `calls===1`. Second synthetic stream with `response.failed{response:{error:{type:'DataPolicyError',message:'… https://opencode.ai/workspace/x'}}}` → `ApiError.type==='DataPolicyError'`.
8. **History conversion**: `toResponsesInput([system,user,assistant{content,reasoning_content,tool_calls[2]},tool,tool,assistant{content:null,tool_calls[1]}])` → 7 items, order `user, assistant, function_call×2, function_call_output×2, function_call`, no `reasoning`, `call_id` preserved; `buildResponsesBody` has flat tools + `instructions`.
9. **Live Responses call**: `gpt-5.6-luna`, `maxTokens: 60`, user `Rispondi solo con la parola ok.` → text non-empty, `usage.promptTokens>0`, `format==='responses'` in `llm` info; on 403/429 → `warn` not fail. Then `muse-spark-1.3-contributor` same prompt → expect `DataPolicyError` (or success if the user opted in → `info`).
10. **Router**: cfg with template `{model:'a', fallbacks:['b','c'], escalation:'e'}` → `chain()` = `[a,b,c]`, `chain({escalate})` = `[e,a,b,c]`; `markUnavailable('a', ModelError)` → `[b,c]`; all marked → `[a]`; `pick(t, 9).last===true`; `formatOf('grok-4.6')==='responses'`, `formatOf('gpt-x')`, override `modelFormats:{'hy3':'responses'}` wins; one toast per model (send spy).
11. **Contracts**: valid contract passes; missing `acceptance` → error; `objective` "fallo come detto" → error; batch with two `deliverable` equal → error naming ids; `parseResultContract` on strict JSON / fenced JSON / prose → statuses `ok`/`ok`/`partial`, `cost` overwritten, `task_id` forced; `run.status='cancelled'` → `partial` + note; 5000-char result with threshold 4000 → `artifact_ref` + summary 400 + file exists; `parsePlan` with 8 tasks → 6 + warning; `parseVerdict` prose → `no_blocker` summary.
12. **Scheduler with a fake model**: `InstancePool` + `AgentRuntime` + `PermissionGate` built with stub `send/bus` and a fake `OpenCodeClient.streamChat` scripted per model/message (returns a ResultContract text after `await sleep(50)`; a "chatty" variant that always emits a `read_file` tool call). Assert: 3 read-only + 2 side-effect tasks → max concurrent side-effect instances = 1, max concurrent read-only ≥ 2 (≤ `maxParallelWorkers`); 9 tasks → error string, `instancesSpawned` unchanged; duplicate objectives → error; re-run `t1` without verifier → error; after `runVerifier` → allowed with `attempt 2`; third run → error; `blocked` result → re-run allowed without verifier; chatty model with `maxToolCalls:2` → `partial`, `budgetHit==='maxToolCalls'`; `maxSeconds:1` with a slow fake → `partial`/`maxSeconds`; `x-opencode-session` header equals requestId on every fake call; `console:add` sent before the first `console:event` of each instance; cancelAll → all `partial` "cancelled by user".
    **Config-driven limits** (same harness, cfg object mutated between calls): `maxParallelWorkers:2` → 3 tasks rejected, 2 accepted; `maxParallelWorkers:6` → 6 tasks run with max observed concurrency 6 (not 4); `maxWorkersPerRequest:3` → 4th instance rejected with "left 0"; `correctionRounds:0` → correction rejected even after verifier, `blocked` continuation still allowed; `correctionRounds:2` → two corrections ok, third rejected; template `maxConcurrent:1` → that template's instances serialized while another template runs in parallel; `allowWorkerDelegation:true, maxDepth:3` → a fake worker issuing `delegate_tasks` spawns level-3 instances with ids `t1.t1`, cycle check rejects delegating back to its own template, `maxDepth:2` → tool absent from the worker toolset; zero worker templates → `delegate_tasks` absent, `pool.delegateTasks` (called directly) returns the "no worker template" error; zero planner/verifier templates → `toolDefsFor('orchestrator')` lacks the tools.

### 13.2 `scripts/e2e-smoke.mjs` scenarios (Playwright, isolated userData, ≈ $0.02–0.04 per run; models via env with cheap defaults)
Setup via `config:completeSetup` with (cheap, all measured today): Orchestratore `minimax-m3` [fallback `qwen3.7-plus`], Planner `minimax-m3`, Worker `muse-spark-1.3-contributor` [fallback `deepseek-v4-flash`] (exercises the 403 fallback), Worker Flash `longcat-2.0` [fallback `glm-5.3-flash`], Verificatore `glm-5.3-flash` [fallback `qwen3.7-plus`]; pool limits left at defaults (4/8/1). `mimo-v2.5` is deliberately not used (token-hungry under small budgets).
| # | Scenario | Assertions |
|---|---|---|
| 1 | Key import + setup | as v1 + `snap.agents` roles (1 orchestrator, 2 workers, planner, verifier), `limits.maxWorkersPerRequest===8` |
| 2 | **T0** `Ciao, come stai?` | run finishes; no `delegation` event; `task_end.tier==='T0'`; no `console:add` (instance count 0 in `runtime:getSnapshot`); header badge text `T0` |
| 3 | **T2 fan-out** `Crea due file nel workspace, in parallelo con due worker diversi: alpha.txt con "alpha" e beta.txt con "beta". Poi fai verificare il risultato.` | ≥2 `delegation` events with `tier==='T2'` and distinct `taskId`; ≥2 ephemeral consoles appeared (`console:add` captured via `page.exposeFunction` spy or `runtime:getSnapshot.instances.length>=2` while running); both files exist with disjoint names; every `delegation.result` parses as ResultContract with `cost.tokens>0`; `run_verifier` tool_call `done` + a `verdict` event on the verifier console; `logs/contracts.jsonl` has ≥ 2 `task`, ≥ 2 `result`, 1 `verifier` lines with this `requestId`; `task_end.tier==='T2'`; the two side-effect instances never overlapped (`task_start.ts`/`task_end.ts` intervals from their consoles) |
| 4 | **Fallback + toast** (Worker primary is `muse-spark-1.3-contributor`) | in scenario 3 (or a dedicated T1 `Scrivi gamma.txt…` if the Worker wasn't used): an `info` event matching `/^Fallback: muse-spark-1.3-contributor → deepseek-v4-flash/` on an instance console, an `app:toast` (spy) mentioning `muse-spark` with a `url`, `runtime:getSnapshot.unavailableModels` includes it, `llm_call.model==='deepseek-v4-flash'` after the fallback, no second 403 in the run. If the user already opted in (no 403) → check downgraded to `info` "opt-in active: fallback not exercised" |
| 5 | **Caps** `Delega in una sola chiamata delegate_tasks esattamente 12 task paralleli distinti, ognuno deve elencare il contenuto della cartella di lavoro con list_directory.` | a `tool_call` `delegate_tasks` whose `result.output` starts with `ERROR` and quotes `maxParallelWorkers=4`, **or** `instances <= cfg.maxParallelWorkers` per batch — and the run still ends with `task_end` + non-empty final text; total instances of the request ≤ `cfg.maxWorkersPerRequest` (8 at defaults) |
| 6 | **Ephemeral cleanup** | after scenario 5 starts, `runtime:getSnapshot.instances` contains no id from scenario 3; `console:remove{reason:'next_request'}` observed |
| 7 | **Permission modal + hot reload** (v1 task 2) | orchestrator asked to run `ls -la` "tu stesso" → it has no `run_command`: expect a T1 delegation whose instance triggers the modal (click "Consenti" through the real modal, as v1); mid-run rename Worker Flash → "Flash Senior" and change `maxParallelWorkers` to 2 → console history kept, UI shows new name, next `delegate_tasks` cap message (if any) says 2 |
| 8 | Settings drawer | opens; contains "Pool", "Ripristina prompt del ruolo", "Apri log contratti" texts; role chips present |
| 9 | Persistence | `config.json` has `version:2`, roles, no `maxDelegationDepth`; `state/console/` has only template ids (no `#`); `state/artifacts/index.json` exists; key not in clear |
| 10 | Restart-safety (cheap) | `console:getEvents(main)` last `delegation` events carry `contract` and `result` (what the card needs after restart) |
| 11 | **Not capped at 4**: `config:update({maxParallelWorkers: 6, maxWorkersPerRequest: 8})`, then `Crea in parallelo, con un solo delegate_tasks e sei worker distinti, i file f1.txt … f6.txt contenenti il proprio nome.` | one `delegate_tasks` `tool_call` whose parsed `args.tasks.length===6` and whose result is not an ERROR; 6 `delegation` events with distinct `taskId`; `runtime:getSnapshot.instances.length>=6` observed at some poll (or 6 `console:add`); 6 files exist; total request cost logged (workers are `longcat-2.0`/`deepseek-v4-flash`). Reset limits to 4/8 afterwards |
| 12 | **Zero verifier templates**: `config:removeAgent(Verificatore)`, then `Crea due file: uno.txt e due.txt con il proprio nome, usando due worker.` | run completes with `task_end` + final text; no `run_verifier` `tool_call` anywhere; `delegate_tasks` tool schema shown in the orchestrator's `llm_call`? (not observable) → instead assert `console:getEvents(main)` has no `error` event and `runtime:getSnapshot` idle; Settings row count decreased; `Verificatore` console removed |
| 13 | **Orchestrator-only pool**: remove Planner, Worker, Worker Flash (`config:removeAgent` ×3 succeed; removing the orchestrator throws), then `Quanti file .txt ci sono nella cartella di lavoro?` and `Scrivi una poesia di due versi.` | both runs finish `done` with non-empty text; zero `delegation` events; the first answer mentions the correct count (orchestrator used `list_directory`); `task_end.tier==='T0'` for both; the Pool section text in the system prompt (dev log) contains "nessun template worker" |
Cost guard: the script sums `task_end.usage.cost` over all consoles and fails if > $0.10 (measured budget: ≈ $0.03–0.06 with the models above).

### 13.3 Manual checklist additions
Wizard shows the recommended pool and cost/privacy badges; change Worker role to verifier → orchestrator prompt's Pool section updates (verify via `--dev` log);
close an instance console mid-run → card shows `Parziale`; `Ripristina prompt del ruolo`; open contracts log; T3 request (`Analizza questo repository e proponi un piano di refactoring in 3 aree`) → `run_planner` then ≥1 `delegate_tasks(T3)`, orchestrator `llm_call.model` switches to `glm-5.3` after T3 is declared.

---

## 14. Implementation order

**Step 0 (shared, first commit)**: `types.d.ts` §2 delta, preload/ipc channel lists §3, `prompt.ts` `DEFAULT_PROMPTS` text §9, `config.ts` `RECOMMENDED_POOL` + `DEFAULT_BUDGET` constants. Both workstreams build against this.

**Workstream A — main**
1. `util.ts` (Semaphore, Mutex, normalizeKey, appendLine) → `api.ts` (DataPolicyError, format dispatch, `readSse`, MODEL_TABLE) → `responses.ts` → `router.ts`; smoke §7–10.
2. `contracts.ts` + `artifacts.ts`; smoke §11.
3. `config.ts` migration, `POOL_RANGES` clamps, `MODEL_TABLE`, presets, role invariant (promote/demote), cap removal; `prompt.ts` builders (Pool/Limits sections from live cfg); `state.ts` ephemeral entries.
4. `tools.ts` per-role catalogue + 4 orchestrator tools; `agent.ts` instance mode, router loop, budget, partial, sequential tools, session header.
5. `pool.ts` + `orchestrator.ts` rewiring (RequestCtx, cascade, snapshot); smoke §12.
6. `ipc.ts`/`preload.ts`/`main.ts` wiring (ContractsLog, ArtifactStore, ModelRouter, `shell:openExternal` allowlist).

**Workstream B — renderer** (against Step 0, with the v1 in-file mock `window.api` extended with `console:add/remove` and synthetic `verdict`/extended events)
1. `dom.ts` badges/formatters, `styles.css`.
2. `console.ts`: `verdict`, extended events, `partial`, tier badge, ephemeral header/budget line/close.
3. `workbench.ts`: instances map, add/remove, flood guard, snapshot restore, tier.
4. `settings.ts`: role/routing/badges/`maxConcurrent`, editable Pool section with `poolRanges` warnings, reset prompt, open log; `modals.ts` toast url.
5. `wizard.ts`: three presets (consigliato / economico Muse Spark / vuoto), unrestricted add/duplicate/remove, role + routing per card, `zdr_verify` info line, step 3.

**Integration**: `npm run build` → `node scripts/api-smoke.mjs` → `node scripts/e2e-smoke.mjs` → §13.3 manual pass → update `docs/PLAN.md` §2/§3 pointers to this file.

---

## 15. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Models ignore the JSON ResultContract format (prose, fences, extra text) | 3-stage parser (§7.3) never fails: prose becomes `partial` with `unverified` note; `task_id`/`cost` always system-set; orchestrator prompt tells it to read `status`; verifier catches missing deliverables. Template `temperature` default suggested 0.2 for workers in the wizard hint. |
| Parallel instances hammer per-model rate limits (429) | per-template `maxConcurrent` semaphore (default = `maxParallelWorkers`) + global `maxParallelWorkers`; 429 switches model along the fallback chain instead of waiting; same-model backoff only when the chain is exhausted; the preset spreads roles over different quota buckets and puts wide fan-out on `longcat-2.0` (11.4 k req/5 h). |
| User raises limits far above the preset (16 parallel, 32 per request, depth 4) | allowed by design (user's explicit choice) but flagged: inline warnings above `recommendedMax`, `delegate_tasks` results echo the live limits, cost guard visible in the header totals; defaults never change. |
| Ephemeral console flood (up to `maxWorkersPerRequest` instances + templates) | auto-collapse beyond `maxParallelWorkers` visible instances; consoles removed at next request; orchestrator cards carry the full contract/result so instance consoles are optional; `✕` close per console. |
| Wrong worker model for JSON contracts (e.g. `minimax-m3` lenient, `mimo-v2.5` token-hungry) | `MODEL_TABLE.jsonStrict/notes` drive badges in the routing editor; lenient parse stage is the normal path for such models; budget `partial` protects against the reasoning sink; presets only use strict models as worker/verifier primaries. |
| Responses reasoning / echo requirements differ per model | reasoning items are never echoed (verified for tool loops); on a 400 mentioning `reasoning`/`item` the adapter logs the body and the run falls to the chat-format fallback model (chain); no `reasoning` param sent; `function_call_arguments.done` reconciliation handles servers that send only `.done`. |
| `muse-spark-1.3-contributor` 403 until opt-in | `DataPolicyError` → immediate fallback, session-wide `unavailable` mark (no repeated 403s), single toast with the opt-in link (`shell:openExternal` limited to opencode.ai); wizard shows the `training` privacy badge so the user knows what opting in implies. |
| Orchestrator does the work itself (RULE ZERO violation) or over-delegates T0 chats | no write/command tools on the orchestrator (structural); prompt makes T0 the default; tier badge makes behaviour visible; user can tune the prompt per template. |
| Side-effect races between a read-only task and a side-effect task | only side-effect tasks are serialized (req); prompt asks for disjoint tasks; verifier flags contradictions; `deliverable` duplicates rejected in code. |
| Instance cost/latency creep (`maxWorkersPerRequest` × 8 k tokens) | budgets in code (tokens/tool calls/seconds) with `partial`; `max_tokens` per call derived from the remaining budget; `maxWorkersPerRequest` cap (default 8); artifacts keep orchestrator context small (summary 400 chars). |
| Byte-identical prompt broken by config edits | accepted: only user edits change the orchestrator system prompt; instances have zero dynamic data in the system prompt; date lives in the user message. |
| Correction loop abuse (re-run without fix) | `correctionRounds` (default 1) re-runs per `task_id`, only after `run_verifier` (one `blocked` continuation allowed); total instances ≤ `maxWorkersPerRequest` including corrections; escalation model used for the correction. |
| `#` in console ids reaching disk or the renderer DOM | `StateStore.ensure` treats `#` ids as in-memory; ids only appear in `data-agent-id` attributes and Map keys; never in file names. |
| Planner output unusable | `parsePlan` drops invalid tasks with warnings and truncates to 6; the orchestrator can still decompose by itself (prompt step 1 says "poi esegui il piano"; a failed plan returns `tasks:[]` + raw text). |
| Renderer ignores instance events arriving before `console:add` | `console:add` is sent synchronously before `state.ensure`/first `emit` (§6.3); `runtime:getSnapshot.instances` restores on reload; unknown ids are dropped as in v1. |
