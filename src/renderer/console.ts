// ConsoleView: one scrollable event log per agent.
// One DOM node per ConsoleEvent (keyed by event id); `console:patch` mutates that node in
// place — streaming deltas never create new nodes. Writes are batched per animation frame.

import type {
  AgentId,
  AgentStatus,
  AgentStatusUpdate,
  AgentView,
  Budget,
  CommandClass,
  ConsoleEvent,
  ConsolePatch,
  PermissionOutcome,
  ResultContract,
  ResultStatus,
  Severity,
  TaskContract,
  Tier,
  Usage,
} from '../shared/types';
import {
  btn,
  clear,
  fmtBudget,
  fmtBytes,
  fmtCost,
  fmtMs,
  fmtTokens,
  h,
  iconBtn,
  prettyArgs,
  prettyJson,
  raf,
  renderMarkdown,
  replace,
  ROLE_LABEL,
  roleOf,
} from './dom.js';
import { errText, toast } from './modals.js';

export const MAX_NODES = 1500;
const COLLAPSE_LIMIT = 300;
const RESULT_HEAD = 2000;

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: 'Inattivo',
  thinking: 'Ragiona',
  streaming: 'Scrive',
  tool: 'Strumento',
  waiting_permission: 'Autorizzazione',
  waiting_user: 'Domanda',
  waiting_delegate: 'Attende delega',
  error: 'Errore',
};

const TOOL_STATUS: Record<string, string> = {
  streaming: 'in arrivo…',
  pending_permission: 'in attesa di autorizzazione',
  running: 'in corso',
  done: 'completato',
  error: 'errore',
  denied: 'negato',
};

const TOOL_CALL_HELP: Record<string, string> = {
  streaming: 'Il modello sta ancora scrivendo gli argomenti: lo strumento non è partito.',
  pending_permission: 'Bloccato in attesa della tua autorizzazione nella finestra al centro.',
  running: 'Lo strumento è in esecuzione.',
  done: 'Eseguito: il risultato qui sotto è tornato all’agente.',
  error: 'Lo strumento ha restituito un errore; l’agente lo legge e può riprovare in altro modo.',
  denied: 'Hai negato l’azione: per l’agente il rifiuto è definitivo e deve procedere senza.',
};

const DELEG_STATUS: Record<string, string> = {
  queued: 'In coda',
  running: 'In corso',
  done: 'Completata',
  error: 'Errore',
  cancelled: 'Annullata',
  rejected: 'Rifiutata',
  partial: 'Parziale',
  blocked: 'Bloccato',
};

const RESULT_STATUS: Record<ResultStatus | string, string> = {
  ok: 'ok',
  blocked: 'bloccato',
  partial: 'parziale',
};

const SEVERITY_LABEL: Record<Severity | string, string> = {
  blocker: 'blocker',
  major: 'grave',
  minor: 'minore',
};

const SEVERITY_ORDER: Severity[] = ['blocker', 'major', 'minor'];

const BUDGET_HIT_LABEL: Record<string, string> = {
  maxTokens: 'token',
  maxToolCalls: 'strumenti',
  maxSeconds: 'secondi',
};

const PERM_STATUS: Record<PermissionOutcome | 'pending', string> = {
  pending: 'In attesa…',
  allow: 'Consentito',
  allow_session: 'Consentito per la sessione',
  deny: 'Negato',
  timeout: 'Scaduto',
  cancelled: 'Annullato',
  auto_allow: 'Consentito (automatico)',
  auto_deny: 'Negato (automatico)',
};

const PERM_HELP: Record<string, string> = {
  pending: 'Richiesta aperta: l’agente è fermo qui finché non rispondi o non scade.',
  allow: 'Consentita solo quella volta: un’azione uguale chiederà di nuovo.',
  allow_session: 'Consentita anche per le prossime azioni con lo stesso schema, fino alla chiusura dell’app.',
  deny: 'Negata da te: per l’agente il rifiuto è definitivo.',
  timeout: 'Scaduta senza risposta: l’app l’ha trattata come un rifiuto.',
  cancelled: 'Annullata perché la richiesta è stata fermata.',
  auto_allow: 'Consentita automaticamente dalla modalità autorizzazioni o dall’elenco dei comandi sempre consentiti.',
  auto_deny: 'Negata automaticamente: percorso protetto o azione vietata dalla modalità in uso.',
};

const TASK_END: Record<string, { icon: string; label: string }> = {
  done: { icon: '✓', label: 'completato' },
  error: { icon: '✗', label: 'errore' },
  cancelled: { icon: '■', label: 'annullato' },
  partial: { icon: '◐', label: 'parziale' },
};

const TASK_END_HELP: Record<string, string> = {
  done: 'Esecuzione conclusa regolarmente.',
  error: 'Esecuzione interrotta da un errore: il dettaglio è nella scheda rossa qui sopra.',
  cancelled: 'Fermata da te o dalla rimozione del template: quello che era già arrivato resta visibile.',
  partial: 'Fermata dal budget (token, strumenti o secondi esauriti): contiene solo il lavoro fatto fino a quel punto.',
};

/** Why an agent is in that state — shown on the header status chip. */
const STATUS_HELP: Record<AgentStatus, string> = {
  idle: 'Inattivo: non ha nulla in corso e non consuma token.',
  thinking: 'Sta ragionando: ha chiamato il modello e attende la risposta. È qui che si spendono i token di ragionamento.',
  streaming: 'Sta scrivendo la risposta: il testo arriva pezzo per pezzo.',
  tool: 'Sta usando uno strumento (file, ricerca, comando): la scheda dello strumento sotto mostra argomenti e risultato.',
  waiting_permission: 'In attesa di una tua autorizzazione: rispondi nella finestra al centro, altrimenti scade e l’azione viene negata.',
  waiting_user: 'Ha fatto una domanda e attende la tua risposta: senza risposta procede senza, o si ferma.',
  waiting_delegate: 'Ha delegato e attende i risultati delle istanze: le loro console compaiono accanto a questa.',
  error: 'Ultima chiamata terminata con errore: il dettaglio è nella scheda rossa qui sotto.',
};

const TOOL_HELP: Record<string, string> = {
  read_file: 'Legge un file. Fuori dalla cartella di lavoro serve la tua autorizzazione.',
  write_file: 'Crea o sovrascrive un file: modifica davvero il disco.',
  edit_file: 'Sostituisce una porzione di un file esistente: modifica davvero il disco.',
  delete_path: 'Elimina un file o una cartella: azione distruttiva, richiede autorizzazione.',
  list_directory: 'Elenca il contenuto di una cartella.',
  search_files: 'Cerca testo nei file della cartella di lavoro.',
  run_command: 'Esegue un comando di shell non interattivo: può cambiare il sistema, quindi passa dalle autorizzazioni.',
  system_info: 'Legge dati sul sistema (OS, shell, percorsi).',
  network_info: 'Legge dati sulla rete: non invia contenuti all’esterno.',
  delegate_task: 'Delega a un altro agente (formato v1, resta nella cronologia).',
  list_agents: 'Elenca gli agenti disponibili (formato v1, resta nella cronologia).',
  delegate_tasks: 'Crea le istanze worker: un TaskContract per task, eseguiti in parallelo se non hanno effetti collaterali. Ogni task è una chiamata al modello a sé, quindi qui si decide il costo della richiesta.',
  run_planner: 'Chiama il planner per scomporre un obiettivo ampio in un piano di task: una chiamata in più, usata solo per le richieste T3.',
  run_verifier: 'Chiama il verificatore sui risultati: cerca errori e requisiti ignorati, non li corregge.',
  read_artifact: 'Rilegge per intero un risultato salvato come artefatto perché troppo lungo per stare nel messaggio.',
  ask_user: 'Ti fa una domanda: l’unico modo in cui un agente può interpellarti durante il lavoro.',
};

const DELEG_HELP: Record<string, string> = {
  queued: 'In coda: attende un posto libero tra i worker paralleli o che finisca un task con effetti collaterali.',
  running: 'L’istanza sta lavorando al contratto.',
  done: 'L’istanza ha consegnato il ResultContract.',
  error: 'La delega è terminata con un errore: l’orchestratore lo vede e decide come procedere.',
  cancelled: 'Delega annullata (annullamento manuale o template rimosso).',
  rejected: 'Rifiutata dal codice, non dal modello: task duplicato, troppi worker o round di correzione esauriti.',
  partial: 'Budget esaurito: l’istanza ha consegnato solo ciò che aveva già prodotto.',
  blocked: 'L’istanza si è fermata: le manca un dato essenziale e ha risposto con una domanda invece di inventare.',
};

const RESULT_HELP: Record<string, string> = {
  ok: 'L’istanza ha completato il task rispettando il contratto.',
  blocked: 'L’istanza si è fermata per un dato mancante: nel contratto trovi la domanda bloccante.',
  partial: 'Budget (token, strumenti o secondi) esaurito: contiene solo il lavoro fatto fino a quel punto.',
};

const SEVERITY_HELP: Record<string, string> = {
  blocker: 'Blocca la consegna: l’orchestratore può ri-eseguire una volta il task interessato con questo rilievo come input.',
  major: 'Problema grave ma non bloccante: la risposta ti arriva comunque, con questo rilievo in evidenza.',
  minor: 'Rilievo minore: segnalato per trasparenza, non ferma nulla.',
};

const TOOL_ICON: Record<string, string> = {
  read_file: '📄',
  write_file: '✎',
  edit_file: '✎',
  delete_path: '🗑',
  list_directory: '🗂',
  search_files: '🔍',
  run_command: '❯',
  system_info: 'ℹ',
  network_info: '🌐',
  delegate_task: '⇢',      // v1 history
  list_agents: '👥',        // v1 history
  delegate_tasks: '⇶',
  run_planner: '🗺',
  run_verifier: '⚖',
  read_artifact: '📎',
  ask_user: '❓',
};

export interface ConsoleHost {
  /** Focus (and un-collapse) a console by agent id — used by "Vai alla console". */
  focusAgent(id: AgentId): void;
  /** Focus this console (click anywhere on it). */
  requestFocus(id: AgentId): void;
  toggleMaximize(id: AgentId): void;
  toggleCollapse(id: AgentId): void;
  agentMeta(id: AgentId | null): { name: string; color: string } | null;
  /** Notified when the unseen counter changes (dock badge). */
  unseenChanged(id: AgentId): void;
  /** True when a console (template or live instance) exists for that id. */
  hasConsole(id: AgentId | null | undefined): boolean;
  /** `instance:close` — cancel if running, drop the ephemeral console. */
  closeInstance(id: AgentId): void;
}

interface EvNode {
  ev: ConsoleEvent;
  node: HTMLElement;
  txt: HTMLElement | null;
  raw: string;
  streaming: boolean;
  timers: number[];
  update: () => void;
  finalize: () => void;
}

function usageMeta(u: Usage | undefined): string {
  if (!u) return '';
  const tok = (u.promptTokens || 0) + (u.completionTokens || 0);
  const parts: string[] = [];
  if (tok) parts.push(fmtTokens(tok) + ' tok');
  if (u.cost) parts.push(fmtCost(u.cost, u.estimated));
  return parts.join(' · ');
}

/** A <pre> that collapses above `limit` chars with a "Mostra"/"Nascondi" toggle. */
function collapsiblePre(text: string, limit = COLLAPSE_LIMIT, cls = 'pre', help?: string): HTMLElement {
  const wrap = h('div', { class: 'collapsible', title: help });
  const pre = h('pre', { class: cls, text });
  wrap.appendChild(pre);
  if (text.length > limit) {
    wrap.classList.add('is-collapsed');
    const toggle = btn('Mostra tutto', () => {
      const collapsed = wrap.classList.toggle('is-collapsed');
      toggle.textContent = collapsed ? 'Mostra tutto' : 'Nascondi';
      toggle.title = collapsed
        ? 'Espande il testo completo (' + text.length.toLocaleString('it-IT') + ' caratteri, qui tagliato).'
        : 'Richiude il blocco lasciando visibili le prime righe.';
    }, 'linkbtn', 'Espande il testo completo (' + text.length.toLocaleString('it-IT') + ' caratteri, qui tagliato).');
    wrap.appendChild(toggle);
  }
  return wrap;
}

/** `8k·10·180s` — the effective per-task budget, compact enough for a chip. */
function budgetChipText(b: Partial<Budget> | undefined): string | null {
  if (!b) return null;
  const parts: string[] = [];
  if (typeof b.maxTokens === 'number') parts.push(fmtTokens(b.maxTokens));
  if (typeof b.maxToolCalls === 'number') parts.push(String(b.maxToolCalls));
  if (typeof b.maxSeconds === 'number') parts.push(b.maxSeconds + 's');
  return parts.length ? 'budget ' + parts.join('·') : null;
}

const CONTRACT_HELP = 'Il compito esatto affidato all’istanza: obiettivo, input, vincoli, deliverable e criterio di accettazione. '
  + 'È tutto ciò che il worker vede: non ha accesso alla conversazione.';
const RESULT_BLOCK_HELP = 'Risposta strutturata dell’istanza: esito, risultato, assunzioni e cose che non ha potuto verificare. '
  + 'Il campo cost lo compila l’app dai consumi reali, non il modello.';

/** Caption + chips + pretty-printed JSON for a TaskContract (task_start / delegation). */
function contractBlock(c: TaskContract): HTMLElement {
  const budget = budgetChipText(c.budget);
  return h('div', { class: 'contract' },
    h('div', { class: 'caption', title: CONTRACT_HELP },
      'TaskContract',
      h('span', { class: 'tid', text: c.task_id || '?', title: 'Identificativo del task dentro questa richiesta: lo ritrovi nella delega, nel risultato e nella verifica.' }),
      c.role ? h('span', { class: 'badge chip', text: c.role, title: 'Template a cui è stato affidato il task.' }) : null,
      c.side_effects
        ? h('span', {
          class: 'badge priv warn', text: 'side_effects',
          title: 'Il task scrive file o esegue comandi: l’app lo esegue da solo, mai in parallelo con un altro task con effetti.',
        })
        : null,
      budget ? h('span', { class: 'badge chip', text: budget, title: 'Budget del task: token massimi · chiamate a strumenti · secondi. Al primo limite raggiunto l’istanza chiude con esito parziale.' }) : null),
    collapsiblePre(prettyJson(c), COLLAPSE_LIMIT, 'pre task', CONTRACT_HELP));
}

/** Caption + status chip + pretty-printed JSON for a ResultContract (task_end / delegation). */
function resultBlock(r: ResultContract): HTMLElement {
  return h('div', { class: 'result' },
    h('div', { class: 'caption', title: RESULT_BLOCK_HELP },
      'ResultContract',
      r.task_id ? h('span', { class: 'tid', text: r.task_id, title: 'Task a cui si riferisce questo risultato.' }) : null,
      h('span', {
        class: 'badge rstatus', data: { status: r.status },
        text: RESULT_STATUS[r.status] ?? r.status,
        title: RESULT_HELP[r.status] ?? 'Esito dichiarato dall’istanza.',
      })),
    collapsiblePre(prettyJson(r), COLLAPSE_LIMIT, 'pre result', RESULT_BLOCK_HELP));
}

/** `6.1k tok · 4 strumenti · 41 s · $0.002 · mimo-v2.5` from the system-filled `cost`. */
function costLine(r: ResultContract): HTMLElement | null {
  const c = r.cost;
  if (!c) return null;
  const parts = [
    fmtTokens(c.tokens) + ' tok',
    (c.tool_calls ?? 0) + ' strumenti',
    (c.seconds ?? 0) + ' s',
    fmtCost(c.usd),
    c.model || '',
  ].filter(Boolean);
  return h('div', {
    class: 'costline', text: parts.join(' · '),
    title: 'Costo reale di questo task misurato dall’app: token, chiamate a strumenti, secondi, spesa stimata e modello '
      + 'effettivamente usato (può essere un fallback, non il primario del template).',
  });
}

export class ConsoleView {
  readonly root: HTMLElement;
  readonly body: HTMLElement;
  readonly footer: HTMLElement;
  agent: AgentView;

  private readonly host: ConsoleHost;
  private readonly list: HTMLElement;
  private readonly olderBar: HTMLElement;
  private readonly pill: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly descEl: HTMLElement;
  private readonly modelEl: HTMLElement;
  private readonly tierEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly costEl: HTMLElement;
  private readonly stopBtn: HTMLElement;
  private readonly eyeBtn: HTMLElement;
  private readonly budgetEl: HTMLElement;
  private readonly budgetText: HTMLElement;
  private readonly budgetBar: HTMLElement;

  /** Ephemeral budget-line state: limits from `task_start.budget`, counters local to this console. */
  private budget: Budget | null = null;
  private budgetStart = 0;
  /** Frozen elapsed once the run ends (from `task_end.durationMs`); 0 while running. */
  private budgetElapsed = 0;
  private budgetHit: string | null = null;
  private lastUsage: Usage | null = null;
  private readonly toolCallIds = new Set<string>();
  private budgetTimer: number | null = null;

  private readonly nodes = new Map<string, EvNode>();
  private pending: Array<{ kind: 'ev'; ev: ConsoleEvent } | { kind: 'patch'; p: ConsolePatch }> = [];
  private currentStream: EvNode | null = null;
  private stick = true;
  private hasOlder = false;
  private loadingOlder = false;
  /** Node cap; raised by explicitly loaded older pages so they are not evicted at once. */
  private cap = MAX_NODES;
  private destroyed = false;

  lastSeq = 0;
  firstSeq = Number.MAX_SAFE_INTEGER;
  unseen = 0;
  status: AgentStatus = 'idle';
  showReasoning: boolean;
  collapsed = false;

  constructor(agent: AgentView, host: ConsoleHost, showReasoning: boolean) {
    this.agent = agent;
    this.host = host;
    this.showReasoning = showReasoning;

    const ephemeral = agent.ephemeral === true;

    this.nameEl = h('span', { class: 'cons-name', text: agent.name, title: this.nameTitle(agent) });
    this.descEl = h('span', { class: 'cons-desc', text: agent.description || '', title: this.descTitle(agent) });
    this.modelEl = h('span', { class: 'badge model', text: agent.model, title: this.modelTitle(agent) });
    this.tierEl = h('span', { class: 'badge tier', hidden: true });
    this.statusEl = h('span', { class: 'badge status', data: { status: 'idle' }, text: STATUS_LABEL.idle, title: STATUS_HELP.idle });
    this.costEl = h('span', {
      class: 'cons-cost', text: fmtCost(0),
      title: 'Costo stimato di questo agente da inizio sessione.',
    });

    this.eyeBtn = iconBtn(showReasoning ? '👁' : '🚫', this.eyeTitle(showReasoning), () => this.toggleReasoning());
    this.stopBtn = iconBtn('■',
      'Interrompe subito la richiesta in corso di questo agente: le istanze che ha creato vengono annullate e '
      + 'quello che è già arrivato resta visibile qui.',
      () => this.cancel(), 'danger');
    this.stopBtn.hidden = true;

    // Ephemeral instance consoles are throw-away: no persisted log to clear, no dock slot to
    // hold (the flood guard collapses them automatically) — but they can be closed (§6.5).
    const maxTitle = 'Ingrandisce questa console a tutta la griglia (Esc, o lo stesso pulsante, per tornare all’affiancamento).';
    const actions = ephemeral
      ? [
        this.eyeBtn,
        this.stopBtn,
        iconBtn('⤢', maxTitle, () => this.host.toggleMaximize(this.agent.id)),
        btn('✕ Chiudi', () => this.host.closeInstance(this.agent.id), 'btn ghost close-inst',
          'Chiude questa console temporanea. Se l’istanza sta ancora lavorando viene annullata e consegna un '
          + 'risultato parziale all’orchestratore.'),
      ]
      : [
        this.eyeBtn,
        this.stopBtn,
        iconBtn('⤢', maxTitle, () => this.host.toggleMaximize(this.agent.id)),
        iconBtn('▁', 'Riduce la console a una scheda nella barra in basso: continua a ricevere eventi e mostra il numero di quelli non visti.',
          () => this.host.toggleCollapse(this.agent.id)),
        iconBtn('⌫', 'Cancella gli eventi mostrati qui e il loro log su disco. Non cancella la memoria della conversazione '
          + '(quella si azzera da Impostazioni → Dati).',
          () => void this.clearRemote()),
      ];

    const head = h('div', { class: 'cons-head' },
      h('span', { class: 'dot' }),
      h('div', { class: 'cons-title' }, this.nameEl, this.descEl),
      this.modelEl,
      this.tierEl,
      this.statusEl,
      this.costEl,
      h('div', { class: 'cons-actions' }, actions),
    );

    this.budgetText = h('span', { class: 'bt' });
    this.budgetBar = h('i');
    this.budgetEl = h('div', {
      class: 'budget-line', hidden: !ephemeral,
      title: 'Consumo di questa istanza rispetto al budget del suo template: token, chiamate a strumenti e secondi. '
        + 'Al primo limite raggiunto l’istanza viene fermata e consegna un risultato parziale.',
    }, this.budgetText, h('span', { class: 'bar' }, this.budgetBar));

    this.list = h('div', { class: 'events' });
    this.olderBar = h('div', { class: 'older-bar', hidden: true },
      btn('Carica eventi precedenti', () => void this.loadOlder(), 'linkbtn',
        'Recupera dal log su disco fino a 200 eventi più vecchi e li mette in cima, senza spostare la vista.'));
    this.body = h('div', { class: 'cons-body' }, this.olderBar, this.list);
    this.pill = h('button', {
      class: 'pill', type: 'button', hidden: true,
      title: 'Lo scorrimento automatico è sospeso perché hai scorso verso l’alto: clicca per tornare in fondo e riattivarlo.',
      on: { click: () => this.repin() },
    }, '↓ nuovi messaggi');
    this.footer = h('div', { class: 'cons-footer', hidden: true });

    this.root = h('section', {
      class: 'console' + (ephemeral ? ' ephemeral' : ''),
      data: { agentId: agent.id, role: roleOf(agent) },
      style: { '--agent-color': agent.color },
    }, head, this.budgetEl, this.body, this.pill, this.footer);

    if (ephemeral) {
      this.budgetStart = Date.now();
      this.renderBudget();
      this.budgetTimer = window.setInterval(() => this.renderBudget(), 1000);
    }

    if (!showReasoning) this.root.classList.add('no-reasoning');

    this.body.addEventListener('scroll', () => {
      this.stick = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 24;
      if (this.stick) this.pill.hidden = true;
    });
    this.root.addEventListener('mousedown', () => this.host.requestFocus(this.agent.id));
  }

  // ------------------------------------------------------------------ header

  private nameTitle(agent: AgentView): string {
    const role = ROLE_LABEL[roleOf(agent)] ?? roleOf(agent);
    return agent.ephemeral
      ? 'Console temporanea di un’istanza ' + role + ' creata per il task ' + (agent.taskId ?? '?')
        + ': sparisce alla prossima richiesta o quando la chiudi.'
      : 'Console del template ' + agent.name + ' (' + role + '): resta sempre aperta e conserva il suo log.';
  }

  private descTitle(agent: AgentView): string {
    if (agent.objective) return 'Obiettivo assegnato a questa istanza: ' + agent.objective;
    return agent.description
      ? 'Descrizione del template: è la riga che l’orchestratore legge per decidere a chi delegare.'
      : 'Nessuna descrizione: l’orchestratore ha meno indizi per scegliere questo template.';
  }

  private modelTitle(agent: AgentView): string {
    return 'Modello primario di questo agente: ' + agent.model
      + '. Se risponde 429 o non è disponibile, il router passa al fallback e lo scrive come riga "Fallback:" nel log.';
  }

  private eyeTitle(on: boolean): string {
    return on
      ? 'Il ragionamento è mostrato in questa console: clicca per nasconderlo (il modello continua a produrlo, cambia solo cosa vedi).'
      : 'Il ragionamento è nascosto in questa console: clicca per mostrarlo. Non cambia costi né risultati.';
  }

  setAgent(agent: AgentView): void {
    this.agent = agent;
    this.nameEl.textContent = agent.name;
    this.nameEl.title = this.nameTitle(agent);
    this.descEl.textContent = agent.description || '';
    this.descEl.title = this.descTitle(agent);
    this.modelEl.textContent = agent.model;
    this.modelEl.title = this.modelTitle(agent);
    this.root.dataset.role = roleOf(agent);
    this.root.style.setProperty('--agent-color', agent.color);
  }

  /**
   * Tier of the last finished user request (orchestrator header badge, §10.1).
   * `null` clears it; `instances`/`agentsUsed` enrich the tooltip when known.
   */
  setTier(tier: Tier | null | undefined, extra?: { instances?: number; agentsUsed?: string[] }): void {
    if (roleOf(this.agent) !== 'orchestrator') return;
    if (!tier) {
      this.tierEl.hidden = true;
      return;
    }
    this.tierEl.hidden = false;
    this.tierEl.textContent = tier;
    this.tierEl.dataset.tier = tier;
    const bits = ['livello dell’ultima richiesta: ' + tier];
    if (typeof extra?.instances === 'number') bits.push(extra.instances + ' istanze');
    if (extra?.agentsUsed?.length) bits.push('agenti: ' + extra.agentsUsed.join(', '));
    this.tierEl.title = bits.join(' · ')
      + '\nT0 = risposta diretta senza deleghe · T1 = un worker · T2 = più worker in parallelo · T3 = prima il planner, poi il piano.'
      + '\nÈ l’orchestratore a scegliere il livello: più alto = più istanze e più token spesi.';
  }

  /** Ephemeral budget line: `tok 3.1k/8k · strumenti 2/10 · 41 s (timeout silenzio 60 s)`. */
  private renderBudget(): void {
    if (this.budgetEl.hidden) return;
    const elapsedMs = this.budgetElapsed || Date.now() - this.budgetStart;
    const toolCalls = this.toolCallIds.size;
    let text = fmtBudget(this.lastUsage ?? undefined, this.budget ?? undefined, { toolCalls, elapsedMs });
    if (this.budgetHit) text += ' · budget ' + (BUDGET_HIT_LABEL[this.budgetHit] ?? this.budgetHit) + ' esaurito';
    this.budgetText.textContent = text;
    // The bar tracks token/tool-call consumption only: unlike those two, maxSeconds is not a
    // cumulative ceiling the elapsed time counts against — it only fires on real model silence — so
    // it plays no part in "how close to being stopped" this instance is.
    let ratio = 0;
    if (this.budget) {
      const tok = (this.lastUsage?.promptTokens ?? 0) + (this.lastUsage?.completionTokens ?? 0);
      ratio = Math.max(
        this.budget.maxTokens > 0 ? tok / this.budget.maxTokens : 0,
        this.budget.maxToolCalls > 0 ? toolCalls / this.budget.maxToolCalls : 0,
      );
    }
    this.budgetBar.style.setProperty('width', Math.min(100, Math.round(ratio * 100)) + '%');
    this.budgetEl.dataset.over = String(this.budgetHit !== null || ratio >= 0.9);
  }

  private stopBudgetClock(): void {
    if (this.budgetTimer !== null) {
      window.clearInterval(this.budgetTimer);
      this.budgetTimer = null;
    }
  }

  applyStatus(u: AgentStatusUpdate): void {
    this.status = u.status;
    this.lastUsage = u.usage ?? this.lastUsage;
    this.renderBudget();
    const label = STATUS_LABEL[u.status] ?? u.status;
    this.statusEl.textContent = u.queueLength > 0 ? label + ' · ' + u.queueLength + ' in coda' : label;
    this.statusEl.dataset.status = u.status;
    const help = STATUS_HELP[u.status] ?? label;
    this.statusEl.title = [
      u.detail ?? null,
      help,
      u.queueLength > 0 ? u.queueLength + ' richieste in coda per questo agente: verranno eseguite una alla volta.' : null,
    ].filter(Boolean).join('\n');
    this.stopBtn.hidden = u.status === 'idle' || u.status === 'error';
    this.costEl.textContent = fmtCost(u.usage?.cost ?? 0, u.usage?.estimated ?? false);
    this.costEl.title = u.usage
      ? [
        'Costo di questo agente' + (u.usage.estimated ? ' (stimato: prezzo del modello non noto)' : '') + ':',
        'prompt: ' + fmtTokens(u.usage.promptTokens),
        'output: ' + fmtTokens(u.usage.completionTokens),
        'ragionamento: ' + fmtTokens(u.usage.reasoningTokens),
        'cache: ' + fmtTokens(u.usage.cachedTokens) + ' (token riletti dalla cache, si pagano meno)',
        'chiamate: ' + u.usage.calls,
      ].join('\n')
      : 'Costo stimato di questo agente da inizio sessione.';
  }

  setFocused(on: boolean): void {
    this.root.classList.toggle('focused', on);
  }

  setMaximized(on: boolean): void {
    this.root.classList.toggle('maximized', on);
  }

  setReasoning(visible: boolean): void {
    this.showReasoning = visible;
    this.root.classList.toggle('no-reasoning', !visible);
    this.eyeBtn.textContent = visible ? '👁' : '🚫';
    this.eyeBtn.title = this.eyeTitle(visible);
    this.eyeBtn.setAttribute('aria-label', this.eyeTitle(visible));
  }

  private toggleReasoning(): void {
    this.setReasoning(!this.showReasoning);
  }

  private cancel(): void {
    void window.api.invoke('agent:cancel', this.agent.id).catch((e: unknown) => toast('error', errText(e)));
  }

  private async clearRemote(): Promise<void> {
    try {
      await window.api.invoke('console:clear', this.agent.id);
    } catch (e) {
      toast('error', errText(e));
      return;
    }
    this.clearDom();
  }

  clearDom(): void {
    for (const n of this.nodes.values()) for (const t of n.timers) window.clearInterval(t);
    this.nodes.clear();
    this.toolCallIds.clear();
    this.currentStream = null;
    clear(this.list);
    this.hasOlder = false;
    this.olderBar.hidden = true;
    this.cap = MAX_NODES;
    this.firstSeq = Number.MAX_SAFE_INTEGER;
    this.stick = true;
    this.pill.hidden = true;
  }

  resetUnseen(): void {
    if (this.unseen === 0) return;
    this.unseen = 0;
    this.host.unseenChanged(this.agent.id);
  }

  destroy(): void {
    this.destroyed = true;
    this.stopBudgetClock();
    this.clearDom();
    this.root.remove();
  }

  // ------------------------------------------------------------------ stream

  pushEvent(ev: ConsoleEvent): void {
    if (ev.seq <= this.lastSeq && this.nodes.has(ev.id)) return; // duplicate from history overlap
    this.pending.push({ kind: 'ev', ev });
    this.schedule();
  }

  pushPatch(p: ConsolePatch): void {
    this.pending.push({ kind: 'patch', p });
    this.schedule();
  }

  private schedule(): void {
    if (this.destroyed) return;
    raf.add(() => this.flush());
  }

  private flush(): void {
    if (this.destroyed || this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    let forceStick = false;
    for (const item of batch) {
      if (item.kind === 'ev') {
        if (item.ev.kind === 'user_input') forceStick = true;
        this.addEventNode(item.ev);
      } else {
        this.applyPatch(item.p);
      }
    }
    this.trim();
    if (forceStick) this.stick = true;
    if (this.stick) {
      this.body.scrollTop = this.body.scrollHeight;
      this.pill.hidden = true;
    } else {
      this.pill.hidden = false;
    }
    if (this.collapsed) {
      this.unseen += batch.length;
      this.host.unseenChanged(this.agent.id);
    }
  }

  /** History load (ascending by seq). Known ids are skipped, so overlap with live events is safe. */
  loadHistory(events: ConsoleEvent[], mode: 'append' | 'prepend' = 'append'): void {
    const fresh = events.filter((e) => !this.nodes.has(e.id));
    if (mode === 'prepend') this.cap = Math.min(4000, this.cap + fresh.length);
    for (const ev of fresh) this.addEventNode(ev);
    // history is already complete: nothing is still streaming
    if (this.currentStream) {
      this.currentStream.finalize();
      this.currentStream = null;
    }
    this.trim();
    if (mode === 'append') {
      this.stick = true;
      this.body.scrollTop = this.body.scrollHeight;
    }
  }

  private async loadOlder(): Promise<void> {
    if (this.loadingOlder || this.firstSeq === Number.MAX_SAFE_INTEGER) return;
    this.loadingOlder = true;
    const keepHeight = this.body.scrollHeight;
    try {
      const older = await window.api.invoke('console:getEvents', this.agent.id, { beforeSeq: this.firstSeq, limit: 200 });
      if (!older.length) {
        this.hasOlder = false;
        this.olderBar.hidden = true;
        return;
      }
      this.loadHistory(older, 'prepend');
      this.body.scrollTop += this.body.scrollHeight - keepHeight;
    } catch (e) {
      toast('error', errText(e));
    } finally {
      this.loadingOlder = false;
    }
  }

  private repin(): void {
    this.stick = true;
    this.pill.hidden = true;
    this.body.scrollTop = this.body.scrollHeight;
  }

  private trim(): void {
    while (this.list.childElementCount > this.cap) {
      const first = this.list.firstElementChild as HTMLElement | null;
      if (!first) break;
      const id = first.dataset.eventId ?? '';
      const n = this.nodes.get(id);
      if (n) {
        for (const t of n.timers) window.clearInterval(t);
        if (this.currentStream === n) this.currentStream = null;
        this.nodes.delete(id);
      }
      first.remove();
      this.hasOlder = true;
    }
    if (this.hasOlder) this.olderBar.hidden = false;
    const firstEl = this.list.firstElementChild as HTMLElement | null;
    this.firstSeq = firstEl ? Number(firstEl.dataset.seq ?? '0') : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Keeps the list ordered by seq. Streaming hits the fast path (append after the newest
   * node); a history page that arrives after live events is placed where it belongs.
   */
  private insertBySeq(node: HTMLElement, seq: number): void {
    const last = this.list.lastElementChild as HTMLElement | null;
    if (!last || Number(last.dataset.seq ?? '0') <= seq) {
      this.list.appendChild(node);
      return;
    }
    for (const el of Array.from(this.list.children)) {
      if (Number((el as HTMLElement).dataset.seq ?? '0') > seq) {
        this.list.insertBefore(node, el);
        return;
      }
    }
    this.list.appendChild(node);
  }

  private addEventNode(ev: ConsoleEvent): EvNode {
    const existing = this.nodes.get(ev.id);
    if (existing) return existing;
    // a new event closes the previous streaming block
    if (this.currentStream && this.currentStream.ev.id !== ev.id) {
      this.currentStream.finalize();
      this.currentStream = null;
    }
    const n = this.createNode(ev);
    this.nodes.set(ev.id, n);
    this.insertBySeq(n.node, ev.seq);
    if (ev.seq > this.lastSeq) this.lastSeq = ev.seq;
    if (ev.seq < this.firstSeq) this.firstSeq = ev.seq;
    if (n.streaming) this.currentStream = n;
    return n;
  }

  private applyPatch(p: ConsolePatch): void {
    const n = this.nodes.get(p.eventId);
    if (!n) return; // unknown id → ignore (§3 ordering rules)
    if (p.append) {
      n.raw += p.append;
      if (n.txt) {
        if (n.streaming) n.txt.appendChild(document.createTextNode(p.append));
        else n.finalize(); // late delta on a closed block → re-render
      }
    }
    if (p.set) {
      Object.assign(n.ev as unknown as Record<string, unknown>, p.set);
      const setText = (p.set as Record<string, unknown>)['text'];
      if (typeof setText === 'string' && n.txt) {
        n.raw = setText;
        if (n.streaming) replace(n.txt, setText);
        else n.finalize();
      }
      n.update();
    }
  }

  // ----------------------------------------------------------- node factory

  private createNode(ev: ConsoleEvent): EvNode {
    const node = h('div', { class: 'ev ev-' + ev.kind, data: { eventId: ev.id, seq: String(ev.seq) } });
    const n: EvNode = {
      ev,
      node,
      txt: null,
      raw: '',
      streaming: false,
      timers: [],
      update: () => undefined,
      finalize: () => undefined,
    };

    switch (ev.kind) {
      case 'user_input': {
        const txt = h('div', { class: 'txt', text: ev.text });
        n.txt = txt;
        n.raw = ev.text;
        node.appendChild(h('div', {
          class: 'bubble',
          title: 'Messaggio che hai inviato: da qui l’orchestratore classifica il livello e decide se delegare.',
        }, txt));
        break;
      }

      case 'task_start': {
        const line = h('div', { class: 'banner' });
        if (ev.origin.kind === 'user') {
          line.title = 'Inizio di una nuova richiesta: l’orchestratore sceglie il livello (T0…T3) e, se serve, crea le istanze worker.';
          line.appendChild(h('span', { class: 'arrow', text: '▶' }));
          line.appendChild(h('span', { text: 'Richiesta dell’utente' }));
        } else {
          line.title = 'Incarico ricevuto: questa istanza vede solo il TaskContract qui sotto, non la conversazione con te.';
          const o = ev.origin;
          const from = this.host.agentMeta(o.fromAgentId);
          node.classList.add('inbound');
          node.style.setProperty('--other-color', from?.color ?? '#8b93a7');
          line.appendChild(h('span', { class: 'arrow', text: '⇠' }));
          line.appendChild(h('span', { class: 'dot other' }));
          line.appendChild(h('span', {}, 'Incarico da ', h('strong', { text: o.fromName || from?.name || 'agente' })));
          if (o.taskId) line.appendChild(h('span', { class: 'tid', text: o.taskId, title: 'Identificativo del task nella richiesta in corso.' }));
          if (o.role) {
            line.appendChild(h('span', {
              class: 'badge role', text: ROLE_LABEL[o.role] ?? o.role,
              title: 'Template con cui è stata creata questa istanza: ne determina strumenti, prompt e budget.',
            }));
          }
          if (typeof o.attempt === 'number' && o.attempt > 1) {
            line.appendChild(h('span', {
              class: 'badge priv warn', text: 'tentativo ' + o.attempt,
              title: 'Ri-esecuzione dopo un rilievo del verificatore: il task viene rifatto da zero con quel feedback negli input, e si paga di nuovo.',
            }));
          }
          line.appendChild(h('span', {
            class: 'badge', text: 'livello ' + o.depth,
            title: 'Profondità della delega: 1 = incarico dell’orchestratore. Oltre 2 solo se hai attivato la delega tra worker.',
          }));
        }
        node.appendChild(line);
        // The contract is the authoritative brief; the raw instance message (environment +
        // inlined inputs) stays available underneath so nothing the worker saw is hidden.
        if (ev.contract) {
          node.appendChild(contractBlock(ev.contract));
          node.appendChild(h('div', {
            class: 'caption',
            title: 'Testo esatto arrivato al modello: ambiente, contratto e input già inseriti. Serve per capire cosa ha davvero letto l’istanza.',
          }, 'Messaggio ricevuto'));
        }
        node.appendChild(collapsiblePre(ev.input, COLLAPSE_LIMIT, 'pre task',
          ev.contract ? undefined : 'Messaggio con cui è partita questa richiesta.'));
        if (ev.context) {
          node.appendChild(collapsiblePre('contesto: ' + ev.context, COLLAPSE_LIMIT, 'pre task ctx',
            'Contesto aggiunto dall’app al messaggio (non l’ha scritto il modello).'));
        }
        // Ephemeral consoles derive their budget line from this event.
        if (this.agent.ephemeral) {
          this.budget = ev.budget ?? this.budget;
          this.budgetStart = ev.ts || Date.now();
          this.budgetElapsed = 0;
          this.budgetHit = null;
          this.renderBudget();
          if (this.budgetTimer === null) this.budgetTimer = window.setInterval(() => this.renderBudget(), 1000);
        }
        break;
      }

      case 'task_end': {
        const line = h('div', { class: 'endline' });
        const extra = h('div', { class: 'result-wrap' });
        node.appendChild(line);
        node.appendChild(extra);
        let lastResultKey = '';
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'task_end' }>;
          const s = TASK_END[e.status] ?? { icon: '·', label: e.status };
          node.dataset.status = e.status;
          const meta = [
            fmtMs(e.durationMs),
            e.iterations + ' iterazioni',
            typeof e.toolCalls === 'number' ? e.toolCalls + ' strumenti' : '',
            usageMeta(e.usage),
            e.budgetHit ? 'budget ' + (BUDGET_HIT_LABEL[e.budgetHit] ?? e.budgetHit) + ' esaurito' : '',
          ].filter(Boolean).join(' · ');
          const tierText = e.tier
            ? e.tier + (typeof e.instances === 'number' ? ' · ' + e.instances + (e.instances === 1 ? ' istanza' : ' istanze') : '')
            : '';
          replace(line,
            h('span', { class: 'ico', text: s.icon }),
            h('span', { class: 'st', text: s.label, title: TASK_END_HELP[e.status] ?? 'Esito di questa esecuzione.' }),
            tierText
              ? h('span', {
                class: 'badge tier', data: { tier: e.tier as string }, text: tierText,
                title: (e.agentsUsed?.length ? 'Agenti coinvolti: ' + e.agentsUsed.join(', ') + '.\n' : '')
                  + 'Livello scelto per la richiesta e numero di istanze create: T0 nessuna delega, T3 anche il planner.',
              })
              : null,
            h('span', {
              class: 'meta', text: meta,
              title: 'Durata, giri di ragionamento + strumenti, token e costo di questa esecuzione.'
                + (e.budgetHit ? '\nUn limite di budget è stato raggiunto: il risultato è quello prodotto fino a quel momento.' : ''),
            }));
          const key = e.result ? JSON.stringify(e.result) : '';
          if (key !== lastResultKey) {
            lastResultKey = key;
            clear(extra);
            if (e.result) {
              extra.appendChild(resultBlock(e.result));
              const cost = costLine(e.result);
              if (cost) extra.appendChild(cost);
            }
          }
          // Freeze the ephemeral budget line at the value it had when the run ended.
          if (this.agent.ephemeral) {
            this.budgetElapsed = e.durationMs || Math.max(1, (e.ts || Date.now()) - this.budgetStart);
            this.budgetHit = e.budgetHit ?? null;
            this.stopBudgetClock();
            this.renderBudget();
          }
        };
        n.update();
        break;
      }

      case 'llm_call': {
        const line = h('div', { class: 'llmline' });
        node.appendChild(line);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'llm_call' }>;
          node.dataset.status = e.status;
          const meta = [
            'iterazione ' + e.iteration,
            e.messageCount + ' msg',
            e.format === 'responses' ? 'responses' : '',
            e.durationMs !== undefined ? fmtMs(e.durationMs) : '',
            usageMeta(e.usage),
            e.finishReason ? 'fine: ' + e.finishReason : '',
          ].filter(Boolean).join(' · ');
          line.title = 'Una chiamata al modello: mostra iterazione, messaggi inviati, durata e token consumati. '
            + 'Ogni riga come questa è una spesa a sé.'
            + (e.format === 'responses' ? '\n"responses" = il modello usa l’API /responses di OpenCode Go invece di /chat/completions.' : '');
          replace(line,
            e.status === 'streaming' ? h('span', { class: 'spinner' }) : h('span', { class: 'arrow', text: '→' }),
            h('span', {
              class: 'model', text: e.model,
              title: 'Modello effettivamente chiamato: se è diverso dal primario del template, il router è passato a un fallback.',
            }),
            h('span', { class: 'meta', text: meta }));
        };
        n.update();
        break;
      }

      case 'reasoning': {
        const txt = h('div', { class: 'txt' }, ev.text);
        n.txt = txt;
        n.raw = ev.text;
        n.streaming = true;
        const toggle = iconBtn('▾', 'Comprime o espande questo blocco di ragionamento (solo qui: non cambia l’impostazione globale).', () => {
          const c = node.classList.toggle('is-collapsed');
          toggle.textContent = c ? '▸' : '▾';
        });
        node.appendChild(h('div', {
          class: 'rz-head',
          title: 'Ragionamento intermedio del modello: utile per capire come è arrivato alla risposta, ma non fa parte della '
            + 'risposta finale. I suoi token si pagano comunque.',
        },
        h('span', { class: 'lbl', text: 'Ragionamento' }),
        h('span', { class: 'spinner sm' }),
        toggle));
        node.appendChild(txt);
        n.finalize = () => {
          n.streaming = false;
          node.classList.add('done');
        };
        break;
      }

      case 'text': {
        const txt = h('div', { class: 'txt' }, ev.text);
        n.txt = txt;
        n.raw = ev.text;
        n.streaming = true;
        const label = h('div', {
          class: 'lbl', hidden: !ev.final,
          title: this.agent.isMain
            ? 'Risposta finale per te: l’orchestratore l’ha sintetizzata dai risultati dei worker, non è un output incollato.'
            : 'Messaggio conclusivo di questo agente: per un worker è il ResultContract che torna all’orchestratore.',
        }, this.agent.isMain ? 'Risposta' : 'Risultato');
        node.appendChild(label);
        node.appendChild(txt);
        const rerender = () => replace(txt, renderMarkdown(n.raw));
        n.finalize = () => {
          n.streaming = false;
          rerender();
        };
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'text' }>;
          label.hidden = !e.final;
          node.classList.toggle('final', !!e.final);
          if (e.final && n.streaming) {
            n.streaming = false;
            rerender();
            if (this.currentStream === n) this.currentStream = null;
          }
        };
        if (ev.final) n.update();
        break;
      }

      case 'tool_call': {
        node.classList.add('card');
        // The ephemeral budget line counts tool calls from this console's own cards.
        if (ev.callId) {
          this.toolCallIds.add(ev.callId);
          this.renderBudget();
        }
        const head = h('div', { class: 'card-head' });
        const argsBox = h('div', { class: 'card-args' });
        const resBox = h('div', { class: 'card-res' });
        node.appendChild(head);
        node.appendChild(argsBox);
        node.appendChild(resBox);
        let lastArgs = '';
        let lastResult = '';
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'tool_call' }>;
          node.dataset.status = e.status;
          const toolHelp = TOOL_HELP[e.name] ?? 'Strumento chiamato dall’agente: sotto vedi gli argomenti e il risultato restituito.';
          replace(head,
            h('span', { class: 'ico', text: TOOL_ICON[e.name] ?? '🔧' }),
            h('span', { class: 'tname', text: e.name || 'strumento', title: toolHelp }),
            h('span', {
              class: 'badge chip', text: TOOL_STATUS[e.status] ?? e.status,
              title: TOOL_CALL_HELP[e.status] ?? 'Stato della chiamata allo strumento.',
            }),
            e.status === 'running' || e.status === 'streaming' ? h('span', { class: 'spinner sm' }) : null,
            e.result ? h('span', { class: 'meta', text: fmtMs(e.result.durationMs), title: 'Tempo impiegato dallo strumento (non dal modello).' }) : null);
          head.title = toolHelp;
          const pretty = prettyArgs(e.argsRaw, e.args);
          if (pretty !== lastArgs) {
            lastArgs = pretty;
            replace(argsBox, collapsiblePre(pretty, COLLAPSE_LIMIT, 'pre args',
              'Argomenti con cui l’agente ha chiamato lo strumento: sono la sua richiesta esatta, utile per capire un errore.'));
            if (e.parseError) {
              argsBox.appendChild(h('div', {
                class: 'warn', text: 'Argomenti non validi: ' + e.parseError,
                title: 'Il modello ha prodotto argomenti non leggibili: l’app rifiuta la chiamata e glielo comunica, così può correggersi.',
              }));
            }
          }
          const out = e.result?.output ?? '';
          if (out !== lastResult) {
            lastResult = out;
            clear(resBox);
            if (e.result) {
              const r = e.result;
              resBox.classList.toggle('bad', !r.ok);
              const short = r.output.length > RESULT_HEAD ? r.output.slice(0, RESULT_HEAD) : r.output;
              const pre = h('pre', { class: 'pre result', text: short });
              resBox.appendChild(pre);
              if (r.output.length > RESULT_HEAD) {
                let open = false;
                const more = btn('Mostra tutto (' + fmtBytes(r.fullLength || r.output.length) + ')', () => {
                  open = !open;
                  pre.textContent = open ? r.output : short;
                  more.textContent = open
                    ? 'Mostra meno'
                    : 'Mostra tutto (' + fmtBytes(r.fullLength || r.output.length) + ')';
                  more.title = open
                    ? 'Torna a mostrare solo l’inizio dell’output.'
                    : 'Mostra l’output completo dello strumento (qui è tagliato alle prime righe).';
                }, 'linkbtn', 'Mostra l’output completo dello strumento (qui è tagliato alle prime righe).');
                resBox.appendChild(more);
              }
              if (r.truncated) {
                resBox.appendChild(h('div', {
                  class: 'meta', text: 'output troncato · totale ' + fmtBytes(r.fullLength),
                  title: 'Anche l’agente ha ricevuto l’output tagliato: serve a non riempire il contesto con un file intero.',
                }));
              }
            }
          }
        };
        n.update();
        break;
      }

      case 'delegation': {
        node.classList.add('card', 'deleg');
        const to = this.host.agentMeta(ev.toAgentId);
        node.style.setProperty('--other-color', to?.color ?? '#8b93a7');
        const head = h('div', { class: 'card-head' });
        const contract = h('div', { class: 'card-contract' });
        const preview = h('div', { class: 'card-res' });
        node.appendChild(head);
        node.appendChild(contract);
        node.appendChild(preview);
        let lastContractKey = '';
        let lastResultKey = '';
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'delegation' }>;
          node.dataset.status = e.status;
          const meta = this.host.agentMeta(e.toAgentId ?? e.instanceId ?? null);
          if (meta) node.style.setProperty('--other-color', meta.color);
          // `⇢ t3 → Worker · T2 · tentativo 2` — the instance console may or may not exist.
          const goTarget = e.instanceId ?? e.toAgentId;
          head.title = 'Delega dell’orchestratore a un’istanza worker: contratto inviato, esito e costo reale. '
            + 'Le istanze non si parlano tra loro, tutto passa da qui.';
          replace(head,
            h('span', { class: 'arrow', text: '⇢' }),
            h('span', { class: 'dot other' }),
            e.taskId ? h('span', { class: 'tid', text: e.taskId, title: 'Identificativo del task: lo ritrovi nella console dell’istanza e nella verifica.' }) : null,
            h('span', {}, e.taskId ? ' → ' : 'Delega a ', h('strong', { text: e.toName || meta?.name || '?' })),
            e.tier
              ? h('span', {
                class: 'badge tier', data: { tier: e.tier }, text: e.tier,
                title: 'Livello scelto per la richiesta: T1 un worker, T2 più worker in parallelo, T3 dopo il planner.',
              })
              : null,
            typeof e.attempt === 'number' && e.attempt > 1
              ? h('span', {
                class: 'badge priv warn', text: 'tentativo ' + e.attempt,
                title: 'Round di correzione: il task viene rifatto con il rilievo del verificatore negli input e si paga di nuovo.',
              })
              : null,
            typeof e.depth === 'number' && e.depth > 1
              ? h('span', { class: 'badge', text: 'livello ' + e.depth, title: 'Delega annidata: un worker ha delegato a sua volta (possibile solo se l’hai attivato nel Pool).' })
              : null,
            h('span', {
              class: 'badge chip', text: DELEG_STATUS[e.status] ?? e.status,
              title: DELEG_HELP[e.status] ?? 'Stato della delega.',
            }),
            e.status === 'running' || e.status === 'queued' ? h('span', { class: 'spinner sm' }) : null,
            e.durationMs !== undefined ? h('span', { class: 'meta', text: fmtMs(e.durationMs), title: 'Tempo totale dell’istanza, attesa in coda compresa.' }) : null,
            goTarget && this.host.hasConsole(goTarget)
              ? btn('Vai alla console', () => this.host.focusAgent(goTarget), 'linkbtn',
                'Apre la console dell’istanza che ha eseguito questo task, con il suo log completo e il consumo di budget.')
              : null);

          const cKey = e.contract ? JSON.stringify(e.contract) : 'task:' + (e.task ?? '');
          if (cKey !== lastContractKey) {
            lastContractKey = cKey;
            clear(contract);
            if (e.contract) contract.appendChild(contractBlock(e.contract));
            else if (e.task) contract.appendChild(collapsiblePre(e.task, COLLAPSE_LIMIT, 'pre task', CONTRACT_HELP));
          }

          const rKey = e.result ? JSON.stringify(e.result) : 'p:' + (e.resultPreview ?? '');
          if (rKey !== lastResultKey) {
            lastResultKey = rKey;
            clear(preview);
            if (e.result) {
              preview.appendChild(resultBlock(e.result));
              const cost = costLine(e.result);
              if (cost) preview.appendChild(cost);
            } else if (e.resultPreview) {
              preview.appendChild(collapsiblePre(e.resultPreview, COLLAPSE_LIMIT, 'pre result',
                'Nessun ResultContract valido: qui c’è il testo grezzo o il motivo del rifiuto, così si capisce cosa è andato storto.'));
            }
          }
        };
        n.update();
        break;
      }

      case 'verdict': {
        node.classList.add('card');
        const head = h('div', { class: 'card-head' });
        const findings = h('div', { class: 'findings' });
        const summary = h('div', { class: 'vsummary' });
        node.appendChild(head);
        node.appendChild(findings);
        node.appendChild(summary);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'verdict' }>;
          const v = e.verdict ?? { findings: [], verdict: 'no_blocker', summary: '' };
          node.dataset.verdict = v.verdict;
          head.title = 'Esito della verifica avversariale: il verificatore cerca fatti inventati, errori e requisiti del '
            + 'contratto ignorati. Non riscrive il risultato.';
          replace(head,
            h('span', { class: 'ico', text: '⚖' }),
            h('span', {}, 'Verifica', e.taskIds?.length
              ? h('span', { class: 'tid', text: ' ' + e.taskIds.join(', '), title: 'Task esaminati in questa verifica.' })
              : null),
            h('span', {
              class: 'badge vd', data: { verdict: v.verdict },
              text: v.verdict === 'blocker' ? 'blocker' : 'nessun blocker',
              title: v.verdict === 'blocker'
                ? 'C’è almeno un problema bloccante: l’orchestratore può ri-eseguire una volta il task interessato con questo feedback (costo di un worker in più).'
                : 'Nessun problema bloccante: la risposta va all’utente così com’è.',
            }),
            e.critical
              ? h('span', {
                class: 'badge priv warn', text: 'critico',
                title: 'Verifica marcata come critica: se il template ha un’escalation, è stata usata quella (modello più forte e più caro).',
              })
              : null,
            h('span', { class: 'meta', text: (v.findings?.length ?? 0) + ' rilievi', title: 'Numero di problemi trovati, ordinati per gravità.' }));
          clear(findings);
          const list = [...(v.findings ?? [])].sort(
            (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
          );
          for (const f of list) {
            const sevHelp = SEVERITY_HELP[f.severity] ?? 'Rilievo del verificatore.';
            findings.appendChild(h('div', { class: 'finding', data: { severity: f.severity }, title: sevHelp },
              h('span', { class: 'sev', text: '■ ' + (SEVERITY_LABEL[f.severity] ?? f.severity), title: sevHelp }),
              h('span', {},
                f.task_id ? h('span', { class: 'tid', text: f.task_id + ' ', title: 'Task a cui si riferisce il rilievo.' }) : null,
                h('span', { text: f.issue || '—' }),
                f.fix ? h('span', { class: 'fix', text: ' → ' + f.fix, title: 'Correzione richiesta dal verificatore: la esegue il worker, non lui.' }) : null)));
          }
          if (!list.length) findings.appendChild(h('div', { class: 'hint', text: 'Nessun rilievo.', title: 'Il verificatore non ha trovato problemi da segnalare.' }));
          summary.textContent = v.summary || '';
          summary.title = 'Riassunto in una riga scritto dal verificatore.';
          summary.hidden = !v.summary;
        };
        n.update();
        break;
      }

      case 'permission': {
        node.classList.add('card', 'perm');
        const head = h('div', { class: 'card-head' });
        node.appendChild(head);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'permission' }>;
          node.dataset.status = e.status;
          const cls: CommandClass = e.commandClass ?? 'benign';
          node.dataset.class = cls;
          head.title = 'Traccia di una richiesta di autorizzazione: la decisione si prende nella finestra al centro dello schermo. '
            + 'Resta qui per sapere cosa hai concesso e quando.';
          replace(head,
            h('span', { class: 'ico', text: '🔒' }),
            h('span', { class: 'ptext', text: 'Autorizzazione: ' + e.summary }),
            h('span', {
              class: 'badge chip', text: PERM_STATUS[e.status] ?? String(e.status),
              title: PERM_HELP[e.status] ?? 'Esito della richiesta.',
            }),
            e.status === 'pending' ? h('span', { class: 'spinner sm' }) : null);
        };
        n.update();
        break;
      }

      case 'ask_user': {
        node.classList.add('card', 'ask');
        const head = h('div', { class: 'card-head' });
        const ans = h('div', { class: 'card-res' });
        node.appendChild(head);
        node.appendChild(ans);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'ask_user' }>;
          node.dataset.status = e.status;
          head.title = 'Domanda dell’agente: la fa solo quando un’ambiguità cambierebbe il risultato. Rispondi nella '
            + 'finestra al centro; senza risposta prosegue senza quel dato.';
          replace(head,
            h('span', { class: 'ico', text: '❓' }),
            h('span', { class: 'ptext', text: e.question }),
            h('span', {
              class: 'badge chip',
              text: e.status === 'pending' ? 'In attesa…' : e.status === 'answered' ? 'Risposto' : e.status === 'timeout' ? 'Scaduto' : 'Annullato',
              title: e.status === 'pending' ? 'L’agente è fermo in attesa della tua risposta.'
                : e.status === 'answered' ? 'La tua risposta è arrivata all’agente, che ha ripreso da lì.'
                  : e.status === 'timeout' ? 'Nessuna risposta entro il timeout: l’agente ha proseguito senza.'
                    : 'Domanda annullata insieme alla richiesta.',
            }));
          clear(ans);
          if (e.answer) ans.appendChild(h('div', { class: 'answer', text: e.answer, title: 'La risposta che hai dato.' }));
        };
        n.update();
        break;
      }

      case 'error': {
        node.classList.add('card', 'bad');
        const head = h('div', { class: 'card-head' });
        const cdEl = h('span', { class: 'meta cd' });
        node.appendChild(head);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'error' }>;
          head.title = 'Errore della chiamata al modello o di uno strumento. Se è riprovabile l’app ci riprova da sola; '
            + 'su 429 o modello non disponibile passa al modello di fallback del template.';
          replace(head,
            h('span', { class: 'ico', text: '✗' }),
            h('span', { class: 'ptext', text: e.message }),
            e.code ? h('span', { class: 'badge chip', text: e.code, title: 'Codice restituito dal fornitore: utile per capire se è un limite di quota, un problema di rete o un rifiuto.' }) : null,
            e.retryable ? cdEl : null);
          cdEl.title = 'Nuovo tentativo automatico con attesa progressiva. Un errore non riprovabile ferma invece la richiesta.';
          for (const t of n.timers) window.clearInterval(t);
          n.timers = [];
          if (e.retryable && e.retryInMs && e.retryInMs > 0) {
            const until = Date.now() + e.retryInMs;
            const tick = () => {
              const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
              cdEl.textContent = left > 0 ? 'Riprovo tra ' + left + ' s' : 'Nuovo tentativo…';
              if (left <= 0) for (const t of n.timers) window.clearInterval(t);
            };
            tick();
            n.timers.push(window.setInterval(tick, 1000));
          } else if (e.retryable) {
            cdEl.textContent = 'Riprovabile';
          }
        };
        n.update();
        break;
      }

      case 'info': {
        const line = h('div', { class: 'infoline', text: ev.message });
        node.appendChild(line);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'info' }>;
          line.textContent = e.message;
          // Model fallbacks are the one info line that must not disappear in the grey noise.
          const isFallback = /^fallback:/i.test(e.message || '');
          line.classList.toggle('fallback', isFallback);
          line.title = isFallback
            ? 'Il modello primario non era utilizzabile (429, non disponibile o rifiuto per data policy): la chiamata è '
              + 'passata al fallback indicato. Prezzo e privacy sono quelli del nuovo modello.'
            : 'Nota dell’app (non del modello): cambi di configurazione, avvisi e informazioni di servizio.';
        };
        n.update();
        break;
      }

      default: {
        node.appendChild(h('div', { class: 'infoline', text: JSON.stringify(ev) }));
      }
    }
    return n;
  }
}
