// SetupWizard: workspace → role templates (with presets) → orchestrator + notes → review.
// Ends with `config:completeSetup`, which starts the runtimes and returns the first snapshot.
// Nothing here fixes the shape of the pool: presets are starting points, every card can be
// added, duplicated or removed, and any mix of roles is valid (PLAN-v2 §0, §10.4).

import type { AgentInput, AgentRole, AppInfo, Budget, ConfigSnapshot, ModelInfo, SetupPayload } from '../shared/types';
import {
  btn,
  clear,
  deriveDescription,
  field,
  h,
  iconBtn,
  modelBadges,
  modelLabel,
  replace,
  ROLE_LABEL,
  ROLE_ORDER,
  routingSummary,
  tip,
  withDescription,
} from './dom.js';
import { errText, toast } from './modals.js';

const NOTES_PLACEHOLDER =
  'Rispondi sempre in italiano, cita i file toccati e chiudi con cosa resta da fare.\n'
  + 'Per le richieste brevi rispondi da solo, senza delegare.';

const STEP_TITLES = ['Cartella di lavoro', 'Template di ruolo', 'Orchestratore e indicazioni', 'Riepilogo'];

const ECONOMY_NOTE =
  'più economico e con la quota più ampia, ma richiede l’opt-in OpenCode e i prompt addestrano '
  + 'modelli Meta: non usarlo con contenuti proprietari o clinici';

const ZDR_VERIFY_NOTE = 'DeepSeek: accordo ZDR indicato fino al 31/08/2026, verifica il rinnovo.';

type PresetId = 'recommended' | 'economy' | 'empty';

interface DraftAgent {
  name: string;
  description: string;
  model: string;
  prompt: string;
  color: string;
  role: AgentRole;
  fallbacks: string[];
  escalation: string;
  budget: Budget | null;
  temperature: number | null;
  maxConcurrent: number | null;
}

/**
 * Used only until `AppInfo.recommendedPool` / `economyPool` / `emptyPool` are filled in by the
 * main process; the numbers mirror PLAN-v2 §11.3 (measured 2026-09-04). Prompts are left empty
 * on purpose: they are fetched per role from `config:defaultPrompt`.
 */
const FALLBACK_PRESETS: Record<PresetId, AgentInput[]> = {
  recommended: [
    { name: 'Orchestratore', role: 'orchestrator', model: 'minimax-m3', prompt: '', color: '#3B82F6', fallbacks: ['qwen3.7-plus', 'deepseek-v4-flash'], escalation: 'glm-5.3' },
    { name: 'Planner', role: 'planner', model: 'glm-5.3', prompt: '', color: '#8B5CF6', fallbacks: ['kimi-k2.7-code', 'minimax-m3'], budget: { maxTokens: 6000, maxToolCalls: 6, maxSeconds: 120 } },
    { name: 'Worker', role: 'worker', model: 'deepseek-v4-flash', prompt: '', color: '#10B981', fallbacks: ['kimi-k2.7-code', 'glm-5.3-flash'], escalation: 'deepseek-v4-pro', budget: { maxTokens: 8000, maxToolCalls: 10, maxSeconds: 180 } },
    { name: 'Worker Flash', role: 'worker', model: 'longcat-2.0', prompt: '', color: '#F59E0B', fallbacks: ['glm-5.3-flash', 'hy3'], budget: { maxTokens: 4000, maxToolCalls: 6, maxSeconds: 120 } },
    { name: 'Verificatore', role: 'verifier', model: 'qwen3.7-plus', prompt: '', color: '#EF4444', fallbacks: ['minimax-m3', 'glm-5.3-flash'], escalation: 'glm-5.3', budget: { maxTokens: 8000, maxToolCalls: 8, maxSeconds: 150 } },
  ],
  economy: [
    { name: 'Orchestratore', role: 'orchestrator', model: 'minimax-m3', prompt: '', color: '#3B82F6', fallbacks: ['qwen3.7-plus', 'deepseek-v4-flash'], escalation: 'glm-5.3' },
    { name: 'Planner', role: 'planner', model: 'glm-5.3', prompt: '', color: '#8B5CF6', fallbacks: ['kimi-k2.7-code', 'minimax-m3'], budget: { maxTokens: 6000, maxToolCalls: 6, maxSeconds: 120 } },
    { name: 'Worker', role: 'worker', model: 'muse-spark-1.3-contributor', prompt: '', color: '#10B981', fallbacks: ['deepseek-v4-flash', 'kimi-k2.7-code'], escalation: 'deepseek-v4-pro', budget: { maxTokens: 8000, maxToolCalls: 10, maxSeconds: 180 } },
    { name: 'Worker Flash', role: 'worker', model: 'muse-spark-1.3-contributor', prompt: '', color: '#F59E0B', fallbacks: ['longcat-2.0', 'glm-5.3-flash'], budget: { maxTokens: 4000, maxToolCalls: 6, maxSeconds: 120 } },
    { name: 'Verificatore', role: 'verifier', model: 'qwen3.7-plus', prompt: '', color: '#EF4444', fallbacks: ['minimax-m3', 'glm-5.3-flash'], escalation: 'glm-5.3', budget: { maxTokens: 8000, maxToolCalls: 8, maxSeconds: 150 } },
  ],
  empty: [
    { name: 'Orchestratore', role: 'orchestrator', model: 'minimax-m3', prompt: '', color: '#3B82F6', fallbacks: ['qwen3.7-plus'] },
  ],
};

const PRESET_LABEL: Record<PresetId, string> = {
  recommended: 'Pool consigliato',
  economy: 'Pool economico (Muse Spark)',
  empty: 'Vuoto',
};

/** Tooltips: what the choice does and what it costs, never a rewording of the label (§10.4). */
const PRESET_HELP: Record<PresetId, string> = {
  recommended: 'Cinque template pronti (orchestratore, planner, due worker, verificatore), ognuno su un modello '
    + 'diverso così ogni ruolo consuma una quota separata. È il punto di partenza consigliato; tutto resta modificabile.',
  economy: 'Come il pool consigliato, ma i due worker usano Muse Spark: costa meno di tutti e ha la quota più ampia. '
    + 'Richiede l’opt-in nel tuo workspace OpenCode (finché manca risponde 403 e il router passa al fallback) e i '
    + 'suoi prompt addestrano modelli Meta: non usarlo con contenuti proprietari o clinici.',
  empty: 'Parte con il solo orchestratore: senza worker risponderà sempre da solo, finché non aggiungi almeno un template worker.',
};

const ROLE_HELP: Record<AgentRole, string> = {
  orchestrator: 'Orchestratore: l’unico che parla con te. Classifica la richiesta (T0…T3), delega e sintetizza la risposta finale. Deve essercene esattamente uno.',
  planner: 'Planner: chiamato solo per obiettivi ampi o ambigui (T3). Produce un piano di al massimo 6 task e non esegue nulla.',
  worker: 'Worker: esegue un singolo TaskContract in un’istanza nuova, senza cronologia della conversazione. È il ruolo che fa il lavoro.',
  verifier: 'Verificatore: rilegge i risultati in modo avversariale cercando errori e requisiti ignorati; non riscrive l’output.',
};

const T = {
  wsPath: 'Cartella in cui gli agenti possono leggere e scrivere senza chiederti nulla: tutto ciò che sta fuori richiede la tua autorizzazione, una richiesta alla volta.',
  wsChoose: 'Apre la finestra di sistema per scegliere la cartella di lavoro. Potrai cambiarla in seguito dalle impostazioni.',
  addTemplate: 'Aggiunge un template con ruolo Worker e il prompt predefinito del ruolo. Non c’è un limite al numero di template.',
  duplicate: 'Crea una copia di questo template (stesso modello, fallback, budget e prompt) con " 2" nel nome: utile per un secondo worker specializzato.',
  remove: 'Toglie questo template dal pool. Puoi ricrearlo o ricaricare un preset in qualsiasi momento.',
  removeMain: 'Serve esattamente un orchestratore: promuovine un altro prima di rimuovere questo.',
  name: 'Nome del template. L’orchestratore lo usa come "role" nei TaskContract per scegliere a chi delegare, quindi deve essere unico e dire che cosa fa.',
  role: 'Decide quali strumenti riceve il template e quando viene chiamato. Cambiandolo, il prompt segue il ruolo se non l’hai ancora modificato.',
  model: 'Modello provato per primo. Nell’elenco vedi prezzo per milione di token, contesto e richieste per 5 ore presi dalla tabella modelli misurata; i badge sotto riportano privacy, formato API e affidabilità del JSON.',
  fallbacks: 'Modelli usati in ordine quando il primario risponde 429, non è disponibile o rifiuta per data policy: il nuovo tentativo cambia modello invece di ripetere lo stesso. Errori di rete restano sul primario.',
  addFallback: 'Aggiunge un modello alla fine della catena di fallback.',
  moveUp: 'Anticipa questo fallback: verrà provato prima degli altri.',
  moveDown: 'Posticipa questo fallback: verrà provato dopo gli altri.',
  escalation: 'Modello più forte (e più costoso) usato solo per le richieste ampie T3 o per le verifiche critiche. Lascialo su "—" per non usarne nessuno.',
  description: 'Una riga che spiega a cosa serve questo template: compare sotto il nome nella console e nell’elenco Pool del prompt dell’orchestratore, che la legge per decidere a chi delegare.',
  prompt: 'Prompt di sistema del template. L’app gli aggiunge sempre le regole fisse del ruolo; i dati che cambiano (contratto, ambiente, input) arrivano nel messaggio, non qui.',
  budgetTok: 'Tetto di token (prompt + risposta) per ogni istanza di questo template: al superamento l’istanza viene fermata e consegna quello che ha prodotto con esito "parziale". Vuoto = 8000.',
  budgetTool: 'Numero massimo di chiamate a strumenti per istanza: al superamento l’istanza chiude con esito "parziale". Vuoto = 10.',
  budgetSec: 'Secondi di silenzio dal modello prima di considerare la chiamata bloccata: non un tempo massimo per il task, che può durare quanto serve finché il modello risponde. Vuoto = 60 s. Allo scadere l\'app riprova o cambia modello.',
  color: 'Colore della console di questo template e del bordo tratteggiato delle sue istanze temporanee.',
  mainRadio: 'Rende questo template l’orchestratore: sarà l’unico a parlare con te e a delegare. Il precedente orchestratore torna worker.',
  notes: 'Istruzioni aggiunte sempre al prompt del solo orchestratore (lingua, stile, cosa evitare). I worker non le vedono: ricevono soltanto il TaskContract.',
  back: 'Torna al passo precedente: quello che hai scelto resta.',
  next: 'Passa al passo successivo dopo aver controllato i campi obbligatori.',
  start: 'Salva la configurazione, avvia i template e apre il banco di lavoro con una console per ciascuno.',
};

export interface WizardHooks {
  onComplete(snapshot: ConfigSnapshot): void;
}

export class SetupWizard {
  readonly root: HTMLElement;

  private readonly info: AppInfo;
  private readonly hooks: WizardHooks;
  private readonly bodyEl: HTMLElement;
  private readonly dotsEl: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly errEl: HTMLElement;

  private step = 0;
  private models: ModelInfo[] = [];
  private readonly defaultPrompts = new Map<AgentRole, string>();
  private workspacePath: string | null = null;
  private agents: DraftAgent[] = [];
  private mainIndex = 0;
  private preset: PresetId = 'recommended';
  private interactionPrompt = '';
  private busy = false;

  constructor(info: AppInfo, hooks: WizardHooks) {
    this.info = info;
    this.hooks = hooks;
    this.applyPreset('recommended');

    this.dotsEl = h('div', { class: 'dots' });
    this.bodyEl = h('div', { class: 'wiz-body' });
    this.errEl = h('div', { class: 'err', hidden: true });
    this.backBtn = btn('Indietro', () => this.go(-1), 'btn ghost', T.back);
    this.nextBtn = btn('Avanti', () => this.go(1), 'btn primary', T.next);

    this.root = h('div', { class: 'screen center' },
      h('div', { class: 'card wiz-card' },
        h('div', { class: 'wiz-head' },
          h('div', { class: 'brand sm' }, 'Agents ', h('span', { class: 'accent', text: 'Pool' })),
          this.dotsEl),
        this.bodyEl,
        this.errEl,
        h('div', { class: 'wiz-foot' }, this.backBtn, h('span', { class: 'spacer' }), this.nextBtn)));

    void this.loadModels();
    void this.loadDefaultPrompts();
    this.render();
  }

  // ---------------------------------------------------------------- presets

  private presetInputs(id: PresetId): AgentInput[] {
    const fromInfo = id === 'recommended' ? this.info.recommendedPool
      : id === 'economy' ? this.info.economyPool
        : this.info.emptyPool;
    return fromInfo?.length ? fromInfo : FALLBACK_PRESETS[id];
  }

  private applyPreset(id: PresetId): void {
    this.preset = id;
    this.agents = this.presetInputs(id).map((a, i) => this.draftFrom(a, i));
    const main = this.agents.findIndex((a) => a.role === 'orchestrator');
    this.mainIndex = main >= 0 ? main : 0;
    if (this.agents[this.mainIndex]) (this.agents[this.mainIndex] as DraftAgent).role = 'orchestrator';
    for (const a of this.agents) this.ensurePrompt(a);
  }

  private draftFrom(a: AgentInput, i: number): DraftAgent {
    const palette = this.paletteFallback();
    return {
      name: a.name,
      description: deriveDescription(a.prompt || ''),
      model: a.model || this.info.defaultModel,
      prompt: a.prompt || '',
      color: a.color ?? palette[i % palette.length] ?? '#3B82F6',
      role: a.role ?? (i === 0 ? 'orchestrator' : 'worker'),
      fallbacks: [...(a.fallbacks ?? [])],
      escalation: a.escalation ?? '',
      budget: a.budget ?? null,
      temperature: a.temperature ?? null,
      maxConcurrent: a.maxConcurrent ?? null,
    };
  }

  private blankAgent(i: number): DraftAgent {
    const palette = this.paletteFallback();
    const a: DraftAgent = {
      name: '',
      description: '',
      model: this.info.defaultModel,
      prompt: '',
      color: palette[i % palette.length] ?? '#3B82F6',
      role: 'worker',
      fallbacks: [],
      escalation: '',
      budget: null,
      temperature: null,
      maxConcurrent: null,
    };
    this.ensurePrompt(a);
    return a;
  }

  private paletteFallback(): string[] {
    return this.info.palette?.length
      ? this.info.palette
      : ['#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#84CC16', '#06B6D4'];
  }

  /** A card's prompt defaults to its role's text and follows a role change while untouched. */
  private ensurePrompt(a: DraftAgent): void {
    const isDefault = !a.prompt.trim() || [...this.defaultPrompts.values()].some((p) => p.trim() === a.prompt.trim());
    if (!isDefault) return;
    const next = this.defaultPrompts.get(a.role);
    if (next === undefined) return;
    a.prompt = next;
    a.description = deriveDescription(next);
  }

  private async loadModels(): Promise<void> {
    try {
      this.models = await window.api.invoke('models:list');
      if (this.step === 1 || this.step === 3) this.render();
    } catch (e) {
      toast('warn', 'Elenco modelli non disponibile: ' + errText(e));
    }
  }

  private async loadDefaultPrompts(): Promise<void> {
    for (const role of ROLE_ORDER) {
      try {
        this.defaultPrompts.set(role, await window.api.invoke('config:defaultPrompt', role));
      } catch {
        /* channel not available yet: cards keep whatever the preset carried */
      }
    }
    if (!this.defaultPrompts.size) return;
    for (const a of this.agents) this.ensurePrompt(a);
    if (this.step === 1 || this.step === 3) this.render();
  }

  private model(id: string | undefined): ModelInfo | undefined {
    return id ? this.models.find((m) => m.id === id) : undefined;
  }

  // ------------------------------------------------------------- navigation

  private go(delta: number): void {
    if (this.busy) return;
    if (delta > 0) {
      const err = this.validateStep();
      if (err) {
        this.errEl.textContent = err;
        this.errEl.hidden = false;
        return;
      }
      if (this.step === STEP_TITLES.length - 1) {
        void this.finish();
        return;
      }
    }
    this.errEl.hidden = true;
    this.step = Math.max(0, Math.min(STEP_TITLES.length - 1, this.step + delta));
    this.render();
  }

  private validateStep(): string | null {
    if (this.step === 0 && !this.workspacePath) return 'Scegli una cartella di lavoro per continuare.';
    if (this.step === 1) {
      if (!this.agents.length) return 'Serve almeno il template dell’orchestratore.';
      const names = this.agents.map((a) => a.name.trim().toLowerCase());
      if (names.some((n) => !n)) return 'Ogni template deve avere un nome.';
      if (new Set(names).size !== names.length) return 'I nomi dei template devono essere diversi tra loro.';
      if (this.agents.some((a) => !a.model)) return 'Scegli un modello primario per ogni template.';
      if (this.agents.filter((a) => a.role === 'orchestrator').length !== 1) {
        return 'Serve esattamente un orchestratore: scegline uno nel passo successivo.';
      }
    }
    return null;
  }

  private render(): void {
    replace(this.dotsEl, STEP_TITLES.map((t, i) =>
      h('span', {
        class: 'dot-step' + (i === this.step ? ' on' : '') + (i < this.step ? ' done' : ''),
        title: 'Passo ' + (i + 1) + ' di ' + STEP_TITLES.length + ': ' + t
          + (i < this.step ? ' — clicca per tornare a questo passo' : i > this.step ? ' — si sbloccherà arrivando qui' : ' — passo corrente'),
        on: { click: () => { if (i < this.step) { this.step = i; this.render(); } } },
      }, String(i + 1))));

    clear(this.bodyEl);
    this.bodyEl.appendChild(h('h2', { class: 'wiz-title', text: (this.step + 1) + '. ' + STEP_TITLES[this.step] }));
    if (this.step === 0) this.renderWorkspace();
    else if (this.step === 1) this.renderAgents();
    else if (this.step === 2) this.renderMain();
    else this.renderReview();

    this.backBtn.hidden = this.step === 0;
    const last = this.step === STEP_TITLES.length - 1;
    this.nextBtn.textContent = last ? 'Avvia' : 'Avanti';
    this.nextBtn.title = last ? T.start : T.next;
  }

  // ------------------------------------------------------------------ step 1

  private renderWorkspace(): void {
    const pathEl = h('input', {
      class: 'input', type: 'text', readOnly: true, title: T.wsPath,
      value: this.workspacePath ?? '',
      placeholder: 'Nessuna cartella scelta',
    });
    this.bodyEl.appendChild(h('p', { class: 'lead', text: 'Gli agenti potranno leggere e scrivere liberamente solo qui dentro. Fuori serve la tua autorizzazione.' }));
    this.bodyEl.appendChild(h('div', { class: 'row' }, pathEl, btn('Scegli cartella…', () => void this.choose(), 'btn ghost', T.wsChoose)));
  }

  private async choose(): Promise<void> {
    try {
      const p = await window.api.invoke('config:chooseWorkspace');
      if (p) {
        this.workspacePath = p;
        this.errEl.hidden = true;
        this.render();
      }
    } catch (e) {
      toast('error', errText(e));
    }
  }

  // ------------------------------------------------------------------ step 2

  private renderAgents(): void {
    this.bodyEl.appendChild(h('p', {
      class: 'lead',
      text: 'Ogni template è un ruolo con il suo modello: l’orchestratore parla con te, i worker vengono creati '
        + 'e distrutti a ogni richiesta. Puoi aggiungere, duplicare e rimuovere quanti template vuoi.',
    }));

    const presetRow = h('div', { class: 'preset-row' },
      (['recommended', 'economy', 'empty'] as PresetId[]).map((id) =>
        btn(PRESET_LABEL[id], () => {
          this.applyPreset(id);
          this.errEl.hidden = true;
          this.render();
        }, 'btn ghost preset' + (this.preset === id ? ' on' : ''),
        PRESET_HELP[id] + (this.preset === id ? ' (preset attivo: ricliccalo per annullare le modifiche fatte alle schede)' : ' Sostituisce le schede sotto.'))));
    this.bodyEl.appendChild(h('div', { class: 'presets' },
      presetRow,
      this.preset === 'economy'
        ? h('div', { class: 'preset-note', text: 'Pool economico: ' + ECONOMY_NOTE + '.' })
        : h('div', { class: 'hint', text: 'Pool economico (Muse Spark): ' + ECONOMY_NOTE + '.' })));

    const list = h('div', { class: 'agent-cards' });
    this.agents.forEach((a, i) => list.appendChild(this.agentCard(a, i)));
    this.bodyEl.appendChild(list);

    // The recommended Worker sits on deepseek-v4-flash: say it once, never block (§10.4).
    const zdr = this.agents.some((a) => {
      const m = this.model(a.model);
      return (m ? m.privacy === 'zdr_verify' : /^deepseek-/.test(a.model));
    });
    if (zdr) this.bodyEl.appendChild(h('div', { class: 'infoline-box', text: ZDR_VERIFY_NOTE }));

    this.bodyEl.appendChild(h('div', { class: 'row' },
      btn('+ Aggiungi template', () => {
        this.agents.push(this.blankAgent(this.agents.length));
        this.render();
      }, 'btn ghost', T.addTemplate),
      h('span', {
        class: 'hint', text: this.agents.length + ' template · ' + this.roleCounts(),
        title: 'Composizione attuale del pool. Ogni template worker può generare più istanze in parallelo durante una richiesta.',
      })));
  }

  private roleCounts(): string {
    return ROLE_ORDER.map((r) => {
      const n = this.agents.filter((a) => a.role === r).length;
      return n ? n + ' × ' + ROLE_LABEL[r] : null;
    }).filter(Boolean).join(' · ');
  }

  private agentCard(a: DraftAgent, i: number): HTMLElement {
    const name = h('input', { class: 'input', type: 'text', value: a.name, placeholder: 'Nome (es. Worker Flash)' });
    name.addEventListener('input', () => { a.name = name.value; });
    const desc = h('input', { class: 'input', type: 'text', value: a.description, placeholder: 'Ruolo in una riga' });
    const prompt = h('textarea', { class: 'input area', rows: 5, spellcheck: false, value: a.prompt, placeholder: 'descrizione: …' });
    const preview = h('div', {
      class: 'hint',
      title: 'Anteprima della riga che l’orchestratore leggerà nell’elenco Pool: viene presa dalla prima riga "descrizione:" del prompt.',
    });
    const sync = () => {
      a.description = desc.value;
      a.prompt = prompt.value;
      preview.textContent = 'Descrizione mostrata: ' + (deriveDescription(withDescription(a.prompt, a.description)) || '—');
    };
    desc.addEventListener('input', sync);
    prompt.addEventListener('input', sync);
    prompt.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ev.stopPropagation(); // Enter never submits inside a textarea
    });

    const role = h('select', { class: 'input', title: T.role + '\n' + ROLE_HELP[a.role] });
    for (const r of ROLE_ORDER) role.appendChild(h('option', { value: r, text: ROLE_LABEL[r], title: ROLE_HELP[r] }));
    role.value = a.role;
    role.addEventListener('change', () => {
      const next = role.value as AgentRole;
      if (next === 'orchestrator') {
        // Exactly one orchestrator: promoting this card demotes the previous one.
        this.agents.forEach((x, xi) => { if (xi !== i && x.role === 'orchestrator') x.role = 'worker'; });
        this.mainIndex = i;
      } else if (this.mainIndex === i) {
        const other = this.agents.findIndex((x, xi) => xi !== i && x.role === 'orchestrator');
        if (other < 0) {
          toast('info', 'Serve un orchestratore: promuovi prima un altro template.');
          role.value = 'orchestrator';
          return;
        }
        this.mainIndex = other;
      }
      a.role = next;
      this.render();
    });

    const model = h('select', { class: 'input', title: T.model });
    for (const m of this.models) {
      model.appendChild(h('option', {
        value: m.id, text: (m.unavailable ? '⚠ ' : '') + modelLabel(m),
        title: [modelLabel(m), m.notes, m.unavailable ? 'Non disponibile in questa sessione: il router lo salta.' : ''].filter(Boolean).join(' · '),
      }));
    }
    if (!this.models.some((m) => m.id === a.model)) model.appendChild(h('option', { value: a.model, text: a.model || 'modello predefinito' }));
    model.value = a.model;
    const badges = h('div', {
      class: 'badges',
      title: 'Avvisi sul modello scelto, dalla tabella modelli misurata: privacy dei dati, formato dell’API e affidabilità del JSON. Passa sopra un badge per il dettaglio.',
    });
    const renderBadges = () => {
      clear(badges);
      for (const b of modelBadges(this.model(a.model), a.role)) badges.appendChild(b);
    };
    model.addEventListener('change', () => {
      a.model = model.value;
      renderBadges();
      this.render();
    });
    renderBadges();

    const chips = h('div', { class: 'chips' });
    const addSel = h('select', { class: 'input', title: T.addFallback });
    addSel.appendChild(h('option', { value: '', text: '— aggiungi fallback' }));
    for (const m of this.models) addSel.appendChild(h('option', { value: m.id, text: m.id, title: modelLabel(m) }));
    const renderChips = () => {
      clear(chips);
      if (!a.fallbacks.length) {
        chips.appendChild(h('span', {
          class: 'empty', text: 'nessun fallback',
          title: 'Senza fallback un 429 o un modello non disponibile fa fallire il tentativo invece di cambiare modello.',
        }));
      }
      a.fallbacks.forEach((id, fi) => {
        chips.appendChild(h('span', {
          class: 'rchip',
          title: 'Fallback n. ' + (fi + 1) + ': provato quando i modelli prima di lui non rispondono.',
        },
        h('span', { text: id }),
        iconBtn('◂', T.moveUp, () => {
          if (fi === 0) return;
          [a.fallbacks[fi - 1], a.fallbacks[fi]] = [a.fallbacks[fi] as string, a.fallbacks[fi - 1] as string];
          renderChips();
        }),
        iconBtn('▸', T.moveDown, () => {
          if (fi >= a.fallbacks.length - 1) return;
          [a.fallbacks[fi], a.fallbacks[fi + 1]] = [a.fallbacks[fi + 1] as string, a.fallbacks[fi] as string];
          renderChips();
        }),
        iconBtn('✕', 'Toglie ' + id + ' dalla catena di fallback.', () => {
          a.fallbacks.splice(fi, 1);
          renderChips();
        }, 'danger')));
      });
    };
    addSel.addEventListener('change', () => {
      const id = addSel.value;
      addSel.value = '';
      if (!id || id === a.model || a.fallbacks.includes(id)) return;
      a.fallbacks.push(id);
      renderChips();
    });
    renderChips();

    const esc = h('select', { class: 'input', title: T.escalation });
    esc.appendChild(h('option', { value: '', text: '— nessuna escalation' }));
    for (const m of this.models) esc.appendChild(h('option', { value: m.id, text: m.id, title: modelLabel(m) }));
    if (a.escalation && !this.models.some((m) => m.id === a.escalation)) esc.appendChild(h('option', { value: a.escalation, text: a.escalation }));
    esc.value = a.escalation;
    esc.addEventListener('change', () => { a.escalation = esc.value; });

    const b = a.budget;
    const bTok = h('input', { class: 'input num', type: 'number', min: '500', max: '60000', value: b ? String(b.maxTokens) : '', placeholder: '8000', title: T.budgetTok });
    const bTool = h('input', { class: 'input num', type: 'number', min: '1', max: '40', value: b ? String(b.maxToolCalls) : '', placeholder: '10', title: T.budgetTool });
    const bSec = h('input', { class: 'input num', type: 'number', min: '10', max: '300', value: b ? String(b.maxSeconds) : '', placeholder: '60', title: T.budgetSec });
    const syncBudget = () => {
      const t = Number(bTok.value);
      const c = Number(bTool.value);
      const s = Number(bSec.value);
      const any = bTok.value.trim() || bTool.value.trim() || bSec.value.trim();
      a.budget = any
        ? { maxTokens: isFinite(t) && t ? t : 8000, maxToolCalls: isFinite(c) && c ? c : 10, maxSeconds: isFinite(s) && s ? s : 60 }
        : null;
    };
    for (const el of [bTok, bTool, bSec]) el.addEventListener('input', syncBudget);

    const color = h('input', { class: 'input color', type: 'color', value: a.color, title: T.color });
    color.addEventListener('input', () => {
      a.color = color.value;
      card.style.setProperty('--agent-color', a.color);
    });

    const card = h('div', { class: 'agent-card', style: { '--agent-color': a.color } },
      h('div', { class: 'ac-head', title: ROLE_HELP[a.role] },
        h('span', { class: 'dot' }),
        h('span', { class: 'ac-idx', text: ROLE_LABEL[a.role] }),
        a.role === 'orchestrator'
          ? h('span', { class: 'badge', text: 'principale', title: 'È l’agente che parla con te: riceve i tuoi messaggi e delega agli altri.' })
          : null,
        h('span', { class: 'spacer' }),
        iconBtn('⧉', T.duplicate, () => {
          const copy: DraftAgent = { ...a, name: a.name + ' 2', fallbacks: [...a.fallbacks], budget: a.budget ? { ...a.budget } : null };
          if (copy.role === 'orchestrator') copy.role = 'worker';
          copy.color = this.paletteFallback()[this.agents.length % this.paletteFallback().length] ?? a.color;
          this.agents.splice(i + 1, 0, copy);
          if (this.mainIndex > i) this.mainIndex += 1;
          this.render();
        }),
        a.role === 'orchestrator'
          ? iconBtn('🗑', T.removeMain, () => undefined, 'disabled')
          : iconBtn('🗑', T.remove, () => {
            this.agents.splice(i, 1);
            const main = this.agents.findIndex((x) => x.role === 'orchestrator');
            this.mainIndex = main >= 0 ? main : 0;
            this.render();
          }, 'danger')),
      h('div', { class: 'form-row' },
        field('Nome', T.name, null, name),
        field('Ruolo', T.role + '\n' + ROLE_HELP[a.role], { cls: 'field narrow' }, role)),
      field('Modello primario', T.model, null, model),
      badges,
      field('Fallback (in ordine)', T.fallbacks, null, chips, addSel),
      field('Escalation (T3 / critico)', T.escalation, null, esc),
      field('Descrizione', T.description, null, desc),
      field('Comportamento', T.prompt, null, prompt),
      a.role === 'orchestrator'
        ? null
        : h('div', { class: 'form-row' },
          field('Budget token', T.budgetTok, { cls: 'field narrow' }, bTok),
          field('Strumenti', T.budgetTool, { cls: 'field narrow' }, bTool),
          field('Secondi', T.budgetSec, { cls: 'field narrow' }, bSec)),
      h('div', { class: 'form-row' },
        field('Colore', T.color, { cls: 'field narrow' }, color),
        preview));
    sync();
    return card;
  }

  // ------------------------------------------------------------------ step 3

  private renderMain(): void {
    this.bodyEl.appendChild(h('p', { class: 'lead', text: 'L’orchestratore riceve i tuoi messaggi, decide il livello della richiesta (T0…T3) e delega ai worker. È l’unico che ti parla.' }));
    const radios = h('div', { class: 'radios' }, this.agents.map((a, i) =>
      h('label', {
        class: 'radio card-radio' + (i === this.mainIndex ? ' on' : ''),
        style: { '--agent-color': a.color },
        title: i === this.mainIndex
          ? 'È già l’orchestratore: riceve i tuoi messaggi e delega agli altri template.'
          : T.mainRadio,
      },
      h('input', {
        type: 'radio', name: 'wiz-main', checked: i === this.mainIndex,
        title: i === this.mainIndex ? 'Orchestratore attuale.' : T.mainRadio,
        on: {
          change: () => {
            this.agents.forEach((x, xi) => { if (xi !== i && x.role === 'orchestrator') x.role = 'worker'; });
            const target = this.agents[i];
            if (target) target.role = 'orchestrator';
            this.mainIndex = i;
            this.render();
          },
        },
      }),
      h('span', { class: 'dot' }),
      h('span', { class: 'rname', text: a.name || 'Template ' + (i + 1) }),
      h('span', { class: 'badge role', text: ROLE_LABEL[a.role], title: ROLE_HELP[a.role] }),
      h('span', { class: 'hint', text: deriveDescription(withDescription(a.prompt, a.description)) }))));
    this.bodyEl.appendChild(radios);

    const ta = h('textarea', { class: 'input area', rows: 6, spellcheck: false, value: this.interactionPrompt, placeholder: NOTES_PLACEHOLDER, title: T.notes });
    ta.addEventListener('input', () => { this.interactionPrompt = ta.value; });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ev.stopPropagation();
    });
    this.bodyEl.appendChild(field('Indicazioni per l’orchestratore (opzionale)', T.notes,
      { hint: 'Entrano solo nel prompt dell’orchestratore: i worker vedono esclusivamente il TaskContract. Modificabile in qualsiasi momento dalle impostazioni.' },
      ta));
  }

  // ------------------------------------------------------------------ step 4

  private renderReview(): void {
    this.bodyEl.appendChild(h('p', { class: 'lead', text: 'Controlla e avvia: le console dei template vengono create subito, quelle delle istanze compaiono durante il lavoro.' }));
    this.bodyEl.appendChild(h('div', { class: 'row', title: T.wsPath },
      h('span', { class: 'lbl', text: 'Cartella' }),
      h('code', { class: 'path', text: this.workspacePath ?? '—' })));
    const table = h('table', { class: 'review' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Template' }),
        h('th', { text: 'Ruolo', title: 'Ruolo del template: decide gli strumenti che riceve e quando viene chiamato.' }),
        h('th', { text: 'Routing', title: 'Catena dei modelli: primario → fallback in ordine ↑ escalation.' }),
        h('th', { text: '' }))),
      h('tbody', {}, this.agents.map((a, i) =>
        h('tr', { style: { '--agent-color': a.color } },
          h('td', {}, h('span', { class: 'dot' }), a.name || 'Template ' + (i + 1)),
          h('td', {}, h('span', { class: 'badge role', text: ROLE_LABEL[a.role], title: ROLE_HELP[a.role] })),
          h('td', {}, h('span', {
            class: 'routing', text: routingSummary(a),
            title: 'Primario ' + (a.model || '—')
              + (a.fallbacks.length ? ' → fallback: ' + a.fallbacks.join(', ') : ' → nessun fallback')
              + (a.escalation ? ' ↑ escalation: ' + a.escalation + ' (solo T3 / critico)' : ''),
          })),
          h('td', {}, i === this.mainIndex
            ? h('span', { class: 'badge', text: 'principale', title: 'Sarà l’orchestratore: l’unico che parla con te.' })
            : null)))));
    this.bodyEl.appendChild(table);

    const missing: string[] = [];
    if (!this.agents.some((a) => a.role === 'worker')) missing.push('senza worker l’orchestratore risponde da solo');
    if (!this.agents.some((a) => a.role === 'planner')) missing.push('senza planner scompone da solo gli obiettivi ampi');
    if (!this.agents.some((a) => a.role === 'verifier')) missing.push('senza verificatore rilegge da solo i risultati');
    if (missing.length) this.bodyEl.appendChild(h('div', { class: 'infoline-box', text: missing.join(' · ') + '.' }));

    this.bodyEl.appendChild(h('div', { class: 'field', title: T.notes },
      h('span', { class: 'lbl', text: 'Indicazioni per l’orchestratore' }),
      h('pre', { class: 'pre', text: this.interactionPrompt.trim() || '(non impostate — puoi aggiungerle dopo)' })));
  }

  private async finish(): Promise<void> {
    this.busy = true;
    this.nextBtn.disabled = true;
    this.nextBtn.textContent = 'Avvio…';
    const payload: SetupPayload = {
      workspacePath: this.workspacePath ?? '',
      agents: this.agents.map((a) => ({
        name: a.name.trim(),
        model: a.model,
        prompt: withDescription(a.prompt, a.description),
        color: a.color,
        role: a.role,
        fallbacks: a.fallbacks.filter((m) => m && m !== a.model),
        escalation: a.escalation || null,
        temperature: a.temperature,
        budget: a.role === 'orchestrator' ? null : a.budget,
        maxConcurrent: a.role === 'orchestrator' ? null : a.maxConcurrent,
      })),
      mainIndex: this.mainIndex,
      interactionPrompt: this.interactionPrompt.trim(),
    };
    try {
      const snap = await window.api.invoke('config:completeSetup', payload);
      this.hooks.onComplete(snap);
    } catch (e) {
      this.errEl.textContent = 'Avvio non riuscito: ' + errText(e);
      this.errEl.hidden = false;
    } finally {
      this.busy = false;
      this.nextBtn.disabled = false;
      this.nextBtn.textContent = 'Avvia';
    }
  }
}
