// Workbench: header, console grid, dock, user input box, focus/maximize/keyboard,
// live handling of config:changed (hot reload) without losing console content.

import type {
  AgentId,
  AgentStatusUpdate,
  AgentView,
  AppInfo,
  ConfigChanged,
  ConfigSnapshot,
  ConsoleEvent,
  ConsolePatch,
  RunFinished,
  RuntimeSnapshot,
  Tier,
  Usage,
} from '../shared/types';
import { btn, fmtClock, fmtCost, fmtTokens, h, iconBtn, replace } from './dom.js';
import { ConsoleView, type ConsoleHost } from './console.js';
import { errText, modals, toast } from './modals.js';
import { SettingsPanel } from './settings.js';

const HISTORY_LIMIT = 400;
/** Fallback when the snapshot has no pool limits yet (v1 config / mid-migration). */
const DEFAULT_MAX_PARALLEL = 4;

/** Header/input tooltips: what the control does and what it costs (never the label again). */
const T = {
  totals: 'Costo e token di tutta la sessione, sommando orchestratore, planner, worker e verificatori (istanze chiuse comprese). '
    + 'Il prefisso ~ indica una stima, perché il prezzo di quel modello non è noto.',
  cancelAll: 'Ferma subito l’orchestratore e tutte le istanze in corso: i worker già partiti consegnano un risultato parziale e la richiesta si chiude.',
  settings: 'Apre il pannello impostazioni: template di ruolo, limiti del pool, autorizzazioni, cartella di lavoro, API key e reset.',
  chatIdle: 'Il messaggio va all’orchestratore, che decide se rispondere da solo (T0) o delegare ai worker. Invio invia, Maiusc+Invio va a capo.',
  chatBusy: 'Il team sta lavorando: attendi la risposta oppure premi Annulla per fermarlo.',
  send: 'Invia il messaggio all’orchestratore e avvia una nuova richiesta.',
  abort: 'Ferma questa richiesta e tutte le istanze che ha creato: quello che è già stato prodotto resta nelle console.',
  queue: 'Messaggi in attesa: partiranno uno alla volta appena l’orchestratore è libero.',
  bypass: 'Modalità bypass attiva: nessuna richiesta di autorizzazione. Gli agenti eseguono subito scritture, eliminazioni e comandi, anche fuori dalla cartella di lavoro e sui percorsi di sistema. Ogni azione concessa resta scritta nelle console. Clicca per cambiare modalità.',
};

export interface WorkbenchHooks {
  onKeyCleared(): void;
  onReset(): void;
}

export class Workbench {
  readonly root: HTMLElement;

  private readonly views = new Map<AgentId, ConsoleView>();
  /** Live worker instances (ephemeral consoles), in arrival order (§6.3 `console:add`). */
  private readonly instances = new Map<AgentId, AgentView>();
  private readonly grid: HTMLElement;
  private readonly dock: HTMLElement;
  private readonly pathBtn: HTMLButtonElement;
  private readonly statusPill: HTMLElement;
  private readonly totalsEl: HTMLElement;
  private readonly bypassBadge: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly settings: SettingsPanel;

  private readonly inputBox: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly abortBtn: HTMLButtonElement;
  private readonly queueNote: HTMLElement;

  private snapshot: ConfigSnapshot;
  private readonly hooks: WorkbenchHooks;

  private focusedId: AgentId | null = null;
  private maximizedId: AgentId | null = null;
  private readonly collapsed = new Set<AgentId>();
  /** Instances docked by the flood guard (released when `maxParallelWorkers` grows). */
  private readonly autoCollapsed = new Set<AgentId>();
  /** Instances the user restored by hand: the flood guard leaves them alone. */
  private readonly userShown = new Set<AgentId>();
  private readonly usage = new Map<AgentId, Usage>();
  private activeUserRun: { runId: string; agentId: AgentId; startedAt: number } | null = null;
  private queuedUserMessages = 0;
  private tickTimer: number | null = null;
  private readonly keyHandler: (ev: KeyboardEvent) => void;

  constructor(info: AppInfo, snapshot: ConfigSnapshot, hooks: WorkbenchHooks) {
    this.snapshot = snapshot;
    this.hooks = hooks;

    this.pathBtn = h('button', {
      class: 'ws-path',
      type: 'button',
      title: this.wsTitle(snapshot.workspacePath),
      aria: { label: 'Apri la cartella di lavoro' },
      on: { click: () => this.openWorkspace() },
    }, snapshot.workspacePath ?? 'nessuna cartella');

    this.statusPill = h('span', { class: 'status-pill', data: { state: 'idle' }, text: 'Pronto' });
    this.totalsEl = h('span', { class: 'totals', title: T.totals, text: fmtCost(0) });
    // Bypass removes every confirmation, so the state must be visible at all times, not buried in
    // Settings: the badge sits in the header and opens the panel where it can be turned off.
    this.bypassBadge = h('button', {
      class: 'badge bypass-badge', type: 'button', hidden: snapshot.permissionMode !== 'bypass',
      title: T.bypass, aria: { label: T.bypass },
      on: { click: () => this.settings.open() },
    }, '⚠ BYPASS PERMESSI');
    this.cancelBtn = h('button', {
      class: 'btn danger', type: 'button', hidden: true, title: T.cancelAll,
      on: { click: () => void this.cancelAll() },
    }, 'Annulla tutto');

    this.settings = new SettingsPanel(info, {
      onKeyCleared: () => this.hooks.onKeyCleared(),
      onReset: () => this.hooks.onReset(),
    });

    const head = h('header', { class: 'app-head' },
      h('span', {
        class: 'app-name',
        title: 'Agents Pool v' + info.version + ' · ' + info.platform + '/' + info.arch
          + '\nConfigurazione, cronologie e log stanno in: ' + info.userDataPath,
      }, 'Agents ', h('span', { class: 'accent', text: 'Pool' })),
      this.pathBtn,
      this.statusPill,
      this.bypassBadge,
      this.totalsEl,
      h('span', { class: 'spacer' }),
      iconBtn(snapshot.showReasoning ? '👁' : '🚫', this.reasoningTitle(snapshot.showReasoning),
        () => void this.toggleReasoning(), 'reason-toggle'),
      this.cancelBtn,
      btn('Impostazioni', () => this.settings.toggle(), 'btn ghost', T.settings),
    );

    this.grid = h('div', { class: 'grid', id: 'grid' });
    this.dock = h('div', { class: 'dock', hidden: true });

    this.textarea = h('textarea', {
      class: 'input chat',
      rows: 2,
      placeholder: 'Scrivi un compito per il team… (Invio per inviare, Maiusc+Invio per andare a capo)',
      spellcheck: false,
      title: T.chatIdle,
    });
    this.sendBtn = btn('Invia', () => void this.send(), 'btn primary send', T.send);
    this.abortBtn = h('button', {
      class: 'btn danger', type: 'button', hidden: true, title: T.abort,
      on: { click: () => void this.cancelAll() },
    }, 'Annulla');
    this.queueNote = h('span', { class: 'queue-note', hidden: true, title: T.queue });
    this.inputBox = h('div', { class: 'input-box' },
      this.textarea,
      h('div', { class: 'input-side' }, this.sendBtn, this.abortBtn, this.queueNote));

    this.textarea.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.send();
      }
    });

    this.root = h('div', { class: 'workbench' }, head, this.grid, this.dock, this.settings.root);

    this.keyHandler = (ev) => this.onKey(ev);
    document.addEventListener('keydown', this.keyHandler);
  }

  private wsTitle(path: string | null | undefined): string {
    return path
      ? 'Apre ' + path + ' nel gestore file. È l’unica cartella in cui gli agenti leggono e scrivono senza chiedere: '
        + 'i percorsi relativi partono da qui. Si cambia dalle impostazioni.'
      : 'Nessuna cartella di lavoro impostata: gli agenti non possono lavorare sui file. Impostala dalle impostazioni.';
  }

  private reasoningTitle(on: boolean): string {
    return on
      ? 'Il ragionamento intermedio dei modelli è visibile in tutte le console: clicca per nasconderlo (il modello continua a produrlo, cambia solo cosa vedi).'
      : 'Il ragionamento intermedio è nascosto in tutte le console: clicca per mostrarlo. Non cambia costi né risultati.';
  }

  // -------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    this.rebuildConsoles();
    this.settings.setSnapshot(this.snapshot);
    try {
      const snap = await window.api.invoke('runtime:getSnapshot');
      this.applyRuntime(snap);
    } catch (e) {
      toast('warn', 'Stato runtime non disponibile: ' + errText(e));
    }
    await this.loadHistories();
    this.startTicker();
  }

  destroy(): void {
    document.removeEventListener('keydown', this.keyHandler);
    if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    this.root.remove();
  }

  private async loadHistories(): Promise<void> {
    await Promise.all([...this.views.entries()].map(async ([id, view]) => {
      try {
        const events = await window.api.invoke('console:getEvents', id, { limit: HISTORY_LIMIT });
        view.loadHistory(events);
      } catch (e) {
        toast('warn', 'Cronologia non caricata per ' + view.agent.name + ': ' + errText(e));
      }
    }));
  }

  private applyRuntime(snap: RuntimeSnapshot): void {
    // Instances first: a reload must recreate their consoles before statuses/histories land.
    if (snap.instances) {
      const live = new Set(snap.instances.map((v) => v.id));
      for (const id of [...this.instances.keys()]) if (!live.has(id)) this.instances.delete(id);
      for (const v of snap.instances) this.instances.set(v.id, v);
      this.rebuildConsoles();
    }
    for (const [id, st] of Object.entries(snap.agents)) {
      const view = this.views.get(id);
      this.usage.set(id, st.usage);
      view?.applyStatus({
        agentId: id, status: st.status, runId: st.runId, queueLength: st.queueLength, usage: st.usage,
      });
    }
    this.setTier(snap.currentTier ?? null);
    this.activeUserRun = snap.activeUserRun;
    this.queuedUserMessages = snap.queuedUserMessages;
    for (const p of snap.pendingPermissions) modals.permission(p);
    for (const a of snap.pendingAsks) modals.ask(a);
    this.refreshStatus();
  }

  private setTier(tier: Tier | null, extra?: { instances?: number; agentsUsed?: string[] }): void {
    const main = this.snapshot.mainAgentId;
    if (main) this.views.get(main)?.setTier(tier, extra);
  }

  // ------------------------------------------------------------- console set

  private rebuildConsoles(opts: { keepFocus?: boolean } = {}): void {
    const host = this.consoleHost();
    const wanted = this.orderedAgents();
    const created: AgentId[] = [];
    for (const agent of wanted) {
      let view = this.views.get(agent.id);
      if (!view) {
        view = new ConsoleView(agent, host, this.snapshot.showReasoning);
        this.views.set(agent.id, view);
        created.push(agent.id);
      } else {
        view.setAgent(agent);
      }
    }
    for (const [id, view] of [...this.views]) {
      if (!wanted.some((a) => a.id === id)) {
        view.destroy();
        this.views.delete(id);
        this.collapsed.delete(id);
        this.autoCollapsed.delete(id);
        this.userShown.delete(id);
        if (this.focusedId === id) this.focusedId = null;
        if (this.maximizedId === id) this.maximizedId = null;
      }
    }
    this.layout();
    this.moveInputBox();
    // A console:add/remove must not move the viewport: focus only follows a console that
    // genuinely disappeared, and never scrolls in that case.
    if (!this.focusedId || !this.views.has(this.focusedId)) {
      const main = this.snapshot.mainAgentId ?? wanted[0]?.id ?? null;
      if (main) this.focus(main, !opts.keepFocus);
    }
    // Defensive: covers a `console:event` that somehow preceded its `console:add`.
    for (const id of created) {
      if (this.instances.has(id)) void this.loadInstanceHistory(id);
    }
  }

  private async loadInstanceHistory(id: AgentId): Promise<void> {
    const view = this.views.get(id);
    if (!view) return;
    try {
      const events = await window.api.invoke('console:getEvents', id, { limit: HISTORY_LIMIT });
      if (events.length) this.views.get(id)?.loadHistory(events);
    } catch {
      /* in-memory console may already be gone — nothing to restore */
    }
  }

  /** Templates (orchestrator first) then live instances in arrival order (§10.2). */
  private orderedAgents(): AgentView[] {
    const main = this.snapshot.mainAgentId;
    const list = [...this.snapshot.agents];
    list.sort((a, b) => (a.id === main ? -1 : b.id === main ? 1 : 0));
    return [...list, ...this.instances.values()];
  }

  private consoleHost(): ConsoleHost {
    return {
      focusAgent: (id) => this.focus(id),
      requestFocus: (id) => this.focus(id, false),
      toggleMaximize: (id) => this.toggleMaximize(id),
      toggleCollapse: (id) => this.toggleCollapse(id),
      agentMeta: (id) => {
        if (!id) return null;
        const inst = this.instances.get(id);
        // Instances borrow their template's colour so the card stripe still matches.
        if (inst) {
          const tpl = this.snapshot.agents.find((x) => x.id === inst.parentId);
          return { name: inst.name, color: tpl?.color ?? inst.color };
        }
        const a = this.snapshot.agents.find((x) => x.id === id);
        return a ? { name: a.name, color: a.color } : null;
      },
      unseenChanged: () => this.renderDock(),
      hasConsole: (id) => (id ? this.views.has(id) : false),
      closeInstance: (id) => void this.closeInstance(id),
    };
  }

  // ------------------------------------------------------ ephemeral instances

  /** `console:add` — always arrives before the instance's first console event (§3, §15). */
  onConsoleAdd(v: AgentView): void {
    if (this.instances.has(v.id)) {
      this.instances.set(v.id, v);
      this.views.get(v.id)?.setAgent(v);
      return;
    }
    this.instances.set(v.id, v);
    this.rebuildConsoles({ keepFocus: true });
  }

  /** `console:remove` — closed by the user, superseded by the next request, or template gone. */
  onConsoleRemove(r: { agentId: AgentId; reason: string }): void {
    if (!this.instances.has(r.agentId)) return;
    this.instances.delete(r.agentId);
    const view = this.views.get(r.agentId);
    if (view) {
      view.destroy();
      this.views.delete(r.agentId);
    }
    this.collapsed.delete(r.agentId);
    this.autoCollapsed.delete(r.agentId);
    this.userShown.delete(r.agentId);
    if (this.focusedId === r.agentId) this.focusedId = null;
    if (this.maximizedId === r.agentId) this.maximizedId = null;
    this.rebuildConsoles({ keepFocus: true });
  }

  private async closeInstance(id: AgentId): Promise<void> {
    try {
      await window.api.invoke('instance:close', id);
    } catch (e) {
      toast('error', errText(e));
    }
  }

  /**
   * Flood guard (§15): with `maxWorkersPerRequest` instances the grid would collapse into
   * unreadable slivers, so the oldest instances beyond `maxParallelWorkers` are docked.
   * Consoles the user opened by hand are never re-docked, and raising the limit (hot reload,
   * §12) releases the ones the guard docked itself.
   */
  private enforceFloodGuard(): void {
    const max = Math.max(1, this.snapshot.maxParallelWorkers ?? DEFAULT_MAX_PARALLEL);
    const ids = [...this.instances.keys()];
    let room = max - ids.filter((id) => !this.collapsed.has(id)).length;
    for (const id of ids) {
      if (room <= 0) break;
      if (!this.autoCollapsed.has(id) || !this.collapsed.has(id)) continue;
      this.collapsed.delete(id);
      this.autoCollapsed.delete(id);
      room -= 1;
    }
    const visible = ids.filter((id) => !this.collapsed.has(id) && !this.userShown.has(id));
    const excess = ids.filter((id) => !this.collapsed.has(id)).length - max;
    if (excess <= 0) return;
    for (const id of visible.slice(0, excess)) {
      this.collapsed.add(id);
      this.autoCollapsed.add(id);
      if (this.maximizedId === id) this.maximizedId = null;
      if (this.focusedId === id) this.focusedId = null;
    }
  }

  private layout(): void {
    this.enforceFloodGuard();
    const order = this.orderedAgents();
    const visible = order.filter((a) => !this.collapsed.has(a.id));
    const n = visible.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    this.grid.style.setProperty('--cols', String(cols));
    this.grid.classList.toggle('span-main', n >= 3);
    this.grid.classList.toggle('has-max', this.maximizedId !== null);
    const roots: HTMLElement[] = [];
    for (const agent of order) {
      const view = this.views.get(agent.id);
      if (!view) continue;
      const isMain = agent.id === this.snapshot.mainAgentId;
      view.root.classList.toggle('is-main', isMain);
      view.collapsed = this.collapsed.has(agent.id);
      view.root.hidden = view.collapsed || (this.maximizedId !== null && this.maximizedId !== agent.id);
      view.setMaximized(this.maximizedId === agent.id);
      roots.push(view.root);
    }
    // Moving a node re-creates its layout box and resets the scroll position of every
    // scrollable descendant, so only the consoles actually out of place are touched:
    // spawning an instance must not yank the other consoles back to the top.
    for (let i = 0; i < roots.length; i++) {
      if (this.grid.children[i] !== roots[i]) this.grid.insertBefore(roots[i] as HTMLElement, this.grid.children[i] ?? null);
    }
    this.renderDock();
  }

  private renderDock(): void {
    const chips = this.orderedAgents()
      .filter((a) => this.collapsed.has(a.id))
      .map((a) => {
        const view = this.views.get(a.id);
        const unseen = view?.unseen ?? 0;
        return h('button', {
          class: 'chip', type: 'button', style: { '--agent-color': a.color },
          title: 'Riporta la console di ' + a.name + ' nella griglia. Ridotta a scheda, continua a ricevere eventi'
            + (unseen > 0 ? ': ' + unseen + ' non ancora visti.' : '.'),
          aria: { label: 'Ripristina la console di ' + a.name },
          on: { click: () => this.focus(a.id) },
        },
        h('span', { class: 'dot' }),
        h('span', { class: 'chip-name', text: a.name }),
        h('span', {
          class: 'badge status', data: { status: view?.status ?? 'idle' }, text: '',
          title: 'Stato attuale: ' + (view?.status ?? 'idle'),
        }),
        unseen > 0
          ? h('span', { class: 'badge unseen', text: String(unseen), title: unseen + ' eventi arrivati da quando la console è ridotta.' })
          : null);
      });
    replace(this.dock, chips);
    this.dock.hidden = chips.length === 0;
  }

  private moveInputBox(): void {
    const mainId = this.snapshot.mainAgentId;
    for (const [id, view] of this.views) {
      if (id === mainId) {
        if (this.inputBox.parentElement !== view.footer) view.footer.appendChild(this.inputBox);
        view.footer.hidden = false;
      } else if (view.footer.contains(this.inputBox)) {
        view.footer.hidden = true;
      } else {
        view.footer.hidden = true;
      }
    }
  }

  // ----------------------------------------------------------------- actions

  focus(id: AgentId, scroll = true): void {
    if (!this.views.has(id)) return;
    if (this.collapsed.has(id)) {
      this.collapsed.delete(id);
      this.autoCollapsed.delete(id);
      if (this.instances.has(id)) this.userShown.add(id);
      this.layout();
    }
    if (this.maximizedId !== null && this.maximizedId !== id) {
      this.maximizedId = null;
      this.layout();
    }
    this.focusedId = id;
    for (const [vid, view] of this.views) {
      view.setFocused(vid === id);
      if (vid === id) view.resetUnseen();
    }
    this.renderDock();
    if (scroll) this.views.get(id)?.root.scrollIntoView({ block: 'nearest' });
  }

  private toggleMaximize(id: AgentId): void {
    this.maximizedId = this.maximizedId === id ? null : id;
    if (this.maximizedId) this.focusedId = id;
    this.layout();
    for (const [vid, view] of this.views) view.setFocused(vid === this.focusedId);
  }

  private toggleCollapse(id: AgentId): void {
    if (this.collapsed.has(id)) {
      this.collapsed.delete(id);
      this.autoCollapsed.delete(id);
      if (this.instances.has(id)) this.userShown.add(id);
    } else {
      if (this.views.size - this.collapsed.size <= 1) {
        toast('info', 'Almeno una console deve restare visibile.');
        return;
      }
      this.collapsed.add(id);
      if (this.maximizedId === id) this.maximizedId = null;
      if (this.focusedId === id) {
        const next = this.orderedAgents().find((a) => !this.collapsed.has(a.id));
        this.focusedId = next?.id ?? null;
      }
    }
    this.layout();
    for (const [vid, view] of this.views) view.setFocused(vid === this.focusedId);
  }

  private onKey(ev: KeyboardEvent): void {
    if (modals.open) return;
    if (ev.key === 'Escape') {
      if (this.settings.isOpen) {
        this.settings.close();
        ev.preventDefault();
        return;
      }
      if (this.maximizedId) {
        this.maximizedId = null;
        this.layout();
        ev.preventDefault();
      }
      return;
    }
    if ((ev.metaKey || ev.ctrlKey) && /^[1-9]$/.test(ev.key)) {
      const idx = Number(ev.key) - 1;
      const visible = this.orderedAgents().filter((a) => !this.collapsed.has(a.id));
      const target = visible[idx] ?? this.orderedAgents()[idx];
      if (target) {
        ev.preventDefault();
        this.focus(target.id);
      }
    }
  }

  private openWorkspace(): void {
    const p = this.snapshot.workspacePath;
    if (!p) {
      toast('info', 'Nessuna cartella di lavoro configurata.');
      return;
    }
    void window.api.invoke('shell:openPath', p).catch((e: unknown) => toast('error', errText(e)));
  }

  private async toggleReasoning(): Promise<void> {
    const next = !this.snapshot.showReasoning;
    try {
      const snap = await window.api.invoke('config:update', { showReasoning: next });
      this.snapshot = snap;
      for (const v of this.views.values()) v.setReasoning(next);
      this.settings.setSnapshot(snap);
      this.paintReasoningToggle(next);
    } catch (e) {
      toast('error', errText(e));
    }
  }

  private async send(): Promise<void> {
    const text = this.textarea.value.trim();
    if (!text) return;
    if (this.textarea.disabled) return;
    this.textarea.value = '';
    try {
      const res = await window.api.invoke('chat:send', text);
      this.activeUserRun = this.activeUserRun ?? { runId: res.runId, agentId: this.snapshot.mainAgentId ?? '', startedAt: Date.now() };
      if (res.queued) this.queuedUserMessages += 1;
      this.refreshStatus();
    } catch (e) {
      toast('error', errText(e));
      this.textarea.value = text;
    }
  }

  private async cancelAll(): Promise<void> {
    try {
      await window.api.invoke('chat:cancel');
      this.queuedUserMessages = 0;
    } catch (e) {
      toast('error', errText(e));
    }
  }

  // ------------------------------------------------------------ event intake

  onConsoleEvent(ev: ConsoleEvent): void {
    this.views.get(ev.agentId)?.pushEvent(ev);
  }

  onConsolePatch(p: ConsolePatch): void {
    this.views.get(p.agentId)?.pushPatch(p);
  }

  onAgentStatus(u: AgentStatusUpdate): void {
    this.usage.set(u.agentId, u.usage);
    this.views.get(u.agentId)?.applyStatus(u);
    if (u.agentId === this.snapshot.mainAgentId && u.status === 'idle' && u.queueLength === 0) {
      this.activeUserRun = null;
    }
    this.renderDock();
    this.refreshStatus();
  }

  onRunFinished(r: RunFinished): void {
    if (r.isUserRun) {
      if (!this.activeUserRun || this.activeUserRun.runId === r.runId) this.activeUserRun = null;
      this.queuedUserMessages = Math.max(0, this.queuedUserMessages - 1);
      if (r.status === 'error') toast('error', 'Il team ha terminato con un errore.');
      if (r.status === 'partial') toast('warn', 'Il team ha consegnato un risultato parziale.');
      this.views.get(r.agentId)?.setTier(r.tier ?? null);
    }
    this.refreshStatus();
  }

  onConfigChanged(c: ConfigChanged): void {
    const prevMain = this.snapshot.mainAgentId;
    this.snapshot = c.snapshot;
    this.pathBtn.textContent = c.snapshot.workspacePath ?? 'nessuna cartella';
    this.pathBtn.title = this.wsTitle(c.snapshot.workspacePath);
    this.rebuildConsoles();
    if (c.diff.mainChanged || prevMain !== c.snapshot.mainAgentId) this.moveInputBox();
    if (c.diff.fields.includes('showReasoning')) {
      for (const v of this.views.values()) v.setReasoning(c.snapshot.showReasoning);
      this.paintReasoningToggle(c.snapshot.showReasoning);
    }
    this.settings.setSnapshot(c.snapshot);
    this.bypassBadge.hidden = c.snapshot.permissionMode !== 'bypass';
    this.refreshStatus();
  }

  // ------------------------------------------------------------------ status

  private paintReasoningToggle(on: boolean): void {
    const b = this.root.querySelector('.reason-toggle') as HTMLElement | null;
    if (!b) return;
    b.textContent = on ? '👁' : '🚫';
    b.title = this.reasoningTitle(on);
    b.setAttribute('aria-label', this.reasoningTitle(on));
  }

  private startTicker(): void {
    this.tickTimer = window.setInterval(() => this.refreshStatus(), 1000);
  }

  private refreshStatus(): void {
    const busyAgents = [...this.views.values()].filter((v) => v.status !== 'idle' && v.status !== 'error').length;
    const running = this.activeUserRun !== null;
    if (running && this.activeUserRun) {
      const elapsed = Date.now() - this.activeUserRun.startedAt;
      this.statusPill.dataset.state = 'run';
      this.statusPill.textContent = 'Team al lavoro · ' + busyAgents + (busyAgents === 1 ? ' agente attivo · ' : ' agenti attivi · ') + fmtClock(elapsed);
      this.statusPill.title = 'Una tua richiesta è in corso da ' + fmtClock(elapsed) + ': agenti che stanno ragionando, scrivendo, '
        + 'usando strumenti o aspettando una delega. Il tempo si ferma quando l’orchestratore consegna la risposta.';
    } else if (busyAgents > 0) {
      this.statusPill.dataset.state = 'run';
      this.statusPill.textContent = busyAgents + (busyAgents === 1 ? ' agente attivo' : ' agenti attivi');
      this.statusPill.title = 'Nessuna tua richiesta in corso, ma qualche agente sta ancora chiudendo il lavoro precedente.';
    } else {
      this.statusPill.dataset.state = 'idle';
      this.statusPill.textContent = 'Pronto';
      this.statusPill.title = 'Nessun agente al lavoro: la prossima richiesta parte subito.';
    }
    const anyBusy = running || busyAgents > 0;
    this.cancelBtn.hidden = !anyBusy;
    this.abortBtn.hidden = !running;
    this.sendBtn.hidden = running;
    this.textarea.disabled = running;
    this.textarea.placeholder = running
      ? 'Il team sta lavorando… usa "Annulla" per fermarlo'
      : 'Scrivi un compito per il team… (Invio per inviare, Maiusc+Invio per andare a capo)';
    this.textarea.title = running ? T.chatBusy : T.chatIdle;
    this.queueNote.hidden = this.queuedUserMessages <= 0;
    this.queueNote.textContent = this.queuedUserMessages + ' in coda';

    let cost = 0;
    let tokens = 0;
    let estimated = false;
    for (const u of this.usage.values()) {
      cost += u.cost || 0;
      tokens += (u.promptTokens || 0) + (u.completionTokens || 0);
      estimated = estimated || u.estimated;
    }
    this.totalsEl.textContent = fmtCost(cost, estimated) + ' · ' + fmtTokens(tokens) + ' tok';
  }

}
