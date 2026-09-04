// Shared ambient types for Agents Pool — transcribed verbatim from docs/PLAN.md §2 (data model)
// and §3 (IPC contract), then extended with the v2 delta of docs/PLAN-v2.md §2 (types) and §3 (IPC).
// This file is types-only (.d.ts, never emitted); it is the frozen contract between the main-process
// and renderer implementation streams (PLAN §1, §13 "Step 0" / PLAN-v2 §14 "Step 0").
//
// ---------------------------------------------------------------------------------------------
// v2 delta (PLAN-v2 §2/§3) — breaking changes and the compatibility shims that keep the v1 tree
// compiling until each workstream lands. Every shim is marked `TODO(v2-A)` / `TODO(v2-B)` inline.
//   1. AppConfig.version: `1` → `1 | 2`. Widened, not switched: config.ts still writes 1.
//      TODO(v2-A): narrow to `2` with the migration (§11.1).
//   2. `maxDelegationDepth` → `maxDepth` (AppConfig/ConfigSnapshot/ConfigPatch). `maxDepth` is
//      added now; the v1 field is kept as **deprecated** (required in AppConfig, optional in
//      ConfigSnapshot, accepted-and-ignored in ConfigPatch) because config.ts/orchestrator.ts/
//      prompt.ts/settings.ts still read it. TODO(v2-A/B): delete it with those rewrites.
//   3. Delegation tools `delegate_task` / `list_agents` are removed in favour of `delegate_tasks`
//      / `run_planner` / `run_verifier` / `read_artifact` (PLAN-v2 §8). No type in this file was
//      tied to them (tool names live in main/tools.ts), so nothing was deleted here.
//   4. `'partial'` is a new status of RunStatus, TaskResult.status, RunFinished.status,
//      ConsoleEvent 'task_end'.status and ConsoleEvent 'delegation'.status (union widening).
//      Renderer status maps are `Record<string, …>` so they keep compiling.
//   5. TaskOrigin's `delegation` member gains requestId/taskId/role/attempt, RunState gains
//      requestId/role/budget/toolCalls/budgetHit, RuntimeSnapshot gains instances/
//      unavailableModels/currentTier, AgentConfig gains role/fallbacks/escalation/temperature/
//      budget/maxConcurrent, AppInfo gains the pool presets, ModelInfo gains format/privacy and
//      the MODEL_TABLE badges: all **optional for now** (the v1 literals in agent.ts,
//      orchestrator.ts, config.ts, api.ts and main.ts do not fill them yet).
//      TODO(v2-A): make them required as each producer starts writing them (PLAN-v2 §14).
//   6. New ConsoleEvent kind `verdict`; new IPC channels (§3): invoke `config:defaultPrompt`,
//      `instance:close`, `logs:openContracts`, `shell:openExternal`; events `console:add`,
//      `console:remove`; `app:toast` gains an optional opt-in `url`.
// ---------------------------------------------------------------------------------------------
//
// Consistency check performed while transcribing v1 (per scaffolding instructions: resolve any
// inconsistency between §2 and §3 in favour of §3, the IPC contract, and note it here):
//   - No inconsistencies were found. Every type referenced by InvokeMap/EventMap in §3
//     (AppInfo, KeyValidationResult, ModelInfo, ConfigSnapshot, ConfigPatch, SetupPayload,
//     AgentInput, AgentId, ConsoleEvent, RuntimeSnapshot, PermissionDecision, RunFinished,
//     ConfigChanged, ConsolePatch, AgentStatusUpdate, PermissionRequest, AskUserRequest) is
//     defined in §2 with a matching shape, so §2 and §3 were transcribed as-is.
//   - `ToolDef` (mentioned in PLAN §4/§6 as the OpenAI-style {type:'function', function:{...}}
//     tool schema) is intentionally NOT included here: PLAN §1's layout comment scopes this file
//     to "§2, §3" only, and ToolDef is a main-process-internal type (used by api.ts/tools.ts),
//     never crossing the IPC boundary or appearing in InvokeMap/EventMap. Same reasoning for the
//     v2 main-only types (RequestCtx, ContractsLog records, ModelTableEntry): they stay in main/.
//   - The preload.ts code sample shown alongside §3 is implementation, not a type declaration;
//     it is intentionally not reproduced here (scaffolding must not add implementation files).

export type AgentId = string;                 // "a_" + 8 hex; instances: "<templateId>#<path>[-rN]"
export type PermissionMode = 'strict' | 'balanced' | 'relaxed';

// ---------- roles / routing / budget (v2 §2) ----------
export type AgentRole = 'orchestrator' | 'planner' | 'worker' | 'verifier';
export type ModelFormat = 'chat' | 'responses';
export type Tier = 'T0' | 'T1' | 'T2' | 'T3';
export type ModelPrivacy = 'zdr' | 'zdr_verify' | 'retention_30d' | 'training';
export interface Budget { maxTokens: number; maxToolCalls: number; maxSeconds: number }
export interface Range { min: number; max: number; default: number; recommendedMax: number }   // UI warns above recommendedMax
export interface PoolRanges {
  maxParallelWorkers: Range; maxWorkersPerRequest: Range; correctionRounds: Range; maxDepth: Range; artifactThresholdChars: Range;
}

// ---------- config ----------
export interface AgentConfig {                 // a ROLE TEMPLATE in v2 (instances are not persisted)
  id: AgentId; name: string; model: string; prompt: string; color: string;   // color: #rrggbb
  maxIterations: number;                       // default 40
  createdAt: number;
  // v2 (§2). TODO(v2-A): `role` and `fallbacks` become required once config.ts fills them in
  // makeAgent()/sanitize() (§11.1 migration); readers must default to 'worker' / [] until then.
  role?: AgentRole;
  fallbacks?: string[];
  escalation?: string;
  temperature?: number;                        // 0..2
  budget?: Budget;
  maxConcurrent?: number;                      // parallel instances of THIS template (default = cfg.maxParallelWorkers)
}
export interface AgentInput {                  // null = clear the field
  name: string; model: string; prompt: string; color?: string; maxIterations?: number;
  role?: AgentRole; fallbacks?: string[]; escalation?: string | null; temperature?: number | null;
  budget?: Budget | null; maxConcurrent?: number | null;
}
export interface AppConfig {                    // config.json (main only)
  version: 1 | 2;                              // BREAKING: target 2. TODO(v2-A): narrow to 2 with the migration (§11.1)
  apiKey: string | null;                       // plain fallback
  apiKeyEnc: string | null;                    // base64(safeStorage.encryptString) preferred
  workspacePath: string | null;
  agents: AgentConfig[];                       // role templates; exactly one 'orchestrator' (= mainAgentId)
  mainAgentId: AgentId | null;
  interactionPrompt: string;                   // UI: "Indicazioni per l'orchestratore" (orchestrator prompt only)
  permissionMode: PermissionMode;              // default 'balanced'
  commandAllowlist: string[];                  // persistent patterns (settings-editable)
  showReasoning: boolean;                      // default true
  permissionTimeoutMs: number;                 // default 300000
  /** @deprecated BREAKING (§2): replaced by `maxDepth`. TODO(v2-A): remove with orchestrator.ts/prompt.ts. */
  maxDelegationDepth: number;                  // v1 default 3
  setupComplete: boolean;
  window?: { width: number; height: number; x?: number; y?: number };
  // v2 pool limits — SETTINGS (defaults = the lead's design; ranges in POOL_RANGES, §11.3).
  // TODO(v2-A): required once config.ts defaults()/sanitize() write them.
  maxParallelWorkers?: number;                 // default 4,  1..16  (tasks per delegate_tasks batch / global instance semaphore)
  maxWorkersPerRequest?: number;               // default 8,  1..32  (instances per user request, incl. planner/verifier/corrections)
  correctionRounds?: number;                   // default 1,  0..3   (re-runs of a task_id after run_verifier)
  allowWorkerDelegation?: boolean;             // default false      (false → hub-and-spoke, depth exactly 2)
  maxDepth?: number;                           // default 2,  2..4   (used only when allowWorkerDelegation)
  artifactThresholdChars?: number;             // default 4000, 1000..20000
  modelFormats?: Record<string, ModelFormat>;  // overrides of the prefix map
}
export interface AgentView extends AgentConfig {
  description: string; isMain: boolean;        // description derived (§2.5)
  // v2: ephemeral worker-instance view built in pool.ts (§2 "Ephemeral instance view")
  ephemeral?: true; parentId?: AgentId; taskId?: string; objective?: string; requestId?: string;
}
export interface ConfigSnapshot {              // what the renderer sees
  hasApiKey: boolean; apiKeyMasked: string | null;      // "sk-…a1b2"
  workspacePath: string | null; agents: AgentView[]; mainAgentId: AgentId | null;
  interactionPrompt: string; permissionMode: PermissionMode; commandAllowlist: string[];
  showReasoning: boolean; permissionTimeoutMs: number; setupComplete: boolean;
  /** @deprecated BREAKING (§2): replaced by `maxDepth`. TODO(v2-A/B): remove with config.ts/settings.ts. */
  maxDelegationDepth?: number;
  // v2 pool limits. TODO(v2-A): required once ConfigStore.snapshot() emits them.
  maxParallelWorkers?: number; maxWorkersPerRequest?: number; correctionRounds?: number;
  allowWorkerDelegation?: boolean; maxDepth?: number; artifactThresholdChars?: number;
  modelFormats?: Record<string, ModelFormat>;
}
export type ConfigPatch = Partial<Pick<AppConfig,'workspacePath'|'interactionPrompt'|'permissionMode'|'commandAllowlist'|'showReasoning'|'permissionTimeoutMs'
  |'mainAgentId'|'maxParallelWorkers'|'maxWorkersPerRequest'|'correctionRounds'|'allowWorkerDelegation'|'maxDepth'|'artifactThresholdChars'|'modelFormats'>>
  /** @deprecated BREAKING (§3): accepted and ignored by config:update. TODO(v2-A/B): remove with config.ts/settings.ts. */
  & { maxDelegationDepth?: number };
export interface SetupPayload { workspacePath: string; agents: AgentInput[]; mainIndex: number; interactionPrompt: string }
export interface ConfigChanged {
  snapshot: ConfigSnapshot;
  diff: { added: AgentId[]; removed: AgentId[]; updated: AgentId[]; mainChanged: boolean; fields: string[] };
}
export interface AppInfo {
  version: string; platform: NodeJS.Platform | string; arch: string; userDataPath: string;
  palette: string[]; defaultModel: string; probeModel: string; hasApiKey: boolean; setupComplete: boolean; locale: string;
  // v2 (§2, §1 main.ts): pool ranges + wizard presets. TODO(v2-A): required once main.ts fills them.
  poolRanges?: PoolRanges; recommendedPool?: AgentInput[]; economyPool?: AgentInput[]; emptyPool?: AgentInput[]; defaultBudget?: Budget;
}
export interface ModelInfo {
  id: string; name: string; costIn?: number; costOut?: number; contextLimit?: number; reasoning?: boolean; toolCall?: boolean;
  // v2: always filled by api.ts::listModels (MODEL_TABLE over models.dev; unknown ids → 'chat'/'zdr').
  // TODO(v2-A): make `format`/`privacy` required once listModels merges MODEL_TABLE (§1 api.ts).
  format?: ModelFormat; privacy?: ModelPrivacy;
  bucketUsd?: number; reqPer5h?: number; jsonStrict?: boolean; notes?: string;   // MODEL_TABLE (§11.3)
  unavailable?: boolean;                                                        // session state (ModelRouter)
}
export type KeyValidationResult =
  | { ok: true; masked: string }
  | { ok: false; reason: 'auth' | 'network' | 'model' | 'rate_limit' | 'unknown'; message: string };

// ---------- chat history (OpenAI wire format; system msg NOT stored) ----------
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
export interface AgentState { sessionId: string; history: ChatMessage[]; usage: Usage; updatedAt: number }   // state/agents/<id>.json
export interface Usage { promptTokens: number; completionTokens: number; reasoningTokens: number; cachedTokens: number; cost: number; calls: number; estimated: boolean }

// ---------- contracts (v2 §2, §7; mirrored by the validators in main/contracts.ts) ----------
export type TaskInput = { type: 'text'; content: string } | { type: 'artifact_ref'; id: string } | { type: 'file'; path: string };
export interface TaskContract {
  task_id: string; role: string; objective: string; inputs: TaskInput[]; constraints: string[]; deliverable: string;
  acceptance: string; side_effects: boolean; budget?: Partial<Budget>;
}
export type ResultStatus = 'ok' | 'blocked' | 'partial';
export interface ArtifactRef { artifact_ref: string; summary: string; chars: number }   // result > cfg.artifactThresholdChars (§7.3)
export interface ResultContract {
  task_id: string; status: ResultStatus; result: string | ArtifactRef;
  assumptions: string[]; unverified: string[]; blocking_question: string | null;
  cost: { tokens: number; tool_calls: number; seconds: number; usd: number; model: string };   // system-filled
}
export type Severity = 'blocker' | 'major' | 'minor';
export interface VerifierFinding { severity: Severity; task_id?: string; issue: string; fix: string }
export interface Verdict { findings: VerifierFinding[]; verdict: 'blocker' | 'no_blocker'; summary: string }
export interface PlanTask extends TaskContract { depends_on?: string[] }
export interface Plan { tasks: PlanTask[]; assumptions: string[]; if_false: string[]; warnings: string[]; raw?: string }   // parsePlan (§7.4)

// ---------- artifacts (v2 §7.6) ----------
export interface ArtifactMeta { requestId: string; taskId: string; chars: number; summary: string; createdAt: number }
export interface ArtifactRecord { id: string; requestId: string; taskId: string; chars: number; createdAt: number; content: string }   // state/artifacts/<requestId>/<id>.json
export type ArtifactIndex = Record<string, ArtifactMeta>;                                                                             // state/artifacts/index.json

// ---------- tasks / runs ----------
export type TaskOrigin =
  | { kind: 'user' }
  | { kind: 'delegation'; fromAgentId: AgentId; fromName: string; parentRunId: string; callId: string; depth: number;
      // v2 (§2). TODO(v2-A): required once pool.ts/orchestrator.ts build delegation origins.
      requestId?: string; taskId?: string; role?: AgentRole; attempt?: number };   // attempt: 1 = first run
export interface Task { id: string; agentId: AgentId; origin: TaskOrigin; input: string; context?: string; createdAt: number; contract?: TaskContract }
export type RunStatus = 'queued'|'running'|'waiting_permission'|'waiting_user'|'waiting_delegate'|'done'|'error'|'cancelled'|'partial';
export interface RunState { runId: string; taskId: string; agentId: AgentId; origin: TaskOrigin; status: RunStatus; iteration: number;
  startedAt: number; finishedAt?: number; usage: Usage; ancestry: AgentId[]; /* agents up the chain incl. self */ childRunIds: string[];
  // v2 (§6.2). TODO(v2-A): requestId/role/toolCalls become required with agent.ts instance mode.
  requestId?: string; role?: AgentRole; budget?: Budget; toolCalls?: number; budgetHit?: keyof Budget }
export interface TaskResult { status: 'done'|'error'|'cancelled'|'partial'; text: string; runId: string; usage: Usage;
  budgetHit?: keyof Budget; toolCalls?: number }                                   // TODO(v2-A): toolCalls required with instance mode
export type AgentStatus = 'idle'|'thinking'|'streaming'|'tool'|'waiting_permission'|'waiting_user'|'waiting_delegate'|'error';
export interface AgentStatusUpdate { agentId: AgentId; status: AgentStatus; runId: string | null; queueLength: number; usage: Usage; detail?: string }
export interface RunFinished { runId: string; agentId: AgentId; status: 'done'|'error'|'cancelled'|'partial'; isUserRun: boolean; finalText: string; usage: Usage; tier?: Tier }
export interface RuntimeSnapshot {
  agents: Record<AgentId, { status: AgentStatus; runId: string | null; queueLength: number; usage: Usage; lastSeq: number }>;
  pendingPermissions: PermissionRequest[]; pendingAsks: AskUserRequest[];
  activeUserRun: { runId: string; agentId: AgentId; startedAt: number } | null; queuedUserMessages: number;
  // v2 (§2). TODO(v2-A): required once orchestrator.snapshot() reports the live pool.
  instances?: AgentView[]; unavailableModels?: string[]; currentTier?: Tier | null;
}

// ---------- permissions ----------
export type CommandClass = 'benign' | 'sensitive' | 'privileged' | 'destructive';
export type PermissionKind = 'fs_read_outside' | 'fs_read_protected' | 'fs_write_inside' | 'fs_write_outside' | 'fs_delete_inside' | 'fs_delete_outside' | 'command';
export interface PermissionRequest {
  id: string; agentId: AgentId; agentName: string; agentColor: string; runId: string; kind: PermissionKind;
  commandClass?: CommandClass; summary: string;                 // "Eseguire: npm test" / "Scrivere fuori dal workspace: /etc/hosts"
  detail: { tool: string; args: Record<string, unknown>; command?: string; cwd?: string; path?: string; hits: string[] };
  sessionPattern: string | null;                                // offered "allow for session" pattern; null = not offered
  createdAt: number; timeoutMs: number;
}
export type PermissionDecision = 'allow' | 'allow_session' | 'deny';
export type PermissionOutcome = PermissionDecision | 'timeout' | 'cancelled' | 'auto_allow' | 'auto_deny';
export interface AskUserRequest { id: string; agentId: AgentId; agentName: string; agentColor: string; runId: string; question: string; options?: string[]; createdAt: number; timeoutMs: number }

// ---------- console events (discriminated union) ----------
export interface EventBase { id: string; agentId: AgentId; runId: string | null; seq: number; ts: number }
export type ConsoleEvent = EventBase & (
  | { kind: 'user_input'; text: string }                                                         // orchestrator console only
  | { kind: 'task_start'; origin: TaskOrigin; input: string; context?: string; contract?: TaskContract; budget?: Budget }
  | { kind: 'task_end'; status: 'done'|'error'|'cancelled'|'partial'; durationMs: number; usage: Usage; iterations: number;
      tier?: Tier; instances?: number; agentsUsed?: string[]; result?: ResultContract; budgetHit?: keyof Budget; toolCalls?: number }
  | { kind: 'llm_call'; model: string; format?: ModelFormat; iteration: number; messageCount: number; status: 'streaming'|'done'|'error';
      finishReason?: string | null; usage?: Usage; durationMs?: number }
  | { kind: 'reasoning'; text: string }                                                          // appended via patch
  | { kind: 'text'; text: string; final: boolean }                                               // appended; final=true on run's last text
  | { kind: 'tool_call'; callId: string; name: string; argsRaw: string; args?: Record<string, unknown>; parseError?: string;
      status: 'streaming'|'pending_permission'|'running'|'done'|'error'|'denied';
      result?: { ok: boolean; output: string; truncated: boolean; fullLength: number; durationMs: number } }
  | { kind: 'delegation'; callId: string; toAgentId: AgentId | null; toName: string; task: string; childRunId?: string;
      status: 'queued'|'running'|'done'|'error'|'cancelled'|'rejected'|'partial'|'blocked'; resultPreview?: string; durationMs?: number;
      taskId?: string; tier?: Tier; attempt?: number; depth?: number; instanceId?: AgentId; contract?: TaskContract; result?: ResultContract }
  | { kind: 'verdict'; taskIds: string[]; verdict: Verdict; critical: boolean }                   // verifier console (§6.4)
  | { kind: 'permission'; requestId: string; permissionKind: PermissionKind; commandClass?: CommandClass; summary: string; status: PermissionOutcome | 'pending' }
  | { kind: 'ask_user'; requestId: string; question: string; status: 'pending'|'answered'|'timeout'|'cancelled'; answer?: string }
  | { kind: 'error'; message: string; retryable: boolean; retryInMs?: number; code?: string }
  | { kind: 'info'; message: string }
);
export interface ConsolePatch { agentId: AgentId; eventId: string; append?: string; set?: Record<string, unknown> }

// ---------- IPC contract (window.api) ----------
export interface InvokeMap {                                        // renderer → main (ipcMain.handle)
  'app:getInfo':            () => AppInfo;
  'key:set':                (apiKey: string) => KeyValidationResult;        // validates (§4.2); saves only if ok
  'key:importFromOpencode': () => KeyValidationResult;                      // reads ~/.local/share/opencode/auth.json (opencode-go.key), validates, saves
  'key:clear':              () => void;                                     // back to KeyScreen; agents cancelled
  'models:list':            (refresh?: boolean) => ModelInfo[];
  'config:get':             () => ConfigSnapshot;
  'config:update':          (patch: ConfigPatch) => ConfigSnapshot;         // pool fields clamped to POOL_RANGES; legacy maxDelegationDepth ignored
  'config:completeSetup':   (p: SetupPayload) => ConfigSnapshot;            // assigns ids/colors, setupComplete=true, starts runtimes; mainIndex ⇒ role 'orchestrator'
  'config:addAgent':        (a: AgentInput) => ConfigSnapshot;              // no count cap in v2; role defaults to 'worker'
  'config:updateAgent':     (id: AgentId, patch: Partial<AgentInput>) => ConfigSnapshot;   // {role:'orchestrator'} promotes it and demotes the previous one
  'config:removeAgent':     (id: AgentId) => ConfigSnapshot;                // throws only for the orchestrator (last planner/verifier/worker may go)
  'config:defaultPrompt':   (role: AgentRole) => string;                    // Italian default text for the role (§9)
  'config:chooseWorkspace': () => string | null;                            // dialog.showOpenDialog openDirectory+createDirectory
  'config:resetAll':        () => void;                                     // wipes config+state (keeps key), returns to Wizard
  'chat:send':              (text: string) => { runId: string; queued: boolean };   // to the orchestrator; queued if busy
  'chat:cancel':            (runId?: string) => void;                       // no arg = cancel everything (instances included) + clear all queues
  'agent:cancel':           (agentId: AgentId) => void;                     // template or instance id; cancels that run (+ its children)
  'agent:clearHistory':     (agentId: AgentId) => void;                     // orchestrator only (instances have no persisted history); only when idle
  'instance:close':         (instanceId: AgentId) => void;                  // cancel if running, drop console, console:remove{reason:'closed'}
  'console:getEvents':      (agentId: AgentId, opts: { beforeSeq?: number; limit: number }) => ConsoleEvent[];  // ascending by seq; instance ids served from memory
  'console:clear':          (agentId: AgentId) => void;                     // clears log only, not history
  'runtime:getSnapshot':    () => RuntimeSnapshot;
  'permission:respond':     (requestId: string, decision: PermissionDecision, pattern?: string) => void;   // unknown id → no-op; pattern = user-edited session pattern (optional)
  'askUser:respond':        (requestId: string, answer: string | null) => void;          // null = dismissed
  'shell:openPath':         (p: string) => void;                            // only workspacePath or its children
  'logs:openContracts':     () => void;                                     // shell.openPath(userData/logs/contracts.jsonl); creates the file if absent
  'shell:openExternal':     (url: string) => void;                          // only https://opencode.ai/** (opt-in link from a DataPolicyError toast)
}
export interface EventMap {                                         // main → renderer (webContents.send)
  'config:changed':      ConfigChanged;
  'console:event':       ConsoleEvent;
  'console:patch':       ConsolePatch;
  'console:add':         AgentView;                                  // ephemeral view; ALWAYS sent before its first console:event
  'console:remove':      { agentId: AgentId; reason: 'closed'|'next_request'|'template_removed'|'reset' };
  'agent:status':        AgentStatusUpdate;
  'permission:request':  PermissionRequest;
  'permission:resolved': { requestId: string; outcome: PermissionOutcome };
  'askUser:request':     AskUserRequest;
  'askUser:resolved':    { requestId: string };
  'run:finished':        RunFinished;
  'app:toast':           { level: 'info'|'warn'|'error'; message: string; url?: string };   // url → renderer button "Apri" → shell:openExternal
}
export interface Api {
  invoke<K extends keyof InvokeMap>(ch: K, ...args: Parameters<InvokeMap[K]>): Promise<ReturnType<InvokeMap[K]>>;
  on<K extends keyof EventMap>(ch: K, cb: (payload: EventMap[K]) => void): () => void;   // returns unsubscribe
}
declare global { interface Window { api: Api } }
