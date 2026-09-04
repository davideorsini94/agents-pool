// Settings drawer (right side, 420 px): role templates CRUD (role, model routing, temperature,
// per-task budget, parallel instances), the editable Pool section (limits + warnings above the
// recommended range), interaction notes for the orchestrator, workspace, permission mode,
// allowlist, API key, contracts log, total reset.
// Every mutation returns a ConfigSnapshot; the panel re-renders from it and the rest of the
// UI reacts to `config:changed` (hot reload) without losing console content.

import type {
  AgentId,
  AgentInput,
  AgentRole,
  AgentView,
  AppInfo,
  Budget,
  ConfigPatch,
  ConfigSnapshot,
  ModelFormat,
  ModelInfo,
  PermissionMode,
  PoolRanges,
  Range,
} from '../shared/types';
import {
  btn,
  clear,
  deriveDescription,
  h,
  iconBtn,
  modelBadges,
  modelLabel,
  privacyBadge,
  roleOf,
  ROLE_LABEL,
  ROLE_ORDER,
  routingSummary,
  withDescription,
} from './dom.js';
import { errText, modals, toast } from './modals.js';

const MODE_LABEL: Record<PermissionMode, { title: string; help: string }> = {
  strict: {
    title: 'Rigorosa',
    help: 'Chiede conferma per ogni scrittura, eliminazione e comando. Massimo controllo, più interruzioni.',
  },
  balanced: {
    title: 'Bilanciata',
    help: 'Scritture e eliminazioni dentro il workspace sono automatiche; comandi e uscite dal workspace chiedono conferma.',
  },
  relaxed: {
    title: 'Permissiva',
    help: 'Comandi innocui e letture fuori dal workspace sono automatici; restano protetti sistema e azioni distruttive.',
  },
  bypass: {
    title: 'Bypass (nessuna richiesta)',
    help: 'Non chiede mai nulla: ogni scrittura, eliminazione e comando parte subito, anche fuori dal workspace, sui percorsi di sistema e distruttivo. Tutto resta tracciato nelle console e nel log.',
  },
};

/** Used until `AppInfo.poolRanges` is filled in by the main process (PLAN-v2 §11.3). */
const POOL_RANGES_FALLBACK: PoolRanges = {
  maxParallelWorkers: { min: 1, max: 16, default: 4, recommendedMax: 8 },
  maxWorkersPerRequest: { min: 1, max: 32, default: 8, recommendedMax: 8 },
  correctionRounds: { min: 0, max: 3, default: 1, recommendedMax: 1 },
  maxDepth: { min: 2, max: 4, default: 2, recommendedMax: 2 },
  artifactThresholdChars: { min: 1000, max: 20000, default: 4000, recommendedMax: 8000 },
};

const POOL_WARN: Record<keyof PoolRanges, string> = {
  maxParallelWorkers: 'oltre 8 worker paralleli il costo e il rischio di rate limit crescono molto',
  maxWorkersPerRequest: 'oltre 8 istanze per richiesta il costo per richiesta cresce molto',
  correctionRounds: 'più di 1 round di correzione raddoppia i costi nei casi peggiori',
  maxDepth: 'profondità > 2 rende il flusso difficile da seguire',
  artifactThresholdChars: 'una soglia alta lascia molto testo nel contesto dell’orchestratore',
};

/**
 * Pool tooltips: every limit says what raising it costs, because these are the four numbers
 * that decide the price of a request (PLAN-v2 §11.3 ranges, §2 hard limits).
 */
const POOL_HELP: Record<keyof PoolRanges, string> = {
  maxParallelWorkers: 'Quanti worker l’orchestratore può lanciare insieme con una sola chiamata delegate_tasks. '
    + 'Alzarlo accorcia i tempi ma moltiplica i token spesi in contemporanea e il rischio di 429 (limite del fornitore): '
    + 'con 8 worker paralleli una richiesta costa fino a 8 volte una singola.',
  maxWorkersPerRequest: 'Tetto di istanze totali per una tua richiesta, round di correzione compresi. Ogni istanza è una '
    + 'chiamata al modello a sé: alzarlo aumenta in proporzione il costo massimo della singola richiesta. Il codice lo '
    + 'applica anche se il modello chiede di più.',
  correctionRounds: 'Quante volte un task può essere ri-eseguito con il rilievo del verificatore. Ogni round ripaga da zero '
    + 'il worker interessato: 1 è il compromesso, 0 disattiva le correzioni, 3 può triplicare il costo dei casi peggiori.',
  maxDepth: 'Livelli di delega ammessi. Con 2 delega solo l’orchestratore; 3 o 4 permettono ai worker di delegare a loro '
    + 'volta, moltiplicando le istanze (una catena costa quanto tutte le istanze che crea) e rendendo il flusso difficile da seguire.',
  artifactThresholdChars: 'Sopra questa lunghezza il risultato di un worker viene salvato come artefatto e l’orchestratore '
    + 'riceve solo un riferimento più un riassunto. Soglia alta = più testo (e più token) nel suo contesto a ogni iterazione; '
    + 'soglia bassa = più chiamate a read_artifact quando serve il contenuto intero.',
};

const T = {
  sectAgents: 'I template sono i ruoli configurati: l’orchestratore è sempre attivo, dai template worker nascono istanze '
    + 'temporanee a ogni richiesta e muoiono con essa.',
  sectPool: 'Limiti applicati dal codice, non dai prompt: valgono anche se il modello chiede di più. Sono le manopole che '
    + 'decidono quanto può costare una richiesta.',
  sectProtocol: 'Istruzioni permanenti per il solo orchestratore.',
  sectWorkspace: 'Cartella in cui gli agenti lavorano senza chiedere autorizzazioni.',
  sectPermissions: 'Quanto gli agenti possono fare da soli prima di fermarsi a chiedertelo.',
  sectKey: 'Credenziale usata per ogni chiamata a OpenCode Go.',
  sectData: 'Cronologia della conversazione e azzeramento della configurazione.',
  addAgent: 'Crea un nuovo template con ruolo Worker, partendo dal prompt predefinito del ruolo. Nessun limite al numero di template.',
  editAgent: 'Apre il form per cambiare ruolo, modelli, temperatura, budget e prompt di questo template.',
  dupAgent: 'Precompila un nuovo template con le stesse impostazioni: utile per un secondo worker specializzato su un altro modello.',
  delAgent: 'Rimuove il template: le sue istanze in corso vengono annullate con esito parziale e le loro console spariscono.',
  delMain: 'Serve sempre un orchestratore: promuovi prima un altro template a principale.',
  mainRadio: 'Rende questo template l’orchestratore, l’unico che parla con te e delega. Il precedente torna worker (e riprende il prompt del ruolo se non l’avevi modificato).',
  routing: 'Catena dei modelli: primario → fallback in ordine ↑ escalation. Il router scende la catena su 429 o modello non disponibile.',
  formName: 'Nome del template. L’orchestratore lo usa come "role" nei TaskContract per scegliere a chi delegare: deve essere unico e dire che cosa fa.',
  formRole: 'Decide quali strumenti riceve e quando viene chiamato. Cambiandolo, il prompt segue il nuovo ruolo se non l’hai ancora modificato a mano.',
  formDesc: 'Riga che l’orchestratore legge nell’elenco Pool per capire a chi delegare; compare anche sotto il nome nella console.',
  formModel: 'Modello provato per primo. Nell’elenco vedi prezzo per milione di token, contesto e richieste per 5 ore dalla tabella modelli misurata; i badge sotto riportano privacy, formato API e affidabilità del JSON.',
  formFallbacks: 'Modelli usati in ordine quando il primario risponde 429, non è disponibile o rifiuta per data policy: il tentativo cambia modello invece di ripetere lo stesso. Senza fallback quel tentativo fallisce.',
  addFallback: 'Aggiunge un modello alla fine della catena di fallback.',
  formEscalation: 'Modello più forte (e più costoso) usato solo per le richieste ampie T3 o le verifiche critiche. "—" per non usarne nessuno.',
  formTemp: 'Quanto il modello si allontana dalla scelta più probabile: 0 = risposte ripetibili e prudenti, 2 = molto creative e meno affidabili sul JSON. Vuoto = valore predefinito del modello.',
  formConc: 'Quante istanze di questo template possono girare insieme. Vuoto = il limite del pool. Alzarlo moltiplica i token spesi in parallelo su questo stesso modello, quindi anche il rischio di 429.',
  formPrompt: 'Prompt di sistema del template. L’app gli aggiunge sempre le regole fisse del ruolo; i dati che cambiano (contratto, ambiente) arrivano nel messaggio, non qui, così la cache dei prompt resta valida.',
  formIters: 'Quanti giri di ragionamento + strumenti può fare in una richiesta prima che l’app lo fermi: protegge dai cicli infiniti.',
  formColor: 'Colore della console di questo template e del bordo delle sue istanze temporanee.',
  formCancel: 'Chiude il form senza salvare nulla.',
  formSave: 'Salva il template: valido dalla prossima chiamata al modello. Le istanze già in corso finiscono con le impostazioni con cui sono nate.',
  resetPrompt: 'Sostituisce il testo con il prompt predefinito di questo ruolo (chiede conferma se hai già scritto qualcosa).',
  allowDeleg: 'Espone delegate_tasks anche ai worker: rompe lo schema hub-and-spoke e può moltiplicare le istanze, perché ogni worker può crearne altre. Serve anche alzare la profondità massima a 3 o 4.',
  formats: 'Forza quale formato di endpoint di OpenCode Go usa un modello (/chat/completions oppure /responses), scavalcando '
    + 'il riconoscimento automatico dal prefisso del nome: utile se OpenCode cambia l’endpoint di un modello prima che l’app venga aggiornata.',
  openLog: 'Apre il file di log con tutti i TaskContract e ResultContract registrati (userData/logs/contracts.jsonl), per rivedere a posteriori cosa è stato chiesto e consegnato.',
  protocol: 'Istruzioni aggiunte sempre al prompt del solo orchestratore (lingua, stile, cosa evitare). I worker non le vedono: ricevono solo il TaskContract. Si salvano uscendo dal campo o con Cmd/Ctrl+S.',
  wsChange: 'Scegli un’altra cartella di lavoro: gli agenti perdono l’accesso libero a quella precedente e i percorsi relativi ripartono dalla nuova.',
  allowlist: 'Comandi che non chiederanno più conferma, uno per riga. Vale solo per i comandi classificati innocui: sudo, rm e simili chiedono sempre. Ogni riga in più è una conferma in meno ma anche un controllo in meno.',
  clearAllowlist: 'Toglie tutti gli schemi: dal prossimo comando l’app chiederà di nuovo conferma.',
  permTimeout: 'Quanto resta in attesa una richiesta di autorizzazione o una domanda prima di scadere. Alla scadenza l’azione è negata e l’agente lo riporta tra le cose non verificate.',
  keyValue: 'Chiave attualmente in uso, mostrata mascherata: è salvata su questo computer, cifrata quando il sistema lo consente.',
  keyChange: 'Apre il campo per incollare un’altra API key: viene validata con una chiamata reale e sostituisce la precedente solo se funziona.',
  keySave: 'Valida la nuova chiave e la sostituisce se funziona.',
  keyRemove: 'Cancella la chiave da questo computer, annulla le attività in corso e riporta l’app alla schermata iniziale di inserimento.',
  clearHistory: 'Azzera la conversazione dell’orchestratore: la prossima richiesta parte senza memoria di quelle precedenti (i token del contesto tornano a zero). Template e impostazioni restano.',
  resetAll: 'Cancella template, cronologie e impostazioni e riapre la procedura guidata. La API key resta salvata.',
};

const DEFAULT_BUDGET: Budget = { maxTokens: 24000, maxToolCalls: 12, maxSeconds: 60 };

const FMT_HELP: Record<ModelFormat, string> = {
  chat: 'Endpoint /chat/completions: il formato usato dalla maggior parte dei modelli.',
  responses: 'Endpoint /responses: lo richiedono grok-*, gpt-* e muse-spark-*, che sul formato classico rispondono errore.',
};

/** The mode hints are already on screen: the tooltip carries the trade-off instead (§5). */
const MODE_TRADEOFF: Record<PermissionMode, string> = {
  strict: 'Nessuna sorpresa: niente viene scritto, eliminato o eseguito senza il tuo sì. In cambio il lavoro si ferma spesso ad aspettarti, anche di notte.',
  balanced: 'Compromesso predefinito: dentro la cartella di lavoro gli agenti procedono da soli, tutto ciò che ne esce o esegue comandi passa da te.',
  relaxed: 'Meno interruzioni al prezzo di meno controllo: comandi innocui e letture fuori dalla cartella passano da soli. Restano protetti i percorsi di sistema e le azioni distruttive.',
  bypass: 'Nessun freno: gli agenti eseguono qualunque cosa senza chiederti niente, compresi rm -rf, sudo, modifiche di rete e scritture fuori dalla cartella di lavoro. Usala solo su una macchina e una cartella che puoi permetterti di perdere, e solo mentre guardi: ogni azione concessa resta scritta nelle console e in log/main.log.',
};

const ROLE_HINT: Record<AgentRole, string> = {
  orchestrator: 'Parla con l’utente e delega. Deve essercene esattamente uno.',
  planner: 'Chiamato solo per obiettivi ampi (T3): produce un piano di task.',
  worker: 'Esegue un singolo TaskContract in un’istanza senza cronologia.',
  verifier: 'Verifica avversariale dei risultati; non li corregge.',
};

export interface SettingsHooks {
  onKeyCleared(): void;
  onReset(): void;
}

interface FormState {
  id: AgentId | null; // null = new template
  name: string;
  description: string;
  model: string;
  prompt: string;
  color: string;
  maxIterations: number;
  role: AgentRole;
  fallbacks: string[];
  escalation: string;      // '' = none
  temperature: string;     // '' = model default
  budget: { maxTokens: string; maxToolCalls: string; maxSeconds: string };
  maxConcurrent: string;   // '' = same as the pool
}

export class SettingsPanel {
  readonly root: HTMLElement;

  private readonly body: HTMLElement;
  private readonly hooks: SettingsHooks;
  private readonly info: AppInfo;
  private snapshot: ConfigSnapshot | null = null;
  private models: ModelInfo[] = [];
  private modelsLoaded = false;
  private form: FormState | null = null;
  private opened = false;
  private rendering = false;
  private renderQueued = false;

  constructor(info: AppInfo, hooks: SettingsHooks) {
    this.info = info;
    this.hooks = hooks;
    this.body = h('div', { class: 'drawer-body' });
    this.root = h('aside', { class: 'drawer', hidden: true },
      h('div', { class: 'drawer-head' },
        h('span', { class: 'drawer-title', text: 'Impostazioni' }),
        iconBtn('✕', 'Chiude il pannello (anche con Esc). Quello che hai cambiato è già salvato.', () => this.close())),
      this.body);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  open(): void {
    this.opened = true;
    this.root.hidden = false;
    this.root.classList.add('open');
    void this.ensureModels();
    this.render();
  }

  close(): void {
    this.opened = false;
    this.root.classList.remove('open');
    this.root.hidden = true;
    this.form = null;
  }

  toggle(): void {
    if (this.opened) this.close();
    else this.open();
  }

  setSnapshot(s: ConfigSnapshot): void {
    this.snapshot = s;
    if (this.opened) this.render();
  }

  private async ensureModels(): Promise<void> {
    if (this.modelsLoaded) return;
    this.modelsLoaded = true;
    try {
      this.models = await window.api.invoke('models:list');
      if (this.opened) this.render();
    } catch (e) {
      toast('warn', 'Elenco modelli non disponibile: ' + errText(e));
    }
  }

  private model(id: string | undefined | null): ModelInfo | undefined {
    if (!id) return undefined;
    return this.models.find((m) => m.id === id);
  }

  private ranges(): PoolRanges {
    return this.info.poolRanges ?? POOL_RANGES_FALLBACK;
  }

  // ------------------------------------------------------------------ render

  /**
   * A blur-triggered save (`interactionPrompt`, allowlist) or an inline `config:update` can
   * deliver `config:changed` while this method is still rebuilding the drawer. Re-entering
   * would clear the tree from under the outer pass, so nested calls are coalesced into one
   * extra render at the end.
   */
  private render(): void {
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;
    try {
      this.renderNow();
    } finally {
      this.rendering = false;
    }
    if (this.renderQueued) {
      this.renderQueued = false;
      this.render();
    }
  }

  private renderNow(): void {
    const s = this.snapshot;
    if (!s) return;
    clear(this.body);
    this.body.appendChild(this.sectionAgents(s));
    this.body.appendChild(this.sectionPool(s));
    this.body.appendChild(this.sectionProtocol(s));
    this.body.appendChild(this.sectionWorkspace(s));
    this.body.appendChild(this.sectionPermissions(s));
    this.body.appendChild(this.sectionKey(s));
    this.body.appendChild(this.sectionData(s));
  }

  private section(title: string, help: string, ...children: Array<Node | null>): HTMLElement {
    return h('section', { class: 'sect' },
      h('h3', { class: 'sect-title', text: title, title: help }),
      ...children.filter((c): c is Node => c !== null));
  }

  /** Label + control + optional hint; `help` becomes the tooltip of both wrapper and control. */
  private field(label: string, control: Node, hint?: string, help?: string): HTMLElement {
    if (help && control instanceof HTMLElement && !control.title) control.title = help;
    return h('label', { class: 'field', title: help },
      h('span', { class: 'lbl', text: label }),
      control,
      hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  // ----------------------------------------------------------------- agents

  private sectionAgents(s: ConfigSnapshot): HTMLElement {
    const rows = s.agents.map((a) => this.agentRow(a, s));
    const counts = ROLE_ORDER.map((r) => {
      const n = s.agents.filter((a) => roleOf(a) === r).length;
      return n ? n + ' × ' + ROLE_LABEL[r] : null;
    }).filter(Boolean).join(' · ');
    return this.section('Template di ruolo', T.sectAgents,
      h('div', {
        class: 'hint', text: counts || 'nessun template',
        title: 'Composizione attuale del pool. Senza worker l’orchestratore risponde sempre da solo; senza verificatore nessuno rilegge i risultati.',
      }),
      h('div', { class: 'agent-rows' }, rows),
      this.form ? this.agentForm(this.form) : btn('+ Aggiungi template', () => this.startNew(s), 'btn ghost wide', T.addAgent),
      h('div', { class: 'hint', text: 'Le istanze dei worker nascono e muoiono con ogni richiesta: qui configuri solo i template.' }),
    );
  }

  private agentRow(a: AgentView, s: ConfigSnapshot): HTMLElement {
    const isMain = a.id === s.mainAgentId;
    const role = roleOf({ role: a.role, isMain });
    return h('div', { class: 'agent-row' + (isMain ? ' main' : ''), style: { '--agent-color': a.color } },
      h('span', { class: 'dot' }),
      h('div', { class: 'ar-main' },
        h('div', { class: 'ar-name' }, a.name, isMain
          ? h('span', { class: 'badge', text: 'principale', title: 'È l’orchestratore: riceve i tuoi messaggi e delega agli altri.' })
          : null),
        h('div', {
          class: 'ar-desc', text: a.description || '—',
          title: a.description ? T.formDesc : 'Nessuna descrizione: l’orchestratore ha meno indizi per delegare a questo template.',
        }),
        h('div', { class: 'ar-role' },
          h('span', { class: 'badge role', text: ROLE_LABEL[role], title: ROLE_HINT[role] }),
          privacyBadge(this.model(a.model)),
          typeof a.maxConcurrent === 'number'
            ? h('span', {
              class: 'badge', text: 'max ' + a.maxConcurrent + ' ist.',
              title: 'Al massimo ' + a.maxConcurrent + ' istanze di questo template in parallelo, anche se il pool ne consentirebbe di più.',
            })
            : null),
        h('div', { class: 'ar-routing', title: T.routing + '\n' + routingSummary(a), text: routingSummary(a) })),
      h('label', { class: 'radio', title: isMain ? 'È già l’orchestratore.' : T.mainRadio },
        h('input', {
          type: 'radio', name: 'main-agent', checked: isMain,
          title: isMain ? 'È già l’orchestratore.' : T.mainRadio,
          on: { change: () => void this.setMain(a.id) },
        }),
        h('span', { text: 'principale' })),
      h('div', { class: 'ar-actions' },
        iconBtn('✎', a.name + ' — ' + T.editAgent, () => this.startEdit(a)),
        iconBtn('⧉', a.name + ' — ' + T.dupAgent, () => this.duplicate(a, s)),
        iconBtn('🗑', isMain ? T.delMain : a.name + ' — ' + T.delAgent,
          () => void this.removeAgent(a), isMain ? 'disabled' : 'danger')),
    );
  }

  private nextColor(s: ConfigSnapshot): string {
    const used = new Set(s.agents.map((a) => a.color.toLowerCase()));
    const palette = this.info.palette?.length
      ? this.info.palette
      : ['#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#84CC16', '#06B6D4'];
    return palette.find((c) => !used.has(c.toLowerCase())) ?? palette[s.agents.length % palette.length] ?? '#3B82F6';
  }

  private startNew(s: ConfigSnapshot): void {
    this.form = {
      id: null,
      name: '',
      description: '',
      model: this.info.defaultModel || s.agents[0]?.model || this.models[0]?.id || '',
      prompt: '',
      color: this.nextColor(s),
      maxIterations: 40,
      role: 'worker',
      fallbacks: [],
      escalation: '',
      temperature: '',
      budget: { maxTokens: '', maxToolCalls: '', maxSeconds: '' },
      maxConcurrent: '',
    };
    void this.fillDefaultPrompt('worker');
    this.render();
  }

  private startEdit(a: AgentView): void {
    this.form = {
      id: a.id,
      name: a.name,
      description: a.description,
      model: a.model,
      prompt: a.prompt,
      color: a.color,
      maxIterations: a.maxIterations || 40,
      role: roleOf({ role: a.role, isMain: a.id === this.snapshot?.mainAgentId }),
      fallbacks: [...(a.fallbacks ?? [])],
      escalation: a.escalation ?? '',
      temperature: typeof a.temperature === 'number' ? String(a.temperature) : '',
      budget: {
        maxTokens: a.budget ? String(a.budget.maxTokens) : '',
        maxToolCalls: a.budget ? String(a.budget.maxToolCalls) : '',
        maxSeconds: a.budget ? String(a.budget.maxSeconds) : '',
      },
      maxConcurrent: typeof a.maxConcurrent === 'number' ? String(a.maxConcurrent) : '',
    };
    this.render();
  }

  /** New templates start from the role's Italian default prompt (§9). */
  private async fillDefaultPrompt(role: AgentRole): Promise<void> {
    try {
      const text = await window.api.invoke('config:defaultPrompt', role);
      if (this.form && !this.form.prompt.trim()) {
        this.form.prompt = text;
        this.form.description = deriveDescription(text);
        if (this.opened) this.render();
      }
    } catch {
      /* main may not expose the channel yet — the textarea simply stays empty */
    }
  }

  private duplicate(a: AgentView, s: ConfigSnapshot): void {
    this.form = {
      id: null,
      name: a.name + ' 2',
      description: a.description,
      model: a.model,
      prompt: a.prompt,
      color: this.nextColor(s),
      maxIterations: a.maxIterations || 40,
      role: roleOf({ role: a.role, isMain: false }) === 'orchestrator' ? 'worker' : roleOf({ role: a.role }),
      fallbacks: [...(a.fallbacks ?? [])],
      escalation: a.escalation ?? '',
      temperature: typeof a.temperature === 'number' ? String(a.temperature) : '',
      budget: {
        maxTokens: a.budget ? String(a.budget.maxTokens) : '',
        maxToolCalls: a.budget ? String(a.budget.maxToolCalls) : '',
        maxSeconds: a.budget ? String(a.budget.maxSeconds) : '',
      },
      maxConcurrent: typeof a.maxConcurrent === 'number' ? String(a.maxConcurrent) : '',
    };
    this.render();
  }

  // ------------------------------------------------------------- agent form

  private agentForm(f: FormState): HTMLElement {
    const name = h('input', { class: 'input', type: 'text', value: f.name, placeholder: 'Nome (es. Worker Flash)', title: T.formName });
    name.addEventListener('input', () => { f.name = name.value; });
    const desc = h('input', { class: 'input', type: 'text', value: f.description, placeholder: 'Ruolo in una riga', title: T.formDesc });
    const prompt = h('textarea', {
      class: 'input area', rows: 7, spellcheck: false, value: f.prompt, title: T.formPrompt,
      placeholder: 'descrizione: esegue un TaskContract\n\nSei un WORKER. Esegui esattamente il TaskContract…',
    });

    const roleHint = h('div', { class: 'hint', text: ROLE_HINT[f.role] });
    const promoteHint = h('div', {
      class: 'pool-warn', hidden: f.role !== 'orchestrator' || f.id === this.snapshot?.mainAgentId,
      text: 'Diventa l’agente principale; l’attuale orchestratore torna worker.',
    });

    const roleSel = h('select', { class: 'input', title: T.formRole });
    for (const r of ROLE_ORDER) roleSel.appendChild(h('option', { value: r, text: ROLE_LABEL[r], title: ROLE_HINT[r] }));
    roleSel.value = f.role;

    const badges = h('div', {
      class: 'badges',
      title: 'Avvisi sul modello scelto, dalla tabella modelli misurata: privacy dei dati, formato dell’API e affidabilità del JSON. Passa sopra un badge per il dettaglio.',
    });
    const privWarn = h('div', { class: 'pool-warn', hidden: true });
    const chips = h('div', { class: 'chips' });
    const escSel = this.modelSelect(f.escalation, { emptyLabel: '— nessuna escalation', title: T.formEscalation });
    const addSel = this.modelSelect('', { emptyLabel: '— aggiungi fallback', title: T.addFallback });

    const temp = h('input', { class: 'input num', type: 'number', min: '0', max: '2', step: '0.1', value: f.temperature, placeholder: 'auto', title: T.formTemp });
    temp.addEventListener('input', () => { f.temperature = temp.value; });
    const conc = h('input', { class: 'input num', type: 'number', min: '1', max: '32', value: f.maxConcurrent, placeholder: 'come il pool', title: T.formConc });
    conc.addEventListener('input', () => { f.maxConcurrent = conc.value; });

    const bTok = h('input', {
      class: 'input num', type: 'number', min: '500', max: '60000', value: f.budget.maxTokens, placeholder: String(DEFAULT_BUDGET.maxTokens),
      title: 'Tetto di token (prompt + risposta) per ogni istanza di questo template: al superamento viene fermata e consegna un risultato parziale.',
    });
    const bTool = h('input', {
      class: 'input num', type: 'number', min: '1', max: '40', value: f.budget.maxToolCalls, placeholder: String(DEFAULT_BUDGET.maxToolCalls),
      title: 'Numero massimo di chiamate a strumenti per istanza: al superamento l’istanza chiude con esito parziale.',
    });
    const bSec = h('input', {
      class: 'input num', type: 'number', min: '10', max: '300', value: f.budget.maxSeconds, placeholder: String(DEFAULT_BUDGET.maxSeconds),
      title: 'Secondi di silenzio dal modello prima di considerare la chiamata bloccata (non un tempo massimo per il task: mentre il modello '
        + 'risponde, anche a fasi, non c\'è alcun conteggio). Allo scadere l\'app riprova automaticamente o cambia modello; alzalo solo se usi un '
        + 'modello lento a iniziare a rispondere.',
    });
    bTok.addEventListener('input', () => { f.budget.maxTokens = bTok.value; });
    bTool.addEventListener('input', () => { f.budget.maxToolCalls = bTool.value; });
    bSec.addEventListener('input', () => { f.budget.maxSeconds = bSec.value; });

    const model = this.modelSelect(f.model, { title: T.formModel });
    const preview = h('div', {
      class: 'hint',
      title: 'Anteprima della riga che l’orchestratore leggerà nell’elenco Pool: viene presa dalla prima riga "descrizione:" del prompt.',
    });

    const budgetRow = h('div', { class: 'form-row' },
      this.field('Token', bTok), this.field('Strumenti', bTool), this.field('Secondi', bSec));
    const budgetBox = h('div', {
      class: 'field', hidden: f.role === 'orchestrator',
      title: 'Token e strumenti sono tetti cumulativi: al primo raggiunto l’istanza viene fermata e consegna quello che ha prodotto. '
        + 'I secondi invece sono una tolleranza al silenzio del modello (si riprova o si cambia modello), non un tempo massimo per il task.',
    },
    h('span', { class: 'lbl', text: 'Budget per task' }),
    budgetRow,
    h('span', { class: 'hint', text: 'Vuoto = predefinito del pool (' + DEFAULT_BUDGET.maxTokens + ' token / ' + DEFAULT_BUDGET.maxToolCalls + ' strumenti / ' + DEFAULT_BUDGET.maxSeconds + ' s di silenzio massimo). Token/strumenti esauriti chiudono l’istanza con esito parziale; il silenzio prolungato fa solo ritentare o cambiare modello.' }));
    const concBox = h('div', { hidden: f.role === 'orchestrator' },
      this.field('Istanze parallele max', conc, 'Vuoto = come il pool (Worker paralleli per chiamata).', T.formConc));

    const renderBadges = () => {
      f.model = model.value;
      clear(badges);
      for (const b of modelBadges(this.model(f.model), f.role)) badges.appendChild(b);
      const m = this.model(f.model);
      const p = m?.privacy;
      const risky = (p === 'training' || p === 'retention_30d') && (f.role === 'worker' || f.role === 'verifier');
      privWarn.hidden = !risky;
      privWarn.textContent = p === 'training'
        ? 'Attenzione: i prompt e le risposte di questo modello vengono usati per addestrare modelli di terze parti. Non usarlo con contenuti proprietari o clinici.'
        : 'Attenzione: questo fornitore conserva prompt e risposte per 30 giorni.';
    };
    model.addEventListener('change', renderBadges);

    const renderChips = () => {
      clear(chips);
      if (!f.fallbacks.length) {
        chips.appendChild(h('span', {
          class: 'empty', text: 'nessun fallback',
          title: 'Senza fallback un 429 o un modello non disponibile fa fallire il tentativo invece di cambiare modello.',
        }));
      }
      f.fallbacks.forEach((id, i) => {
        const m = this.model(id);
        chips.appendChild(h('span', {
          class: 'rchip',
          title: 'Fallback n. ' + (i + 1) + ', provato quando i precedenti non rispondono'
            + (m ? ': ' + modelLabel(m) : ' (' + id + ')'),
        },
        h('span', { text: id }),
        iconBtn('◂', 'Anticipa questo fallback: verrà provato prima degli altri.', () => {
          if (i === 0) return;
          const arr = f.fallbacks;
          [arr[i - 1], arr[i]] = [arr[i] as string, arr[i - 1] as string];
          renderChips();
        }),
        iconBtn('▸', 'Posticipa questo fallback: verrà provato dopo gli altri.', () => {
          const arr = f.fallbacks;
          if (i >= arr.length - 1) return;
          [arr[i], arr[i + 1]] = [arr[i + 1] as string, arr[i] as string];
          renderChips();
        }),
        iconBtn('✕', 'Toglie ' + id + ' dalla catena: se il primario cade si passerà direttamente al fallback successivo.', () => {
          f.fallbacks.splice(i, 1);
          renderChips();
        }, 'danger')));
      });
    };
    addSel.addEventListener('change', () => {
      const id = addSel.value;
      addSel.value = '';
      if (!id || id === f.model || f.fallbacks.includes(id)) return;
      f.fallbacks.push(id);
      renderChips();
    });
    escSel.addEventListener('change', () => { f.escalation = escSel.value; });

    const sync = () => {
      f.description = desc.value;
      f.prompt = prompt.value;
      preview.textContent = 'Descrizione mostrata: ' + (deriveDescription(withDescription(f.prompt, f.description)) || '—');
    };
    desc.addEventListener('input', sync);
    prompt.addEventListener('input', sync);

    roleSel.addEventListener('change', () => {
      f.role = roleSel.value as AgentRole;
      roleHint.textContent = ROLE_HINT[f.role];
      roleSel.title = T.formRole;
      promoteHint.hidden = f.role !== 'orchestrator' || f.id === this.snapshot?.mainAgentId;
      budgetBox.hidden = f.role === 'orchestrator';
      concBox.hidden = f.role === 'orchestrator';
      renderBadges();
    });

    const color = h('input', { class: 'input color', type: 'color', value: f.color, title: T.formColor });
    color.addEventListener('input', () => { f.color = color.value; });
    const iters = h('input', { class: 'input num', type: 'number', min: '1', max: '200', value: String(f.maxIterations), title: T.formIters });
    iters.addEventListener('input', () => { f.maxIterations = Math.max(1, Math.min(200, Number(iters.value) || 40)); });

    renderBadges();
    renderChips();
    sync();

    return h('div', { class: 'agent-form', style: { '--agent-color': f.color } },
      h('div', { class: 'form-title', text: f.id ? 'Modifica template' : 'Nuovo template' }),
      this.field('Nome', name, undefined, T.formName),
      this.field('Ruolo', roleSel, undefined, T.formRole),
      roleHint,
      promoteHint,
      this.field('Descrizione', desc, 'Scritta come prima riga "descrizione:" del prompt.', T.formDesc),
      this.field('Modello primario', model, undefined, T.formModel),
      badges,
      privWarn,
      h('div', { class: 'field', title: T.formFallbacks },
        h('span', { class: 'lbl', text: 'Fallback (in ordine)' }),
        chips,
        h('div', { class: 'chip-add' }, addSel),
        h('span', { class: 'hint', text: 'Su 429 / modello non disponibile / data policy il tentativo passa al modello successivo.' })),
      this.field('Escalation (T3 / critico)', escSel, 'Usato solo per richieste T3 o verifiche critiche.', T.formEscalation),
      h('div', { class: 'form-row' },
        this.field('Temperatura', temp, '0–2, vuoto = default', T.formTemp),
        concBox),
      budgetBox,
      h('div', { class: 'field', title: T.formPrompt },
        h('span', { class: 'lbl', text: 'Prompt di comportamento' }),
        prompt,
        h('div', { class: 'row' },
          btn('Ripristina prompt del ruolo', () => void this.resetPrompt(f, prompt, desc, sync), 'btn ghost', T.resetPrompt),
          h('span', { class: 'hint', text: 'Testo predefinito del ruolo ' + ROLE_LABEL[f.role] + '.' }))),
      preview,
      h('div', { class: 'form-row' },
        this.field('Colore', color, undefined, T.formColor),
        this.field('Iterazioni max', iters, undefined, T.formIters)),
      h('div', { class: 'form-actions' },
        btn('Annulla', () => {
          this.form = null;
          this.render();
        }, 'btn ghost', T.formCancel),
        btn(f.id ? 'Salva' : 'Aggiungi', () => void this.submit(f), 'btn primary',
          f.id ? T.formSave : 'Aggiunge il template al pool: l’orchestratore lo vedrà nell’elenco Pool dalla prossima chiamata.')),
    );
  }

  private async resetPrompt(
    f: FormState,
    prompt: HTMLTextAreaElement,
    desc: HTMLInputElement,
    sync: () => void,
  ): Promise<void> {
    if (prompt.value.trim()) {
      const ok = await modals.confirm({
        title: 'Ripristinare il prompt predefinito di ' + ROLE_LABEL[f.role] + '?',
        body: 'Il testo attuale viene sostituito con il prompt predefinito del ruolo.',
        okLabel: 'Ripristina',
      });
      if (!ok) return;
    }
    try {
      const text = await window.api.invoke('config:defaultPrompt', f.role);
      prompt.value = text;
      f.prompt = text;
      const d = deriveDescription(text);
      if (d) {
        desc.value = d;
        f.description = d;
      }
      sync();
      toast('info', 'Prompt del ruolo ripristinato.');
    } catch (e) {
      toast('error', errText(e));
    }
  }

  private async submit(f: FormState): Promise<void> {
    const name = f.name.trim();
    if (!name) {
      toast('warn', 'Il nome è obbligatorio.');
      return;
    }
    if (!f.model) {
      toast('warn', 'Scegli un modello primario.');
      return;
    }
    const num = (v: string): number | null => {
      const n = Number(v);
      return v.trim() === '' || !isFinite(n) ? null : n;
    };
    const bt = num(f.budget.maxTokens);
    const bc = num(f.budget.maxToolCalls);
    const bs = num(f.budget.maxSeconds);
    const anyBudget = bt !== null || bc !== null || bs !== null;
    const input: AgentInput = {
      name,
      model: f.model,
      prompt: withDescription(f.prompt, f.description),
      color: f.color,
      maxIterations: Math.max(1, Math.min(200, f.maxIterations || 40)),
      role: f.role,
      fallbacks: f.fallbacks.filter((m) => m && m !== f.model),
      escalation: f.escalation || null,
      temperature: num(f.temperature),
      budget: f.role === 'orchestrator' || !anyBudget
        ? null
        : {
          maxTokens: bt ?? DEFAULT_BUDGET.maxTokens,
          maxToolCalls: bc ?? DEFAULT_BUDGET.maxToolCalls,
          maxSeconds: bs ?? DEFAULT_BUDGET.maxSeconds,
        },
      maxConcurrent: f.role === 'orchestrator' ? null : num(f.maxConcurrent),
    };
    await this.saveAgent(f.id, input);
  }

  /**
   * Model picker. Unavailable-this-session models stay selectable (the router simply skips
   * them) but are marked so the choice is informed.
   */
  private modelSelect(value: string, opts: { emptyLabel?: string; title?: string } = {}): HTMLSelectElement {
    const sel = h('select', { class: 'input', title: opts.title });
    if (opts.emptyLabel) sel.appendChild(h('option', { value: '', text: opts.emptyLabel, title: opts.title }));
    const ids = new Set<string>();
    for (const m of this.models) {
      ids.add(m.id);
      const opt = h('option', {
        value: m.id, text: (m.unavailable ? '⚠ ' : '') + modelLabel(m),
        title: [modelLabel(m), m.notes, m.unavailable ? 'Non disponibile in questa sessione: il router lo salta.' : ''].filter(Boolean).join(' · '),
      });
      if (m.unavailable) opt.classList.add('opt-unavailable');
      sel.appendChild(opt);
    }
    if (value && !ids.has(value)) sel.appendChild(h('option', { value, text: value }));
    if (!this.models.length && !value && !opts.emptyLabel) sel.appendChild(h('option', { value: '', text: 'Modelli non disponibili' }));
    sel.value = value;
    return sel;
  }

  private async saveAgent(id: AgentId | null, input: AgentInput): Promise<void> {
    try {
      if (id) await window.api.invoke('config:updateAgent', id, input);
      else await window.api.invoke('config:addAgent', input);
      this.form = null;
      // `config:changed` may have re-rendered before the form was cleared: render again.
      if (this.opened) this.render();
      toast('info', id ? 'Template aggiornato.' : 'Template aggiunto.');
    } catch (e) {
      toast('error', errText(e));
    }
  }

  private async removeAgent(a: AgentView): Promise<void> {
    const ok = await modals.confirm({
      title: 'Rimuovere ' + a.name + '?',
      body: 'Le istanze in corso di questo template vengono annullate (esito parziale) e le sue console spariscono.',
      okLabel: 'Rimuovi',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.api.invoke('config:removeAgent', a.id);
    } catch (e) {
      toast('error', errText(e));
    }
  }

  private async setMain(id: AgentId): Promise<void> {
    try {
      await window.api.invoke('config:update', { mainAgentId: id });
    } catch (e) {
      toast('error', errText(e));
    }
  }

  // ------------------------------------------------------------------- pool

  private sectionPool(s: ConfigSnapshot): HTMLElement {
    const r = this.ranges();
    const allow = s.allowWorkerDelegation === true;

    const depthBox = h('div', { hidden: !allow });
    const rows = [
      this.poolNumber('Worker paralleli per chiamata', 'maxParallelWorkers', s.maxParallelWorkers, r.maxParallelWorkers),
      this.poolNumber('Istanze per richiesta', 'maxWorkersPerRequest', s.maxWorkersPerRequest, r.maxWorkersPerRequest),
      this.poolNumber('Round di correzione', 'correctionRounds', s.correctionRounds, r.correctionRounds),
      this.poolNumber('Soglia artefatti (caratteri)', 'artifactThresholdChars', s.artifactThresholdChars, r.artifactThresholdChars),
    ];

    const toggle = h('input', { type: 'checkbox', checked: allow, title: T.allowDeleg });
    toggle.addEventListener('change', () => {
      depthBox.hidden = !toggle.checked;
      void this.update({ allowWorkerDelegation: toggle.checked });
    });
    depthBox.appendChild(this.poolNumber(
      'Profondità massima', 'maxDepth', s.maxDepth, r.maxDepth,
      'Con 2 i worker non possono comunque delegare: serve 3 o 4.',
    ));

    return this.section('Pool', T.sectPool,
      h('div', { class: 'pool-grid' }, rows),
      h('label', { class: 'toggle', title: T.allowDeleg }, toggle, h('span', { text: 'I worker possono delegare' })),
      h('div', { class: 'hint', text: allow ? 'Profondità oltre 2: i worker ricevono delegate_tasks.' : 'Disattivato: solo l’orchestratore delega (hub-and-spoke, profondità 2).' }),
      depthBox,
      h('div', { class: 'field', title: T.formats },
        h('span', { class: 'lbl', text: 'Formati modello' }),
        this.formatEditor(s),
        h('span', { class: 'hint', text: 'Override della mappa automatica (grok-*, gpt-*, muse-spark-* usano /responses).' })),
      btn('Apri log contratti', () => void this.openContracts(), 'btn ghost wide', T.openLog),
    );
  }

  private poolNumber(
    label: string,
    key: keyof PoolRanges,
    value: number | undefined,
    range: Range,
    hint?: string,
  ): HTMLElement {
    const v = typeof value === 'number' ? value : range.default;
    const help = POOL_HELP[key] + ' Intervallo ' + range.min + '–' + range.max + ', predefinito ' + range.default + '.';
    const input = h('input', {
      class: 'input num', type: 'number', min: String(range.min), max: String(range.max), value: String(v),
      title: help,
    });
    const warn = h('div', {
      class: 'pool-warn', hidden: v <= range.recommendedMax, text: POOL_WARN[key],
      title: 'Valore oltre quello consigliato (' + range.recommendedMax + '): funziona, ma paghi di più e il flusso è meno prevedibile.',
    });
    input.addEventListener('change', () => {
      const next = Math.max(range.min, Math.min(range.max, Number(input.value) || range.default));
      input.value = String(next);
      warn.hidden = next <= range.recommendedMax;
      void this.update({ [key]: next } as ConfigPatch);
    });
    return h('div', { class: 'field', title: help },
      h('span', { class: 'lbl', text: label }),
      input,
      h('span', { class: 'hint', text: range.min + '–' + range.max + ' · consigliato fino a ' + range.recommendedMax + (hint ? ' · ' + hint : '') }),
      warn);
  }

  private formatEditor(s: ConfigSnapshot): HTMLElement {
    const map = s.modelFormats ?? {};
    const box = h('div', { class: 'fmt-rows' });
    const entries = Object.entries(map);
    if (!entries.length) {
      box.appendChild(h('div', {
        class: 'hint', text: 'nessun override',
        title: 'Nessun override attivo: ogni modello usa il formato riconosciuto automaticamente dal prefisso del nome.',
      }));
    }
    for (const [id, fmt] of entries) {
      const sel = h('select', {
        class: 'input',
        title: 'Endpoint usato per ' + id + ': /chat/completions (formato classico) oppure /responses. '
          + 'Un formato sbagliato fa fallire ogni chiamata a questo modello.',
      });
      for (const f of ['chat', 'responses'] as ModelFormat[]) sel.appendChild(h('option', { value: f, text: f, title: FMT_HELP[f] }));
      sel.value = fmt;
      sel.addEventListener('change', () => {
        void this.update({ modelFormats: { ...map, [id]: sel.value as ModelFormat } });
      });
      box.appendChild(h('div', { class: 'fmt-row' },
        h('code', { text: id, title: 'Modello a cui si applica questo override.' }),
        sel,
        iconBtn('✕', 'Toglie l’override per ' + id + ': si torna al formato riconosciuto automaticamente dal nome.', () => {
          const next = { ...map };
          delete next[id];
          void this.update({ modelFormats: next });
        }, 'danger')));
    }
    const addModel = this.modelSelect('', { emptyLabel: '— aggiungi override', title: T.formats });
    const addFmt = h('select', { class: 'input', title: 'Formato da applicare al modello scelto qui a fianco.' });
    for (const f of ['chat', 'responses'] as ModelFormat[]) addFmt.appendChild(h('option', { value: f, text: f, title: FMT_HELP[f] }));
    addModel.addEventListener('change', () => {
      const id = addModel.value;
      addModel.value = '';
      if (!id) return;
      void this.update({ modelFormats: { ...map, [id]: addFmt.value as ModelFormat } });
    });
    box.appendChild(h('div', { class: 'fmt-row' }, addModel, addFmt));
    return box;
  }

  private async openContracts(): Promise<void> {
    try {
      await window.api.invoke('logs:openContracts');
    } catch (e) {
      toast('error', errText(e));
    }
  }

  // --------------------------------------------------------------- protocol

  private sectionProtocol(s: ConfigSnapshot): HTMLElement {
    const ta = h('textarea', { class: 'input area', rows: 6, spellcheck: false, value: s.interactionPrompt,
      title: T.protocol,
      placeholder: 'Come vuoi che l’orchestratore lavori e risponda…' });
    const save = () => {
      if (ta.value === (this.snapshot?.interactionPrompt ?? '')) return;
      void this.update({ interactionPrompt: ta.value });
    };
    ta.addEventListener('blur', save);
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 's' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        save();
      }
    });
    return this.section('Indicazioni per l’orchestratore', T.sectProtocol,
      ta,
      h('div', { class: 'hint', text: 'Applicate dalla prossima chiamata al modello. I worker non le vedono: ricevono solo il TaskContract.' }));
  }

  // -------------------------------------------------------------- workspace

  private sectionWorkspace(s: ConfigSnapshot): HTMLElement {
    return this.section('Cartella di lavoro', T.sectWorkspace,
      h('div', { class: 'row' },
        h('code', {
          class: 'path', text: s.workspacePath ?? 'non impostata',
          title: s.workspacePath
            ? 'Gli agenti leggono e scrivono qui senza chiedere; i percorsi relativi partono da questa cartella.'
            : 'Senza cartella di lavoro gli agenti non possono operare sui file.',
        }),
        btn('Cambia…', () => void this.chooseWorkspace(), 'btn ghost', T.wsChange)));
  }

  private async chooseWorkspace(): Promise<void> {
    try {
      const p = await window.api.invoke('config:chooseWorkspace');
      if (!p) return;
      await this.update({ workspacePath: p });
    } catch (e) {
      toast('error', errText(e));
    }
  }

  // ------------------------------------------------------------ permissions

  private sectionPermissions(s: ConfigSnapshot): HTMLElement {
    const modes = (Object.keys(MODE_LABEL) as PermissionMode[]).map((m) =>
      h('label', { class: 'mode' + (s.permissionMode === m ? ' on' : ''), title: MODE_TRADEOFF[m] },
        h('input', {
          type: 'radio', name: 'perm-mode', checked: s.permissionMode === m,
          title: MODE_TRADEOFF[m],
          on: { change: () => void this.update({ permissionMode: m }) },
        }),
        h('div', {},
          h('div', { class: 'mode-title', text: MODE_LABEL[m].title }),
          h('div', { class: 'hint', text: MODE_LABEL[m].help }))));

    const list = h('textarea', {
      class: 'input area mono', rows: 4, spellcheck: false,
      value: s.commandAllowlist.join('\n'),
      title: T.allowlist,
      placeholder: 'npm test\ngit status',
    });
    const saveList = () => {
      const next = list.value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (next.join('\n') === (this.snapshot?.commandAllowlist ?? []).join('\n')) return;
      void this.update({ commandAllowlist: next });
    };
    list.addEventListener('blur', saveList);

    const timeout = h('input', {
      class: 'input num', type: 'number', min: '1', max: '60',
      value: String(Math.round(s.permissionTimeoutMs / 60000)), title: T.permTimeout,
    });
    timeout.addEventListener('change', () => {
      const m = Math.max(1, Math.min(60, Number(timeout.value) || 5));
      void this.update({ permissionTimeoutMs: m * 60000 });
    });

    return this.section('Autorizzazioni', T.sectPermissions,
      h('div', { class: 'modes' }, modes),
      this.field('Comandi sempre consentiti', list, 'Uno schema per riga; vale solo per i comandi innocui.', T.allowlist),
      h('div', { class: 'row' },
        btn('Svuota elenco', () => void this.clearAllowlist(), 'btn ghost', T.clearAllowlist),
        h('span', { class: 'hint', text: 'Le autorizzazioni "per la sessione" si azzerano alla chiusura dell’app.' })),
      this.field('Timeout richieste (minuti)', timeout, undefined, T.permTimeout));
  }

  private async clearAllowlist(): Promise<void> {
    if (!(this.snapshot?.commandAllowlist.length)) {
      toast('info', 'L’elenco è già vuoto.');
      return;
    }
    const ok = await modals.confirm({
      title: 'Svuotare l’elenco dei comandi consentiti?',
      body: 'I prossimi comandi chiederanno di nuovo conferma.',
      okLabel: 'Svuota',
      danger: true,
    });
    if (ok) await this.update({ commandAllowlist: [] });
  }

  // -------------------------------------------------------------- API key

  private sectionKey(s: ConfigSnapshot): HTMLElement {
    const inputWrap = h('div', { class: 'row', hidden: true });
    const input = h('input', {
      class: 'input', type: 'password', placeholder: 'sk-…', spellcheck: false,
      title: 'Nuova API key di OpenCode Go: viene validata con una chiamata reale e sostituisce la precedente solo se funziona.',
    });
    const doSave = async () => {
      const key = input.value.trim();
      if (!key) return;
      try {
        const res = await window.api.invoke('key:set', key);
        if (res.ok) {
          input.value = '';
          inputWrap.hidden = true;
          toast('info', 'Chiave aggiornata (' + res.masked + ').');
        } else {
          toast('error', res.message || 'Chiave non valida.');
        }
      } catch (e) {
        toast('error', errText(e));
      }
    };
    inputWrap.appendChild(input);
    inputWrap.appendChild(btn('Salva', () => void doSave(), 'btn primary', T.keySave));

    return this.section('API key', T.sectKey,
      h('div', { class: 'row' },
        h('code', {
          class: 'path', text: s.hasApiKey ? (s.apiKeyMasked ?? 'impostata') : 'non impostata',
          title: s.hasApiKey ? T.keyValue : 'Nessuna chiave salvata: l’app non può chiamare i modelli.',
        }),
        btn('Cambia chiave…', () => {
          inputWrap.hidden = !inputWrap.hidden;
          if (!inputWrap.hidden) input.focus();
        }, 'btn ghost', T.keyChange),
        btn('Rimuovi', () => void this.clearKey(), 'btn ghost danger', T.keyRemove)),
      inputWrap);
  }

  private async clearKey(): Promise<void> {
    const ok = await modals.confirm({
      title: 'Rimuovere la API key?',
      body: 'Tutte le attività in corso vengono annullate e l’app torna alla schermata di inserimento della chiave.',
      okLabel: 'Rimuovi',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.api.invoke('key:clear');
      this.close();
      this.hooks.onKeyCleared();
    } catch (e) {
      toast('error', errText(e));
    }
  }

  // ----------------------------------------------------------------- data

  private sectionData(s: ConfigSnapshot): HTMLElement {
    // Only the orchestrator keeps a conversation: instances are stateless by design (§0).
    const main = s.agents.find((a) => a.id === s.mainAgentId);
    return this.section('Dati', T.sectData,
      main ? btn('Cancella cronologia di ' + main.name, () => void this.clearHistory(main), 'btn ghost wide', T.clearHistory) : null,
      h('div', { class: 'hint', text: 'Ogni console ha il suo pulsante 🧠 per azzerare la memoria di quell’agente. Solo l’orchestratore '
        + 'conserva una conversazione tra una richiesta e l’altra: planner, worker e verificatori partono già da zero a ogni task.' }),
      btn('Reset totale', () => void this.resetAll(), 'btn danger wide', T.resetAll),
      h('div', { class: 'hint', text: 'Il reset cancella template, cronologie e impostazioni (la API key resta) e riapre la procedura guidata.' }));
  }

  private async clearHistory(a: AgentView): Promise<void> {
    const ok = await modals.confirm({
      title: 'Cancellare la cronologia di ' + a.name + '?',
      body: 'L’agente ripartirà senza memoria della conversazione precedente. Possibile solo quando è inattivo.',
      okLabel: 'Cancella',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.api.invoke('agent:clearHistory', a.id);
      toast('info', 'Cronologia di ' + a.name + ' cancellata.');
    } catch (e) {
      toast('error', errText(e));
    }
  }

  private async resetAll(): Promise<void> {
    const ok = await modals.confirm({
      title: 'Reset totale?',
      body: 'Vengono eliminati template, cronologie e impostazioni. La API key viene conservata.',
      okLabel: 'Azzera tutto',
      danger: true,
    });
    if (!ok) return;
    try {
      await window.api.invoke('config:resetAll');
      this.close();
      this.hooks.onReset();
    } catch (e) {
      toast('error', errText(e));
    }
  }

  private async update(patch: ConfigPatch): Promise<void> {
    try {
      const snap = await window.api.invoke('config:update', patch);
      this.setSnapshot(snap);
    } catch (e) {
      toast('error', errText(e));
    }
  }
}
