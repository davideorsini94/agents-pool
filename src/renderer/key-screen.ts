// KeyScreen: first run (or after `key:clear`). Validates the OpenCode Go API key through
// the main process — the key itself never lives in renderer state longer than the request.

import type { AppInfo, KeyValidationResult } from '../shared/types';
import { btn, h, replace } from './dom.js';
import { errText } from './modals.js';

const REASON_TEXT: Record<string, string> = {
  auth: 'Chiave non valida',
  network: 'Nessuna connessione a opencode.ai — controlla la rete',
  rate_limit: 'Limite di utilizzo raggiunto, riprova tra poco',
  model: 'Modello di verifica non disponibile',
};

export interface KeyScreenHooks {
  onValidated(): void;
}

export class KeyScreen {
  readonly root: HTMLElement;

  private readonly input: HTMLInputElement;
  private readonly errBox: HTMLElement;
  private readonly primary: HTMLButtonElement;
  private readonly secondary: HTMLButtonElement;
  private readonly spinner: HTMLElement;
  private readonly hooks: KeyScreenHooks;
  private readonly probeModel: string;
  private busy = false;

  constructor(info: AppInfo, hooks: KeyScreenHooks) {
    this.hooks = hooks;
    this.probeModel = info.probeModel;
    this.input = h('input', {
      class: 'input key', type: 'password', placeholder: 'sk-…', spellcheck: false,
      title: 'Incolla qui la API key di OpenCode Go (inizia con "sk-"). Viene inviata a opencode.ai solo per '
        + 'la verifica e poi salvata su questo computer, cifrata quando il sistema lo consente. Invio per validare.',
      aria: { label: 'API key di OpenCode Go' },
    });
    const eye = h('button', {
      class: 'icon-btn reveal', type: 'button',
      title: 'Mostra o nasconde i caratteri della chiave: utile per controllare un incollaggio, evitalo se qualcuno guarda lo schermo.',
      aria: { label: 'Mostra o nascondi la chiave' },
    }, '👁');
    eye.addEventListener('click', () => {
      const shown = this.input.getAttribute('type') === 'text';
      this.input.setAttribute('type', shown ? 'password' : 'text');
      eye.textContent = shown ? '👁' : '🚫';
    });
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        void this.validate();
      }
    });
    this.input.addEventListener('input', () => {
      this.errBox.hidden = true;
    });

    this.errBox = h('div', { class: 'err', hidden: true });
    this.spinner = h('span', { class: 'spinner', hidden: true });
    this.primary = btn('Valida e continua', () => void this.validate(), 'btn primary wide',
      'Prova la chiave con una vera chiamata al modello di verifica'
      + (this.probeModel ? ' (' + this.probeModel + ')' : '')
      + ': se risponde, la chiave viene salvata e si passa alla configurazione del pool.');
    this.secondary = btn('Importa da opencode CLI', () => void this.importKey(), 'btn ghost wide',
      'Riprende la chiave già salvata dalla CLI opencode su questo computer (~/.local/share/opencode/auth.json) '
      + 'e la valida: non serve incollarla a mano.');

    this.root = h('div', { class: 'screen center' },
      h('div', { class: 'card key-card' },
        h('div', { class: 'brand' }, 'Agents ', h('span', { class: 'accent', text: 'Pool' })),
        h('p', { class: 'lead', text: 'Inserisci la tua API key di OpenCode Go per iniziare.' }),
        h('div', { class: 'key-row' }, this.input, eye),
        this.errBox,
        h('div', { class: 'key-actions' }, this.primary, this.secondary, this.spinner),
        h('p', { class: 'hint', text: 'La chiave resta sul tuo computer, cifrata quando il sistema lo consente. Verifica su opencode.ai.' }),
        h('p', { class: 'hint dim', text: 'v' + info.version + ' · ' + info.platform + '/' + info.arch }),
      ));
  }

  focus(): void {
    this.input.focus();
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.spinner.hidden = !on;
    this.primary.disabled = on;
    this.secondary.disabled = on;
    this.input.disabled = on;
    this.primary.textContent = on ? 'Verifica in corso…' : 'Valida e continua';
  }

  private showError(text: string, detail?: string): void {
    replace(this.errBox, h('strong', { text }), detail ? h('span', { class: 'detail', text: detail }) : null);
    this.errBox.hidden = false;
  }

  private handle(res: KeyValidationResult): void {
    if (res.ok) {
      this.errBox.hidden = true;
      this.hooks.onValidated();
      return;
    }
    let base = REASON_TEXT[res.reason] ?? res.message ?? 'Verifica non riuscita';
    if (res.reason === 'model' && this.probeModel) base += ' (' + this.probeModel + ')';
    this.showError(base, res.reason === 'unknown' ? undefined : res.message);
  }

  private async validate(): Promise<void> {
    if (this.busy) return;
    const key = this.input.value.trim();
    if (!key) {
      this.showError('Inserisci una chiave');
      return;
    }
    this.setBusy(true);
    try {
      this.handle(await window.api.invoke('key:set', key));
    } catch (e) {
      this.showError('Verifica non riuscita', errText(e));
    } finally {
      this.setBusy(false);
    }
  }

  private async importKey(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    try {
      this.handle(await window.api.invoke('key:importFromOpencode'));
    } catch (e) {
      this.showError('Importazione non riuscita', errText(e));
    } finally {
      this.setBusy(false);
    }
  }
}
