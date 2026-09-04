// Prompt sources (PLAN-v2 §9). Italian role prompts, transcribed verbatim, plus the builders:
//   - `buildRolePrompt`  — the SYSTEM prompt. Byte-identical between calls of one configuration:
//     no date, no per-request data. The orchestrator's Pool / Limiti / Ambiente / Indicazioni
//     sections change only when the user edits the configuration (§0 "Byte-identical system
//     prompts"); instances get role prompt + fixed rules and nothing else.
//   - `buildContractMessage` / `buildPlannerMessage` / `buildVerifierMessage` — the single USER
//     message of an instance, where every dynamic value (date, contract, inlined inputs) lives.
// IMPORTANT: no 'electron' import — the pool is exercised headless by scripts/api-smoke.mjs.

import type {
  AgentConfig, AgentRole, AgentView, AppConfig, Budget, ResultContract, TaskContract,
} from '../shared/types';
import { DEFAULT_BUDGET, effectiveBudget, poolLimits, roleOf } from './contracts';

export interface PromptEnv {
  platform: string;
  release: string;
  arch: string;
  shell: string;
  locale: string;
}

/** UI/prompt label of a role (Italian, user-visible). */
export const ROLE_LABEL: Record<AgentRole, string> = {
  orchestrator: 'orchestratore',
  planner: 'planner',
  worker: 'worker',
  verifier: 'verificatore',
};

export const DEFAULT_PROMPTS: Record<AgentRole, string> = {
  orchestrator: `descrizione: coordina il pool di agenti e parla con l'utente

Sei l'ORCHESTRATORE: l'unico che parla con l'utente. REGOLA ZERO: non svolgi mai lavoro di dominio (ricerca, codice, analisi, scrittura): lo deleghi ai worker con delegate_tasks. Puoi solo leggere il workspace con read_file e list_directory per rispondere a domande fattuali immediate.

Per ogni richiesta:
1. Classifica il livello e dichiaralo nella prima riga della risposta finale: T0 = rispondi da solo (conversazione, domanda fattuale, chiarimento) ed è il caso normale: non delegare se non serve; T1 = 1 worker; T2 = 2-4 worker paralleli e disgiunti; T3 = obiettivo ampio o ambiguo: se hai lo strumento run_planner usalo prima, altrimenti scomponi tu; poi esegui il piano con delegate_tasks(tier "T3"), un batch per gruppo di task indipendenti.
2. Scomponi in task disgiunti: nessuna sovrapposizione di obiettivo o deliverable. I task che scrivono file o eseguono comandi hanno side_effects true.
3. Delega con TaskContract eseguibili da chi non ha letto la conversazione: objective in una frase autosufficiente, senza pronomi né "come detto sopra"; passa i dati con inputs (text, artifact_ref, file), indica deliverable e un acceptance verificabile in una riga. Usa come role il nome di un template della sezione Pool.
4. Sintetizza una sola risposta finale nella lingua dell'utente: non incollare mai output grezzi; se ti serve il contenuto completo di un artefatto usa read_artifact.
5. Se hanno lavorato almeno 2 worker o il risultato è critico e hai lo strumento run_verifier, chiamalo; se non lo hai, rileggi tu i risultati cercando contraddizioni e requisiti ignorati. Se emerge un blocker, ri-esegui il task interessato con delegate_tasks (stesso task_id, feedback del verificatore negli inputs) restando nei round di correzione indicati nei Limiti. Se un worker risponde blocked, rispondi alla sua domanda (chiedendo all'utente con ask_user se necessario) e ri-esegui il task con la risposta negli inputs.
Budget: rispetta i Limiti indicati sotto (worker paralleli per chiamata, istanze per richiesta, round di correzione). Se il budget non basta, consegna il meglio ottenuto e dichiara cosa manca. Se la sezione Pool non contiene worker, rispondi direttamente e dichiaralo. Se un'ambiguità cambia il risultato, fai UNA sola domanda con ask_user prima di delegare.`,

  planner: `descrizione: trasforma un obiettivo ampio in un piano di task

Sei il PLANNER. Ricevi un obiettivo ampio e produci un piano di al massimo 6 task ordinati. Per ogni task indica: task_id (t1, t2, …), role (nome di un template worker tra quelli elencati nel messaggio), objective (una frase autosufficiente, senza pronomi), inputs, constraints, deliverable, acceptance (criterio verificabile in una riga), side_effects (true se scrive file o esegue comandi) e depends_on (task_id da cui dipende; i task senza dipendenze si eseguono in parallelo). Unisci i task che producono lo stesso output. Puoi leggere il workspace (read_file, list_directory, search_files) ma non modificarlo. Chiudi con le assunzioni fatte e con cosa cambierebbe se fossero false.
Rispondi SOLO con JSON: {"tasks":[{"task_id":"t1","role":"…","objective":"…","inputs":[],"constraints":[],"deliverable":"…","acceptance":"…","side_effects":false,"depends_on":[]}],"assumptions":["…"],"if_false":["…"]}`,

  worker: `descrizione: esegue un singolo TaskContract e restituisce un ResultContract

Sei un WORKER. Esegui esattamente il TaskContract che ricevi: non hai accesso alla conversazione con l'utente e non puoi fargli domande. L'ambito è solo l'objective: niente extra, niente miglioramenti non richiesti. Se manca qualcosa di essenziale non inventare: rispondi con status "blocked" e una blocking_question precisa. Agisci solo tramite strumenti e non dichiarare mai fatto ciò che non hai fatto. Separa ciò che hai verificato da ciò che hai dedotto: le deduzioni vanno in assumptions, ciò che non hai potuto controllare in unverified. Rispetta constraints e deliverable.
Chiudi con un solo messaggio che contiene SOLO il ResultContract JSON: {"task_id":"…","status":"ok|blocked|partial","result":"…","assumptions":[],"unverified":[],"blocking_question":null}`,

  verifier: `descrizione: verifica avversariale dei risultati, non li corregge

Sei il VERIFICATORE, avversariale: non migliori il lavoro, trovi ciò che non va. Ricevi la richiesta originale, i TaskContract e gli output. Controlla nell'ordine: 1) l'insieme risponde alla richiesta originale, non a una versione comoda; 2) fatti non supportati o inventati; 3) errori di calcolo, logica o codice; 4) requisiti del contratto ignorati (deliverable, constraints, acceptance); 5) contraddizioni interne o tra worker. Puoi leggere il workspace (read_file, list_directory, search_files) per controllare, ma non modificarlo. Non riscrivere mai l'output.
Rispondi SOLO con JSON: {"findings":[{"severity":"blocker|major|minor","task_id":"t2","issue":"…","fix":"…"}],"verdict":"blocker|no_blocker","summary":"una riga"}. Se non ci sono blocker, dillo in una riga in summary.`,
};

/** Fixed rules appended to the orchestrator's system prompt (PLAN-v2 §9). */
export const FIXED_RULES_ORCHESTRATOR = `## Regole fisse
- Agisci solo tramite strumenti; non affermare mai di aver fatto ciò che non hai fatto. Un rifiuto di autorizzazione da parte dell'utente è definitivo.
- Il tuo messaggio finale senza chiamate a strumenti è la risposta mostrata all'utente: inizia con il livello (es. "T2 ·") e chiudi sempre con una risposta completa.
- delegate_tasks accetta al massimo il numero di task indicato nei Limiti; task duplicati o con lo stesso deliverable vengono rifiutati dal sistema; un task_id può essere ri-eseguito solo dopo run_verifier e al massimo per i round di correzione indicati nei Limiti (continuare un task blocked non conta come correzione).
- I worker non vedono questa conversazione: ogni contratto deve bastare da solo.
- Rispondi nella lingua dell'utente ({locale}); codice, comandi e contenuti dei file restano nella loro lingua.`;

/** Headers and fixed wordings of the orchestrator's config-driven sections (PLAN-v2 §9). */
export const ORCHESTRATOR_SECTIONS = {
  pool: '## Pool',
  limits: '## Limiti',
  environment: '## Ambiente',
  userNotes: "## Indicazioni dell'utente",
  noPlanner: '(nessun template planner: pianifica tu)',
  noVerifier: '(nessun template verificatore: verifica tu)',
  noWorker: '(nessun template worker: rispondi direttamente)',
  noUserNotes: '(nessuna)',
} as const;

/** Fixed rules appended to an instance's system prompt (PLAN-v2 §9). */
export const INSTANCE_RULES = {
  header: '## Regole fisse',
  tools: '- Agisci solo tramite gli strumenti disponibili ({toolList}); i percorsi relativi partono dal workspace indicato nel messaggio.',
  runCommand: '- run_command: solo comandi non interattivi. Alcune azioni richiedono l\'autorizzazione dell\'utente, gestita dall\'app: un rifiuto è definitivo, riportalo in unverified.',
  delegateTasks: '- delegate_tasks: puoi delegare sotto-task disgiunti a un template worker della sezione Pool ({worker names}); mai a te stesso né a chi ti ha delegato; al massimo {maxParallelWorkers} per chiamata, profondità massima {maxDepth}.',
  jsonOnly: '- Il tuo ultimo messaggio deve contenere solo il JSON richiesto, senza testo attorno. Il campo cost lo compila il sistema.',
  // Replaces `runCommand` when the user chose the bypass mode: saying "some actions need approval"
  // would be false there, and the agent must know its actions execute immediately.
  bypass: "- Modalità bypass attiva: l'app non chiede alcuna autorizzazione, quindi ogni azione (compresi comandi distruttivi o percorsi fuori dal workspace) viene eseguita subito e senza conferma. Agisci con prudenza: preferisci azioni minime e reversibili, resta nel workspace se non è indispensabile uscirne, e non eseguire comandi che non ti servono per l'obiettivo del contratto.",
  language: '- Rispondi nella lingua della richiesta ({locale}); codice, comandi e contenuti dei file restano nella loro lingua.',
} as const;

/** `config:defaultPrompt` (PLAN-v2 §3): the Italian default prompt text of a role. */
export function defaultPrompt(role: AgentRole): string {
  return DEFAULT_PROMPTS[role] ?? DEFAULT_PROMPTS.worker;
}

// ================================================================ system prompts

export interface RolePromptOpts {
  /** Tool names exposed to this role in this iteration (tools.ts::toolNamesFor). */
  toolNames: string[];
}

/**
 * SYSTEM prompt of a template (PLAN-v2 §9). Contains zero per-request data: the orchestrator's
 * dynamic sections derive from the configuration only, instances get no dynamic data at all.
 */
export function buildRolePrompt(
  agent: AgentConfig,
  cfg: AppConfig,
  roster: AgentView[],
  env: PromptEnv,
  opts: RolePromptOpts,
): string {
  const role = roleOf(agent);
  const head = (agent.prompt ?? '').trim() || DEFAULT_PROMPTS[role];
  if (role === 'orchestrator') {
    return [
      head,
      '',
      FIXED_RULES_ORCHESTRATOR.replace('{locale}', env.locale),
      poolSection(roster),
      limitsSection(cfg),
      environmentSection(cfg, env),
      notesSection(cfg),
    ].join('\n');
  }
  return [head, '', instanceRules(role, cfg, roster, env, opts.toolNames)].join('\n');
}

function poolSection(roster: AgentView[]): string {
  const lines: string[] = [ORCHESTRATOR_SECTIONS.pool];
  for (const a of roster) {
    if (roleOf(a) === 'orchestrator') continue;
    const routing: string[] = [`modello ${a.model}`];
    if (a.fallbacks && a.fallbacks.length) routing.push(`fallback ${a.fallbacks.join(', ')}`);
    if (a.escalation) routing.push(`escalation ${a.escalation}`);
    lines.push(`- ${a.name} — ${ROLE_LABEL[roleOf(a)]} — ${a.description || 'senza descrizione'} [${routing.join(', ')}]`);
  }
  if (!roster.some((a) => roleOf(a) === 'planner')) lines.push(`- ${ORCHESTRATOR_SECTIONS.noPlanner}`);
  if (!roster.some((a) => roleOf(a) === 'verifier')) lines.push(`- ${ORCHESTRATOR_SECTIONS.noVerifier}`);
  if (!roster.some((a) => roleOf(a) === 'worker')) lines.push(`- ${ORCHESTRATOR_SECTIONS.noWorker}`);
  return lines.join('\n');
}

function limitsSection(cfg: AppConfig): string {
  const l = poolLimits(cfg);
  const depth = l.allowWorkerDelegation ? `${l.maxDepth} (i worker possono delegare)` : '2';
  const b = DEFAULT_BUDGET;
  return [
    ORCHESTRATOR_SECTIONS.limits,
    `worker paralleli per chiamata: ${l.maxParallelWorkers} · istanze per richiesta: ${l.maxWorkersPerRequest}`
    + ` · round di correzione: ${l.correctionRounds} · profondità: ${depth}`
    + ` · soglia artefatti: ${l.artifactThresholdChars} caratteri`
    + ` · budget predefinito per task: ${b.maxTokens}/${b.maxToolCalls}/${b.maxSeconds}`,
  ].join('\n');
}

function environmentSection(cfg: AppConfig, env: PromptEnv): string {
  return [
    ORCHESTRATOR_SECTIONS.environment,
    `OS ${env.platform} ${env.release} (${env.arch}) · shell ${env.shell} · workspace ${cfg.workspacePath ?? '(non impostato)'} (i percorsi relativi partono da qui)`,
  ].join('\n');
}

function notesSection(cfg: AppConfig): string {
  return [
    ORCHESTRATOR_SECTIONS.userNotes,
    (cfg.interactionPrompt ?? '').trim() || ORCHESTRATOR_SECTIONS.noUserNotes,
  ].join('\n');
}

function instanceRules(
  role: AgentRole,
  cfg: AppConfig,
  roster: AgentView[],
  env: PromptEnv,
  toolNames: string[],
): string {
  const l = poolLimits(cfg);
  const lines: string[] = [INSTANCE_RULES.header];
  lines.push(INSTANCE_RULES.tools.replace('{toolList}', toolNames.join(', ') || 'nessuno'));
  const bypass = cfg.permissionMode === 'bypass';
  if (role === 'worker' && toolNames.includes('run_command')) {
    lines.push(bypass ? INSTANCE_RULES.bypass : INSTANCE_RULES.runCommand);
  } else if (bypass && role === 'worker') {
    lines.push(INSTANCE_RULES.bypass);
  }
  if (role === 'worker' && toolNames.includes('delegate_tasks')) {
    const workers = roster.filter((a) => roleOf(a) === 'worker').map((a) => a.name).join(', ');
    lines.push(INSTANCE_RULES.delegateTasks
      .replace('{worker names}', workers || '—')
      .replace('{maxParallelWorkers}', String(l.maxParallelWorkers))
      .replace('{maxDepth}', String(l.maxDepth)));
  }
  lines.push(INSTANCE_RULES.jsonOnly);
  lines.push(INSTANCE_RULES.language.replace('{locale}', env.locale));
  return lines.join('\n');
}

// ================================================================ instance user messages

function ambiente(cfg: AppConfig, env: PromptEnv): string {
  return [
    '## Ambiente',
    `OS ${env.platform} ${env.release} (${env.arch}) · shell ${env.shell} · workspace ${cfg.workspacePath ?? '(non impostato)'}`
    + ` · data ${new Date().toISOString()} · lingua utente ${env.locale}`,
  ].join('\n');
}

/** The contract as the worker sees it: inputs are listed by reference, contents come below. */
function contractForModel(c: TaskContract, budget: Budget): Record<string, unknown> {
  return {
    task_id: c.task_id,
    role: c.role,
    objective: c.objective,
    inputs: c.inputs.map((i) => (i.type === 'text'
      ? { type: 'text', chars: i.content.length }
      : (i.type === 'artifact_ref' ? { type: 'artifact_ref', id: i.id } : { type: 'file', path: i.path }))),
    constraints: c.constraints,
    deliverable: c.deliverable,
    acceptance: c.acceptance,
    side_effects: c.side_effects,
    budget: { max_tokens: budget.maxTokens, max_tool_calls: budget.maxToolCalls, max_seconds: budget.maxSeconds },
  };
}

export interface ContractMessageOpts {
  contract: TaskContract;
  /** Already-inlined input blocks from ArtifactStore.inline (§7.2). */
  inputBlocks: string[];
  budget: Budget;
  attempt: number;
  /** Result of the previous attempt, when this is a correction / blocked continuation (§9). */
  previous?: ResultContract | null;
}

/** The single USER message of a worker instance (PLAN-v2 §9 "Instance user message"). */
export function buildContractMessage(cfg: AppConfig, env: PromptEnv, o: ContractMessageOpts): string {
  const parts: string[] = [ambiente(cfg, env)];
  parts.push('', '## TaskContract', '```json', JSON.stringify(contractForModel(o.contract, o.budget), null, 2), '```');
  if (o.inputBlocks.length) parts.push('', '## Input inclusi', o.inputBlocks.join('\n\n'));
  if (o.attempt > 1) {
    const prev = o.previous;
    const summary = prev
      ? `stato precedente: ${prev.status}\n${typeof prev.result === 'string' ? prev.result.slice(0, 1200) : `artifact_ref ${prev.result.artifact_ref} — ${prev.result.summary}`}`
      : '(esito precedente non disponibile)';
    parts.push('', `## Tentativo ${o.attempt}`, summary);
  }
  parts.push('', '## Risposta attesa', `Solo il ResultContract JSON con task_id "${o.contract.task_id}".`);
  return parts.join('\n');
}

/** The single USER message of a planner instance (PLAN-v2 §9). */
export function buildPlannerMessage(
  cfg: AppConfig,
  env: PromptEnv,
  o: { objective: string; context?: string; workers: AgentView[] },
): string {
  const parts: string[] = [ambiente(cfg, env)];
  parts.push('', '## Obiettivo', o.objective.trim());
  parts.push('', '## Contesto', (o.context ?? '').trim() || '(nessuno)');
  parts.push('', '## Template worker disponibili');
  if (o.workers.length) {
    for (const w of o.workers) parts.push(`- ${w.name} — ${w.description || 'senza descrizione'}`);
  } else {
    parts.push('- (nessuno: indica comunque i task, il sistema li assegnerà)');
  }
  parts.push('', '## Risposta attesa',
    'Solo JSON: {"tasks":[{"task_id":"t1","role":"…","objective":"…","inputs":[],"constraints":[],"deliverable":"…","acceptance":"…","side_effects":false,"depends_on":[]}],"assumptions":["…"],"if_false":["…"]}',
    'Al massimo 6 task.');
  return parts.join('\n');
}

export interface VerifierItem { taskId: string; contract: TaskContract; output: string }

/** The single USER message of a verifier instance (PLAN-v2 §9). */
export function buildVerifierMessage(
  cfg: AppConfig,
  env: PromptEnv,
  o: { userText: string; items: VerifierItem[] },
): string {
  const parts: string[] = [ambiente(cfg, env)];
  parts.push('', "## Richiesta originale dell'utente", o.userText.trim() || '(non disponibile)');
  for (const it of o.items) {
    const budget = effectiveBudget(it.contract.budget, undefined);
    parts.push('', `## ${it.taskId} — TaskContract`, '```json', JSON.stringify(contractForModel(it.contract, budget), null, 2), '```');
    parts.push('', `## ${it.taskId} — Output`, it.output);
  }
  parts.push('', '## Risposta attesa',
    'Solo JSON: {"findings":[{"severity":"blocker|major|minor","task_id":"t2","issue":"…","fix":"…"}],"verdict":"blocker|no_blocker","summary":"una riga"}');
  return parts.join('\n');
}
