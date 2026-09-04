// Renderer bootstrap: subscribe to every EventMap channel first (so nothing is missed while
// history loads), then route to KeyScreen / SetupWizard / Workbench and dispatch events.

import type { AppInfo, ConfigSnapshot } from '../shared/types';
import { btn, h, replace } from './dom.js';
import { KeyScreen } from './key-screen.js';
import { modals, toast } from './modals.js';
import { SetupWizard } from './wizard.js';
import { Workbench } from './workbench.js';

const mount = document.getElementById('app') as HTMLElement | null;

class App {
  private readonly mount: HTMLElement;
  private workbench: Workbench | null = null;
  private routing = false;

  constructor(mountEl: HTMLElement) {
    this.mount = mountEl;
  }

  async boot(): Promise<void> {
    this.subscribe();
    await this.route();
  }

  // ------------------------------------------------------------ subscriptions

  private subscribe(): void {
    window.api.on('console:event', (ev) => this.workbench?.onConsoleEvent(ev));
    window.api.on('console:patch', (p) => this.workbench?.onConsolePatch(p));
    // Ephemeral worker instances: `console:add` always precedes their first event (§3).
    window.api.on('console:add', (v) => this.workbench?.onConsoleAdd(v));
    window.api.on('console:remove', (r) => this.workbench?.onConsoleRemove(r));
    window.api.on('agent:status', (u) => this.workbench?.onAgentStatus(u));
    window.api.on('run:finished', (r) => this.workbench?.onRunFinished(r));
    window.api.on('config:changed', (c) => {
      if (!c.snapshot.setupComplete) {
        void this.route(); // resetAll → back to the wizard
        return;
      }
      if (!this.workbench) {
        void this.route(); // setup just completed elsewhere
        return;
      }
      this.workbench.onConfigChanged(c);
    });
    window.api.on('permission:request', (req) => modals.permission(req));
    window.api.on('permission:resolved', (r) => modals.drop('permission', r.requestId));
    window.api.on('askUser:request', (req) => modals.ask(req));
    window.api.on('askUser:resolved', (r) => modals.drop('ask', r.requestId));
    window.api.on('app:toast', (t) => toast(t.level, t.message, t.url));
  }

  // ------------------------------------------------------------------ routing

  async route(): Promise<void> {
    if (this.routing) return;
    this.routing = true;
    try {
      const info = await window.api.invoke('app:getInfo');
      if (!info.hasApiKey) {
        const screen = new KeyScreen(info, { onValidated: () => void this.route() });
        this.show(screen);
        screen.focus();
        return;
      }
      const snapshot = await window.api.invoke('config:get');
      if (!snapshot.setupComplete) {
        this.show(new SetupWizard(info, { onComplete: (snap) => void this.showWorkbench(info, snap) }));
        return;
      }
      await this.showWorkbench(info, snapshot);
    } catch (err) {
      this.fatal(err);
    } finally {
      this.routing = false;
    }
  }

  private async showWorkbench(info: AppInfo, snapshot: ConfigSnapshot): Promise<void> {
    const wb = new Workbench(info, snapshot, {
      onKeyCleared: () => void this.route(),
      onReset: () => void this.route(),
    });
    this.show(wb);
    this.workbench = wb;
    await wb.init();
  }

  private show(view: { root: HTMLElement }): void {
    if (this.workbench && this.workbench !== view) {
      this.workbench.destroy();
      this.workbench = null;
    }
    replace(this.mount, view.root);
  }

  private fatal(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    replace(this.mount,
      h('div', { class: 'screen center' },
        h('div', { class: 'card' },
          h('div', { class: 'brand sm' }, 'Agents ', h('span', { class: 'accent', text: 'Pool' })),
          h('div', { class: 'err' }, h('strong', { text: 'Avvio non riuscito' }), h('span', { class: 'detail', text: message })),
          btn('Riprova', () => void this.route(), 'btn primary wide',
            'Ricarica configurazione e stato dal processo principale: utile se l’errore era temporaneo. Nessun dato viene perso.'))));
  }
}

function noApi(el: HTMLElement): void {
  replace(el,
    h('div', { class: 'screen center' },
      h('div', { class: 'card' },
        h('div', { class: 'brand sm' }, 'Agents ', h('span', { class: 'accent', text: 'Pool' })),
        h('div', { class: 'err' },
          h('strong', { text: 'Ponte IPC non disponibile' }),
          h('span', { class: 'detail', text: 'window.api non è stato esposto: apri l’app con "npm start" invece di caricare il file nel browser.' })))));
}

if (mount) {
  if (typeof window.api === 'undefined') {
    noApi(mount);
  } else {
    const app = new App(mount);
    window.addEventListener('error', (ev) => toast('error', 'Errore interfaccia: ' + ev.message));
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = (ev as PromiseRejectionEvent).reason;
      toast('error', 'Errore: ' + (reason instanceof Error ? reason.message : String(reason)));
    });
    void app.boot();
  }
}
