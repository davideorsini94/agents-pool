// SetupWizard: workspace → agents → main agent + interaction protocol → review.
// Ends with `config:completeSetup`, which starts the runtimes and returns the first snapshot.

import type { AppInfo, ConfigSnapshot, ModelInfo, SetupPayload } from '../shared/types';
import { btn, clear, deriveDescription, h, iconBtn, modelLabel, replace, withDescription } from './dom.js';
import { errText, toast } from './modals.js';

const PROTOCOL_PLACEHOLDER =
  'Il Coordinatore analizza la richiesta, delega la ricerca al Ricercatore e la scrittura del codice '
  + 'allo Sviluppatore, poi verifica il risultato e riassume all’utente in italiano.\n'
  + 'Ogni agente lavora solo nella cartella di lavoro, chiede autorizzazione per i comandi e riporta '
  + 'sempre un esito chiaro (fatto / non fatto / cosa manca).';

const PROMPT_PLACEHOLDER =
  'descrizione: cerca nel codice e riassume\n\n'
  + 'Sei il Ricercatore del team. Usa gli strumenti di lettura e ricerca per raccogliere fatti, '
  + 'non modificare file e rispondi con un elenco puntato di risultati verificati.';

const STEP_TITLES = ['Cartella di lavoro', 'Agenti', 'Principale e protocollo', 'Riepilogo'];

interface DraftAgent {
  name: string;
  description: string;
  model: string;
  prompt: string;
  color: string;
}

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
  private workspacePath: string | null = null;
  private agents: DraftAgent[] = [];
  private mainIndex = 0;
  private interactionPrompt = '';
  private busy = false;

  constructor(info: AppInfo, hooks: WizardHooks) {
    this.info = info;
    this.hooks = hooks;
    this.agents = [this.blankAgent(0, 'Coordinatore')];

    this.dotsEl = h('div', { class: 'dots' });
    this.bodyEl = h('div', { class: 'wiz-body' });
    this.errEl = h('div', { class: 'err', hidden: true });
    this.backBtn = btn('Indietro', () => this.go(-1), 'btn ghost');
    this.nextBtn = btn('Avanti', () => this.go(1), 'btn primary');

    this.root = h('div', { class: 'screen center' },
      h('div', { class: 'card wiz-card' },
        h('div', { class: 'wiz-head' },
          h('div', { class: 'brand sm' }, 'Agents ', h('span', { class: 'accent', text: 'Windows' })),
          this.dotsEl),
        this.bodyEl,
        this.errEl,
        h('div', { class: 'wiz-foot' }, this.backBtn, h('span', { class: 'spacer' }), this.nextBtn)));

    void this.loadModels();
    this.render();
  }

  private blankAgent(i: number, name = ''): DraftAgent {
    const palette = this.paletteFallback();
    return {
      name,
      description: '',
      model: this.info.defaultModel,
      prompt: '',
      color: palette[i % palette.length] ?? '#3B82F6',
    };
  }

  private paletteFallback(): string[] {
    return this.info.palette?.length
      ? this.info.palette
      : ['#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#84CC16', '#06B6D4'];
  }

  private async loadModels(): Promise<void> {
    try {
      this.models = await window.api.invoke('models:list');
      if (this.step === 1) this.render();
    } catch (e) {
      toast('warn', 'Elenco modelli non disponibile: ' + errText(e));
    }
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
      if (!this.agents.length) return 'Serve almeno un agente.';
      const names = this.agents.map((a) => a.name.trim().toLowerCase());
      if (names.some((n) => !n)) return 'Ogni agente deve avere un nome.';
      if (new Set(names).size !== names.length) return 'I nomi degli agenti devono essere diversi tra loro.';
      if (this.agents.some((a) => !a.model)) return 'Scegli un modello per ogni agente.';
    }
    return null;
  }

  private render(): void {
    replace(this.dotsEl, STEP_TITLES.map((t, i) =>
      h('span', {
        class: 'dot-step' + (i === this.step ? ' on' : '') + (i < this.step ? ' done' : ''),
        title: t,
        on: { click: () => { if (i < this.step) { this.step = i; this.render(); } } },
      }, String(i + 1))));

    clear(this.bodyEl);
    this.bodyEl.appendChild(h('h2', { class: 'wiz-title', text: (this.step + 1) + '. ' + STEP_TITLES[this.step] }));
    if (this.step === 0) this.renderWorkspace();
    else if (this.step === 1) this.renderAgents();
    else if (this.step === 2) this.renderMain();
    else this.renderReview();

    this.backBtn.hidden = this.step === 0;
    this.nextBtn.textContent = this.step === STEP_TITLES.length - 1 ? 'Avvia' : 'Avanti';
  }

  // ------------------------------------------------------------------ step 1

  private renderWorkspace(): void {
    const pathEl = h('input', {
      class: 'input', type: 'text', readOnly: true,
      value: this.workspacePath ?? '',
      placeholder: 'Nessuna cartella scelta',
    });
    this.bodyEl.appendChild(h('p', { class: 'lead', text: 'Gli agenti potranno leggere e scrivere liberamente solo qui dentro. Fuori serve la tua autorizzazione.' }));
    this.bodyEl.appendChild(h('div', { class: 'row' }, pathEl, btn('Scegli cartella…', () => void this.choose(), 'btn ghost')));
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
    this.bodyEl.appendChild(h('p', { class: 'lead', text: 'Definisci la squadra: da 1 a 10 agenti. Il prompt descrive comportamento e ruolo (la prima riga "descrizione:" diventa il sottotitolo della console).' }));
    const list = h('div', { class: 'agent-cards' });
    this.agents.forEach((a, i) => list.appendChild(this.agentCard(a, i)));
    this.bodyEl.appendChild(list);
    this.bodyEl.appendChild(h('div', { class: 'row' },
      btn('+ Aggiungi agente', () => {
        if (this.agents.length >= 10) {
          toast('info', 'Massimo 10 agenti.');
          return;
        }
        this.agents.push(this.blankAgent(this.agents.length));
        this.render();
      }, 'btn ghost'),
      h('span', { class: 'hint', text: this.agents.length + ' / 10' })));
  }

  private agentCard(a: DraftAgent, i: number): HTMLElement {
    const name = h('input', { class: 'input', type: 'text', value: a.name, placeholder: 'Nome (es. Ricercatore)' });
    name.addEventListener('input', () => {
      a.name = name.value;
    });
    const desc = h('input', { class: 'input', type: 'text', value: a.description, placeholder: 'Ruolo in una riga' });
    const prompt = h('textarea', { class: 'input area', rows: 5, spellcheck: false, value: a.prompt, placeholder: PROMPT_PLACEHOLDER });
    const preview = h('div', { class: 'hint' });
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

    const model = h('select', { class: 'input' });
    for (const m of this.models) model.appendChild(h('option', { value: m.id, text: modelLabel(m) }));
    if (!this.models.some((m) => m.id === a.model)) model.appendChild(h('option', { value: a.model, text: a.model || 'modello predefinito' }));
    model.value = a.model;
    model.addEventListener('change', () => {
      a.model = model.value;
    });

    const color = h('input', { class: 'input color', type: 'color', value: a.color });
    color.addEventListener('input', () => {
      a.color = color.value;
      card.style.setProperty('--agent-color', a.color);
    });

    const card = h('div', { class: 'agent-card', style: { '--agent-color': a.color } },
      h('div', { class: 'ac-head' },
        h('span', { class: 'dot' }),
        h('span', { class: 'ac-idx', text: 'Agente ' + (i + 1) }),
        h('span', { class: 'spacer' }),
        this.agents.length > 1
          ? iconBtn('🗑', 'Rimuovi questo agente', () => {
            this.agents.splice(i, 1);
            if (this.mainIndex >= this.agents.length) this.mainIndex = 0;
            this.render();
          }, 'danger')
          : null),
      h('div', { class: 'form-row' },
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Nome' }), name),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Modello' }), model)),
      h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Descrizione' }), desc),
      h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Comportamento' }), prompt),
      h('div', { class: 'form-row' },
        h('label', { class: 'field narrow' }, h('span', { class: 'lbl', text: 'Colore' }), color),
        preview));
    sync();
    return card;
  }

  // ------------------------------------------------------------------ step 3

  private renderMain(): void {
    this.bodyEl.appendChild(h('p', { class: 'lead', text: 'L’agente principale riceve i tuoi messaggi e coordina gli altri delegando i compiti.' }));
    const radios = h('div', { class: 'radios' }, this.agents.map((a, i) =>
      h('label', { class: 'radio card-radio' + (i === this.mainIndex ? ' on' : ''), style: { '--agent-color': a.color } },
        h('input', {
          type: 'radio', name: 'wiz-main', checked: i === this.mainIndex,
          on: { change: () => { this.mainIndex = i; this.render(); } },
        }),
        h('span', { class: 'dot' }),
        h('span', { class: 'rname', text: a.name || 'Agente ' + (i + 1) }),
        h('span', { class: 'hint', text: deriveDescription(withDescription(a.prompt, a.description)) }))));
    this.bodyEl.appendChild(radios);

    const ta = h('textarea', { class: 'input area', rows: 7, spellcheck: false, value: this.interactionPrompt, placeholder: PROTOCOL_PLACEHOLDER });
    ta.addEventListener('input', () => {
      this.interactionPrompt = ta.value;
    });
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') ev.stopPropagation();
    });
    this.bodyEl.appendChild(h('label', { class: 'field' },
      h('span', { class: 'lbl', text: 'Come devono interagire gli agenti' }),
      ta,
      h('span', { class: 'hint', text: 'Questo testo entra nel prompt di sistema di ogni agente e puoi cambiarlo in qualsiasi momento dalle impostazioni.' })));
  }

  // ------------------------------------------------------------------ step 4

  private renderReview(): void {
    this.bodyEl.appendChild(h('p', { class: 'lead', text: 'Controlla e avvia: le console vengono create subito.' }));
    this.bodyEl.appendChild(h('div', { class: 'row' },
      h('span', { class: 'lbl', text: 'Cartella' }),
      h('code', { class: 'path', text: this.workspacePath ?? '—' })));
    const table = h('table', { class: 'review' },
      h('thead', {}, h('tr', {},
        h('th', { text: 'Agente' }), h('th', { text: 'Ruolo' }), h('th', { text: 'Modello' }), h('th', { text: '' }))),
      h('tbody', {}, this.agents.map((a, i) =>
        h('tr', { style: { '--agent-color': a.color } },
          h('td', {}, h('span', { class: 'dot' }), a.name || 'Agente ' + (i + 1)),
          h('td', { text: deriveDescription(withDescription(a.prompt, a.description)) || '—' }),
          h('td', {}, h('code', { text: a.model })),
          h('td', {}, i === this.mainIndex ? h('span', { class: 'badge', text: 'principale' }) : null)))));
    this.bodyEl.appendChild(table);
    this.bodyEl.appendChild(h('div', { class: 'field' },
      h('span', { class: 'lbl', text: 'Protocollo di interazione' }),
      h('pre', { class: 'pre', text: this.interactionPrompt.trim() || '(non impostato — puoi aggiungerlo dopo)' })));
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
