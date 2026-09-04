// Settings drawer (right side, 420 px): agents CRUD, main agent, interaction protocol,
// workspace, permission mode, allowlist, API key, per-agent limits, total reset.
// Every mutation returns a ConfigSnapshot; the panel re-renders from it and the rest of the
// UI reacts to `config:changed` (hot reload) without losing console content.

import type {
  AgentId,
  AgentInput,
  AgentView,
  ConfigPatch,
  ConfigSnapshot,
  ModelInfo,
  PermissionMode,
} from '../shared/types';
import {
  btn,
  clear,
  deriveDescription,
  h,
  iconBtn,
  modelLabel,
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
};

export interface SettingsHooks {
  onKeyCleared(): void;
  onReset(): void;
}

interface FormState {
  id: AgentId | null; // null = new agent
  name: string;
  description: string;
  model: string;
  prompt: string;
  color: string;
  maxIterations: number;
}

export class SettingsPanel {
  readonly root: HTMLElement;

  private readonly body: HTMLElement;
  private readonly hooks: SettingsHooks;
  private snapshot: ConfigSnapshot | null = null;
  private models: ModelInfo[] = [];
  private modelsLoaded = false;
  private form: FormState | null = null;
  private opened = false;

  constructor(hooks: SettingsHooks) {
    this.hooks = hooks;
    this.body = h('div', { class: 'drawer-body' });
    this.root = h('aside', { class: 'drawer', hidden: true },
      h('div', { class: 'drawer-head' },
        h('span', { class: 'drawer-title', text: 'Impostazioni' }),
        iconBtn('✕', 'Chiudi le impostazioni', () => this.close())),
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

  // ------------------------------------------------------------------ render

  private render(): void {
    const s = this.snapshot;
    if (!s) return;
    clear(this.body);
    this.body.appendChild(this.sectionAgents(s));
    this.body.appendChild(this.sectionProtocol(s));
    this.body.appendChild(this.sectionWorkspace(s));
    this.body.appendChild(this.sectionPermissions(s));
    this.body.appendChild(this.sectionKey(s));
    this.body.appendChild(this.sectionData(s));
  }

  private section(title: string, ...children: Array<Node | null>): HTMLElement {
    return h('section', { class: 'sect' },
      h('h3', { class: 'sect-title', text: title }),
      ...children.filter((c): c is Node => c !== null));
  }

  private field(label: string, control: Node, hint?: string): HTMLElement {
    return h('label', { class: 'field' },
      h('span', { class: 'lbl', text: label }),
      control,
      hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  // ----------------------------------------------------------------- agents

  private sectionAgents(s: ConfigSnapshot): HTMLElement {
    const rows = s.agents.map((a) => this.agentRow(a, s));
    return this.section('Agenti',
      h('div', { class: 'agent-rows' }, rows),
      this.form ? this.agentForm(this.form) : btn('+ Aggiungi agente', () => this.startNew(s), 'btn ghost wide'),
    );
  }

  private agentRow(a: AgentView, s: ConfigSnapshot): HTMLElement {
    const isMain = a.id === s.mainAgentId;
    const last = s.agents.length <= 1;
    return h('div', { class: 'agent-row' + (isMain ? ' main' : ''), style: { '--agent-color': a.color } },
      h('span', { class: 'dot' }),
      h('div', { class: 'ar-main' },
        h('div', { class: 'ar-name' }, a.name, isMain ? h('span', { class: 'badge', text: 'principale' }) : null),
        h('div', { class: 'ar-desc', text: a.description || '—' }),
        h('div', { class: 'ar-model', text: a.model })),
      h('label', { class: 'radio', title: 'Imposta come agente principale' },
        h('input', { type: 'radio', name: 'main-agent', checked: isMain, on: { change: () => void this.setMain(a.id) } }),
        h('span', { text: 'principale' })),
      h('div', { class: 'ar-actions' },
        iconBtn('✎', 'Modifica ' + a.name, () => this.startEdit(a)),
        iconBtn('🗑', isMain ? 'L’agente principale non può essere rimosso' : last ? 'Deve restare almeno un agente' : 'Rimuovi ' + a.name,
          () => void this.removeAgent(a), isMain || last ? 'disabled' : 'danger')),
    );
  }

  private startNew(s: ConfigSnapshot): void {
    const used = new Set(s.agents.map((a) => a.color.toLowerCase()));
    const palette = ['#3B82F6', '#F59E0B', '#10B981', '#EF4444', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316', '#84CC16', '#06B6D4'];
    const color = palette.find((c) => !used.has(c.toLowerCase())) ?? palette[s.agents.length % palette.length] ?? '#3B82F6';
    this.form = {
      id: null,
      name: '',
      description: '',
      model: s.agents[0]?.model ?? this.models[0]?.id ?? '',
      prompt: '',
      color,
      maxIterations: 40,
    };
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
    };
    this.render();
  }

  private agentForm(f: FormState): HTMLElement {
    const name = h('input', { class: 'input', type: 'text', value: f.name, placeholder: 'Nome (es. Ricercatore)' });
    const desc = h('input', { class: 'input', type: 'text', value: f.description, placeholder: 'Ruolo in una riga' });
    const model = this.modelSelect(f.model);
    const prompt = h('textarea', { class: 'input area', rows: 6, spellcheck: false, value: f.prompt,
      placeholder: 'descrizione: ricerca nel codice e riassume\n\nSei un ricercatore. Usa gli strumenti per…' });
    const color = h('input', { class: 'input color', type: 'color', value: f.color });
    const iters = h('input', { class: 'input num', type: 'number', min: '1', max: '200', value: String(f.maxIterations) });
    const preview = h('div', { class: 'hint', text: 'Descrizione mostrata: ' + (deriveDescription(withDescription(f.prompt, f.description)) || '—') });
    const sync = () => {
      preview.textContent = 'Descrizione mostrata: '
        + (deriveDescription(withDescription(prompt.value, desc.value)) || '—');
    };
    desc.addEventListener('input', sync);
    prompt.addEventListener('input', sync);

    return h('div', { class: 'agent-form', style: { '--agent-color': f.color } },
      h('div', { class: 'form-title', text: f.id ? 'Modifica agente' : 'Nuovo agente' }),
      this.field('Nome', name),
      this.field('Descrizione', desc, 'Scritta come prima riga "descrizione:" del prompt.'),
      this.field('Modello', model),
      this.field('Prompt di comportamento', prompt),
      preview,
      h('div', { class: 'form-row' },
        this.field('Colore', color),
        this.field('Iterazioni max', iters)),
      h('div', { class: 'form-actions' },
        btn('Annulla', () => {
          this.form = null;
          this.render();
        }, 'btn ghost'),
        btn(f.id ? 'Salva' : 'Aggiungi', () => {
          const input: AgentInput = {
            name: name.value.trim(),
            model: model.value,
            prompt: withDescription(prompt.value, desc.value),
            color: color.value,
            maxIterations: Math.max(1, Math.min(200, Number(iters.value) || 40)),
          };
          if (!input.name) {
            toast('warn', 'Il nome è obbligatorio.');
            return;
          }
          if (!input.model) {
            toast('warn', 'Scegli un modello.');
            return;
          }
          void this.saveAgent(f.id, input);
        }, 'btn primary')),
    );
  }

  private modelSelect(value: string): HTMLSelectElement {
    const sel = h('select', { class: 'input' });
    const ids = new Set<string>();
    for (const m of this.models) {
      ids.add(m.id);
      sel.appendChild(h('option', { value: m.id, text: modelLabel(m) }));
    }
    if (value && !ids.has(value)) sel.appendChild(h('option', { value, text: value }));
    if (!this.models.length && !value) sel.appendChild(h('option', { value: '', text: 'Modelli non disponibili' }));
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
      toast('info', id ? 'Agente aggiornato.' : 'Agente aggiunto.');
    } catch (e) {
      toast('error', errText(e));
    }
  }

  private async removeAgent(a: AgentView): Promise<void> {
    const ok = await modals.confirm({
      title: 'Rimuovere ' + a.name + '?',
      body: 'Le attività in corso di questo agente (e quelle delegate) vengono annullate e la sua cronologia viene eliminata.',
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

  // --------------------------------------------------------------- protocol

  private sectionProtocol(s: ConfigSnapshot): HTMLElement {
    const ta = h('textarea', { class: 'input area', rows: 6, spellcheck: false, value: s.interactionPrompt,
      placeholder: 'Come devono collaborare gli agenti…' });
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
    return this.section('Protocollo di interazione',
      ta,
      h('div', { class: 'hint', text: 'Applicato dalla prossima chiamata al modello, senza interrompere il lavoro in corso.' }));
  }

  // -------------------------------------------------------------- workspace

  private sectionWorkspace(s: ConfigSnapshot): HTMLElement {
    return this.section('Cartella di lavoro',
      h('div', { class: 'row' },
        h('code', { class: 'path', text: s.workspacePath ?? 'non impostata' }),
        btn('Cambia…', () => void this.chooseWorkspace(), 'btn ghost')));
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
      h('label', { class: 'mode' + (s.permissionMode === m ? ' on' : '') },
        h('input', {
          type: 'radio', name: 'perm-mode', checked: s.permissionMode === m,
          on: { change: () => void this.update({ permissionMode: m }) },
        }),
        h('div', {},
          h('div', { class: 'mode-title', text: MODE_LABEL[m].title }),
          h('div', { class: 'hint', text: MODE_LABEL[m].help }))));

    const list = h('textarea', {
      class: 'input area mono', rows: 4, spellcheck: false,
      value: s.commandAllowlist.join('\n'),
      placeholder: 'npm test\ngit status',
    });
    const saveList = () => {
      const next = list.value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (next.join('\n') === (this.snapshot?.commandAllowlist ?? []).join('\n')) return;
      void this.update({ commandAllowlist: next });
    };
    list.addEventListener('blur', saveList);

    const timeout = h('input', { class: 'input num', type: 'number', min: '1', max: '60', value: String(Math.round(s.permissionTimeoutMs / 60000)) });
    timeout.addEventListener('change', () => {
      const m = Math.max(1, Math.min(60, Number(timeout.value) || 5));
      void this.update({ permissionTimeoutMs: m * 60000 });
    });
    const depth = h('input', { class: 'input num', type: 'number', min: '1', max: '6', value: String(s.maxDelegationDepth) });
    depth.addEventListener('change', () => {
      void this.update({ maxDelegationDepth: Math.max(1, Math.min(6, Number(depth.value) || 3)) });
    });

    return this.section('Autorizzazioni',
      h('div', { class: 'modes' }, modes),
      this.field('Comandi sempre consentiti', list, 'Uno schema per riga; vale solo per i comandi innocui.'),
      h('div', { class: 'row' },
        btn('Svuota elenco', () => void this.clearAllowlist(), 'btn ghost'),
        h('span', { class: 'hint', text: 'Le autorizzazioni "per la sessione" si azzerano alla chiusura dell’app.' })),
      h('div', { class: 'form-row' },
        this.field('Timeout richieste (minuti)', timeout),
        this.field('Profondità delega', depth)));
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
    const input = h('input', { class: 'input', type: 'password', placeholder: 'sk-…', spellcheck: false });
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
    inputWrap.appendChild(btn('Salva', () => void doSave(), 'btn primary'));

    return this.section('API key',
      h('div', { class: 'row' },
        h('code', { class: 'path', text: s.hasApiKey ? (s.apiKeyMasked ?? 'impostata') : 'non impostata' }),
        btn('Cambia chiave…', () => {
          inputWrap.hidden = !inputWrap.hidden;
          if (!inputWrap.hidden) input.focus();
        }, 'btn ghost'),
        btn('Rimuovi', () => void this.clearKey(), 'btn ghost danger')),
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
    const hist = s.agents.map((a) =>
      btn('Cancella cronologia di ' + a.name, () => void this.clearHistory(a), 'btn ghost wide'));
    return this.section('Dati',
      h('div', { class: 'col' }, hist),
      btn('Reset totale', () => void this.resetAll(), 'btn danger wide'),
      h('div', { class: 'hint', text: 'Il reset cancella agenti, cronologie e impostazioni (la API key resta) e riapre la procedura guidata.' }));
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
      body: 'Vengono eliminati agenti, cronologie e impostazioni. La API key viene conservata.',
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
