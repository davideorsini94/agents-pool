// Global modal layer: permission queue, ask-user queue, generic confirm, toasts.
// Requests are shown no matter which agent raised them (never routed through a console),
// and the rest of the UI keeps streaming behind a dim overlay.

import type {
  AskUserRequest,
  PermissionKind,
  PermissionRequest,
  CommandClass,
} from '../shared/types';
import { btn, clear, fmtClock, h, iconBtn } from './dom.js';

const KIND_TITLE: Record<PermissionKind, string> = {
  fs_read_outside: 'Leggere fuori dal workspace',
  fs_read_protected: 'Leggere un percorso protetto',
  fs_write_inside: 'Scrivere nel workspace',
  fs_write_outside: 'Scrivere fuori dal workspace',
  fs_delete_inside: 'Eliminare nel workspace',
  fs_delete_outside: 'Eliminare fuori dal workspace',
  command: 'Eseguire un comando',
};

const CLASS_LABEL: Record<CommandClass, string> = {
  benign: 'innocuo',
  sensitive: 'sensibile',
  privileged: 'privilegiato',
  destructive: 'distruttivo',
};

/** How the app classified the command — decides what "per la sessione" is even allowed to do. */
const CLASS_HELP: Record<CommandClass, string> = {
  benign: 'Classificato innocuo: legge o compila senza toccare il sistema. Solo questi comandi possono entrare nell’elenco dei comandi sempre consentiti.',
  sensitive: 'Classificato sensibile: tocca dati o configurazioni. Concedilo se sai cosa fa.',
  privileged: 'Classificato privilegiato: chiede permessi elevati (sudo o simili) e può cambiare il sistema.',
  destructive: 'Classificato distruttivo: può eliminare o sovrascrivere dati in modo non recuperabile.',
};

/** Tooltips of the decision buttons: each one says exactly how long the choice lasts (§10.5). */
const T = {
  allow: 'Autorizza soltanto questa azione, una volta. Un’azione uguale più avanti chiederà di nuovo il permesso.',
  allowSession: 'Consente questa azione e tutte quelle che corrispondono allo schema mostrato sopra, senza chiedere più, '
    + 'fino alla chiusura dell’app. Non viene salvato nelle impostazioni e non vale al prossimo avvio.',
  deny: 'Rifiuta l’azione. Il rifiuto è definitivo per questa richiesta: l’agente non può insistere e deve proseguire senza, '
    + 'segnalandolo tra le cose non verificate.',
  pattern: 'Schema che verrebbe consentito per il resto della sessione scegliendo "Consenti per la sessione". '
    + 'Lo decide l’app in base al comando: qui non è modificabile.',
  countdown: 'Tempo che resta per decidere (si regola in Impostazioni → Autorizzazioni → Timeout). Alla scadenza la '
    + 'richiesta viene negata automaticamente.',
  agentChip: 'Agente che ha chiesto l’autorizzazione: è fermo in attesa della tua risposta.',
  queue: 'Altre richieste in attesa: verranno mostrate una dopo l’altra, appena avrai risposto a questa.',
  cwd: 'Cartella da cui verrebbe eseguito il comando: i percorsi relativi al suo interno partono da qui.',
  tool: 'Strumento che ha generato la richiesta.',
  hits: 'Parti del comando che l’app ha riconosciuto come rischiose: sono il motivo per cui ti sta chiedendo il permesso.',
  askText: 'La risposta va soltanto all’agente che ha fatto la domanda, non agli altri. Cmd/Ctrl+Invio per inviarla.',
  askCancel: 'Chiude senza rispondere (come Esc): l’agente riceve un rifiuto e deve proseguire senza quel dato.',
  askSend: 'Invia la risposta all’agente, che riprende il lavoro da dove si era fermato.',
  toastOpen: 'Apre il link nel browser di sistema: sono ammessi solo indirizzi di opencode.ai.',
  toastClose: 'Chiude questa notifica (scompare comunque da sola dopo qualche secondo).',
};

interface ConfirmOpts {
  title?: string;
  body?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

type Entry =
  | { type: 'permission'; req: PermissionRequest }
  | { type: 'ask'; req: AskUserRequest }
  | { type: 'confirm'; opts: ConfirmOpts; resolve: (v: boolean) => void };

class ModalLayer {
  private readonly layer: HTMLElement;
  private readonly card: HTMLElement;
  private readonly toasts: HTMLElement;
  private queue: Entry[] = [];
  private timer: number | null = null;

  constructor() {
    this.card = h('div', { class: 'modal-card' });
    this.layer = h('div', { class: 'modal-layer', hidden: true }, this.card);
    this.toasts = h('div', { class: 'toast-stack' });
    document.body.appendChild(this.layer);
    document.body.appendChild(this.toasts);
    document.addEventListener('keydown', (ev) => this.onKey(ev), true);
  }

  get isOpen(): boolean {
    return this.queue.length > 0;
  }

  // ------------------------------------------------------------- public API

  pushPermission(req: PermissionRequest): void {
    if (this.queue.some((e) => e.type === 'permission' && e.req.id === req.id)) return;
    this.queue.push({ type: 'permission', req });
    this.render();
  }

  pushAsk(req: AskUserRequest): void {
    if (this.queue.some((e) => e.type === 'ask' && e.req.id === req.id)) return;
    this.queue.push({ type: 'ask', req });
    this.render();
  }

  /** Called on `permission:resolved` / `askUser:resolved`: drop the entry if still queued. */
  drop(kind: 'permission' | 'ask', id: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => !(e.type === kind && e.req.id === id));
    if (this.queue.length !== before) this.render();
  }

  confirm(opts: ConfirmOpts): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.queue.push({ type: 'confirm', opts, resolve });
      this.render();
    });
  }

  /**
   * `url` comes from an `app:toast` carrying an opt-in link (DataPolicyError, §4): it opens
   * through `shell:openExternal`, which the main process restricts to https://opencode.ai/**.
   * URL toasts stay up longer — they are actionable, not informational.
   */
  toast(level: 'info' | 'warn' | 'error', message: string, url?: string): void {
    const el = h('div', { class: 'toast toast-' + level }, h('span', { text: message }));
    const kill = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };
    if (url) {
      el.appendChild(btn('Apri', () => {
        void window.api.invoke('shell:openExternal', url).catch((err: unknown) => {
          this.toast('error', 'Link non aperto: ' + msg(err));
        });
      }, 'btn ghost toast-open', T.toastOpen));
    }
    el.appendChild(iconBtn('✕', T.toastClose, kill, 'toast-x'));
    this.toasts.appendChild(el);
    window.setTimeout(kill, url ? 20000 : 4000);
  }

  // -------------------------------------------------------------- internals

  private onKey(ev: KeyboardEvent): void {
    const head = this.queue[0];
    if (!head) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      if (head.type === 'permission') this.respondPermission(head.req, 'deny');
      else if (head.type === 'ask') this.respondAsk(head.req, null);
      else this.finishConfirm(head, false);
      return;
    }
    if (ev.key === 'Enter' && head.type === 'permission' && !ev.shiftKey) {
      ev.preventDefault();
      this.respondPermission(head.req, 'allow');
    }
  }

  private shift(): void {
    this.queue.shift();
    this.render();
  }

  private respondPermission(req: PermissionRequest, decision: 'allow' | 'allow_session' | 'deny'): void {
    void window.api.invoke('permission:respond', req.id, decision).catch((err: unknown) => {
      this.toast('error', 'Risposta non inviata: ' + msg(err));
    });
    this.shift();
  }

  private respondAsk(req: AskUserRequest, answer: string | null): void {
    void window.api.invoke('askUser:respond', req.id, answer).catch((err: unknown) => {
      this.toast('error', 'Risposta non inviata: ' + msg(err));
    });
    this.shift();
  }

  private finishConfirm(entry: Extract<Entry, { type: 'confirm' }>, value: boolean): void {
    entry.resolve(value);
    this.shift();
  }

  private render(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    clear(this.card);
    const head = this.queue[0];
    if (!head) {
      this.layer.hidden = true;
      this.card.className = 'modal-card';
      return;
    }
    this.layer.hidden = false;
    if (head.type === 'permission') this.renderPermission(head.req);
    else if (head.type === 'ask') this.renderAsk(head.req);
    else this.renderConfirm(head);
  }

  private pendingBadge(): HTMLElement | null {
    const extra = this.queue.length - 1;
    if (extra <= 0) return null;
    return h('span', { class: 'badge queue-badge', text: '+' + extra + ' in attesa', title: T.queue });
  }

  private renderPermission(req: PermissionRequest): void {
    const cls = req.commandClass ?? 'benign';
    const severe = cls === 'privileged' || cls === 'destructive';
    this.card.className = 'modal-card perm-' + cls + (severe ? ' severe' : '');
    this.card.style.setProperty('--agent-color', req.agentColor || '#8b93a7');

    const cd = h('span', { class: 'countdown', text: '', title: T.countdown });
    const tick = () => {
      const left = req.createdAt + req.timeoutMs - Date.now();
      cd.textContent = left > 0 ? 'Scade tra ' + fmtClock(left) : 'Scaduto';
      if (left <= 30_000) cd.classList.add('urgent');
    };
    tick();
    this.timer = window.setInterval(tick, 1000);

    const d = req.detail;
    const target = d.command ?? d.path ?? '';
    const targetHelp = d.command
      ? 'Comando esatto che verrebbe eseguito, senza modifiche: se qualcosa non ti torna, nega.'
      : 'Percorso su cui l’agente vuole agire: è fuori dalla cartella di lavoro o protetto, per questo serve il tuo permesso.';
    const hits = (d.hits ?? []).map((hit) => h('span', { class: 'hit', text: hit, title: T.hits }));

    // The session pattern is shown read-only: `permission:respond` carries only the decision,
    // so an edited pattern could not reach the main process (see report note).
    const pattern = req.sessionPattern;

    this.card.appendChild(
      h('div', { class: 'modal-head' },
        h('span', { class: 'agent-chip', title: T.agentChip },
          h('span', { class: 'dot' }),
          h('span', { text: req.agentName || 'Agente' })),
        h('span', { class: 'modal-title', text: KIND_TITLE[req.kind] ?? 'Autorizzazione richiesta' }),
        req.kind === 'command'
          ? h('span', { class: 'badge cls-badge', text: CLASS_LABEL[cls], title: CLASS_HELP[cls] })
          : null,
        this.pendingBadge(),
        cd,
      ),
    );
    this.card.appendChild(h('div', {
      class: 'modal-summary', text: req.summary,
      title: 'Che cosa farebbe l’agente se concedi: finché non rispondi resta fermo qui.',
    }));
    if (target) this.card.appendChild(h('pre', { class: 'modal-pre', text: target, title: targetHelp }));
    if (d.cwd) this.card.appendChild(h('div', { class: 'modal-meta', text: 'cwd: ' + d.cwd, title: T.cwd }));
    if (d.tool) this.card.appendChild(h('div', { class: 'modal-meta', text: 'strumento: ' + d.tool, title: T.tool }));
    if (hits.length) this.card.appendChild(h('div', { class: 'hits', title: T.hits }, hits));
    if (severe) {
      this.card.appendChild(
        h('div', {
          class: 'modal-warn', text: 'Questa azione può modificare il sistema. Concedila solo se sai cosa fa.',
          title: 'Comando ' + CLASS_LABEL[cls] + ': per queste azioni non esiste il consenso per la sessione, ogni volta ti verrà richiesto.',
        }),
      );
    }
    if (pattern) {
      this.card.appendChild(
        h('div', { class: 'modal-field', title: T.pattern },
          h('span', { class: 'lbl', text: 'Schema consentito per la sessione' }),
          h('code', { class: 'pattern', text: pattern, title: T.pattern })),
      );
    }
    const actions = h('div', { class: 'modal-actions' },
      btn('Nega', () => this.respondPermission(req, 'deny'), 'btn ghost danger', T.deny),
      pattern
        ? btn('Consenti per la sessione', () => this.respondPermission(req, 'allow_session'), 'btn ghost', T.allowSession)
        : null,
      btn('Consenti', () => this.respondPermission(req, 'allow'), 'btn primary', T.allow + ' (Invio)'),
    );
    this.card.appendChild(actions);
    (actions.lastElementChild as HTMLElement | null)?.focus();
  }

  private renderAsk(req: AskUserRequest): void {
    this.card.className = 'modal-card ask';
    this.card.style.setProperty('--agent-color', req.agentColor || '#8b93a7');
    const ta = h('textarea', { class: 'input area', rows: 4, placeholder: 'La tua risposta…', spellcheck: false, title: T.askText });

    const cd = h('span', { class: 'countdown', title: T.countdown });
    const tick = () => {
      const left = req.createdAt + req.timeoutMs - Date.now();
      cd.textContent = left > 0 ? 'Scade tra ' + fmtClock(left) : 'Scaduto';
    };
    tick();
    this.timer = window.setInterval(tick, 1000);

    this.card.appendChild(
      h('div', { class: 'modal-head' },
        h('span', { class: 'agent-chip', title: 'Agente che ha fatto la domanda: è fermo in attesa della tua risposta.' },
          h('span', { class: 'dot' }), h('span', { text: req.agentName || 'Agente' })),
        h('span', { class: 'modal-title', text: 'Domanda dall’agente' }),
        this.pendingBadge(),
        cd,
      ),
    );
    this.card.appendChild(h('div', {
      class: 'modal-question', text: req.question,
      title: 'L’agente chiede solo quando un’ambiguità cambierebbe il risultato: rispondere evita che lavori su un’ipotesi sbagliata.',
    }));
    if (req.options?.length) {
      this.card.appendChild(
        h('div', { class: 'opt-row' },
          req.options.map((o) => btn(o, () => this.respondAsk(req, o), 'btn ghost opt',
            'Risponde "' + o + '" e fa riprendere subito l’agente.'))),
      );
    }
    this.card.appendChild(ta);
    this.card.appendChild(
      h('div', { class: 'modal-actions' },
        btn('Annulla', () => this.respondAsk(req, null), 'btn ghost', T.askCancel),
        btn('Rispondi', () => this.respondAsk(req, ta.value.trim() || null), 'btn primary', T.askSend + ' (Cmd/Ctrl+Invio)'),
      ),
    );
    ta.focus();
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        this.respondAsk(req, ta.value.trim() || null);
      }
    });
  }

  private renderConfirm(entry: Extract<Entry, { type: 'confirm' }>): void {
    const o = entry.opts;
    this.card.className = 'modal-card confirm' + (o.danger ? ' severe' : '');
    this.card.appendChild(
      h('div', { class: 'modal-head' }, h('span', { class: 'modal-title', text: o.title ?? 'Confermi?' }), this.pendingBadge()),
    );
    if (o.body) this.card.appendChild(h('div', { class: 'modal-question', text: o.body }));
    const actions = h('div', { class: 'modal-actions' },
      btn(o.cancelLabel ?? 'Annulla', () => this.finishConfirm(entry, false), 'btn ghost',
        'Chiude senza fare nulla (anche con Esc).'),
      btn(o.okLabel ?? 'Conferma', () => this.finishConfirm(entry, true), 'btn primary' + (o.danger ? ' danger' : ''),
        o.danger ? 'Esegue l’operazione descritta: non si può annullare.' : 'Esegue l’operazione descritta qui sopra.'),
    );
    this.card.appendChild(actions);
    (actions.lastElementChild as HTMLElement | null)?.focus();
  }
}

function msg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

let layer: ModalLayer | null = null;
function get(): ModalLayer {
  if (!layer) layer = new ModalLayer();
  return layer;
}

export const modals = {
  permission: (req: PermissionRequest): void => get().pushPermission(req),
  ask: (req: AskUserRequest): void => get().pushAsk(req),
  drop: (kind: 'permission' | 'ask', id: string): void => get().drop(kind, id),
  confirm: (opts: ConfirmOpts): Promise<boolean> => get().confirm(opts),
  toast: (level: 'info' | 'warn' | 'error', message: string, url?: string): void => get().toast(level, message, url),
  get open(): boolean {
    return get().isOpen;
  },
};

export function toast(level: 'info' | 'warn' | 'error', message: string, url?: string): void {
  modals.toast(level, message, url);
}

export function errText(err: unknown): string {
  return msg(err);
}
