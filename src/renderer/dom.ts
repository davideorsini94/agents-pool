// Tiny DOM helper layer + formatters. No dependencies, no innerHTML: every node is built
// programmatically so the strict CSP (script-src 'self'; style-src 'self') is never violated.
// Inline colours are applied through the CSSOM (element.style.setProperty), which CSP allows.

import type { AgentRole, Budget, ModelInfo, ModelPrivacy, Usage } from '../shared/types';

export type Child = Node | string | number | null | undefined | false | Child[];

export interface ElProps {
  class?: string;
  id?: string;
  title?: string;
  text?: string;
  type?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  rows?: number;
  min?: string;
  max?: string;
  step?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  spellcheck?: boolean;
  tabIndex?: number;
  hidden?: boolean;
  data?: Record<string, string>;
  aria?: Record<string, string>;
  /** Applied via CSSOM (CSP-safe), keys may be custom properties like `--agent-color`. */
  style?: Record<string, string>;
  on?: Record<string, EventListener>;
}

function appendChild(parent: Node, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) {
    for (const sub of c) appendChild(parent, sub);
    return;
  }
  if (typeof c === 'string' || typeof c === 'number') {
    parent.appendChild(document.createTextNode(String(c)));
    return;
  }
  parent.appendChild(c);
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    if (props.class !== undefined) el.className = props.class;
    if (props.id !== undefined) el.id = props.id;
    if (props.title !== undefined) el.title = props.title;
    if (props.text !== undefined) el.textContent = props.text;
    if (props.hidden !== undefined) el.hidden = props.hidden;
    if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex;
    if (props.spellcheck !== undefined) el.spellcheck = props.spellcheck;
    if (props.type !== undefined) el.setAttribute('type', props.type);
    if (props.name !== undefined) el.setAttribute('name', props.name);
    if (props.placeholder !== undefined) el.setAttribute('placeholder', props.placeholder);
    if (props.rows !== undefined) el.setAttribute('rows', String(props.rows));
    if (props.min !== undefined) el.setAttribute('min', props.min);
    if (props.max !== undefined) el.setAttribute('max', props.max);
    if (props.step !== undefined) el.setAttribute('step', props.step);
    if (props.href !== undefined) el.setAttribute('href', props.href);
    if (props.value !== undefined) {
      const anyEl = el as unknown as { value: string };
      anyEl.value = props.value;
      if (tag === 'input') el.setAttribute('value', props.value);
    }
    if (props.checked !== undefined) (el as unknown as { checked: boolean }).checked = props.checked;
    if (props.disabled !== undefined) (el as unknown as { disabled: boolean }).disabled = props.disabled;
    if (props.readOnly !== undefined) (el as unknown as { readOnly: boolean }).readOnly = props.readOnly;
    if (props.data) for (const [k, v] of Object.entries(props.data)) el.dataset[k] = v;
    if (props.aria) for (const [k, v] of Object.entries(props.aria)) el.setAttribute('aria-' + k, v);
    if (props.style) for (const [k, v] of Object.entries(props.style)) el.style.setProperty(k, v);
    if (props.on) for (const [k, v] of Object.entries(props.on)) el.addEventListener(k, v);
  }
  for (const c of children) appendChild(el, c);
  return el;
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children) appendChild(f, c);
  return f;
}

export function clear(el: Node): void {
  // Removing a focused node fires blur synchronously, and a blur handler may re-enter and
  // detach further nodes: never assume `firstChild` is still ours (NotFoundError otherwise).
  while (el.firstChild) {
    const child: ChildNode = el.firstChild;
    if (child.parentNode === el) el.removeChild(child);
    else child.remove();
  }
}

export function replace(el: Node, ...children: Child[]): void {
  clear(el);
  for (const c of children) appendChild(el, c);
}

/** Icon button used across the UI (unicode glyphs only — no external font/CDN). */
export function iconBtn(glyph: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', {
    class: ('icon-btn ' + cls).trim(),
    title,
    type: 'button',
    aria: { label: title },
    on: { click: () => onClick() },
  }, glyph);
}

export function btn(
  label: string,
  onClick: () => void,
  cls = 'btn',
  title?: string,
): HTMLButtonElement {
  return h('button', { class: cls, type: 'button', title, on: { click: () => onClick() } }, label);
}

/**
 * Native tooltip on an element, inline inside an `h(...)` tree: `tip(sel, 'che cosa fa')`.
 * Deliberately the only tooltip mechanism in the app — no custom layer, no library.
 */
export function tip<T extends HTMLElement>(el: T, title: string): T {
  el.title = title;
  return el;
}

/**
 * `<label class="field">` used by the wizard and the settings drawer. The help text lands on
 * the wrapper *and* on every control inside that has none yet, so hovering the label, the hint
 * or the input all show the same explanation (icon buttons keep their own, more specific one).
 */
export function field(
  label: string,
  title: string,
  opts: { cls?: string; hint?: string } | null,
  ...controls: Child[]
): HTMLLabelElement {
  const el = h('label', { class: opts?.cls ?? 'field', title },
    h('span', { class: 'lbl', text: label }),
    ...controls,
    opts?.hint ? h('span', { class: 'hint', text: opts.hint }) : null);
  for (const c of Array.from(el.querySelectorAll('input,select,textarea,button'))) {
    const ctrl = c as HTMLElement;
    if (!ctrl.title) ctrl.title = title;
  }
  return el;
}

// ---------------------------------------------------------------- formatters

export function fmtTokens(n: number | undefined): string {
  if (n === undefined || n === null || !isFinite(n)) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  return (n / 1_000_000).toFixed(1) + 'M';
}

export function fmtCost(cost: number | undefined, estimated = false): string {
  const v = typeof cost === 'number' && isFinite(cost) ? cost : 0;
  const s = v >= 1 ? '$' + v.toFixed(2) : '$' + v.toFixed(4);
  return estimated ? '~' + s : s;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !isFinite(ms)) return '—';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + ' s';
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return m + ' m ' + String(s).padStart(2, '0') + ' s';
}

export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (v: number) => String(v).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** Friendly model label: `name · $in/$out per M · 128k ctx` (parts present only when known). */
export function modelLabel(m: ModelInfo): string {
  const parts: string[] = [m.name || m.id];
  if (typeof m.costIn === 'number' || typeof m.costOut === 'number') {
    const i = typeof m.costIn === 'number' ? '$' + m.costIn : '—';
    const o = typeof m.costOut === 'number' ? '$' + m.costOut : '—';
    parts.push(i + '/' + o + ' per M');
  }
  if (typeof m.contextLimit === 'number' && m.contextLimit > 0) parts.push(fmtTokens(m.contextLimit) + ' ctx');
  if (typeof m.reqPer5h === 'number' && m.reqPer5h > 0) parts.push(m.reqPer5h.toLocaleString('it-IT') + ' req/5h');
  if (m.reasoning) parts.push('ragionamento');
  if (m.unavailable) parts.push('non disponibile in questa sessione');
  return parts.join(' · ');
}

// ------------------------------------------------------- roles / model badges

export const ROLE_LABEL: Record<AgentRole, string> = {
  orchestrator: 'Orchestratore',
  planner: 'Planner',
  worker: 'Worker',
  verifier: 'Verificatore',
};

export const ROLE_ORDER: AgentRole[] = ['orchestrator', 'planner', 'worker', 'verifier'];

/**
 * Role of a template / instance view. `role` is optional in the contract until Workstream A
 * fills it in (types.d.ts TODO(v2-A)), so v1 configs degrade to main ⇒ orchestrator, else worker.
 */
export function roleOf(a: { role?: AgentRole; isMain?: boolean }): AgentRole {
  return a.role ?? (a.isMain ? 'orchestrator' : 'worker');
}

interface BadgeSpec { text: string; cls: string; title: string }

const PRIVACY_BADGE: Record<ModelPrivacy, BadgeSpec> = {
  zdr: { text: 'ZDR', cls: 'ok', title: 'Zero Data Retention: prompt e risposte non vengono conservati.' },
  zdr_verify: {
    text: 'ZDR fino al 31/08/2026 · conferma rinnovo',
    cls: 'warn',
    title: 'L’accordo Zero Data Retention risulta valido fino al 31/08/2026: verifica il rinnovo prima di inviare dati sensibili.',
  },
  retention_30d: { text: 'conservazione 30 gg', cls: 'warn', title: 'Il fornitore conserva prompt e risposte per 30 giorni.' },
  training: {
    text: 'addestramento dati',
    cls: 'bad',
    title: 'Prompt e risposte vengono usati per addestrare modelli di terze parti: non usarlo con contenuti proprietari o clinici.',
  },
};

export function privacyBadge(m: ModelInfo | undefined | null): HTMLElement | null {
  if (!m) return null;
  const spec = PRIVACY_BADGE[m.privacy ?? 'zdr'];
  return h('span', { class: 'badge priv ' + spec.cls, title: spec.title, text: spec.text });
}

/** `responses` models talk to a different API surface — worth showing, never blocking. */
export function formatBadge(m: ModelInfo | undefined | null): HTMLElement | null {
  if (!m || (m.format ?? 'chat') !== 'responses') return null;
  return h('span', { class: 'badge fmt', title: 'Usa l’API /responses di OpenCode Go.', text: 'responses' });
}

/** Lenient-JSON models are fine as orchestrator (tool driven), risky as JSON workers. */
export function jsonBadge(m: ModelInfo | undefined | null, role?: AgentRole): HTMLElement | null {
  if (!m || m.jsonStrict !== false || role === 'orchestrator') return null;
  return h('span', {
    class: 'badge priv warn', text: 'JSON non stretto',
    title: 'Questo modello avvolge il JSON in prosa: il ResultContract viene estratto dal testo (funziona, ma è meno affidabile).',
  });
}

/** Token-hungry models produce nothing under a small budget → amber chip. */
export function notesBadge(m: ModelInfo | undefined | null): HTMLElement | null {
  if (!m) return null;
  const notes = m.notes ?? '';
  const hungry = /token-hungry|molti token|nulla sotto/i.test(notes) || /^mimo-/.test(m.id);
  if (!hungry) return null;
  return h('span', {
    class: 'badge priv warn', text: 'molti token',
    title: notes || 'Consuma molti token di ragionamento: con budget piccoli può non produrre nulla.',
  });
}

/** Every badge the routing editor shows for one model, in a stable order. */
export function modelBadges(m: ModelInfo | undefined | null, role?: AgentRole): HTMLElement[] {
  if (!m) return [];
  const out: Array<HTMLElement | null> = [privacyBadge(m), formatBadge(m), jsonBadge(m, role), notesBadge(m)];
  if (m.unavailable) {
    out.push(h('span', {
      class: 'badge priv dim', text: 'non disponibile',
      title: m.notes ? 'Non disponibile in questa sessione · ' + m.notes : 'Non disponibile in questa sessione.',
    }));
  }
  return out.filter((x): x is HTMLElement => x !== null);
}

/** `tok 3.1k/8k · strumenti 2/10 · 41 s/180 s` — u = live usage, b = budget, s = counters. */
export function fmtBudget(
  u: Usage | undefined,
  b: Budget | undefined,
  s: { toolCalls: number; elapsedMs: number },
): string {
  const tok = (u?.promptTokens ?? 0) + (u?.completionTokens ?? 0);
  const secs = Math.max(0, Math.round(s.elapsedMs / 1000));
  return [
    'tok ' + fmtTokens(tok) + (b ? '/' + fmtTokens(b.maxTokens) : ''),
    'strumenti ' + s.toolCalls + (b ? '/' + b.maxToolCalls : ''),
    secs + ' s' + (b ? '/' + b.maxSeconds + ' s' : ''),
  ].join(' · ');
}

/** `minimax-m3 → mimo-v2.5, qwen3.7-plus ↑ glm-5.3` (fallback chain, then escalation). */
export function routingSummary(a: { model: string; fallbacks?: string[]; escalation?: string }): string {
  let s = a.model || '—';
  const fb = (a.fallbacks ?? []).filter(Boolean);
  if (fb.length) s += ' → ' + fb.join(', ');
  if (a.escalation) s += ' ↑ ' + a.escalation;
  return s;
}

/** Pretty-print a contract / verdict object; never throws. */
export function prettyJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

const DESC_LINE = /^(description|descrizione)\s*:\s*(.+)$/im;

/** Mirrors config.ts §2.5 so the wizard/settings can preview the derived description. */
export function deriveDescription(prompt: string): string {
  const m = DESC_LINE.exec(prompt || '');
  if (m && m[2]) return truncate(m[2].trim(), 80);
  const first = (prompt || '').split('\n').map((l) => l.replace(/^[\s#*>-]+/, '').trim()).find((l) => l.length > 0);
  return first ? truncate(first, 80) : '';
}

/** Writes an explicit `descrizione:` line into the prompt (§2.5 convention). */
export function withDescription(prompt: string, description: string): string {
  const desc = description.trim();
  const body = prompt || '';
  if (!desc) return body;
  if (DESC_LINE.test(body)) return body.replace(DESC_LINE, 'descrizione: ' + desc);
  return 'descrizione: ' + desc + (body.trim() ? '\n' + body.replace(/^\n+/, '') : '');
}

/** Pretty-print JSON-ish tool arguments; falls back to the raw string. */
export function prettyArgs(argsRaw: string, args?: Record<string, unknown>): string {
  if (args && typeof args === 'object') {
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      /* fall through */
    }
  }
  const raw = (argsRaw || '').trim();
  if (!raw) return '{}';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// ------------------------------------------------------------ markdown-lite

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;

function inlineNodes(line: string): Child[] {
  const out: Child[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(line.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(h('code', { class: 'md-code', text: tok.slice(1, -1) }));
    else if (tok.startsWith('**')) out.push(h('strong', { text: tok.slice(2, -2) }));
    else out.push(h('em', { text: tok.slice(1, -1) }));
    last = idx + tok.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

/**
 * Markdown-lite → DOM: fenced code blocks, paragraphs (pre-wrap), headings,
 * bullet lines, inline code, bold, italic. Deliberately small; never uses innerHTML.
 */
export function renderMarkdown(raw: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const parts = raw.split(/```/);
  for (let i = 0; i < parts.length; i++) {
    const chunk = parts[i] ?? '';
    if (i % 2 === 1) {
      // fenced code: first line may be a language hint
      const nl = chunk.indexOf('\n');
      const lang = nl >= 0 ? chunk.slice(0, nl).trim() : '';
      const code = nl >= 0 ? chunk.slice(nl + 1) : chunk;
      const pre = h('pre', { class: 'md-pre' }, h('code', { text: code.replace(/\n$/, '') }));
      if (lang && /^[\w+#.-]{1,20}$/.test(lang)) pre.appendChild(h('span', { class: 'md-lang', text: lang }));
      out.appendChild(pre);
      continue;
    }
    if (!chunk.trim()) continue;
    for (const block of chunk.split(/\n{2,}/)) {
      if (!block.trim()) continue;
      const lines = block.split('\n');
      const table = renderTable(lines);
      if (table) { out.appendChild(table); continue; }
      const p = h('div', { class: 'md-p' });
      lines.forEach((line, li) => {
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^\s*([-*•]|\d+\.)\s+(.*)$/.exec(line);
        if (heading) {
          p.appendChild(h('div', { class: 'md-h' }, inlineNodes(heading[2] ?? '')));
        } else if (bullet) {
          p.appendChild(h('div', { class: 'md-li' }, h('span', { class: 'md-bul', text: '•' }), inlineNodes(bullet[2] ?? '')));
        } else {
          if (li > 0 && p.lastChild && !(p.lastChild as HTMLElement).classList?.contains('md-li')) {
            p.appendChild(document.createTextNode('\n'));
          }
          for (const n of inlineNodes(line)) appendChild(p, n);
        }
      });
      out.appendChild(p);
    }
  }
  return out;
}

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.map((c) => c.trim());
}

/** GitHub-flavoured table (header, separator, rows) → <div.md-table-wrap><table>; null if not a table. */
function renderTable(lines: string[]): HTMLElement | null {
  if (lines.length < 2 || !lines[0]!.includes('|') || !TABLE_SEP.test(lines[1]!)) return null;
  const header = splitRow(lines[0]!);
  const aligns = splitRow(lines[1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'md-center' : c.endsWith(':') ? 'md-right' : ''));
  const cell = (tag: 'th' | 'td', text: string, i: number) => {
    const el = h(tag, {}, inlineNodes(text));
    if (aligns[i]) el.classList.add(aligns[i]!);
    return el;
  };
  const thead = h('thead', {}, h('tr', {}, header.map((t, i) => cell('th', t, i))));
  const tbody = h('tbody');
  for (const line of lines.slice(2)) {
    if (!line.trim()) continue;
    const cells = splitRow(line);
    tbody.appendChild(h('tr', {}, header.map((_, i) => cell('td', cells[i] ?? '', i))));
  }
  return h('div', { class: 'md-table-wrap' }, h('table', { class: 'md-table' }, thead, tbody));
}

/** requestAnimationFrame-batched writer: one flush per frame, shared by all consoles. */
export class RafBatch {
  private queued = false;
  private readonly jobs = new Set<() => void>();

  add(job: () => void): void {
    this.jobs.add(job);
    if (this.queued) return;
    this.queued = true;
    const run = () => {
      if (!this.queued) return; // whichever of rAF / timeout fires first wins
      this.queued = false;
      const jobs = [...this.jobs];
      this.jobs.clear();
      for (const j of jobs) {
        try {
          j();
        } catch (err) {
          console.error('[renderer] flush failed', err);
        }
      }
    };
    requestAnimationFrame(run);
    // rAF never fires while the window is hidden/occluded (minimised Electron window):
    // without this fallback the buffer would grow until the window is shown again.
    setTimeout(run, 120);
  }
}

export const raf = new RafBatch();
