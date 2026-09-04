// Shared ambient types for Agents Pool — transcribed verbatim from docs/PLAN.md §2 (data model)
// and §3 (IPC contract). This file is types-only (.d.ts, never emitted); it is the frozen contract
// between the main-process and renderer implementation streams (see PLAN §1, §13 "Step 0").
//
// Consistency check performed while transcribing (per scaffolding instructions: resolve any
// inconsistency between §2 and §3 in favour of §3, the IPC contract, and note it here):
//   - No inconsistencies were found. Every type referenced by InvokeMap/EventMap in §3
//     (AppInfo, KeyValidationResult, ModelInfo, ConfigSnapshot, ConfigPatch, SetupPayload,
//     AgentInput, AgentId, ConsoleEvent, RuntimeSnapshot, PermissionDecision, RunFinished,
//     ConfigChanged, ConsolePatch, AgentStatusUpdate, PermissionRequest, AskUserRequest) is
//     defined in §2 with a matching shape, so §2 and §3 were transcribed as-is.
//   - `ToolDef` (mentioned in PLAN §4/§6 as the OpenAI-style {type:'function', function:{...}}
//     tool schema) is intentionally NOT included here: PLAN §1's layout comment scopes this file
//     to "§2, §3" only, and ToolDef is a main-process-internal type (used by api.ts/tools.ts),
//     never crossing the IPC boundary or appearing in InvokeMap/EventMap.
//   - The preload.ts code sample shown alongside §3 is implementation, not a type declaration;
//     it is intentionally not reproduced here (scaffolding must not add implementation files).

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

// ---------- IPC contract (window.api) ----------
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
  'permission:respond':     (requestId: string, decision: PermissionDecision, pattern?: string) => void;   // unknown id → no-op; pattern = user-edited session pattern (optional)
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
