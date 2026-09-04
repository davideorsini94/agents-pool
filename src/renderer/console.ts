// ConsoleView: one scrollable event log per agent.
// One DOM node per ConsoleEvent (keyed by event id); `console:patch` mutates that node in
// place — streaming deltas never create new nodes. Writes are batched per animation frame.

import type {
  AgentId,
  AgentStatus,
  AgentStatusUpdate,
  AgentView,
  CommandClass,
  ConsoleEvent,
  ConsolePatch,
  PermissionOutcome,
  Usage,
} from '../shared/types';
import {
  btn,
  clear,
  fmtBytes,
  fmtCost,
  fmtMs,
  fmtTokens,
  h,
  iconBtn,
  prettyArgs,
  raf,
  renderMarkdown,
  replace,
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

const DELEG_STATUS: Record<string, string> = {
  queued: 'In coda',
  running: 'In corso',
  done: 'Completata',
  error: 'Errore',
  cancelled: 'Annullata',
  rejected: 'Rifiutata',
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

const TASK_END: Record<string, { icon: string; label: string }> = {
  done: { icon: '✓', label: 'completato' },
  error: { icon: '✗', label: 'errore' },
  cancelled: { icon: '■', label: 'annullato' },
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
  delegate_task: '⇢',
  list_agents: '👥',
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
function collapsiblePre(text: string, limit = COLLAPSE_LIMIT, cls = 'pre'): HTMLElement {
  const wrap = h('div', { class: 'collapsible' });
  const pre = h('pre', { class: cls, text });
  wrap.appendChild(pre);
  if (text.length > limit) {
    wrap.classList.add('is-collapsed');
    const toggle = btn('Mostra tutto', () => {
      const collapsed = wrap.classList.toggle('is-collapsed');
      toggle.textContent = collapsed ? 'Mostra tutto' : 'Nascondi';
    }, 'linkbtn');
    wrap.appendChild(toggle);
  }
  return wrap;
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
  private readonly statusEl: HTMLElement;
  private readonly costEl: HTMLElement;
  private readonly stopBtn: HTMLElement;
  private readonly eyeBtn: HTMLElement;

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

    this.nameEl = h('span', { class: 'cons-name', text: agent.name });
    this.descEl = h('span', { class: 'cons-desc', text: agent.description || '' });
    this.modelEl = h('span', { class: 'badge model', text: agent.model, title: agent.model });
    this.statusEl = h('span', { class: 'badge status', data: { status: 'idle' }, text: STATUS_LABEL.idle });
    this.costEl = h('span', { class: 'cons-cost', text: fmtCost(0) });

    this.eyeBtn = iconBtn(showReasoning ? '👁' : '🚫', 'Mostra/nascondi ragionamento', () => this.toggleReasoning());
    this.stopBtn = iconBtn('■', 'Ferma questo agente', () => this.cancel(), 'danger');
    this.stopBtn.hidden = true;

    const head = h('div', { class: 'cons-head' },
      h('span', { class: 'dot' }),
      h('div', { class: 'cons-title' }, this.nameEl, this.descEl),
      this.modelEl,
      this.statusEl,
      this.costEl,
      h('div', { class: 'cons-actions' },
        this.eyeBtn,
        this.stopBtn,
        iconBtn('⤢', 'Ingrandisci / ripristina', () => this.host.toggleMaximize(this.agent.id)),
        iconBtn('▁', 'Riduci nella barra', () => this.host.toggleCollapse(this.agent.id)),
        iconBtn('⌫', 'Pulisci la console', () => void this.clearRemote()),
      ),
    );

    this.list = h('div', { class: 'events' });
    this.olderBar = h('div', { class: 'older-bar', hidden: true },
      btn('Carica eventi precedenti', () => void this.loadOlder(), 'linkbtn'));
    this.body = h('div', { class: 'cons-body' }, this.olderBar, this.list);
    this.pill = h('button', { class: 'pill', type: 'button', hidden: true, on: { click: () => this.repin() } }, '↓ nuovi messaggi');
    this.footer = h('div', { class: 'cons-footer', hidden: true });

    this.root = h('section', {
      class: 'console',
      data: { agentId: agent.id },
      style: { '--agent-color': agent.color },
    }, head, this.body, this.pill, this.footer);

    if (!showReasoning) this.root.classList.add('no-reasoning');

    this.body.addEventListener('scroll', () => {
      this.stick = this.body.scrollHeight - this.body.scrollTop - this.body.clientHeight < 24;
      if (this.stick) this.pill.hidden = true;
    });
    this.root.addEventListener('mousedown', () => this.host.requestFocus(this.agent.id));
  }

  // ------------------------------------------------------------------ header

  setAgent(agent: AgentView): void {
    this.agent = agent;
    this.nameEl.textContent = agent.name;
    this.descEl.textContent = agent.description || '';
    this.modelEl.textContent = agent.model;
    this.modelEl.title = agent.model;
    this.root.style.setProperty('--agent-color', agent.color);
  }

  applyStatus(u: AgentStatusUpdate): void {
    this.status = u.status;
    const label = STATUS_LABEL[u.status] ?? u.status;
    this.statusEl.textContent = u.queueLength > 0 ? label + ' · ' + u.queueLength + ' in coda' : label;
    this.statusEl.dataset.status = u.status;
    this.statusEl.title = u.detail ?? label;
    this.stopBtn.hidden = u.status === 'idle' || u.status === 'error';
    this.costEl.textContent = fmtCost(u.usage?.cost ?? 0, u.usage?.estimated ?? false);
    this.costEl.title = u.usage
      ? [
        'prompt: ' + fmtTokens(u.usage.promptTokens),
        'output: ' + fmtTokens(u.usage.completionTokens),
        'ragionamento: ' + fmtTokens(u.usage.reasoningTokens),
        'cache: ' + fmtTokens(u.usage.cachedTokens),
        'chiamate: ' + u.usage.calls,
      ].join('\n')
      : '';
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
        node.appendChild(h('div', { class: 'bubble' }, txt));
        break;
      }

      case 'task_start': {
        const line = h('div', { class: 'banner' });
        if (ev.origin.kind === 'user') {
          line.appendChild(h('span', { class: 'arrow', text: '▶' }));
          line.appendChild(h('span', { text: 'Richiesta dell’utente' }));
        } else {
          const from = this.host.agentMeta(ev.origin.fromAgentId);
          node.classList.add('inbound');
          node.style.setProperty('--other-color', from?.color ?? '#8b93a7');
          line.appendChild(h('span', { class: 'arrow', text: '⇠' }));
          line.appendChild(h('span', { class: 'dot other' }));
          line.appendChild(h('span', {}, 'Incarico da ', h('strong', { text: ev.origin.fromName || from?.name || 'agente' })));
          line.appendChild(h('span', { class: 'badge', text: 'livello ' + ev.origin.depth }));
        }
        node.appendChild(line);
        node.appendChild(collapsiblePre(ev.input, COLLAPSE_LIMIT, 'pre task'));
        if (ev.context) node.appendChild(collapsiblePre('contesto: ' + ev.context, COLLAPSE_LIMIT, 'pre task ctx'));
        break;
      }

      case 'task_end': {
        const line = h('div', { class: 'endline' });
        node.appendChild(line);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'task_end' }>;
          const s = TASK_END[e.status] ?? { icon: '·', label: e.status };
          node.dataset.status = e.status;
          replace(line,
            h('span', { class: 'ico', text: s.icon }),
            h('span', { class: 'st', text: s.label }),
            h('span', {
              class: 'meta',
              text: [fmtMs(e.durationMs), e.iterations + ' iterazioni', usageMeta(e.usage)].filter(Boolean).join(' · '),
            }));
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
            e.durationMs !== undefined ? fmtMs(e.durationMs) : '',
            usageMeta(e.usage),
            e.finishReason ? 'fine: ' + e.finishReason : '',
          ].filter(Boolean).join(' · ');
          replace(line,
            e.status === 'streaming' ? h('span', { class: 'spinner' }) : h('span', { class: 'arrow', text: '→' }),
            h('span', { class: 'model', text: e.model }),
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
        const toggle = iconBtn('▾', 'Comprimi/espandi il ragionamento', () => {
          const c = node.classList.toggle('is-collapsed');
          toggle.textContent = c ? '▸' : '▾';
        });
        node.appendChild(h('div', { class: 'rz-head' },
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
        const label = h('div', { class: 'lbl', hidden: !ev.final },
          this.agent.isMain ? 'Risposta' : 'Risultato');
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
          replace(head,
            h('span', { class: 'ico', text: TOOL_ICON[e.name] ?? '🔧' }),
            h('span', { class: 'tname', text: e.name || 'strumento' }),
            h('span', { class: 'badge chip', text: TOOL_STATUS[e.status] ?? e.status }),
            e.status === 'running' || e.status === 'streaming' ? h('span', { class: 'spinner sm' }) : null,
            e.result ? h('span', { class: 'meta', text: fmtMs(e.result.durationMs) }) : null);
          const pretty = prettyArgs(e.argsRaw, e.args);
          if (pretty !== lastArgs) {
            lastArgs = pretty;
            replace(argsBox, collapsiblePre(pretty, COLLAPSE_LIMIT, 'pre args'));
            if (e.parseError) argsBox.appendChild(h('div', { class: 'warn', text: 'Argomenti non validi: ' + e.parseError }));
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
                }, 'linkbtn');
                resBox.appendChild(more);
              }
              if (r.truncated) resBox.appendChild(h('div', { class: 'meta', text: 'output troncato · totale ' + fmtBytes(r.fullLength) }));
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
        const preview = h('div', { class: 'card-res' });
        node.appendChild(head);
        node.appendChild(collapsiblePre(ev.task, COLLAPSE_LIMIT, 'pre task'));
        node.appendChild(preview);
        n.update = () => {
          const e = n.ev as Extract<ConsoleEvent, { kind: 'delegation' }>;
          node.dataset.status = e.status;
          const meta = this.host.agentMeta(e.toAgentId);
          if (meta) node.style.setProperty('--other-color', meta.color);
          replace(head,
            h('span', { class: 'arrow', text: '⇢' }),
            h('span', { class: 'dot other' }),
            h('span', {}, 'Delega a ', h('strong', { text: e.toName || meta?.name || '?' })),
            h('span', { class: 'badge chip', text: DELEG_STATUS[e.status] ?? e.status }),
            e.status === 'running' || e.status === 'queued' ? h('span', { class: 'spinner sm' }) : null,
            e.durationMs !== undefined ? h('span', { class: 'meta', text: fmtMs(e.durationMs) }) : null,
            e.toAgentId ? btn('Vai alla console', () => this.host.focusAgent(e.toAgentId as AgentId), 'linkbtn') : null);
          clear(preview);
          if (e.resultPreview) preview.appendChild(collapsiblePre(e.resultPreview, COLLAPSE_LIMIT, 'pre result'));
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
          replace(head,
            h('span', { class: 'ico', text: '🔒' }),
            h('span', { class: 'ptext', text: 'Autorizzazione: ' + e.summary }),
            h('span', { class: 'badge chip', text: PERM_STATUS[e.status] ?? String(e.status) }),
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
          replace(head,
            h('span', { class: 'ico', text: '❓' }),
            h('span', { class: 'ptext', text: e.question }),
            h('span', { class: 'badge chip', text: e.status === 'pending' ? 'In attesa…' : e.status === 'answered' ? 'Risposto' : e.status === 'timeout' ? 'Scaduto' : 'Annullato' }));
          clear(ans);
          if (e.answer) ans.appendChild(h('div', { class: 'answer', text: e.answer }));
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
          replace(head,
            h('span', { class: 'ico', text: '✗' }),
            h('span', { class: 'ptext', text: e.message }),
            e.code ? h('span', { class: 'badge chip', text: e.code }) : null,
            e.retryable ? cdEl : null);
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
        };
        break;
      }

      default: {
        node.appendChild(h('div', { class: 'infoline', text: JSON.stringify(ev) }));
      }
    }
    return n;
  }
}
