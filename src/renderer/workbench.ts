// Workbench: header, console grid, dock, user input box, focus/maximize/keyboard,
// live handling of config:changed (hot reload) without losing console content.

import type {
  AgentId,
  AgentStatusUpdate,
  AppInfo,
  ConfigChanged,
  ConfigSnapshot,
  ConsoleEvent,
  ConsolePatch,
  RunFinished,
  RuntimeSnapshot,
  Usage,
} from '../shared/types';
import { btn, fmtClock, fmtCost, fmtTokens, h, iconBtn, replace } from './dom.js';
import { ConsoleView, type ConsoleHost } from './console.js';
import { errText, modals, toast } from './modals.js';
import { SettingsPanel } from './settings.js';

const HISTORY_LIMIT = 400;

export interface WorkbenchHooks {
  onKeyCleared(): void;
  onReset(): void;
}

export class Workbench {
  readonly root: HTMLElement;

  private readonly views = new Map<AgentId, ConsoleView>();
  private readonly grid: HTMLElement;
  private readonly dock: HTMLElement;
  private readonly pathBtn: HTMLButtonElement;
  private readonly statusPill: HTMLElement;
  private readonly totalsEl: HTMLElement;
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
      title: 'Apri la cartella di lavoro',
      on: { click: () => this.openWorkspace() },
    }, snapshot.workspacePath ?? 'nessuna cartella');

    this.statusPill = h('span', { class: 'status-pill', data: { state: 'idle' }, text: 'Pronto' });
    this.totalsEl = h('span', { class: 'totals', title: 'Costo e token totali della sessione', text: fmtCost(0) });
    this.cancelBtn = h('button', {
      class: 'btn danger', type: 'button', hidden: true,
      on: { click: () => void this.cancelAll() },
    }, 'Annulla tutto');

    this.settings = new SettingsPanel({
      onKeyCleared: () => this.hooks.onKeyCleared(),
      onReset: () => this.hooks.onReset(),
    });

    const head = h('header', { class: 'app-head' },
      h('span', {
        class: 'app-name',
        title: 'Agents Pool v' + info.version + ' · ' + info.platform + '/' + info.arch + '\n' + info.userDataPath,
      }, 'Agents ', h('span', { class: 'accent', text: 'Pool' })),
      this.pathBtn,
      this.statusPill,
      this.totalsEl,
      h('span', { class: 'spacer' }),
      iconBtn(snapshot.showReasoning ? '👁' : '🚫', 'Ragionamento visibile (globale)', () => void this.toggleReasoning(), 'reason-toggle'),
      this.cancelBtn,
      btn('Impostazioni', () => this.settings.toggle(), 'btn ghost'),
    );

    this.grid = h('div', { class: 'grid', id: 'grid' });
    this.dock = h('div', { class: 'dock', hidden: true });

    this.textarea = h('textarea', {
      class: 'input chat',
      rows: 2,
      placeholder: 'Scrivi un compito per il team… (Invio per inviare, Maiusc+Invio per andare a capo)',
      spellcheck: false,
    });
    this.sendBtn = btn('Invia', () => void this.send(), 'btn primary send');
    this.abortBtn = h('button', { class: 'btn danger', type: 'button', hidden: true, on: { click: () => void this.cancelAll() } }, 'Annulla');
    this.queueNote = h('span', { class: 'queue-note', hidden: true });
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
    for (const [id, st] of Object.entries(snap.agents)) {
      const view = this.views.get(id);
      this.usage.set(id, st.usage);
      view?.applyStatus({
        agentId: id, status: st.status, runId: st.runId, queueLength: st.queueLength, usage: st.usage,
      });
    }
    this.activeUserRun = snap.activeUserRun;
    this.queuedUserMessages = snap.queuedUserMessages;
    for (const p of snap.pendingPermissions) modals.permission(p);
    for (const a of snap.pendingAsks) modals.ask(a);
    this.refreshStatus();
  }

  // ------------------------------------------------------------- console set

  private rebuildConsoles(): void {
    const host = this.consoleHost();
    const wanted = this.orderedAgents();
    for (const agent of wanted) {
      let view = this.views.get(agent.id);
      if (!view) {
        view = new ConsoleView(agent, host, this.snapshot.showReasoning);
        this.views.set(agent.id, view);
      } else {
        view.setAgent(agent);
      }
    }
    for (const [id, view] of [...this.views]) {
      if (!wanted.some((a) => a.id === id)) {
        view.destroy();
        this.views.delete(id);
        this.collapsed.delete(id);
        if (this.focusedId === id) this.focusedId = null;
        if (this.maximizedId === id) this.maximizedId = null;
      }
    }
    this.layout();
    this.moveInputBox();
    if (!this.focusedId || !this.views.has(this.focusedId)) {
      const main = this.snapshot.mainAgentId ?? wanted[0]?.id ?? null;
      if (main) this.focus(main);
    }
  }

  private orderedAgents() {
    const main = this.snapshot.mainAgentId;
    const list = [...this.snapshot.agents];
    list.sort((a, b) => (a.id === main ? -1 : b.id === main ? 1 : 0));
    return list;
  }

  private consoleHost(): ConsoleHost {
    return {
      focusAgent: (id) => this.focus(id),
      requestFocus: (id) => this.focus(id, false),
      toggleMaximize: (id) => this.toggleMaximize(id),
      toggleCollapse: (id) => this.toggleCollapse(id),
      agentMeta: (id) => {
        if (!id) return null;
        const a = this.snapshot.agents.find((x) => x.id === id);
        return a ? { name: a.name, color: a.color } : null;
      },
      unseenChanged: () => this.renderDock(),
    };
  }

  private layout(): void {
    const order = this.orderedAgents();
    const visible = order.filter((a) => !this.collapsed.has(a.id));
    const n = visible.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 6 ? 3 : 4;
    this.grid.style.setProperty('--cols', String(cols));
    this.grid.classList.toggle('span-main', n >= 3);
    this.grid.classList.toggle('has-max', this.maximizedId !== null);
    for (const agent of order) {
      const view = this.views.get(agent.id);
      if (!view) continue;
      const isMain = agent.id === this.snapshot.mainAgentId;
      view.root.classList.toggle('is-main', isMain);
      view.collapsed = this.collapsed.has(agent.id);
      view.root.hidden = view.collapsed || (this.maximizedId !== null && this.maximizedId !== agent.id);
      view.setMaximized(this.maximizedId === agent.id);
      this.grid.appendChild(view.root); // append in order = re-order
    }
    this.renderDock();
  }

  private renderDock(): void {
    const chips = this.orderedAgents()
      .filter((a) => this.collapsed.has(a.id))
      .map((a) => {
        const view = this.views.get(a.id);
        return h('button', {
          class: 'chip', type: 'button', style: { '--agent-color': a.color },
          title: 'Ripristina ' + a.name,
          on: { click: () => this.focus(a.id) },
        },
        h('span', { class: 'dot' }),
        h('span', { class: 'chip-name', text: a.name }),
        h('span', { class: 'badge status', data: { status: view?.status ?? 'idle' }, text: '' }),
        view && view.unseen > 0 ? h('span', { class: 'badge unseen', text: String(view.unseen) }) : null);
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
      const b = this.root.querySelector('.reason-toggle');
      if (b) b.textContent = next ? '👁' : '🚫';
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
    }
    this.refreshStatus();
  }

  onConfigChanged(c: ConfigChanged): void {
    const prevMain = this.snapshot.mainAgentId;
    this.snapshot = c.snapshot;
    this.pathBtn.textContent = c.snapshot.workspacePath ?? 'nessuna cartella';
    this.rebuildConsoles();
    if (c.diff.mainChanged || prevMain !== c.snapshot.mainAgentId) this.moveInputBox();
    if (c.diff.fields.includes('showReasoning')) {
      for (const v of this.views.values()) v.setReasoning(c.snapshot.showReasoning);
      const b = this.root.querySelector('.reason-toggle');
      if (b) b.textContent = c.snapshot.showReasoning ? '👁' : '🚫';
    }
    this.settings.setSnapshot(c.snapshot);
    this.refreshStatus();
  }

  // ------------------------------------------------------------------ status

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
    } else if (busyAgents > 0) {
      this.statusPill.dataset.state = 'run';
      this.statusPill.textContent = busyAgents + (busyAgents === 1 ? ' agente attivo' : ' agenti attivi');
    } else {
      this.statusPill.dataset.state = 'idle';
      this.statusPill.textContent = 'Pronto';
    }
    const anyBusy = running || busyAgents > 0;
    this.cancelBtn.hidden = !anyBusy;
    this.abortBtn.hidden = !running;
    this.sendBtn.hidden = running;
    this.textarea.disabled = running;
    this.textarea.placeholder = running
      ? 'Il team sta lavorando… usa "Annulla" per fermarlo'
      : 'Scrivi un compito per il team… (Invio per inviare, Maiusc+Invio per andare a capo)';
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
