// Contracts: pool limits, budget defaults, TaskContract/ResultContract/plan/verdict validation and
// the JSONL contracts log. PLAN-v2 §7 (+ §11.3 ranges).
//
// IMPORTANT: no 'electron' import — scripts/api-smoke.mjs §11/§12 exercises these validators with a
// plain AppConfig object. POOL_RANGES / DEFAULT_BUDGET live here (not in config.ts as PLAN-v2 §11.3
// suggests) for exactly that reason; config.ts re-exports them so the rest of the tree and
// `AppInfo.poolRanges` are unaffected.

import * as path from 'node:path';
import type {
  AgentConfig, AppConfig, Budget, Plan, PlanTask, PoolRanges, Range, ResultContract, ResultStatus,
  Severity, TaskContract, TaskInput, TaskResult, Usage, Verdict, VerifierFinding,
} from '../shared/types';
import type { ArtifactStore } from './artifacts';
import { resolvePath } from './permissions';
import {
  appendLine, clampInt, firstBalancedObject, fmtErr, isRecord, logWarn, normalizeKey, stripFences,
} from './util';

// ================================================================ limits & budgets

/** Pool limits are settings, not constants (PLAN-v2 §11.3): `default` reproduces the designed
 *  behaviour, the UI warns above `recommendedMax` and everything is clamped to [min, max]. */
export const POOL_RANGES: PoolRanges = {
  maxParallelWorkers:     { min: 1,    max: 16,    default: 4,    recommendedMax: 8 },
  maxWorkersPerRequest:   { min: 1,    max: 32,    default: 8,    recommendedMax: 8 },
  correctionRounds:       { min: 0,    max: 3,     default: 1,    recommendedMax: 1 },
  maxDepth:               { min: 2,    max: 4,     default: 2,    recommendedMax: 2 },
  artifactThresholdChars: { min: 1000, max: 20000, default: 4000, recommendedMax: 8000 },
};

/** Per-task budget when neither the TaskContract nor the template sets one (§11.3). */
// Measured on real runs: one file write costs 4.7k-7.1k tokens because every iteration re-sends
// (and re-counts) the prompt, so a budget of 8k killed ordinary tasks halfway. These defaults leave
// room for a 4-6 iteration task; the user can lower them per template in Settings.
// `maxSeconds` is NOT a wall clock for the whole task: it is how long the model may go silent
// (no streamed data at all) before a call is treated as stalled and retried/switched. A task with
// several legitimate iterations can run far longer than this in total as long as the model keeps
// responding — only real silence counts against it.
export const DEFAULT_BUDGET: Budget = { maxTokens: 24000, maxToolCalls: 12, maxSeconds: 60 };
/** Ceiling no contract or template can exceed (§7.1). */
export const HARD_MAX_BUDGET: Budget = { maxTokens: 60000, maxToolCalls: 40, maxSeconds: 300 };

export function clampRange(raw: unknown, r: Range): number {
  return clampInt(raw, r.min, r.max, r.default);
}

export interface PoolLimits {
  maxParallelWorkers: number;
  maxWorkersPerRequest: number;
  correctionRounds: number;
  allowWorkerDelegation: boolean;
  maxDepth: number;
  artifactThresholdChars: number;
}

/**
 * Every algorithm reads its limits through this helper so no literal 4/8/1 exists in the code and
 * a config written by an older version still behaves like the documented defaults (PLAN-v2 §0).
 */
export function poolLimits(cfg: AppConfig): PoolLimits {
  return {
    maxParallelWorkers: clampRange(cfg.maxParallelWorkers, POOL_RANGES.maxParallelWorkers),
    maxWorkersPerRequest: clampRange(cfg.maxWorkersPerRequest, POOL_RANGES.maxWorkersPerRequest),
    correctionRounds: clampRange(cfg.correctionRounds, POOL_RANGES.correctionRounds),
    allowWorkerDelegation: cfg.allowWorkerDelegation === true,
    maxDepth: clampRange(cfg.maxDepth, POOL_RANGES.maxDepth),
    artifactThresholdChars: clampRange(cfg.artifactThresholdChars, POOL_RANGES.artifactThresholdChars),
  };
}

/**
 * The budget an orchestrator writes into a TaskContract is **advisory only**: it is logged and shown
 * in the UI, never enforced. Models invent unusable values (measured: 1500-4000 `maxTokens` for
 * tasks that really cost 4.7k-7.1k), and every instance came back `partial` with no deliverable.
 * Hard limits belong to code and settings — so the template budget (or `DEFAULT_BUDGET`) is what the
 * kill switch uses, capped by `HARD_MAX_BUDGET` (§7.1).
 */
export function effectiveBudget(
  _contractAdvisory: Partial<Budget> | undefined,
  template: Budget | undefined,
): Budget {
  const pick = (k: keyof Budget): number => {
    const raw = template?.[k];
    const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_BUDGET[k];
    return Math.max(1, Math.min(HARD_MAX_BUDGET[k], n));
  };
  return { maxTokens: pick('maxTokens'), maxToolCalls: pick('maxToolCalls'), maxSeconds: pick('maxSeconds') };
}

/** Accepts both `max_tokens` and `maxTokens` from the model (§8). */
export function normalizeBudgetInput(raw: unknown): Partial<Budget> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Partial<Budget> = {};
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = raw[k];
      const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number.parseFloat(v) : NaN);
      if (Number.isFinite(n)) return Math.round(n);
    }
    return undefined;
  };
  const t = num('max_tokens', 'maxTokens');
  const c = num('max_tool_calls', 'maxToolCalls');
  const s = num('max_seconds', 'maxSeconds');
  if (t !== undefined) out.maxTokens = t;
  if (c !== undefined) out.maxToolCalls = c;
  if (s !== undefined) out.maxSeconds = s;
  return Object.keys(out).length ? out : undefined;
}

// ================================================================ TaskContract validation

export type Validated<T> = { ok: T } | { error: string };

const TASK_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const PRONOUN_START_RE = /^(questo|quello|questa|quella|ciò|it|this|that)\b/i;
/** Back-references to a conversation the worker never saw (PLAN-v2 §9 step 3, §13.1 item 11). */
const BACKREF_RE = /\b(come detto|come sopra|come indicato sopra|come richiesto sopra|as said above|as above|as mentioned above)\b/i;
const MAX_INPUTS = 12;
const MAX_CONSTRAINTS = 12;

/** §7.1 — normalize first, then check; never throws. */
export function validateTaskContract(
  raw: unknown,
  i: number,
  opts: { workspacePath: string | null },
): Validated<TaskContract> {
  if (!isRecord(raw)) return { error: `task ${i + 1}: not an object` };

  let taskId = typeof raw.task_id === 'string' ? raw.task_id.trim() : '';
  if (!taskId) taskId = `t${i + 1}`;
  if (!TASK_ID_RE.test(taskId)) {
    return { error: `task ${i + 1}: task_id "${taskId}" must match [A-Za-z0-9_-]{1,24}` };
  }

  const role = typeof raw.role === 'string' ? raw.role.trim() : '';
  if (!role) return { error: `${taskId}: role is required (a worker template name from the Pool section)` };

  const objective = typeof raw.objective === 'string' ? raw.objective.trim() : '';
  if (objective.length < 10 || objective.length > 1200) {
    return { error: `${taskId}: objective must be a self-contained sentence of 10..1200 chars (got ${objective.length})` };
  }
  if (PRONOUN_START_RE.test(objective)) {
    return { error: `${taskId}: objective must be self-contained — it starts with a pronoun ("${objective.slice(0, 24)}…"); name the subject explicitly` };
  }
  if (BACKREF_RE.test(objective)) {
    return { error: `${taskId}: objective must be self-contained — it refers back to the conversation ("${objective.slice(0, 40)}…"); spell the request out` };
  }

  const inputsRaw = Array.isArray(raw.inputs) ? raw.inputs : [];
  if (inputsRaw.length > MAX_INPUTS) return { error: `${taskId}: at most ${MAX_INPUTS} inputs (got ${inputsRaw.length})` };
  const inputs: TaskInput[] = [];
  for (let k = 0; k < inputsRaw.length; k++) {
    const inp = inputsRaw[k];
    if (!isRecord(inp)) return { error: `${taskId}: input ${k + 1} is not an object` };
    const type = typeof inp.type === 'string' ? inp.type : '';
    if (type === 'text') {
      const content = typeof inp.content === 'string' ? inp.content : '';
      if (!content) return { error: `${taskId}: input ${k + 1} of type text needs "content"` };
      inputs.push({ type: 'text', content });
    } else if (type === 'artifact_ref') {
      const id = typeof inp.id === 'string' ? inp.id.trim() : '';
      if (!id) return { error: `${taskId}: input ${k + 1} of type artifact_ref needs "id"` };
      inputs.push({ type: 'artifact_ref', id });
    } else if (type === 'file') {
      const p = typeof inp.path === 'string' ? inp.path.trim() : '';
      if (!p) return { error: `${taskId}: input ${k + 1} of type file needs "path"` };
      const r = resolvePath(p, opts.workspacePath);
      if (!r.inside) return { error: `${taskId}: input file "${p}" is outside the workspace` };
      if (r.isProtected) return { error: `${taskId}: input file "${p}" is a protected path` };
      inputs.push({ type: 'file', path: p });
    } else {
      return { error: `${taskId}: input ${k + 1} has unknown type "${type}" (text | artifact_ref | file)` };
    }
  }

  const constraintsRaw = Array.isArray(raw.constraints) ? raw.constraints : [];
  if (constraintsRaw.length > MAX_CONSTRAINTS) {
    return { error: `${taskId}: at most ${MAX_CONSTRAINTS} constraints (got ${constraintsRaw.length})` };
  }
  const constraints: string[] = [];
  for (const c of constraintsRaw) {
    if (typeof c !== 'string') continue;
    const s = c.trim();
    if (!s) continue;
    if (s.length > 400) return { error: `${taskId}: each constraint must be ≤ 400 chars` };
    constraints.push(s);
  }

  const deliverable = typeof raw.deliverable === 'string' ? raw.deliverable.trim() : '';
  if (!deliverable || deliverable.length > 600) {
    return { error: `${taskId}: deliverable is required and must be ≤ 600 chars` };
  }
  const acceptance = typeof raw.acceptance === 'string' ? raw.acceptance.trim() : '';
  if (!acceptance || acceptance.length > 600) {
    return { error: `${taskId}: acceptance is required (a one-line verifiable criterion, ≤ 600 chars)` };
  }

  const se = raw.side_effects;
  const sideEffects = se === true || se === 'true' ? true : false;

  const contract: TaskContract = {
    task_id: taskId, role, objective, inputs, constraints, deliverable, acceptance,
    side_effects: sideEffects,
  };
  const budget = normalizeBudgetInput(raw.budget);
  if (budget) contract.budget = budget;
  return { ok: contract };
}

/** Duplicate ids / objectives / deliverables inside one batch (§7.1, §6.3 step 2). */
export function validateBatch(tasks: TaskContract[]): string | null {
  const ids = new Map<string, string>();
  const objectives = new Map<string, string>();
  const deliverables = new Map<string, string>();
  for (const t of tasks) {
    const prevId = ids.get(t.task_id);
    if (prevId) return `duplicate task_id: ${t.task_id} appears twice in this batch`;
    ids.set(t.task_id, t.task_id);

    const ok = normalizeKey(t.objective);
    const prevO = objectives.get(ok);
    if (prevO) return `duplicate tasks: ${prevO} ≈ ${t.task_id} (same objective); make them disjoint`;
    objectives.set(ok, t.task_id);

    const dk = normalizeKey(t.deliverable);
    const prevD = deliverables.get(dk);
    if (prevD) return `duplicate tasks: ${prevD} ≈ ${t.task_id} (same deliverable); make them disjoint`;
    deliverables.set(dk, t.task_id);
  }
  return null;
}

// ================================================================ ResultContract

export interface ParseResultOpts {
  requestId: string;
  model: string;
  durationMs: number;
  artifactThresholdChars: number;
  artifacts?: ArtifactStore | null;
}
export interface ParsedResult {
  result: ResultContract;
  /** 1 = strict JSON, 2 = JSON extracted from text, 3 = no JSON at all (§7.3). */
  stage: 1 | 2 | 3;
}

const RESULT_STATUSES: ResultStatus[] = ['ok', 'blocked', 'partial'];

/**
 * Models routinely answer with a synonym instead of the three contract values (measured: `completed`,
 * `success`). Coercing those to `partial` made perfectly good work look failed, which then made the
 * verifier raise blockers and burn a correction round — so synonyms are mapped, in both languages.
 */
const STATUS_SYNONYMS: Record<string, ResultStatus> = {
  ok: 'ok', done: 'ok', completed: 'ok', complete: 'ok', success: 'ok', successful: 'ok',
  succeeded: 'ok', finished: 'ok', fatto: 'ok', completato: 'ok', riuscito: 'ok', eseguito: 'ok',
  blocked: 'blocked', blocker: 'blocked', bloccato: 'blocked', blocco: 'blocked',
  partial: 'partial', partially: 'partial', parziale: 'partial', incomplete: 'partial',
  incompleto: 'partial', truncated: 'partial',
};

/** Maps a model-written status onto the contract values; `null` when it is unrecognizable. */
function coerceStatus(raw: string): ResultStatus | null {
  const s = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  return STATUS_SYNONYMS[s] ?? null;
}

/**
 * Three-stage parser that never throws (§7.3, §15): strict JSON → first balanced object (the normal
 * path for lenient models such as minimax-m3) → free text wrapped as `partial`. `task_id` and
 * `cost` are always system-set, never trusted from the model.
 */
export async function parseResultContract(
  text: string,
  contract: TaskContract,
  run: Pick<TaskResult, 'status' | 'usage' | 'budgetHit' | 'toolCalls'> & { truncated?: boolean },
  opts: ParseResultOpts,
): Promise<ParsedResult> {
  const raw = String(text ?? '');
  const trimmed = raw.trim();
  const candidates: Array<{ text: string; stage: 1 | 2 }> = [
    { text: trimmed, stage: 1 },
    { text: stripFences(trimmed).trim(), stage: 2 },
    { text: firstBalancedObject(trimmed) ?? '', stage: 2 },
  ];

  let parsed: Record<string, unknown> | null = null;
  let stage: 1 | 2 | 3 = 3;
  for (const cand of candidates) {
    if (!cand.text) continue;
    try {
      const v = JSON.parse(cand.text) as unknown;
      if (isRecord(v)) { parsed = v; stage = cand.stage; break; }
    } catch { /* next candidate */ }
  }

  const assumptions: string[] = parsed ? strArray(parsed.assumptions) : [];
  const unverified: string[] = parsed ? strArray(parsed.unverified) : [];
  let status: ResultStatus = 'partial';
  let result: ResultContract['result'] = trimmed;
  let blocking: string | null = null;

  if (parsed) {
    const s = typeof parsed.status === 'string' ? parsed.status : '';
    const coerced = coerceStatus(s);
    if (coerced) {
      status = coerced;
      if (!(RESULT_STATUSES as string[]).includes(s.trim().toLowerCase())) {
        unverified.push(`status "${s.trim()}" interpretato come "${coerced}"`);
      }
    } else {
      // Unknown word: a non-empty deliverable is worth more than a label, so it counts as done and
      // the ambiguity is recorded instead of silently degrading the result.
      const hasResult = typeof parsed.result === 'string'
        ? parsed.result.trim().length > 0
        : parsed.result !== undefined && parsed.result !== null;
      status = hasResult ? 'ok' : 'partial';
      unverified.push(s.trim() ? `status "${s.trim()}" non riconosciuto` : 'status assente');
    }
    // Measured: models answer `{"status":"success"}` with `result` empty and the real deliverable
    // under another key, leaving the orchestrator with nothing to synthesize. Look there too.
    const ALT_KEYS = ['result', 'output', 'deliverable', 'summary', 'content', 'answer', 'risultato',
      'esito', 'message', 'text', 'value', 'data'];
    let r: unknown;
    for (const k of ALT_KEYS) {
      const v = parsed[k];
      if (typeof v === 'string' ? v.trim().length > 0 : v !== undefined && v !== null) {
        r = v;
        if (k !== 'result') unverified.push(`deliverable letto dal campo "${k}" invece di "result"`);
        break;
      }
    }
    if (typeof r === 'string') result = r;
    else if (r === undefined || r === null) result = '';
    else { try { result = JSON.stringify(r); } catch { result = String(r); } }
    // A success with no deliverable at all is not a success: the verifier must see it.
    if (status === 'ok' && (typeof result === 'string' ? result.trim().length === 0 : false)) {
      status = 'partial';
      unverified.push('nessun deliverable: il campo result è vuoto');
    }
    blocking = typeof parsed.blocking_question === 'string' && parsed.blocking_question.trim()
      ? parsed.blocking_question.trim()
      : null;
  } else {
    unverified.push(run.truncated
      ? 'risposta troncata prima del JSON (budget token esaurito): alza il budget del template'
      : 'output not in ResultContract format');
  }

  // 4. the run itself failed / was cut short
  if (run.status !== 'done') {
    status = 'partial';
    unverified.push(`run ${run.status}${run.budgetHit ? ` (budget ${run.budgetHit})` : ''}`);
  }
  if (status === 'blocked' && !blocking) {
    status = 'partial';
    unverified.push('blocked without question');
  }

  // 6. large payloads go to the blackboard
  if (typeof result === 'string' && result.length > opts.artifactThresholdChars && opts.artifacts) {
    try {
      const art = await opts.artifacts.put(opts.requestId, contract.task_id, result);
      result = { artifact_ref: art.id, summary: art.summary, chars: art.chars };
    } catch (e) {
      logWarn('contracts: artifact store failed', fmtErr(e));
    }
  }

  const usage: Usage = run.usage;
  const out: ResultContract = {
    task_id: contract.task_id,                     // 2. never trust the model
    status,
    result,
    assumptions,
    unverified,
    blocking_question: blocking,
    cost: {                                        // 5. always overwritten from real usage
      tokens: Math.round((usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0)),
      tool_calls: run.toolCalls ?? 0,
      seconds: Math.round(opts.durationMs / 1000),
      usd: usage?.cost ?? 0,
      model: opts.model,
    },
  };
  return { result: out, stage };
}

/** A synthetic ResultContract for the paths that never reached a model (cancel, cap, error). */
export function syntheticResult(
  taskId: string,
  status: ResultStatus,
  text: string,
  note: string,
  model = '',
): ResultContract {
  return {
    task_id: taskId,
    status,
    result: text,
    assumptions: [],
    unverified: note ? [note] : [],
    blocking_question: null,
    cost: { tokens: 0, tool_calls: 0, seconds: 0, usd: 0, model },
  };
}

// ================================================================ plan / verdict

const MAX_PLAN_TASKS = 6;

/** §7.4 — invalid tasks are dropped with a warning, never fatal. */
export function parsePlan(
  text: string,
  opts: { workspacePath: string | null; truncated?: boolean },
): Plan {
  const parsed = extractObject(text);
  if (!parsed) {
    // Distinguish "the model wrote prose" from "the answer was cut off": the second is a budget
    // problem the user can fix in Settings, and it used to be reported as a format error.
    const why = opts.truncated || !String(text ?? '').trim()
      ? 'risposta troncata prima del JSON (budget token del Planner esaurito): alza "budget per task" del template Planner nelle impostazioni, oppure riduci l\'obiettivo'
      : 'plan not in JSON format';
    return { tasks: [], assumptions: [], if_false: [], warnings: [why], raw: String(text ?? '').slice(0, 4000) };
  }
  const warnings: string[] = [];
  const rawTasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const tasks: PlanTask[] = [];
  for (let i = 0; i < rawTasks.length; i++) {
    const v = validateTaskContract(rawTasks[i], i, opts);
    if ('error' in v) { warnings.push(`task dropped: ${v.error}`); continue; }
    const task: PlanTask = { ...v.ok };
    const dep = isRecord(rawTasks[i]) ? (rawTasks[i] as Record<string, unknown>).depends_on : undefined;
    const deps = strArray(dep);
    if (deps.length) task.depends_on = deps;
    tasks.push(task);
  }
  if (tasks.length > MAX_PLAN_TASKS) {
    tasks.length = MAX_PLAN_TASKS;
    warnings.push(`plan truncated to ${MAX_PLAN_TASKS} tasks`);
  }
  return {
    tasks,
    assumptions: strArray(parsed.assumptions),
    if_false: strArray(parsed.if_false),
    warnings,
  };
}

const SEVERITIES: Severity[] = ['blocker', 'major', 'minor'];

/** §7.5 — free text degrades to `no_blocker` + a summary; the verdict is derived, not trusted. */
export function parseVerdict(text: string): Verdict {
  const parsed = extractObject(text);
  if (!parsed) {
    return { findings: [], verdict: 'no_blocker', summary: String(text ?? '').trim().slice(0, 400) };
  }
  const findings: VerifierFinding[] = [];
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  for (const f of rawFindings) {
    if (!isRecord(f)) continue;
    const issue = typeof f.issue === 'string' ? f.issue.trim() : '';
    if (!issue) continue;
    const sev = typeof f.severity === 'string' ? f.severity.trim().toLowerCase() : '';
    const finding: VerifierFinding = {
      severity: (SEVERITIES as string[]).includes(sev) ? (sev as Severity) : 'minor',
      issue,
      fix: typeof f.fix === 'string' ? f.fix.trim() : '',
    };
    if (typeof f.task_id === 'string' && f.task_id.trim()) finding.task_id = f.task_id.trim();
    findings.push(finding);
  }
  const summaryRaw = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  return {
    findings,
    verdict: findings.some((f) => f.severity === 'blocker') ? 'blocker' : 'no_blocker',
    summary: (summaryRaw || String(text ?? '').trim()).slice(0, 400),
  };
}

// ================================================================ contracts log

export type ContractKind = 'task' | 'result' | 'rejected' | 'plan' | 'verifier';

export interface ContractRecord {
  ts: number;
  requestId: string;
  kind: ContractKind;
  taskId?: string;
  instanceId?: string;
  template?: string;
  model?: string;
  attempt?: number;
  data: unknown;
}

/** One JSON line per record in `userData/logs/contracts.jsonl`, fire-and-forget (§7.7). */
export class ContractsLog {
  private readonly path: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.path = path.join(userDataPath, 'logs', 'contracts.jsonl');
  }

  get file(): string { return this.path; }

  append(rec: Omit<ContractRecord, 'ts'>): void {
    let line: string;
    try {
      line = JSON.stringify({ ts: Date.now(), ...rec });
    } catch (e) {
      logWarn('contracts log: unserializable record', fmtErr(e));
      return;
    }
    this.chain = this.chain
      .then(() => appendLine(this.path, line))
      .catch((e) => logWarn('contracts log append failed', fmtErr(e)));
  }

  /** `logs:openContracts` must not fail on a fresh profile. */
  async ensureFile(): Promise<string> {
    await appendLine(this.path, '').catch(() => {});
    await this.chain.catch(() => {});
    return this.path;
  }

  async flush(): Promise<void> { await this.chain.catch(() => {}); }
}

// ================================================================ helpers

function extractObject(text: string): Record<string, unknown> | null {
  const trimmed = String(text ?? '').trim();
  for (const cand of [trimmed, stripFences(trimmed).trim(), firstBalancedObject(trimmed) ?? '']) {
    if (!cand) continue;
    try {
      const v = JSON.parse(cand) as unknown;
      if (isRecord(v)) return v;
    } catch { /* next */ }
  }
  return null;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) out.push(x.trim());
    else if (isRecord(x)) { try { out.push(JSON.stringify(x)); } catch { /* skip */ } }
  }
  return out;
}

/** Role of a template, defaulting to 'worker' (types keep `role` optional for the Step-0 shim). */
export function roleOf(a: Pick<AgentConfig, 'role'>): NonNullable<AgentConfig['role']> {
  return a.role ?? 'worker';
}

/** Valid role strings — used to validate the `config:defaultPrompt` argument (§3). */
export const ROLE_VALUES: string[] = ['orchestrator', 'planner', 'worker', 'verifier'];
