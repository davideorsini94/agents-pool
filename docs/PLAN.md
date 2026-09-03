# Agents Windows — Implementation Plan

Multi-console desktop window for a team of AI agents on OpenCode Go. Electron 44 + plain `tsc`, vanilla DOM renderer, zero runtime npm deps.
Read `docs/RESEARCH.md` first (verified API contract). UI strings in Italian, code/comments in English, agent system prompts in English.

Requirement map: R1 key+validation → §4/§9.1 · R2 wizard → §9.2 · R3 interaction protocol → §5.3/§10 · R4 tools → §6 · R5 permissions → §7 · R6/R8 consoles → §2.3/§9.3 · R7 hot reload → §10.

---

## 0. Key decisions

| Topic | Decision |
|---|---|
| Process split | Main owns everything stateful: config, API key, agent loops, tools, permissions, persistence. Renderer is a pure view over IPC (`window.api`). |
| Shared code | `src/shared/types.d.ts` is **types only** (`.d.ts` → not emitted, so it can sit outside both `rootDir`s). Runtime constants (palette, default model) live in main and reach the renderer via `app:getInfo`. |
| Renderer modules | Compiled to native ES modules (`module: es2022`), loaded with `<script type="module">`. Relative imports written with `.js` extension in TS source. |
| Console stream | Main coalesces streamed deltas into one `reasoning`/`text` event and sends `console:event` (new node) + `console:patch` (append/set). Renderer mirrors this 1:1 → DOM node per event, no re-render. |
| Tool call rendering | One event per tool call holds call + status + result (patched over time). |
| Delegation | `delegate_task` tool, synchronous from caller's perspective (awaits callee's final text). Ancestry-chain cycle check + depth limit 3 makes the wait graph acyclic (deadlock-free). |
| Permissions | 3 modes (`strict`/`balanced`/`relaxed`), 4 command classes (`benign`/`sensitive`/`privileged`/`destructive`), session allowlist only for `benign`. Requests go renderer-direct, never through an agent. |
| Persistence | `config.json` (atomic write, immediate) + `state/agents/<id>.json` (history, debounced 500 ms) + `state/console/<id>.json` (last 1500 events, debounced 1 s / throttled 5 s). |
| API key | Encrypted with Electron `safeStorage` when available (`apiKeyEnc`), plain fallback. Never sent to renderer (masked). |
| Security | `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, strict CSP, single-file preload. |

---

## 1. Directory / file layout (22 source files + config)

```
agents-windows/
├─ package.json                  scripts (given) + "build" key (§12.1)
├─ tsconfig.main.json            main + preload → dist/main (CJS)
├─ tsconfig.renderer.json        renderer → dist/renderer (ESM)
├─ build/icon.png                512×512 source icon (electron-builder derives icns/ico)
├─ docs/RESEARCH.md, docs/PLAN.md
├─ scripts/api-smoke.mjs         headless API-client test using OPENCODE_API_KEY (§13.3)
└─ src/
   ├─ shared/types.d.ts          ALL shared types: config, events, IPC maps, window.api (§2, §3)
   ├─ main/
   │  ├─ main.ts                 Electron entry: window, lifecycle, wiring, quit flush, --dev flag
   │  ├─ preload.ts              contextBridge → window.api {invoke, on} with channel whitelist
   │  ├─ ipc.ts                  ipcMain.handle registrations, broadcast(channel,payload), error mapping
   │  ├─ config.ts               ConfigStore: load/validate/save config.json, defaults, ids, colors, AgentView, 'changed' diff
   │  ├─ state.ts                StateStore: per-agent history + console log, debounced atomic writes, resume repair
   │  ├─ api.ts                  OpenCodeClient: fetch wrapper, validateKey, listModels(+models.dev), streamChat SSE parser, ApiError
   │  ├─ prompt.ts               buildSystemPrompt(agent, config, roster, env) — pure function
   │  ├─ agent.ts                AgentRuntime: FIFO task queue, run loop, delta accumulation, history trimming, cancel
   │  ├─ orchestrator.ts         Team: agent runtimes, user turn entry, delegate(), cycle/depth checks, applyConfig(), resume()
   │  ├─ tools.ts                Tool definitions (JSON schema) + executors (fs, search, run_command, system/network info)
   │  ├─ permissions.ts          PermissionGate: policy table, classifyCommand(), path sandbox, allowlists, pending requests/timeouts
   │  └─ util.ts                 ids, truncate, debounce/throttle, atomicWrite, log(), tokenEstimate, sleep
   └─ renderer/
      ├─ index.html              static shell + CSP; <script type="module" src="../../dist/renderer/index.js">
      ├─ styles.css              dark theme, grid layout, event styles, modals
      ├─ index.ts                bootstrap: getInfo → route to KeyScreen / Wizard / Workbench; global event subscriptions
      ├─ dom.ts                  h(), text(), fmt (bytes, ms, cost, tokens), escape, relative time
      ├─ key-screen.ts           KeyScreen: key input, validate, import-from-opencode, error mapping (IT)
      ├─ wizard.ts               SetupWizard: workspace → agents → main+protocol → review → completeSetup
      ├─ workbench.ts            Workbench: header, console grid, dock, focus, input box, event dispatch, run status
      ├─ console.ts              ConsoleView: event renderers, patch application, autoscroll, filters, DOM cap
      ├─ settings.ts             Settings panel: agents CRUD, protocol, workspace, mode, allowlist, key, reset
      └─ modals.ts               PermissionModal queue, AskUserModal, confirm()
```

---

## 2. Data model — `src/shared/types.d.ts`

```ts
export type AgentId = string;                 // "a_" + 8 hex
export type PermissionMode = 'strict' | 'balanced' | 'relaxed';

// ---------- config ----------
export interface AgentConfig {
  id: AgentId; name: string; model: string; prompt: string; color: string;   // color: #rrggbb
  maxIterations: number;                       // default 40
  createdAt: number;
}
export interface AgentInput { name: string; model: string; prompt: string; color?: string; maxIterations?: number }
export interface AppConfig {                    // config.json (main only)
  version: 1;
  apiKey: string | null;                       // plain fallback
  apiKeyEnc: string | null;                    // base64(safeStorage.encryptString) preferred
  workspacePath: string | null;
  agents: AgentConfig[];
  mainAgentId: AgentId | null;
  interactionPrompt: string;
  permissionMode: PermissionMode;              // default 'balanced'
  commandAllowlist: string[];                  // persistent patterns (settings-editable)
  showReasoning: boolean;                      // default true
  permissionTimeoutMs: number;                 // default 300000
  maxDelegationDepth: number;                  // default 3
  setupComplete: boolean;
  window?: { width: number; height: number; x?: number; y?: number };
}
export interface AgentView extends AgentConfig { description: string; isMain: boolean }   // description derived (§2.5)
export interface ConfigSnapshot {              // what the renderer sees
  hasApiKey: boolean; apiKeyMasked: string | null;      // "sk-…a1b2"
  workspacePath: string | null; agents: AgentView[]; mainAgentId: AgentId | null;
  interactionPrompt: string; permissionMode: PermissionMode; commandAllowlist: string[];
  showReasoning: boolean; permissionTimeoutMs: number; maxDelegationDepth: number; setupComplete: boolean;
}
export type ConfigPatch = Partial<Pick<AppConfig,'workspacePath'|'interactionPrompt'|'permissionMode'|'commandAllowlist'|'showReasoning'|'permissionTimeoutMs'|'maxDelegationDepth'|'mainAgentId'>>;
export interface SetupPayload { workspacePath: string; agents: AgentInput[]; mainIndex: number; interactionPrompt: string }
export interface ConfigChanged {
  snapshot: ConfigSnapshot;
  diff: { added: AgentId[]; removed: AgentId[]; updated: AgentId[]; mainChanged: boolean; fields: string[] };
}
export interface AppInfo {
  version: string; platform: NodeJS.Platform | string; arch: string; userDataPath: string;
  palette: string[]; defaultModel: string; probeModel: string; hasApiKey: boolean; setupComplete: boolean; locale: string;
}
export interface ModelInfo { id: string; name: string; costIn?: number; costOut?: number; contextLimit?: number; reasoning?: boolean; toolCall?: boolean }
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

// ---------- tasks / runs ----------
export type TaskOrigin =
  | { kind: 'user' }
  | { kind: 'delegation'; fromAgentId: AgentId; fromName: string; parentRunId: string; callId: string; depth: number };
export interface Task { id: string; agentId: AgentId; origin: TaskOrigin; input: string; context?: string; createdAt: number }
export type RunStatus = 'queued'|'running'|'waiting_permission'|'waiting_user'|'waiting_delegate'|'done'|'error'|'cancelled';
export interface RunState { runId: string; taskId: string; agentId: AgentId; origin: TaskOrigin; status: RunStatus; iteration: number;
  startedAt: number; finishedAt?: number; usage: Usage; ancestry: AgentId[]; /* agents up the chain incl. self */ childRunIds: string[] }
export interface TaskResult { status: 'done'|'error'|'cancelled'; text: string; runId: string; usage: Usage }
export type AgentStatus = 'idle'|'thinking'|'streaming'|'tool'|'waiting_permission'|'waiting_user'|'waiting_delegate'|'error';
export interface AgentStatusUpdate { agentId: AgentId; status: AgentStatus; runId: string | null; queueLength: number; usage: Usage; detail?: string }
export interface RunFinished { runId: string; agentId: AgentId; status: 'done'|'error'|'cancelled'; isUserRun: boolean; finalText: string; usage: Usage }
export interface RuntimeSnapshot {
  agents: Record<AgentId, { status: AgentStatus; runId: string | null; queueLength: number; usage: Usage; lastSeq: number }>;
  pendingPermissions: PermissionRequest[]; pendingAsks: AskUserRequest[];
  activeUserRun: { runId: string; agentId: AgentId; startedAt: number } | null; queuedUserMessages: number;
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
  | { kind: 'user_input'; text: string }                                                         // main console only
  | { kind: 'task_start'; origin: TaskOrigin; input: string; context?: string }
  | { kind: 'task_end'; status: 'done'|'error'|'cancelled'; durationMs: number; usage: Usage; iterations: number }
  | { kind: 'llm_call'; model: string; iteration: number; messageCount: number; status: 'streaming'|'done'|'error'; finishReason?: string | null; usage?: Usage; durationMs?: number }
  | { kind: 'reasoning'; text: string }                                                          // appended via patch
  | { kind: 'text'; text: string; final: boolean }                                               // appended; final=true on run's last text
  | { kind: 'tool_call'; callId: string; name: string; argsRaw: string; args?: Record<string, unknown>; parseError?: string;
      status: 'streaming'|'pending_permission'|'running'|'done'|'error'|'denied';
      result?: { ok: boolean; output: string; truncated: boolean; fullLength: number; durationMs: number } }
  | { kind: 'delegation'; callId: string; toAgentId: AgentId | null; toName: string; task: string; childRunId?: string;
      status: 'queued'|'running'|'done'|'error'|'cancelled'|'rejected'; resultPreview?: string; durationMs?: number }
  | { kind: 'permission'; requestId: string; permissionKind: PermissionKind; commandClass?: CommandClass; summary: string; status: PermissionOutcome | 'pending' }
  | { kind: 'ask_user'; requestId: string; question: string; status: 'pending'|'answered'|'timeout'|'cancelled'; answer?: string }
  | { kind: 'error'; message: string; retryable: boolean; retryInMs?: number; code?: string }
  | { kind: 'info'; message: string }
);
export interface ConsolePatch { agentId: AgentId; eventId: string; append?: string; set?: Record<string, unknown> }
```

### 2.5 Derived fields (computed in `config.ts`)
- `description`: line matching `/^(description|descrizione)\s*:\s*(.+)$/im` → group 2; else first non-empty line of `prompt`, stripped of leading `#*->` and whitespace; truncated to 80 chars + `…`.
- `color`: `PALETTE[i % 10]` where `i` = first palette index not used by existing agents, else `agents.length % 10`. Palette: `#3B82F6 #F59E0B #10B981 #EF4444 #8B5CF6 #EC4899 #14B8A6 #F97316 #84CC16 #06B6D4`.
- Console title = `name` · `description`; model badge separate.

---

## 3. IPC contract (`window.api`)

Preload exposes exactly two functions; channel names are whitelisted arrays in `preload.ts` (must match the keys below). Handlers throw `Error(message)` for unexpected failures (renderer shows toast); expected outcomes are returned as result objects.

```ts
export interface InvokeMap {                                        // renderer → main (ipcMain.handle)
  'app:getInfo':            () => AppInfo;
  'key:set':                (apiKey: string) => KeyValidationResult;        // validates (§4.2); saves only if ok
  'key:importFromOpencode': () => KeyValidationResult;                      // reads ~/.local/share/opencode/auth.json (opencode-go.key), validates, saves
  'key:clear':              () => void;                                     // back to KeyScreen; agents cancelled
  'models:list':            (refresh?: boolean) => ModelInfo[];
  'config:get':             () => ConfigSnapshot;
  'config:update':          (patch: ConfigPatch) => ConfigSnapshot;         // mainAgentId must exist; workspacePath must be a dir
  'config:completeSetup':   (p: SetupPayload) => ConfigSnapshot;            // assigns ids/colors, setupComplete=true, starts runtimes
  'config:addAgent':        (a: AgentInput) => ConfigSnapshot;
  'config:updateAgent':     (id: AgentId, patch: Partial<AgentInput>) => ConfigSnapshot;
  'config:removeAgent':     (id: AgentId) => ConfigSnapshot;                // throws if main or last agent
  'config:chooseWorkspace': () => string | null;                            // dialog.showOpenDialog openDirectory+createDirectory
  'config:resetAll':        () => void;                                     // wipes config+state (keeps key), returns to Wizard
  'chat:send':              (text: string) => { runId: string; queued: boolean };   // to current main agent; queued if busy
  'chat:cancel':            (runId?: string) => void;                       // no arg = cancel everything + clear all queues
  'agent:cancel':           (agentId: AgentId) => void;                     // cancel that agent's current run (+ its children)
  'agent:clearHistory':     (agentId: AgentId) => void;                     // only when idle; new sessionId; info event
  'console:getEvents':      (agentId: AgentId, opts: { beforeSeq?: number; limit: number }) => ConsoleEvent[];  // ascending by seq
  'console:clear':          (agentId: AgentId) => void;                     // clears log only, not history
  'runtime:getSnapshot':    () => RuntimeSnapshot;
  'permission:respond':     (requestId: string, decision: PermissionDecision) => void;   // unknown id → no-op
  'askUser:respond':        (requestId: string, answer: string | null) => void;          // null = dismissed
  'shell:openPath':         (p: string) => void;                            // only workspacePath or its children
}
export interface EventMap {                                         // main → renderer (webContents.send)
  'config:changed':      ConfigChanged;
  'console:event':       ConsoleEvent;
  'console:patch':       ConsolePatch;
  'agent:status':        AgentStatusUpdate;
  'permission:request':  PermissionRequest;
  'permission:resolved': { requestId: string; outcome: PermissionOutcome };
  'askUser:request':     AskUserRequest;
  'askUser:resolved':    { requestId: string };
  'run:finished':        RunFinished;
  'app:toast':           { level: 'info'|'warn'|'error'; message: string };
}
export interface Api {
  invoke<K extends keyof InvokeMap>(ch: K, ...args: Parameters<InvokeMap[K]>): Promise<ReturnType<InvokeMap[K]>>;
  on<K extends keyof EventMap>(ch: K, cb: (payload: EventMap[K]) => void): () => void;   // returns unsubscribe
}
declare global { interface Window { api: Api } }
```

`preload.ts` (whole file, CJS, sandbox-compatible):
```ts
import { contextBridge, ipcRenderer } from 'electron';
const INVOKE = new Set([ /* every InvokeMap key */ ]); const EVENTS = new Set([ /* every EventMap key */ ]);
contextBridge.exposeInMainWorld('api', {
  invoke: (ch: string, ...args: unknown[]) => INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error('bad channel ' + ch)),
  on: (ch: string, cb: (p: unknown) => void) => { if (!EVENTS.has(ch)) throw new Error('bad channel ' + ch);
    const h = (_e: unknown, p: unknown) => cb(p); ipcRenderer.on(ch, h); return () => ipcRenderer.removeListener(ch, h); },
});
```
Ordering guarantees: per agent, `seq` is strictly increasing across `console:event`; patches reference an `eventId` already sent. Renderer bootstrap: subscribe first, then `console:getEvents`; drop incoming events with `seq <= lastLoadedSeq[agentId]`; ignore patches for unknown ids.

---

## 4. API client — `api.ts`

```ts
class ApiError extends Error { status: number; type: 'AuthError'|'ModelError'|'RateLimit'|'Server'|'Network'|'Abort'|'Protocol'|'Unknown'; retryAfterMs?: number; retryable: boolean }
interface StreamHandlers { onReasoning(t: string): void; onText(t: string): void; onToolCallDelta(d: {index: number; id?: string; name?: string; args?: string}): void; onUsage(u: Partial<Usage>, cost?: number): void }
interface StreamResult { finishReason: string | null; usage: Usage | null }
class OpenCodeClient {
  constructor(getKey: () => string | null, version: string)
  validateKey(key: string): Promise<KeyValidationResult>     // POST /chat/completions {model: PROBE, max_tokens:1, messages:[{role:'user',content:'hi'}]}, 15 s timeout
  listModels(refresh?: boolean): Promise<ModelInfo[]>        // GET /models; enrich from https://models.dev/api.json ['opencode-go'].models (8 s timeout, cached 24 h in userData/models-cache.json); fallback raw ids
  streamChat(req: { model: string; messages: ChatMessage[]; tools?: ToolDef[]; sessionId: string; maxTokens?: number }, h: StreamHandlers, signal: AbortSignal): Promise<StreamResult>
}
```
- Headers: `Authorization: Bearer`, `Content-Type: application/json`, `x-opencode-session: <sessionId>`, `User-Agent: agents-windows/<version>`. Body adds `stream: true, stream_options: { include_usage: true }, tool_choice: 'auto'` (when tools present).
- Error mapping: non-2xx → read body → `{error:{type,message}}`: 401+AuthError→`AuthError`; 401+ModelError→`ModelError`; 429→`RateLimit` (retryAfterMs from `Retry-After` header else 20 s); 5xx→`Server` (retryable); fetch `TypeError`/`ECONNRESET`→`Network` (retryable); `AbortError`→`Abort`. `KeyValidationResult.reason`: AuthError→`auth`, Network→`network`, ModelError→`model`, RateLimit→`rate_limit`, else `unknown`.
- SSE parser: read `body` via `TextDecoder(stream:true)`; buffer; split on `\n`; for lines starting with `data:` → trim → `[DONE]` ends; else `JSON.parse`. Chunk with top-level `error` → throw `ApiError('Protocol'|mapped)`. For `choices[0].delta`: `reasoning_content ?? reasoning` → onReasoning; `content` → onText; `tool_calls[]` → onToolCallDelta per item; `choices[0].finish_reason` recorded; chunk with `usage` (choices may be empty) → onUsage (also read top-level `cost` string if present). Idle watchdog: no bytes for 120 s → abort with `Network` error (retryable).
- `Usage` normalization: `prompt_tokens, completion_tokens, prompt_tokens_details.cached_tokens, completion_tokens_details.reasoning_tokens`, `cost` parsed float. If no usage arrives: estimate `chars/4` for prompt and completion, `cost` from ModelInfo prices, `estimated: true`.

---

## 5. Agent loop — `agent.ts` (+ `prompt.ts`)

### 5.1 AgentRuntime
```
class AgentRuntime {
  cfg(): AgentConfig                       // live getter into ConfigStore (hot reload, §10)
  queue: Task[]; current: RunState | null; abort: AbortController | null
  enqueue(task): Promise<TaskResult>       // FIFO; returns when that task finishes; emits agent:status queueLength
  cancel(reason)                            // aborts current run, rejects queued tasks with status 'cancelled', cascades to childRunIds
}
```
### 5.2 run(task) — pseudo-code
```
run = new RunState(status 'running', ancestry = task.origin.kind==='delegation' ? parentRun.ancestry+[self] : [self])
emit task_start; status('thinking')
history.push({role:'user', content: formatTaskInput(task)})          // user: text verbatim; delegation: "[Task delegated by <Name>]\n<task>\n\n[Context]\n<context>"
for iteration in 1..cfg().maxIterations:
  if aborted: break
  system = buildSystemPrompt(cfg(), configStore.get(), roster, env)   // rebuilt EVERY iteration from live config
  messages = [system, ...trimHistory(history, contextLimit(cfg().model))]
  ev = emit llm_call {model: cfg().model, iteration, messageCount, status:'streaming'}
  acc = { reasoning:'', text:'', toolCalls: Map<index,{id,name,args}> , reasoningEv?, textEv? }
  attempt = 0
  loop:
    try: result = await client.streamChat({model, messages, tools: toolDefs(agent), sessionId}, handlers, abort.signal); break
    catch e:
      if e.type==='Abort': goto cancelled
      if e.retryable && attempt < 5: wait = e.retryAfterMs ?? min(5s*2^attempt, 60s) + jitter; emit error{retryable:true, retryInMs}; status('thinking','retry'); await sleep(wait, signal); attempt++; continue
      emit error{retryable:false}; patch ev {status:'error'}; run.status='error'; goto finish
  handlers:
    onReasoning(t): acc.reasoningEv ??= emit reasoning{text:''}; acc.reasoning+=t; coalesce→patch append (flush ≤ every 30 ms); status('streaming')
    onText(t):      acc.textEv ??= emit text{text:'',final:false}; same coalescing
    onToolCallDelta(d): tc = acc.toolCalls.get(d.index) ?? create{id:'',name:'',args:'',ev:null}; if d.id: tc.id=d.id; if d.name: tc.name+=d.name; if d.args: tc.args+=d.args
                    when tc.name first non-empty: tc.ev = emit tool_call{callId, name, argsRaw:'', status:'streaming'}
    onUsage(u): run.usage += u; agent cumulative += u
  // ---- assistant message complete ----
  toolCalls = [...acc.toolCalls sorted by index]; each id ||= `call_${runId}_${iteration}_${index}`
  assistant = {role:'assistant', content: acc.text || null, reasoning_content: acc.reasoning || undefined, tool_calls: toolCalls.length ? wire(toolCalls) : undefined}
  history.push(assistant); state.persistHistory()
  patch ev {status:'done', finishReason, usage, durationMs}; emit agent:status usage
  if toolCalls.empty:
    if acc.textEv: patch {final:true}
    run.status='done'; finalText = acc.text; goto finish
  status('tool')
  results = await executeToolCalls(toolCalls, run)          // §5.4
  for tc in toolCalls (original order): history.push({role:'tool', tool_call_id: tc.id, content: truncateForModel(results[tc.id], 16000)})
  state.persistHistory()
end for → run.status='error'; emit error{"Limite di iterazioni raggiunto"}; finalText = acc.text || ''
cancelled: if acc.text or acc.reasoning partially streamed → discard (not pushed). If tool calls were executing → for each without result push tool msg "[cancelled by user]". run.status='cancelled'
finish: emit task_end{status, durationMs, usage, iterations}; status('idle'); emit run:finished; resolve TaskResult; dequeue next
```
### 5.3 executeToolCalls(calls, run)
```
groups = split calls into consecutive runs: delegate_task calls → one parallel group (Promise.all); every other call → sequential group of 1
for group in order: await group; results[callId] = string
per call:
  patch ev {argsRaw}; args = parseArgs(argsRaw)   // JSON.parse; on failure: try repairs (strip trailing commas, take first balanced {...} object, replace single quotes) ; still failing → result "ERROR: invalid JSON arguments: <msg>. Resend the call with valid JSON." status 'error', patch parseError
  unknown name → "ERROR: unknown tool <name>. Available: …"
  status('tool', name); patch {status:'running', args}
  r = await tools.execute(name, args, ctx{agent, run, gate, orchestrator})   // gate may set status pending_permission / waiting_permission
  patch {status: r.ok?'done': r.denied?'denied':'error', result:{ok, output: truncate(r.output, 32768), truncated, fullLength, durationMs}}
```
### 5.4 History trimming
`trimHistory`: estimate tokens = Σ chars/4 (+ 200 per tool call). If > 0.7 × contextLimit (models.dev `limit.context`, default 128k): drop oldest messages in whole turns (cut only right before a `user` message, never between assistant(tool_calls) and its tool messages); prepend `{role:'user', content:'[Earlier conversation truncated for length]'}`. Never drop the last user message.

### 5.5 System prompt (`prompt.ts`, English)
```
You are "{name}", an AI agent in a team of {N} agents inside the desktop app "Agents Windows".
{MAIN:  You are the MAIN agent, the only one who talks to the user. Every user message arrives to you. Your final message without tool calls is shown to the user as the team's result — always end with a complete final answer. Delegate sub-tasks with delegate_task when a teammate's role fits, then integrate the results yourself.}
{OTHER: You are a SPECIALIST agent. Tasks reach you by delegation from a teammate; your final message without tool calls is returned verbatim to that teammate (not to the user). Be complete, factual and concise. Never address the user directly except through ask_user when truly blocked.}

## Your role
{agent.prompt}

## Team ({N})
- {name} — {description} [model {model}] {(MAIN)} {(you)}      ← one line per agent, live roster

## Interaction protocol (written by the user, follow it)
{interactionPrompt || "No specific protocol. Delegate when a teammate's role fits the sub-task, otherwise do the work yourself."}
Control always returns to the main agent, which produces the final output for the user.

## Environment
OS {platform} {release} ({arch}) · shell {shell} · workspace {workspacePath} (relative paths resolve here; prefer them) · date {ISO} · user language: {locale}

## Rules
1. Act only through tools; never claim to have done something you did not do. Read before editing. Prefer edit_file for small changes.
2. run_command: non-interactive only (no prompts/editors); default cwd is the workspace; long-running servers: start with `&` redirecting to a log file, then inspect the log. Avoid sudo unless essential.
3. Some actions require the user's authorization (shown to them by the app, not by you). A denial is final for that action: explain it and propose alternatives.
4. delegate_task: never yourself or an agent above you in the delegation chain; max depth {D}. Give a self-contained task and context. Multiple independent delegations in one message run in parallel.
5. The user watches your reasoning and tool activity live in a console; keep reasoning purposeful.
6. Answer in the user's language ({locale}); code, commands and file contents keep their natural language.
```

---

## 6. Tools catalogue — `tools.ts`

All tools return `{ ok: boolean; output: string; denied?: boolean }`. Output is a string (JSON for structured tools). `ToolDef` = OpenAI `{type:'function', function:{name, description, parameters}}`.

| Tool | Parameters (JSON schema, `required` in bold) | Behaviour | Permission (§7) |
|---|---|---|---|
| `read_file` | **path**:string, offset?:int (1-based line), limit?:int (lines) | UTF-8 read; binary (NUL in first 8 KB) → error; raw text, max 64 KB (head/tail marker), optional line window via offset/limit | fs_read |
| `write_file` | **path**, **content**:string | mkdir -p parent; write UTF-8; returns bytes written | fs_write |
| `edit_file` | **path**, **search**:string, **replace**:string, replaceAll?:bool=false | exact substring match; 0 matches → error; >1 matches & !replaceAll → error with count; returns occurrences replaced | fs_write |
| `delete_path` | **path**, recursive?:bool=false | file or dir (dir needs recursive) | fs_delete |
| `list_directory` | path?:string='.', recursive?:bool=false, maxEntries?:int=500 | entries `type name size` sorted; ignores `.git node_modules dist .DS_Store` when recursive | fs_read |
| `search_files` | query?:string (text/regex), glob?:string (e.g. `**/*.ts`), path?:string='.', regex?:bool=false, caseSensitive?:bool=false, maxResults?:int=200 | pure-Node walk (ignore list as above, skip files >2 MB / binary); glob only → file list; query → `relpath:line: text` | fs_read |
| `run_command` | **command**:string, cwd?:string, timeoutMs?:int=120000 (max 600000), env?:object | `child_process.spawn` via shell (§6.2); stdout/stderr captured (each ≤ 1 MB, then killed); result `exit=<code> timedOut=<b>\n--- stdout ---\n…\n--- stderr ---\n…`; kills process tree on timeout/cancel (`detached` + `process.kill(-pid)` unix, `taskkill /T /F` win) | command |
| `system_info` | — | JSON: platform, release, arch, hostname, cpus{count,model}, memory{total,free}, uptime, homedir, username, shell, PATH, node/electron versions, workspacePath, cwd, env keys (names only) | auto |
| `network_info` | — | JSON: `os.networkInterfaces()` + output of fixed read-only commands: mac `ifconfig`, `netstat -rn`, `scutil --dns`, `networksetup -listallnetworkservices`; linux `ip -brief addr`, `ip route`, `cat /etc/resolv.conf`; win `ipconfig /all`, `route print`, `netsh interface show interface`. Each 10 s timeout, failures inlined | auto |
| `delegate_task` | **agent**:string (name or id), **task**:string, context?:string | see §8.2; returns `Result from <Name>:\n<text>` or `Delegation to <Name> failed: <reason>` | auto |
| `list_agents` | — | JSON roster: id, name, description, model, status, isMain | auto |
| `ask_user` | **question**:string, options?:string[] | shows AskUserModal (§9.5); returns the answer, or `"No answer from user (dismissed/timeout)"` | auto |

Final answer = assistant message without tool calls (no `finish` tool).

### 6.1 Path sandbox (`permissions.ts::resolvePath`)
1. `abs = path.resolve(workspace, p)` (relative → workspace). Expand leading `~` to homedir.
2. `real = realpath(deepest existing ancestor of abs) + remainder` (defeats symlink escapes).
3. `inside = real === ws || real.startsWith(ws + sep)` with `ws = realpath(workspace)`; on Windows compare lower-cased.
4. `protected` if `real` matches: `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`, `~/.config/gcloud/**`, `~/.kube/config`, `**/auth.json` under `~/.local/share/opencode`, our `userData/config.json`, `/etc/shadow`, `/etc/sudoers*`, `**/*.pem|*.key|id_rsa*|id_ed25519*` outside ws, `**/.env*` outside ws, `~/Library/Keychains/**`, `%APPDATA%/**/Login Data`.
5. Reads/writes/deletes route to the gate with kind `fs_{read|write|delete}_{inside|outside}` or `fs_read_protected` (protected + write → treated as `fs_write_outside` with hit `protected`).

### 6.2 Shell per OS
- unix: `spawn('/bin/sh', ['-c', command], {cwd, env, detached:true})`; user shell from `$SHELL` only for `system_info` reporting.
- win32: `spawn('cmd.exe', ['/d','/s','/c', command], {cwd, env, windowsHide:true})`; if command starts with `powershell`/`pwsh` it is still fine via cmd. Encoding: set `chcp 65001` is NOT injected; decode stdout as UTF-8 and fall back to latin1 on invalid sequences.
- `env`: process env + `AGENTS_WINDOWS=1`, `NO_COLOR=1`, `CI=1`, `GIT_TERMINAL_PROMPT=0`, plus tool-provided `env` (cannot override PATH/HOME).

---

## 7. Permission policy — `permissions.ts`

### 7.1 Policy table (`decide(kind, class, mode)` → `allow` | `ask` | `deny`)

| Action | strict | balanced (default) | relaxed |
|---|---|---|---|
| read / list / search inside workspace | allow | allow | allow |
| read outside workspace (non-protected) | ask | ask (session-allow: directory prefix) | allow |
| read protected path | deny | ask (red) | ask (red) |
| write / edit inside workspace | ask | allow | allow |
| write / edit outside workspace | ask | ask | ask |
| delete file inside workspace | ask | allow | allow |
| delete directory (recursive) inside workspace | ask | ask | allow |
| delete outside workspace | ask | ask | ask |
| system_info / network_info / list_agents / delegate_task / ask_user | allow | allow | allow |
| run_command `benign` | ask (session-allow) | ask (session-allow) | allow |
| run_command `benign` with cwd outside workspace | ask | ask | ask |
| run_command `sensitive` (installs, kill, services, git-destructive, opaque inline code, remote) | ask | ask | ask |
| run_command `privileged` (sudo, network config, firewall, registry, system settings, rm -rf) | ask (red, no session-allow) | ask (red) | ask (red) |
| run_command `destructive` (wipe system roots/disks) | deny | deny | ask (red) |

- Session allowlist (memory only, cleared on restart) + `commandAllowlist` (persistent) apply **only** to `benign` commands and `fs_read_outside` directory prefixes. Match: split command on `&&`, `||`, `;`, `|`, newline; strip leading `VAR=x`, `env`, `time`, `nohup`, `exec`; each segment's first 1–2 tokens must equal a pattern (`npm test`, `git *`, `node *`). Pattern offered = program + first non-flag arg (`npm test`, `git status`, `cargo build`); user can edit it in the modal before accepting.
- Pending request: emitted to renderer + `permission` console event; agent status `waiting_permission`; timeout `permissionTimeoutMs` (default 5 min) → outcome `timeout` → tool result `"DENIED: user did not answer in time"`. Run cancel → `cancelled`. Deny → `"DENIED by user: <summary>. Do not retry the same action; explain or propose an alternative."`.
- Any agent (not only main) can trigger requests; the modal shows agent name + color.

### 7.2 Command classifier (`classifyCommand(cmd, ctx) → {class, hits, sessionPattern}`)
Split into segments as above; for each segment strip wrappers; class = max severity over segments (and over inner code of `-c/-e/-Command` strings, which are recursively classified). Regexes (case-insensitive, `\b` word bounds):

| Class | Pattern (hit label) |
|---|---|
| destructive | `rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)\b.*\s(/|/\*|~|~/|\$HOME/?|/(etc|usr|bin|sbin|lib|var|boot|System|Library|Users|home|Windows))(\s|$)` (rm-rf-system) · `mkfs\b` · `dd\s.*of=/dev/` · `diskutil\s+(erase|partition|reformat|apfs\s+delete)` · `wipefs|shred\s+.*/dev` · `format(\.com)?\s+[a-z]:` · `diskpart` · `Remove-Item\s+.*-Recurse.*(C:\\|\$env:SystemRoot|\$env:USERPROFILE\s|~\s)` · `(rd|rmdir)\s+/s.*[a-z]:\\(\s|$)` · `chmod\s+(-R\s+)?\S+\s+/(\s|$)` · `chown\s+(-R\s+)?\S+\s+/(\s|$)` · `:\(\)\s*\{\s*:\|:&\s*\};:` |
| privileged | `^(sudo|doas|su)\b` · `runas\b` · `Start-Process\b.*-Verb\s+RunAs` · `rm\s+-[a-z]*r[a-z]*f?\b|rm\s+-[a-z]*f[a-z]*r\b` (rm-rf) · `ifconfig\s+\S+\s+(up|down|inet|add|delete|\d)` · `ip\s+(addr|address|link|route|neigh|rule)\s+(add|del|delete|set|flush|change|replace)` · `route\s+(add|delete|del|change)` · `networksetup\s+-set` · `scutil\s+--set` · `nmcli\s+(con|connection|dev|device|radio|networking)\s+(add|mod|modify|up|down|delete|off|on)` · `(iptables|ip6tables|nft|pfctl|ufw|firewall-cmd|tc)\b` (fw) · `resolvectl\s+(dns|domain|flush)` · `dhclient|wpa_cli|iwconfig` · `netsh\b(?!.*\bshow\b)` · `Set-(NetIPAddress|NetIPInterface|DnsClientServerAddress|NetFirewallRule|NetAdapter|NetRoute|ExecutionPolicy|MpPreference|Service)\b` · `New-(NetFirewallRule|NetRoute|NetIPAddress|LocalUser)` · `(Enable|Disable)-NetAdapter` · `reg(\.exe)?\s+(add|delete|import|restore)` · `regedit|bcdedit|Set-ItemProperty\s+.*HKLM` · `sc(\.exe)?\s+(create|delete|config|start|stop)` · `net\s+(start|stop|user|localgroup|share)` · `systemctl\s+(start|stop|restart|enable|disable|mask|daemon-reload)` · `launchctl\s+(load|unload|bootstrap|bootout|enable|disable|kickstart)` · `service\s+\S+\s+(start|stop|restart)` · `(shutdown|reboot|halt|poweroff)\b` · `(Stop|Restart)-Computer` · `systemsetup|pmset\s+-|nvram|csrutil|spctl\s+--master` · `defaults\s+write\s+(/Library|NSGlobalDomain|com\.apple)` · `dscl|useradd|usermod|passwd|chsh` · `(mount|umount)\b` · `crontab\s+(-e|-r|\S+\.txt)` · `schtasks\s+/(create|delete|change)` · `icacls|takeown` · `dism|sfc\s+/scannow` · `xattr\s+-d.*quarantine` · any token matching a protected path (§6.1) (protected-path) |
| sensitive | `(apt|apt-get|dnf|yum|pacman|zypper|apk|snap|flatpak)\s+(install|remove|purge|upgrade|dist-upgrade|add|del)` · `brew\s+(install|uninstall|reinstall|upgrade|tap|services)` · `(npm|pnpm|yarn|bun)\s+(i|install|add|rm|remove|uninstall|link|unlink)\b.*(\s-g\b|--global)` · `npx\s` · `pip3?\s+(install|uninstall)` · `(cargo|gem|go)\s+install` · `(choco|winget|scoop)\s+(install|uninstall|upgrade)` · `Install-(Module|Package|WindowsFeature)` · `msiexec|installer\s+-pkg|softwareupdate|dpkg\s+-i|rpm\s+-[iuU]` · `(kill|killall|pkill|taskkill|Stop-Process)\b` · `git\s+(push\s+.*(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|branch\s+-D|filter-branch)` · `(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node|iex|powershell|pwsh)\b` (pipe-to-shell) · `(bash|sh|zsh|python\d?|node|ruby|perl|php)\s+-(c|e)\s` · `(powershell|pwsh)\b.*-(c|command|encodedcommand|e|enc)\b` · `osascript` · `(ssh|scp|sftp)\b|rsync\b.*\S+:` · `docker\b.*(--privileged|--network\s+host|-v\s+/(?!workspace)|system\s+prune|rmi|volume\s+rm)` · `>{1,2}\s*(/(etc|usr|bin|sbin|lib|var|boot|Library|System)|~|\$HOME|/Users/|/home/|[A-Za-z]:\\)` (redirect-outside) · write-verb (`cp|mv|tee|touch|mkdir|ln|rm|sed\s+-i`) with an absolute or `~` path token outside workspace (path-outside) · `chmod|chown` (not on `/`) · `rm\s` (non -rf) outside workspace |
| benign | everything else (default) |

Also: `run_command` with explicit `cwd` outside workspace → additional hit `cwd-outside`, forces `ask`.

---

## 8. Orchestration — `orchestrator.ts`

### 8.1 User turn
1. `chat:send(text)` → `main = agents[config.mainAgentId]`; emit `user_input` on main; `task = {origin:{kind:'user'}, input:text}`; `runId = main.enqueue(task)`; return `{runId, queued: main.current !== null}`.
2. Main runs (§5). Its `delegate_task` calls go through `orchestrator.delegate()`; main's loop is blocked on `await`, so **control returns to main automatically** when children finish, and main's next iteration integrates results. Main's final text → `text{final:true}` + `run:finished{isUserRun:true, finalText}`.
3. Failure paths still end at main: child error/cancel/timeout/rejection becomes a tool result string; main continues. Main error → `error` + `task_end{error}` + `run:finished{status:'error'}`; renderer re-enables input and shows a red footer "Terminato con errore". Queue: further user messages run after.

### 8.2 delegate(fromRun, ref, task, context)
```
target = agents.find(a => a.id===ref || a.name.toLowerCase()===ref.trim().toLowerCase())
reject (tool result string, delegation ev status 'rejected') if:
  !target                         → "Unknown agent '<ref>'. Known: <names>"
  target.id===from.id             → "You cannot delegate to yourself"
  fromRun.ancestry includes target → "Cycle: <Name> is above you in the delegation chain (…); return your result instead"
  depth(fromRun)+1 > maxDelegationDepth → "Max delegation depth reached"
  fromRun.delegationCount >= 20   → "Too many delegations in this task"
ev = emit delegation{toAgentId,toName,task,status: target.busy?'queued':'running'} on FROM console
childTask = {origin:{kind:'delegation', fromAgentId, fromName, parentRunId, callId, depth}}
p = target.enqueue(childTask); fromRun.childRunIds.push(child.runId); from.status('waiting_delegate', toName)
r = await p     (cancel of fromRun cascades: target.cancelRun(child.runId))
patch ev {status:r.status, childRunId, resultPreview: first 300 chars, durationMs}
return r.status==='done' ? `Result from ${toName}:\n${r.text}` : `Delegation to ${toName} ${r.status}: ${r.text || 'no output'}`
```
Deadlock-freedom: waits only go parent→child; ancestry check forbids any edge back to a running ancestor; an agent's queue never blocks its current run. Parallel: sibling `delegate_task` calls in one assistant message run concurrently (§5.3); distinct agents run truly in parallel (independent fetches).

### 8.3 Attribution & what the user sees
- Every event carries `agentId` of the agent performing it: child work appears in the child's console; parent shows a `delegation` block (spinner, "In coda"/"In corso", button "Vai alla console" → focuses child; result preview when done).
- Header run status: "Team al lavoro · 2 agenti attivi · 00:42" while `activeUserRun`; main console footer shows spinner text `In attesa di <Name>…` when `waiting_delegate`.
- Cancel: header "Ferma" → `chat:cancel()` cancels every run and clears queues; per-console stop icon → `agent:cancel(id)` (parent receives "Delegation cancelled").

---

## 9. Renderer UI spec

Routing in `index.ts`: `getInfo()` → `!hasApiKey` → KeyScreen; `!setupComplete` → Wizard; else Workbench. Subscribe to all `EventMap` channels once at bootstrap; a small in-renderer store (`Map<AgentId, ConsoleView>`, `snapshot`, `config`) dispatches.

### 9.1 KeyScreen (`key-screen.ts`)
Centered card: title "Agents Windows", text "Inserisci la tua API key di OpenCode Go", password input (toggle show), buttons "Verifica e continua" (primary) and "Importa da opencode CLI" (secondary, calls `key:importFromOpencode`). While validating: spinner + disabled. Error mapping: `auth` → "Chiave non valida"; `network` → "Nessuna connessione a opencode.ai — controlla la rete"; `rate_limit` → "Limite di utilizzo raggiunto, riprova tra poco"; `model` → "Modello di verifica non disponibile (glm-5.3-flash)"; `unknown` → message. On ok → Wizard.

### 9.2 SetupWizard (`wizard.ts`) — 4 steps, progress dots, "Indietro/Avanti"
1. **Workspace**: path field (read-only) + "Scegli cartella…" (`config:chooseWorkspace`). Required.
2. **Agenti**: number stepper (1–10) + list of agent cards: Nome (required, unique), Modello (`<select>` from `models:list`, label `name · $in/$out per M · ctx`; default `deepseek-v4-flash`), Prompt (textarea, placeholder shows the `descrizione:` convention; live derived description preview), Colore (`<input type=color>` prefilled from `palette[i]`). Add/remove card buttons.
3. **Principale e protocollo**: radio "Agente principale" over agent names (default first); textarea "Come devono interagire gli agenti" (interactionPrompt) with example placeholder ("Il Coordinatore analizza la richiesta, delega la ricerca al Ricercatore e la scrittura del codice allo Sviluppatore, poi verifica e riassume…").
4. **Riepilogo**: table + "Avvia" → `config:completeSetup` → Workbench.
Validation inline; `Enter` never submits textareas.

### 9.3 Workbench (`workbench.ts`, `console.ts`)
**Header** (40 px): app name · workspace path (click → `shell:openPath`) · run status pill · total cost/tokens · buttons: "Ferma" (visible while any run active), "Impostazioni" (opens side panel), toggle "Ragionamento" (global default; per-console override).
**Grid** (`#grid`, CSS grid, gap 8 px, fills remaining height): `cols = N<=1?1 : N<=2?2 : N<=4?2 : N<=6?3 : 4`; `grid-auto-rows: minmax(0,1fr)`; `grid-auto-flow: dense`. Main console: `grid-column: span 2; grid-row: span 2` when `N>=3` (span 1 for N≤2), always first in DOM. Others follow config order.
**Console** (`.console`, `--agent-color` set via `style.setProperty`): header = 4 px color stripe + name (bold) + description (muted, ellipsis) + model badge + status dot (idle gray / thinking pulse / streaming solid / tool amber / waiting_* violet / error red) + cost `$0.0123` + icon buttons: filter reasoning (eye), maximize, collapse (→ dock), clear, stop (visible while running). Body = scrollable event list. Main console only: footer input (`textarea`, Enter sends, Shift+Enter newline; "Invia" button; while a user run is active shows queue count "1 in coda" and keeps accepting input).
**Focus**: click anywhere on a console → `.focused` (2 px `--agent-color` border, header brighter); at load focus = main. Keyboard: `Ctrl/Cmd+1..9` focus by index; `Esc` closes maximize.
**Maximize**: `.maximized` console fills the grid, others `hidden`; header button/Esc restores.
**Collapse/dock**: collapsed consoles leave the grid and become chips in a bottom dock (28 px): color dot, name, status dot, badge with unseen event count; click → restore. Grid `N` for column calc = visible consoles.
**Config changes** (`config:changed`): added → create ConsoleView + node; removed → destroy; updated → re-render header (title/color/model); mainChanged → move input footer to the new main, re-order grid.

**Event render rules** (one DOM node per event, `data-event-id`):

| kind | Rendering |
|---|---|
| user_input | right-aligned bubble, agent-color border, `pre-wrap` |
| task_start | banner: user → "▶ Richiesta dell'utente"; delegation → "▶ Incarico da **{fromName}**" (from's color dot), task text collapsible (>300 chars) |
| task_end | footer line: ✓/✗/■ + `stato · 12.3 s · 4 iterazioni · 3.1k tok · $0.004` |
| llm_call | thin muted line "→ {model} · iterazione {n}" with spinner until done, then `· 1.2 s · 812 tok` |
| reasoning | muted italic block, left border dotted, label "Ragionamento" with collapse toggle; hidden entirely when the console filter is off; text appended as text nodes |
| text | normal block `pre-wrap`; `final:true` → stronger background + label "Risposta" (main) / "Risultato" (others); code fences (```) rendered as `<pre><code>` when the block is complete (final or run end) |
| tool_call | card: icon + `name` + status chip; args as pretty JSON (`<pre>`, collapsed if >300 chars, "Mostra"); when `result`: `<pre>` with first 2000 chars + "Mostra tutto (N KB)" toggle (local expand); `ok:false` red left border; `denied` violet |
| delegation | card with target's color stripe: "⇢ Delega a **{toName}**" + task (collapsible) + status chip (In coda / In corso ⟳ / Completata / Errore / Rifiutata) + "Vai alla console" + result preview |
| permission | inline card "🔒 Autorizzazione richiesta: {summary}" + status chip (In attesa… / Consentito / Consentito per la sessione / Negato / Timeout); mirrors the modal |
| ask_user | card "❓ {question}" + answer when present |
| error | red card; `retryable` → "Riprovo tra Ns" countdown |
| info | small gray centered line |

**Patch application**: `append` → `node.querySelector('.txt').appendChild(document.createTextNode(text))`; `set` → update chips/fields; re-evaluate autoscroll. Incoming events/patches are buffered and flushed once per `requestAnimationFrame`.
**Autoscroll**: per console `stick = scrollHeight - scrollTop - clientHeight < 24` measured on user `scroll`; after each flush, if `stick` → `scrollTop = scrollHeight`; else show floating "↓ Nuovi eventi" button (click → scroll + stick). `runId`-scoped: a `user_input` event always forces stick.
**DOM cap**: keep last 1500 event nodes; removing oldest reveals "Carica eventi precedenti" button (uses `console:getEvents` with `beforeSeq` of first visible). Initial load: `limit: 400`.
**Colors/theme**: dark (`--bg #0f1115`, `--panel #171a21`, `--fg #e6e6e6`, `--muted #8b93a7`); agent color used for stripe, focus border, chips, status dot; text never colored by agent (readability).

### 9.4 Settings panel (`settings.ts`) — right side drawer (420 px), sections
- **Agenti**: list with color swatch, name, model, main radio, "Modifica"/"Rimuovi" (disabled for main / last); "Aggiungi agente". Edit form = wizard card. Save → `config:updateAgent` / `addAgent` / `removeAgent` (confirm dialog explaining running tasks get cancelled).
- **Protocollo di interazione**: textarea, saves on blur / Cmd+S → `config:update`. Note under it: "Applicato dalla prossima chiamata al modello, senza interrompere il lavoro in corso".
- **Workspace**: path + "Cambia…".
- **Autorizzazioni**: mode radio (Rigorosa / Bilanciata / Permissiva) with one-line explanations; persistent allowlist editor (one pattern per line); timeout minutes; delegation depth.
- **API key**: masked, "Cambia chiave…" (inline input → `key:set`), "Rimuovi chiave".
- **Dati**: "Cancella cronologia di <agente>", "Ripristina tutto" (confirm).
Every mutation returns `ConfigSnapshot`; panel re-renders from it. Toasts (bottom-left, 4 s) for errors.

### 9.5 Modals (`modals.ts`)
- **PermissionModal**: FIFO queue of `PermissionRequest`s; one shown at a time, badge "+2 in attesa". Content: agent chip (name, color) · kind title (`Eseguire comando` / `Leggere fuori dal workspace` / `Scrivere fuori dal workspace` / `Eliminare` …) · `<pre>` of command/path + cwd · hit labels as tags (`sudo`, `network-config`, `pipe-to-shell`) · class-based styling: benign neutral, sensitive amber, privileged/destructive red with warning text "Questa azione può modificare il sistema". Buttons: "Nega" (Esc), "Consenti" (Enter), and if `sessionPattern` → "Consenti per la sessione: [editable pattern]". Countdown of `timeoutMs`. `permission:resolved` removes it if still queued (timeout/cancel). Non-blocking for the rest of the UI (consoles keep streaming behind a dim overlay).
- **AskUserModal**: agent chip, question, optional option buttons, textarea, "Rispondi" / "Ignora" (→ null). Same queueing.
- Sound/attention: window `flashFrame(true)` (win/linux) / `app.dock.bounce()` (mac) when a request arrives and the window is not focused (main side).

---

## 10. Hot reload semantics

`ConfigStore.update()` saves atomically, computes `diff`, emits `changed`; `Orchestrator.applyConfig(diff)` then `broadcast('config:changed')`. Runtimes never cache config: `AgentRuntime.cfg()` and `buildSystemPrompt` read live values at each iteration; tools read `workspacePath`, `permissionMode` at each call.

| Change | In-flight run | Effect |
|---|---|---|
| `agent.prompt`, `interactionPrompt`, rename, description | continues; current HTTP call unaffected | next iteration's system prompt uses new text; `info` event "Configurazione aggiornata" on affected consoles; roster lines in other agents update at their next call; title/color re-rendered immediately |
| `agent.model` | current stream finishes on old model | next iteration uses new model; `llm_call` shows it. Invalid model → `ModelError` non-retryable → run error |
| add agent | — | runtime created (empty history, new sessionId), console added, roster updated at next calls |
| remove agent | its run (and children) cancelled with reason "agent removed"; parents awaiting it get tool result "Delegation to X cancelled: agent removed by the user"; queued tasks rejected | state files deleted; console removed; future `delegate_task` to that name → "Unknown agent" |
| `mainAgentId` | old main's active user run finishes normally and still reports `run:finished{isUserRun:true}` | `chat:send` targets the new main from now on; renderer moves input box immediately; queued user messages on old main stay there (shown in its footer) |
| `workspacePath` | running command keeps its cwd | next tool call resolves against new path; sandbox uses new root; `info` broadcast to all consoles |
| `permissionMode`, allowlists, timeout | pending requests keep their original decision context | next gate check uses new mode |
| API key (`key:set` validates first) | in-flight requests continue with old key | next request uses new key; on `key:clear`: `chat:cancel()`, renderer → KeyScreen |
| `maxIterations` | read at loop condition | applies immediately |

`sessionId` (x-opencode-session) is per agent and survives config edits; regenerated only on `agent:clearHistory`.

---

## 11. Persistence & resume — `state.ts`

| File | Content | Write policy |
|---|---|---|
| `<userData>/config.json` | `AppConfig` (apiKey encrypted via `safeStorage` when `isEncryptionAvailable()`) | atomic (`.tmp` + `rename`) on every change |
| `<userData>/state/agents/<id>.json` | `AgentState {sessionId, history, usage, updatedAt}` | debounced 500 ms after each history push; forced on `before-quit` |
| `<userData>/state/console/<id>.json` | `{ events: ConsoleEvent[] }` — last 1500 events with patches applied; tool outputs ≤ 32 KB | debounced 1 s, max once per 5 s while streaming; forced on quit |
| `<userData>/models-cache.json` | `{ fetchedAt, models: ModelInfo[] }` | on refresh |
| `<userData>/logs/main.log` | main-process log lines | append; rotate at 5 MB (keep 1 backup) |

Resume on launch (`Orchestrator.resume()`): load config → for each agent load state (missing/corrupt → empty + log warning). Repair: if last history message is `assistant` with `tool_calls` lacking matching `tool` messages → append `tool` messages `"[interrupted: the app was restarted before this tool finished]"`; if the console's last event is not `task_end`/`info` → append `info` "Sessione ripristinata: l'attività precedente è stata interrotta dal riavvio". All agents start `idle`; no run is auto-resumed (the user re-issues the request). Renderer loads the last 400 events per console; cumulative usage restored. `before-quit`: `chat:cancel()`, `state.flushAll()` (sync-ish via `event.preventDefault()` + `app.quit()` after promises settle, 2 s cap). Window bounds saved in `config.window` on `resize/move` (debounced 500 ms).

---

## 12. Build, tsconfig, security

### 12.1 `package.json` additions
```json
"build": {
  "appId": "dev.agentswindows.app",
  "productName": "Agents Windows",
  "directories": { "output": "release", "buildResources": "build" },
  "files": ["dist/**/*", "src/renderer/index.html", "src/renderer/styles.css", "package.json"],
  "asar": true,
  "mac": { "category": "public.app-category.developer-tools", "target": [{ "target": "dmg", "arch": ["arm64", "x64"] }], "icon": "build/icon.png", "identity": null },
  "win": { "target": [{ "target": "nsis", "arch": ["x64"] }], "icon": "build/icon.png" },
  "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true },
  "linux": { "target": ["AppImage", "deb"], "category": "Development", "icon": "build/icon.png", "maintainer": "agents-windows" }
}
```
(`identity: null` = unsigned mac build; only mac is verified locally. `build/icon.png` 512×512; electron-builder converts.)

### 12.2 tsconfigs
```jsonc
// tsconfig.main.json
{ "compilerOptions": { "target": "es2022", "module": "node16", "moduleResolution": "node16", "rootDir": "src/main", "outDir": "dist/main",
    "strict": true, "esModuleInterop": true, "skipLibCheck": true, "sourceMap": true, "types": ["node"] },
  "include": ["src/main/**/*.ts", "src/shared/**/*.d.ts"] }
// tsconfig.renderer.json
{ "compilerOptions": { "target": "es2022", "module": "es2022", "moduleResolution": "bundler", "rootDir": "src/renderer", "outDir": "dist/renderer",
    "lib": ["es2022", "dom", "dom.iterable"], "types": [], "strict": true, "skipLibCheck": true, "sourceMap": true },
  "include": ["src/renderer/**/*.ts", "src/shared/**/*.d.ts"] }
```
Renderer imports use `.js` extensions (`import { h } from './dom.js'`); shared types via `import type { … } from '../shared/types'` (erased). The `.d.ts` is not emitted, so `rootDir` is satisfied; if `tsc` ever reports TS6059, fall back to `rootDir: "src"` and set `"main": "dist/main/main/main.js"`.

### 12.3 Window & security (`main.ts`)
```ts
new BrowserWindow({ width: cfg.window?.width ?? 1440, height: 900, minWidth: 960, minHeight: 600, backgroundColor: '#0f1115', title: 'Agents Windows',
  webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
win.loadFile(path.join(__dirname, '../../src/renderer/index.html'));   // works from asar too (files listed in build.files)
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); win.webContents.on('will-navigate', e => e.preventDefault());
session.defaultSession.setPermissionRequestHandler((_w, _p, cb) => cb(false));
```
`index.html` CSP meta: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'`. No inline scripts/styles; colors via `element.style.setProperty` (CSSOM, allowed). `--dev` flag → `openDevTools({mode:'detach'})`. `window-all-closed` → `app.quit()` on every platform (agents must not run headless). Single instance lock (`app.requestSingleInstanceLock()`).

---

## 13. Implementation order & verification

Step 0 (both, day 1): commit `src/shared/types.d.ts` exactly as §2/§3 + both tsconfigs + `package.json` build key. Contract is frozen; changes require both streams.

### Workstream A — main process
1. `util.ts`, `config.ts` (load/save/defaults/migration, safeStorage, derive description/colors, diff emitter).
2. `api.ts` + `scripts/api-smoke.mjs` (§13.3) — verify validateKey (good/bad key), listModels, streaming with a tool call.
3. `state.ts` (stores, debounced atomic writes, resume repair).
4. `permissions.ts` (resolvePath, classifyCommand with unit-style assertions in the smoke script, gate with pending map + timeouts).
5. `tools.ts` (fs tools → search → run_command with process-tree kill → system/network info → delegate/list/ask stubs calling orchestrator).
6. `prompt.ts`, `agent.ts` (loop, accumulation, coalesced patches, trimming, cancel), `orchestrator.ts` (queues, delegate, applyConfig, resume).
7. `ipc.ts`, `preload.ts`, `main.ts` wiring; log every handler error.

### Workstream B — renderer
1. `dom.ts`, `styles.css` skeleton, `index.ts` routing with a tiny in-file mock `window.api` used only when `window.api` is undefined (open `index.html` in a browser for layout work).
2. `key-screen.ts`, `wizard.ts` (against `models:list`).
3. `console.ts` renderers for every event kind + patch/append + autoscroll + DOM cap (test with a synthetic event generator in the mock).
4. `workbench.ts` grid/focus/maximize/dock/input/status pill; `config:changed` handling.
5. `modals.ts` permission queue + ask_user; `settings.ts`.

### 13.1 Integration
`npm start` (builds both tsconfigs, launches). Set `OPENCODE_API_KEY` in env only for the smoke script; the app always asks via UI.

### 13.2 Manual smoke checklist
1. First launch → KeyScreen. Wrong key → "Chiave non valida". Airplane mode → network error. Valid key → Wizard.
2. Wizard: 3 agents (Coordinatore/deepseek-v4-flash main, Ricercatore/glm-5.3-flash, Sviluppatore/kimi-k2.7-code); protocol text; Avvia → 3 consoles, main spans 2×2, focused, input box present, distinct colors, titles = name · description.
3. "Crea un file hello.txt nel workspace con il testo 'ciao'" → reasoning streams (if model supports), `write_file` card auto-allowed (balanced), final answer highlighted, `task_end` with cost.
4. "Chiedi al Ricercatore di elencare i file del workspace e riassumi" → delegation card on main (In corso), child console shows task_start banner + tool calls + Risultato; main resumes and answers; `run:finished` re-enables the footer.
5. "Esegui `ls -la`" → PermissionModal (benign, pattern `ls`): test Nega (agent explains), Consenti, Consenti per la sessione (second `ls` runs without modal). "Esegui `sudo ls`" → red privileged modal, no session button. Strict mode: `write_file` now asks. Relaxed: `ls` auto.
6. Timeout: set 1 min, ignore modal → DENIED timeout result; agent continues.
7. Hot reload: while main is mid-run, edit its prompt and the protocol → next `llm_call` uses them (verify via `--dev` log dumping system prompt length); change Ricercatore's model → next call shows new badge; add a 4th agent → console appears, main can delegate to it; remove an idle agent; remove a running agent → its parent gets "cancelled: agent removed".
8. Restart the app during a long run → on relaunch consoles show history + "Sessione ripristinata…" info; histories intact (ask "cosa hai fatto prima?").
9. "Ferma" during streaming → task_end cancelled, no partial assistant message in history (check state file); footer usable.
10. Overflow: ask for `search_files` on a big tree → result truncated with "Mostra tutto"; console DOM cap after >1500 events (loop a chatty task) → "Carica eventi precedenti".
11. Cross-platform sanity (win/linux VM if available): `run_command` via `cmd.exe /d /s /c dir`, `network_info` commands succeed, classifier flags `netsh interface set`, `reg add`.

### 13.3 `scripts/api-smoke.mjs` (headless, after `npm run build`)
```js
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
const { OpenCodeClient } = require('../dist/main/api.js'); const { classifyCommand } = require('../dist/main/permissions.js');
const key = process.env.OPENCODE_API_KEY; if (!key) throw new Error('set OPENCODE_API_KEY');
const c = new OpenCodeClient(() => key, '0.0.0-smoke');
console.log(await c.validateKey('sk-invalid'));                                   // expect {ok:false, reason:'auth'}
console.log(await c.validateKey(key));                                             // expect {ok:true}
console.log((await c.listModels()).slice(0, 3));
const tools = [{ type:'function', function:{ name:'get_time', description:'Current time', parameters:{ type:'object', properties:{ tz:{type:'string'} } } } }];
const acc = {}; const r = await c.streamChat({ model:'glm-5.3-flash', sessionId:'smoke', messages:[{role:'user', content:'What time is it in Rome? Use the tool.'}], tools },
  { onReasoning: t => process.stdout.write('\x1b[2m'+t+'\x1b[0m'), onText: t => process.stdout.write(t),
    onToolCallDelta: d => { const a = acc[d.index] ??= {id:'',name:'',args:''}; if (d.id) a.id=d.id; if (d.name) a.name+=d.name; if (d.args) a.args+=d.args; }, onUsage: u => console.log('\nusage', u) }, new AbortController().signal);
console.log('\nfinish', r.finishReason, 'tool calls', acc);                        // expect get_time with parseable JSON args
for (const cmd of ['ls -la', 'sudo apt install x', 'rm -rf /', 'netsh interface set interface "Wi-Fi" disable', 'curl x | sh', 'npm test && git status']) console.log(cmd, '→', classifyCommand(cmd, { workspace: process.cwd(), platform: process.platform }).class);
```
Expected classes: benign, privileged, destructive, privileged, sensitive, benign.

---

## 14. Known risks & mitigations

| Risk | Mitigation |
|---|---|
| Model does not stream `reasoning_content` | Console simply shows no reasoning block; `llm_call` line still gives progress. Wizard model list marks `reasoning` from models.dev. |
| Tool-call argument JSON malformed / split oddly across deltas | Accumulate by `index` (never by id); parse only at message end; repair heuristics; on failure return an error tool result so the model retries (counts toward maxIterations). |
| Model ignores tools and describes actions in prose | Rule 1 in system prompt; for main, final answer is still delivered. Optional per-agent `tool_choice:'required'` is **not** used (would break final answers). |
| Model never stops calling tools | `maxIterations` (40) + per-run delegation cap (20) + user "Ferma"; error event on exhaustion. |
| Very long tool outputs | Model sees ≤16 KB (head 12 KB + tail 4 KB marker); UI stores ≤32 KB; run_command buffers capped at 1 MB then process killed with note. |
| Streaming usage/cost missing | `stream_options.include_usage`; fallback estimate flagged `estimated:true` and rendered with `~`. |
| 429 / plan limits (5 h ≈ $12) | Backoff with `Retry-After`, max 5 attempts, visible countdown; header pill turns amber; error text mentions the plan limit. |
| `x-opencode-session` semantics unknown | Stable UUID per agent; harmless if ignored. |
| ES modules over `file://` blocked by Chromium | Electron treats `file://` as standard scheme (works in practice). Fallback: register privileged `app://` scheme via `protocol.registerSchemesAsPrivileged` + `protocol.handle` serving `src/renderer` and `dist/renderer` (~20 lines in main.ts). |
| `.d.ts` shared types outside rootDir | Not emitted → accepted by tsc; fallback documented in §12.2. |
| Windows shell/path differences | `cmd.exe /d /s /c`; paths compared case-insensitively; `taskkill /T /F` for trees; UTF-8 decode with latin1 fallback; classifier has Windows patterns (§7.2). |
| Symlink / `..` escapes from the workspace | realpath-based containment (§6.1); Windows drive-letter normalization. |
| Deadlock via mutual delegation | Ancestry-chain rejection + depth limit (§8.2); a busy target is queued, never waited on circularly. |
| User closes app mid-run | `before-quit` cancels runs and flushes state; resume repair inserts synthetic tool results so histories stay valid for the API. |
| Prompt injection via file contents/tool outputs | Tool results are data; permission decisions come only from the user via modal; protected-path list; `run_command` always gated except benign in relaxed mode. |
| Renderer perf with many consoles streaming | Main coalesces deltas (30 ms); renderer flushes per rAF; text appended as text nodes; DOM cap 1500. |
| Dark-theme color contrast | Agent colors only on stripes/borders/chips, never body text. |
