// Path sandbox, command classifier and the permission gate. PLAN §6.1, §6.2, §7.
// IMPORTANT: no 'electron' import — scripts/api-smoke.mjs loads this file in a plain Node process.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentId, AgentStatus, AppConfig, AskUserRequest, CommandClass, PermissionDecision,
  PermissionKind, PermissionMode, PermissionOutcome, PermissionRequest,
} from '../shared/types';
import type { ConsoleBus } from './state';
import { Send, log, newId, truncate } from './util';

// ================================================================ path sandbox

export interface ResolvedPath {
  input: string;
  abs: string;
  real: string;
  inside: boolean;
  isProtected: boolean;
  hits: string[];
}

const extraProtected: string[] = [];
/** main.ts registers our own userData/config.json (PLAN §6.1 point 4). */
export function registerProtectedPaths(paths: string[]): void {
  for (const p of paths) if (p) extraProtected.push(path.resolve(p));
}

const isWin = process.platform === 'win32';
/** Windows paths compare case-insensitively with unified separators (PLAN §6.1 point 3). */
function norm(p: string): string { return isWin ? p.replace(/\//g, '\\').toLowerCase() : p; }

function realpathDeepest(abs: string): string {
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isUnder(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent).replace(/[/\\]+$/, '');
  if (!p) return false;
  return c === p || c.startsWith(p + path.sep) || c.startsWith(p + '/');
}

/** Resolves a tool path against the workspace, defeating `..` and symlink escapes. */
export function resolvePath(p: string, workspace: string | null): ResolvedPath {
  const home = os.homedir();
  const input = String(p ?? '');
  let expanded = input;
  if (expanded === '~') expanded = home;
  else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) expanded = path.join(home, expanded.slice(2));
  const base = workspace || process.cwd();
  const abs = path.resolve(base, expanded);
  const real = realpathDeepest(abs);
  const wsReal = workspace ? realpathDeepest(workspace) : null;
  const inside = !!wsReal && isUnder(real, wsReal);
  const hits = protectedHits(abs, real, inside, home);
  return { input, abs, real, inside, isProtected: hits.length > 0, hits };
}

/**
 * Candidate spellings of the same path: the resolved one, the literal one, and the
 * /private-stripped variant (on macOS /etc, /tmp and /var are symlinks into /private).
 */
function pathVariants(abs: string, real: string): string[] {
  const out = new Set<string>();
  for (const p of [real, abs]) {
    out.add(p);
    if (p.startsWith('/private/')) out.add(p.slice('/private'.length));
    else out.add(`/private${p}`);
  }
  return [...out];
}

function protectedHits(abs: string, real: string, inside: boolean, home: string): string[] {
  const hits: string[] = [];
  const cands = pathVariants(abs, real);
  const homes = pathVariants(home, realpathDeepest(home));
  const anyUnder = (dir: string): boolean => cands.some((c) => isUnder(c, dir));
  const anyIs = (file: string): boolean => cands.some((c) => norm(c) === norm(file));
  const anyMatch = (re: RegExp): boolean => cands.some((c) => re.test(c));

  const dirs: Array<[string, string]> = [];
  for (const h of homes) {
    dirs.push([path.join(h, '.ssh'), 'ssh']);
    dirs.push([path.join(h, '.aws'), 'aws']);
    dirs.push([path.join(h, '.gnupg'), 'gnupg']);
    dirs.push([path.join(h, '.config', 'gcloud'), 'gcloud']);
    dirs.push([path.join(h, 'Library', 'Keychains'), 'keychain']);
  }
  for (const [dir, label] of dirs) if (anyUnder(dir)) hits.push(label);

  for (const h of homes) if (anyIs(path.join(h, '.kube', 'config'))) hits.push('kubeconfig');
  if (anyIs('/etc/shadow')) hits.push('etc-shadow');
  if (anyMatch(/^\/etc\/sudoers/i)) hits.push('sudoers');
  for (const h of homes) {
    if (anyUnder(path.join(h, '.local', 'share', 'opencode')) && path.basename(real) === 'auth.json') {
      hits.push('opencode-auth');
    }
  }
  for (const p of extraProtected) if (anyIs(p)) hits.push('app-config');

  const bn = path.basename(real);
  if (!inside) {
    if (/\.(pem|key)$/i.test(bn) || /^id_rsa/i.test(bn) || /^id_ed25519/i.test(bn)) hits.push('private-key');
    if (/^\.env/i.test(bn)) hits.push('dotenv');
  }
  const appData = process.env.APPDATA;
  if (appData && anyUnder(appData) && /^login data$/i.test(bn)) hits.push('browser-credentials');

  return [...new Set(hits)];
}

/** Does any bare token in a command point at a protected path? (PLAN §7.2 privileged) */
function protectedTokenHits(segment: string, workspace: string | null): string[] {
  const hits: string[] = [];
  for (const tok of tokenize(segment)) {
    const t = tok.replace(/^["']|["']$/g, '');
    if (!/^([/~]|[A-Za-z]:[\\/])/.test(t)) continue;
    const r = resolvePath(t, workspace);
    if (r.isProtected) hits.push('protected-path');
  }
  return [...new Set(hits)];
}

// ================================================================ command classifier

export interface ClassifyCtx { workspace: string | null; platform: NodeJS.Platform | string }
export interface Classification { class: CommandClass; hits: string[]; sessionPattern: string | null }

type Rule = [label: string, re: RegExp];

const DESTRUCTIVE: Rule[] = [
  ['rm-rf-system', /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r)\b.*\s(\/|\/\*|~|~\/|\$HOME\/?|\/(etc|usr|bin|sbin|lib|var|boot|System|Library|Users|home|Windows))(\s|$)/i],
  ['mkfs', /\bmkfs\b/i],
  ['dd-device', /\bdd\s.*of=\/dev\//i],
  ['diskutil', /\bdiskutil\s+(erase|partition|reformat|apfs\s+delete)/i],
  ['wipe', /\bwipefs\b|\bshred\s+.*\/dev/i],
  ['format-drive', /\bformat(\.com)?\s+[a-z]:/i],
  ['diskpart', /\bdiskpart\b/i],
  ['remove-item-system', /Remove-Item\s+.*-Recurse.*(C:\\|\$env:SystemRoot|\$env:USERPROFILE\s|~\s)/i],
  ['rd-drive', /\b(rd|rmdir)\s+\/s.*[a-z]:\\(\s|$)/i],
  ['chmod-root', /\bchmod\s+(-R\s+)?\S+\s+\/(\s|$)/i],
  ['chown-root', /\bchown\s+(-R\s+)?\S+\s+\/(\s|$)/i],
  ['fork-bomb', /:\(\)\s*\{\s*:\|:&\s*\};:/],
];

const PRIVILEGED: Rule[] = [
  ['sudo', /^\s*(sudo|doas|su)\b/i],
  ['runas', /\brunas\b/i],
  ['runas', /Start-Process\b.*-Verb\s+RunAs/i],
  ['rm-rf', /\brm\s+-[a-z]*r[a-z]*f?\b|\brm\s+-[a-z]*f[a-z]*r\b/i],
  ['network-config', /\bifconfig\s+\S+\s+(up|down|inet|add|delete|\d)/i],
  ['network-config', /\bip\s+(addr|address|link|route|neigh|rule)\s+(add|del|delete|set|flush|change|replace)\b/i],
  ['network-config', /\broute\s+(add|delete|del|change)\b/i],
  ['network-config', /\bnetworksetup\s+-set/i],
  ['network-config', /\bscutil\s+--set/i],
  ['network-config', /\bnmcli\s+(con|connection|dev|device|radio|networking)\s+(add|mod|modify|up|down|delete|off|on)\b/i],
  ['firewall', /\b(iptables|ip6tables|nft|pfctl|ufw|firewall-cmd|tc)\b/i],
  ['network-config', /\bresolvectl\s+(dns|domain|flush)\b/i],
  ['network-config', /\b(dhclient|wpa_cli|iwconfig)\b/i],
  ['network-config', /\bnetsh\b(?!.*\bshow\b)/i],
  ['system-settings', /\bSet-(NetIPAddress|NetIPInterface|DnsClientServerAddress|NetFirewallRule|NetAdapter|NetRoute|ExecutionPolicy|MpPreference|Service)\b/i],
  ['system-settings', /\bNew-(NetFirewallRule|NetRoute|NetIPAddress|LocalUser)\b/i],
  ['network-config', /\b(Enable|Disable)-NetAdapter\b/i],
  ['registry', /\breg(\.exe)?\s+(add|delete|import|restore)\b/i],
  ['registry', /\b(regedit|bcdedit)\b|Set-ItemProperty\s+.*HKLM/i],
  ['services', /\bsc(\.exe)?\s+(create|delete|config|start|stop)\b/i],
  ['services', /\bnet\s+(start|stop|user|localgroup|share)\b/i],
  ['services', /\bsystemctl\s+(start|stop|restart|enable|disable|mask|daemon-reload)\b/i],
  ['services', /\blaunchctl\s+(load|unload|bootstrap|bootout|enable|disable|kickstart)\b/i],
  ['services', /\bservice\s+\S+\s+(start|stop|restart)\b/i],
  ['power', /\b(shutdown|reboot|halt|poweroff)\b/i],
  ['power', /\b(Stop|Restart)-Computer\b/i],
  ['system-settings', /\b(systemsetup|nvram|csrutil)\b|\bpmset\s+-|\bspctl\s+--master/i],
  ['system-settings', /\bdefaults\s+write\s+(\/Library|NSGlobalDomain|com\.apple)/i],
  ['accounts', /\b(dscl|useradd|usermod|passwd|chsh)\b/i],
  ['mount', /\b(mount|umount)\b/i],
  ['scheduler', /\bcrontab\s+(-e|-r|\S+\.txt)/i],
  ['scheduler', /\bschtasks\s+\/(create|delete|change)\b/i],
  ['acl', /\b(icacls|takeown)\b/i],
  ['system-repair', /\bdism\b|\bsfc\s+\/scannow/i],
  ['quarantine', /\bxattr\s+-d.*quarantine/i],
];

const SENSITIVE: Rule[] = [
  ['package-install', /\b(apt|apt-get|dnf|yum|pacman|zypper|apk|snap|flatpak)\s+(install|remove|purge|upgrade|dist-upgrade|add|del)\b/i],
  ['package-install', /\bbrew\s+(install|uninstall|reinstall|upgrade|tap|services)\b/i],
  ['global-install', /\b(npm|pnpm|yarn|bun)\s+(i|install|add|rm|remove|uninstall|link|unlink)\b.*(\s-g\b|--global)/i],
  ['npx', /\bnpx\s/i],
  ['package-install', /\bpip3?\s+(install|uninstall)\b/i],
  ['package-install', /\b(cargo|gem|go)\s+install\b/i],
  ['package-install', /\b(choco|winget|scoop)\s+(install|uninstall|upgrade)\b/i],
  ['package-install', /\bInstall-(Module|Package|WindowsFeature)\b/i],
  ['package-install', /\b(msiexec|softwareupdate)\b|\binstaller\s+-pkg|\bdpkg\s+-i|\brpm\s+-[iuU]\b/i],
  ['kill-process', /\b(kill|killall|pkill|taskkill)\b|\bStop-Process\b/i],
  ['git-destructive', /\bgit\s+(push\s+.*(-f\b|--force)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|branch\s+-D|filter-branch)/i],
  ['pipe-to-shell', /\b(curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node|iex|powershell|pwsh)\b/i],
  ['inline-code', /\b(bash|sh|zsh|python\d?|node|ruby|perl|php)\s+-(c|e)\s/i],
  ['inline-code', /\b(powershell|pwsh)\b.*-(c|command|encodedcommand|e|enc)\b/i],
  ['inline-code', /\bosascript\b/i],
  ['remote', /\b(ssh|scp|sftp)\b|\brsync\b.*\S+:/i],
  ['docker', /\bdocker\b.*(--privileged|--network\s+host|-v\s+\/(?!workspace)|system\s+prune|rmi\b|volume\s+rm)/i],
  ['redirect-outside', />{1,2}\s*(\/(etc|usr|bin|sbin|lib|var|boot|Library|System)|~|\$HOME|\/Users\/|\/home\/|[A-Za-z]:\\)/],
  ['permissions', /\bchmod\b|\bchown\b/i],
];

const WRITE_VERBS = /^(cp|mv|tee|touch|mkdir|ln|rm|sed)$/i;
const SEVERITY: Record<CommandClass, number> = { benign: 0, sensitive: 1, privileged: 2, destructive: 3 };

/** Splits a command line on `&&`, `||`, `;`, `|`, `&` and newlines, honouring quotes. */
export function splitSegments(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  const push = (): void => { const t = cur.trim(); if (t) out.push(t); cur = ''; };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < cmd.length) { cur += cmd[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '\\' && i + 1 < cmd.length && cmd[i + 1] !== '\n') { cur += ch + cmd[++i]; continue; }
    if (ch === '\n' || ch === '\r' || ch === ';') { push(); continue; }
    if ((ch === '&' || ch === '|') && cmd[i + 1] === ch) { push(); i++; continue; }
    if (ch === '|' || ch === '&') { push(); continue; }
    cur += ch;
  }
  push();
  return out;
}

/** Quote-aware tokenizer (quotes are kept off the tokens). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < s.length) { cur += s[++i]; continue; }
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

function stripWrappers(seg: string): string {
  let s = seg.trim();
  for (;;) {
    const before = s;
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, '');
    s = s.replace(/^(env|time|nohup|exec|command|builtin)\s+/i, '');
    if (s === before) return s;
  }
}

/** Payloads of `-c` / `-e` / `-Command` so inline code is classified recursively. */
function innerCode(segment: string): string[] {
  const out: string[] = [];
  const re = /-(?:c|e|command|encodedcommand)\s+(?:(['"])([\s\S]*?)\1|(\S+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const code = m[2] ?? m[3];
    if (code && code.length > 1) out.push(code);
  }
  return out;
}

/** Program + first non-flag argument, e.g. `npm test` / `ls` (PLAN §7.1). */
function patternForSegment(seg: string): string | null {
  const toks = tokenize(stripWrappers(seg));
  if (!toks.length) return null;
  const prog = path.basename(toks[0]);
  if (!prog || /^[-/\\]/.test(prog)) return null;
  const arg = toks.slice(1).find((t) => !t.startsWith('-'));
  if (arg && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(arg)) return `${prog} ${arg}`;
  return prog;
}

export function classifyCommand(cmd: string, ctx: ClassifyCtx): Classification {
  const command = String(cmd ?? '');
  const segments = splitSegments(command);
  const candidates: string[] = [command, ...segments];
  for (const seg of segments) {
    candidates.push(stripWrappers(seg));
    for (const code of innerCode(seg)) {
      candidates.push(code, ...splitSegments(code).map(stripWrappers));
    }
  }

  const hits = new Set<string>();
  let cls: CommandClass = 'benign';
  const bump = (c: CommandClass): void => { if (SEVERITY[c] > SEVERITY[cls]) cls = c; };

  const apply = (rules: Rule[], severity: CommandClass): void => {
    for (const [label, re] of rules) {
      for (const cand of candidates) {
        if (re.test(cand)) { hits.add(label); bump(severity); break; }
      }
    }
  };
  apply(DESTRUCTIVE, 'destructive');
  apply(PRIVILEGED, 'privileged');
  apply(SENSITIVE, 'sensitive');

  // Path-aware rules (need the workspace root).
  for (const seg of segments) {
    const stripped = stripWrappers(seg);
    const toks = tokenize(stripped);
    if (!toks.length) continue;
    const prog = path.basename(toks[0]);
    const prot = protectedTokenHits(stripped, ctx.workspace);
    if (prot.length) { for (const h of prot) hits.add(h); bump('privileged'); }
    const isWriteVerb = WRITE_VERBS.test(prog) && (prog.toLowerCase() !== 'sed' || /\s-i\b/.test(stripped));
    if (!isWriteVerb) continue;
    for (const tok of toks.slice(1)) {
      if (!/^([/~]|[A-Za-z]:[\\/]|\$HOME)/.test(tok)) continue;
      const r = resolvePath(tok.replace(/^\$HOME/, os.homedir()), ctx.workspace);
      if (!r.inside) { hits.add('path-outside'); bump('sensitive'); break; }
    }
  }

  const patterns = segments.map(patternForSegment).filter((p): p is string => !!p);
  const sessionPattern = cls === 'benign' && patterns.length ? [...new Set(patterns)].join(', ') : null;
  return { class: cls, hits: [...hits], sessionPattern };
}

function expandPatterns(list: string[]): string[] {
  const out: string[] = [];
  for (const entry of list) {
    for (const part of String(entry).split(/[,\n]/)) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function segmentMatchesPattern(seg: string, pattern: string): boolean {
  const toks = tokenize(stripWrappers(seg));
  if (!toks.length) return false;
  const pt = pattern.split(/\s+/).filter(Boolean);
  if (!pt.length) return false;
  if (path.basename(toks[0]).toLowerCase() !== pt[0].toLowerCase()) return false;
  if (pt.length === 1) return true;
  if (pt[1] === '*') return true;
  return (toks[1] ?? '').toLowerCase() === pt[1].toLowerCase();
}

/** Every segment of the command must match some allowlist pattern (PLAN §7.1). */
export function matchesAllowlist(cmd: string, patterns: string[]): boolean {
  const pats = expandPatterns(patterns);
  if (!pats.length) return false;
  const segs = splitSegments(cmd);
  if (!segs.length) return false;
  return segs.every((seg) => pats.some((p) => segmentMatchesPattern(seg, p)));
}

// ================================================================ policy table

export type Policy = 'allow' | 'ask' | 'deny';

export function decide(
  kind: PermissionKind,
  mode: PermissionMode,
  opts: { commandClass?: CommandClass; recursiveDir?: boolean; cwdOutside?: boolean } = {},
): Policy {
  // 'bypass' never interrupts the user: everything is granted, including protected paths and
  // destructive commands. The gate still records each granted action (see `auditOnly`) so the
  // consoles and the log show exactly what ran without a prompt.
  if (mode === 'bypass') return 'allow';
  switch (kind) {
    case 'fs_read_outside':
      return mode === 'relaxed' ? 'allow' : 'ask';
    case 'fs_read_protected':
      return mode === 'strict' ? 'deny' : 'ask';
    case 'fs_write_inside':
      return mode === 'strict' ? 'ask' : 'allow';
    case 'fs_write_outside':
      return 'ask';
    case 'fs_delete_inside':
      if (opts.recursiveDir) return mode === 'relaxed' ? 'allow' : 'ask';
      return mode === 'strict' ? 'ask' : 'allow';
    case 'fs_delete_outside':
      return 'ask';
    case 'command': {
      const c = opts.commandClass ?? 'benign';
      if (c === 'destructive') return mode === 'relaxed' ? 'ask' : 'deny';
      if (c === 'privileged' || c === 'sensitive') return 'ask';
      if (opts.cwdOutside) return 'ask';
      return mode === 'relaxed' ? 'allow' : 'ask';
    }
    default:
      return 'ask';
  }
}

/** Session/persistent allowlists apply only to benign commands and read-outside dirs. */
function allowlistEligible(kind: PermissionKind, cls?: CommandClass): boolean {
  if (kind === 'command') return (cls ?? 'benign') === 'benign';
  return kind === 'fs_read_outside';
}

// ================================================================ gate

export interface GateWho {
  agentId: AgentId;
  agentName: string;
  agentColor: string;
  runId: string;
}

export interface GateResult {
  allowed: boolean;
  outcome: PermissionOutcome;
  /** Tool-result text to hand back to the model when not allowed (English: model-facing). */
  message: string;
}

export interface GateDeps {
  cfg: () => AppConfig;
  bus: ConsoleBus;
  send: Send;
  setStatus: (agentId: AgentId, status: AgentStatus, detail?: string) => void;
  attention?: () => void;
}

interface Pending {
  req: PermissionRequest;
  eventId: string;
  timer: NodeJS.Timeout;
  settle: (outcome: PermissionOutcome) => void;
}
interface PendingAsk {
  req: AskUserRequest;
  eventId: string;
  timer: NodeJS.Timeout;
  settle: (answer: string | null, status: 'answered' | 'timeout' | 'cancelled') => void;
}

export class PermissionGate {
  private readonly sessionCommands = new Set<string>();
  private readonly sessionReadDirs = new Set<string>();
  private readonly pendingPerm = new Map<string, Pending>();
  private readonly pendingAskMap = new Map<string, PendingAsk>();

  constructor(private readonly deps: GateDeps) {}

  pending(): PermissionRequest[] { return [...this.pendingPerm.values()].map((p) => p.req); }
  pendingAsks(): AskUserRequest[] { return [...this.pendingAskMap.values()].map((p) => p.req); }
  sessionPatterns(): string[] { return [...this.sessionCommands]; }

  // ---------------------------------------------------------- path checks

  async checkPath(
    who: GateWho,
    action: 'read' | 'write' | 'delete',
    tool: string,
    args: Record<string, unknown>,
    r: ResolvedPath,
    opts: { recursiveDir?: boolean } = {},
  ): Promise<GateResult> {
    const cfg = this.deps.cfg();
    // Reads inside the workspace are always allowed and never reach the user.
    if (action === 'read' && r.inside && !r.isProtected) {
      return { allowed: true, outcome: 'auto_allow', message: '' };
    }
    const contained = r.inside && !r.isProtected;
    let kind: PermissionKind;
    if (action === 'read') kind = r.isProtected ? 'fs_read_protected' : 'fs_read_outside';
    else if (action === 'write') kind = contained ? 'fs_write_inside' : 'fs_write_outside';
    else kind = contained ? 'fs_delete_inside' : 'fs_delete_outside';

    const hits = [...r.hits];
    if (r.isProtected && action !== 'read') hits.push('protected');

    if (kind === 'fs_read_outside' && this.readDirAllowed(r.real)) {
      return { allowed: true, outcome: 'auto_allow', message: '' };
    }

    const policy = decide(kind, cfg.permissionMode, { recursiveDir: opts.recursiveDir });
    const summary = pathSummary(kind, r.real, opts.recursiveDir);
    const sessionPattern = allowlistEligible(kind) ? path.dirname(r.real) : null;
    const auditOnly = cfg.permissionMode === 'bypass'
      && decide(kind, 'balanced', { recursiveDir: opts.recursiveDir }) !== 'allow';
    return this.resolvePolicy(who, policy, {
      kind, summary, sessionPattern, auditOnly,
      detail: { tool, args, path: r.real, hits },
    });
  }

  private readDirAllowed(real: string): boolean {
    const dirs = [...this.sessionReadDirs, ...this.deps.cfg().commandAllowlist.filter((p) => p.startsWith('/') || p.startsWith('~'))];
    for (const d of dirs) {
      const dir = d.startsWith('~') ? path.join(os.homedir(), d.slice(1)) : d;
      if (isUnder(real, dir)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------- command check

  async checkCommand(
    who: GateWho,
    tool: string,
    args: Record<string, unknown>,
    command: string,
    cwd: { path: string; inside: boolean },
  ): Promise<GateResult & { classification: Classification }> {
    const cfg = this.deps.cfg();
    const c = classifyCommand(command, { workspace: cfg.workspacePath, platform: process.platform });
    const cwdOutside = !cwd.inside;
    const hits = [...c.hits];
    if (cwdOutside) hits.push('cwd-outside');

    if (c.class === 'benign' && !cwdOutside) {
      const allow = [...this.sessionCommands, ...cfg.commandAllowlist];
      if (matchesAllowlist(command, allow)) {
        return { allowed: true, outcome: 'auto_allow', message: '', classification: c };
      }
    }

    const policy = decide('command', cfg.permissionMode, { commandClass: c.class, cwdOutside });
    const short = truncate(command.replace(/\s+/g, ' ').trim(), 160).text;
    // In bypass every command runs; classify anyway so the console says what it was.
    const auditOnly = cfg.permissionMode === 'bypass';
    const res = await this.resolvePolicy(who, policy, {
      kind: 'command',
      commandClass: c.class,
      auditOnly,
      summary: `Eseguire: ${short}`,
      sessionPattern: allowlistEligible('command', c.class) && !cwdOutside ? c.sessionPattern : null,
      detail: { tool, args, command, cwd: cwd.path, hits },
    });
    return { ...res, classification: c };
  }

  // ---------------------------------------------------------- core

  private async resolvePolicy(
    who: GateWho,
    policy: Policy,
    spec: {
      kind: PermissionKind;
      commandClass?: CommandClass;
      summary: string;
      sessionPattern: string | null;
      detail: PermissionRequest['detail'];
      /** True when only 'bypass' turned an ask/deny into an allow: worth showing, never blocking. */
      auditOnly?: boolean;
    },
  ): Promise<GateResult> {
    if (policy === 'allow') {
      if (spec.auditOnly) {
        this.deps.bus.emit(who.agentId, who.runId, {
          kind: 'permission',
          requestId: newId('bypass'),
          permissionKind: spec.kind,
          ...(spec.commandClass ? { commandClass: spec.commandClass } : {}),
          summary: spec.summary,
          status: 'auto_allow',
        });
        log(`bypass: granted without asking — ${spec.kind}: ${spec.summary}`);
      }
      return { allowed: true, outcome: 'auto_allow', message: '' };
    }

    if (policy === 'deny') {
      this.deps.bus.emit(who.agentId, who.runId, {
        kind: 'permission',
        requestId: newId('p'),
        permissionKind: spec.kind,
        ...(spec.commandClass ? { commandClass: spec.commandClass } : {}),
        summary: spec.summary,
        status: 'auto_deny',
      });
      return {
        allowed: false,
        outcome: 'auto_deny',
        message: `DENIED by policy (${this.deps.cfg().permissionMode} permission mode): ${spec.summary}. Do not retry the same action; explain the limitation to the user and propose an alternative.`,
      };
    }

    const cfg = this.deps.cfg();
    const req: PermissionRequest = {
      id: newId('perm'),
      agentId: who.agentId,
      agentName: who.agentName,
      agentColor: who.agentColor,
      runId: who.runId,
      kind: spec.kind,
      ...(spec.commandClass ? { commandClass: spec.commandClass } : {}),
      summary: spec.summary,
      detail: spec.detail,
      sessionPattern: spec.sessionPattern,
      createdAt: Date.now(),
      timeoutMs: cfg.permissionTimeoutMs,
    };

    const ev = this.deps.bus.emit(who.agentId, who.runId, {
      kind: 'permission',
      requestId: req.id,
      permissionKind: req.kind,
      ...(req.commandClass ? { commandClass: req.commandClass } : {}),
      summary: req.summary,
      status: 'pending',
    });

    this.deps.setStatus(who.agentId, 'waiting_permission', spec.summary);
    this.deps.send('permission:request', req);
    this.deps.attention?.();
    log(`permission: ask ${req.kind}${req.commandClass ? '/' + req.commandClass : ''} for ${who.agentName}`);

    const outcome = await new Promise<PermissionOutcome>((resolve) => {
      const timer = setTimeout(() => this.finish(req.id, 'timeout'), req.timeoutMs);
      this.pendingPerm.set(req.id, { req, eventId: ev.id, timer, settle: resolve });
    });

    if (outcome === 'allow_session' && spec.sessionPattern) {
      if (spec.kind === 'command') this.sessionCommands.add(spec.sessionPattern);
      else this.sessionReadDirs.add(spec.sessionPattern);
    }

    if (outcome === 'allow' || outcome === 'allow_session') {
      return { allowed: true, outcome, message: '' };
    }
    if (outcome === 'timeout') {
      return { allowed: false, outcome, message: 'DENIED: user did not answer in time. Do not retry the same action; report that authorization was not granted.' };
    }
    if (outcome === 'cancelled') {
      return { allowed: false, outcome, message: 'CANCELLED: the run was stopped by the user.' };
    }
    return {
      allowed: false,
      outcome: 'deny',
      message: `DENIED by user: ${spec.summary}. Do not retry the same action; explain or propose an alternative.`,
    };
  }

  /** Called from IPC (`permission:respond`); unknown ids are a no-op. */
  respond(requestId: string, decision: PermissionDecision, patternOverride?: string): void {
    const p = this.pendingPerm.get(requestId);
    if (!p) return;
    if (decision === 'allow_session' && patternOverride && patternOverride.trim()) {
      p.req.sessionPattern = patternOverride.trim();
      if (p.req.kind === 'command') this.sessionCommands.add(p.req.sessionPattern);
      else this.sessionReadDirs.add(p.req.sessionPattern);
    }
    this.finish(requestId, decision);
  }

  private finish(requestId: string, outcome: PermissionOutcome): void {
    const p = this.pendingPerm.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingPerm.delete(requestId);
    this.deps.bus.patch(p.req.agentId, p.eventId, { set: { status: outcome } });
    this.deps.send('permission:resolved', { requestId, outcome });
    if (outcome !== 'cancelled') this.deps.setStatus(p.req.agentId, 'tool');
    p.settle(outcome);
  }

  // ---------------------------------------------------------- ask_user

  async ask(who: GateWho, question: string, options?: string[]): Promise<string | null> {
    const cfg = this.deps.cfg();
    const req: AskUserRequest = {
      id: newId('ask'),
      agentId: who.agentId,
      agentName: who.agentName,
      agentColor: who.agentColor,
      runId: who.runId,
      question,
      ...(options && options.length ? { options } : {}),
      createdAt: Date.now(),
      timeoutMs: cfg.permissionTimeoutMs,
    };
    const ev = this.deps.bus.emit(who.agentId, who.runId, {
      kind: 'ask_user', requestId: req.id, question, status: 'pending',
    });
    this.deps.setStatus(who.agentId, 'waiting_user', question.slice(0, 80));
    this.deps.send('askUser:request', req);
    this.deps.attention?.();

    const answer = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => this.finishAsk(req.id, null, 'timeout'), req.timeoutMs);
      this.pendingAskMap.set(req.id, {
        req, eventId: ev.id, timer,
        settle: (a) => resolve(a),
      });
    });
    return answer;
  }

  respondAsk(requestId: string, answer: string | null): void {
    this.finishAsk(requestId, answer, 'answered');
  }

  private finishAsk(requestId: string, answer: string | null, status: 'answered' | 'timeout' | 'cancelled'): void {
    const p = this.pendingAskMap.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingAskMap.delete(requestId);
    const set: Record<string, unknown> = { status: answer === null && status === 'answered' ? 'cancelled' : status };
    if (answer !== null) set.answer = answer;
    this.deps.bus.patch(p.req.agentId, p.eventId, { set });
    this.deps.send('askUser:resolved', { requestId });
    if (status !== 'cancelled') this.deps.setStatus(p.req.agentId, 'tool');
    p.settle(answer, status);
  }

  // ---------------------------------------------------------- cancellation

  /** Resolves everything pending for a run as `cancelled` (PLAN §7.1). */
  cancelRun(runId: string): void {
    for (const [id, p] of [...this.pendingPerm]) if (p.req.runId === runId) this.finish(id, 'cancelled');
    for (const [id, p] of [...this.pendingAskMap]) if (p.req.runId === runId) this.finishAsk(id, null, 'cancelled');
  }

  cancelAgent(agentId: AgentId): void {
    for (const [id, p] of [...this.pendingPerm]) if (p.req.agentId === agentId) this.finish(id, 'cancelled');
    for (const [id, p] of [...this.pendingAskMap]) if (p.req.agentId === agentId) this.finishAsk(id, null, 'cancelled');
  }

  cancelAll(): void {
    for (const id of [...this.pendingPerm.keys()]) this.finish(id, 'cancelled');
    for (const id of [...this.pendingAskMap.keys()]) this.finishAsk(id, null, 'cancelled');
  }
}

function pathSummary(kind: PermissionKind, p: string, recursiveDir?: boolean): string {
  switch (kind) {
    case 'fs_read_outside': return `Leggere fuori dal workspace: ${p}`;
    case 'fs_read_protected': return `Leggere un percorso protetto: ${p}`;
    case 'fs_write_inside': return `Scrivere nel workspace: ${p}`;
    case 'fs_write_outside': return `Scrivere fuori dal workspace: ${p}`;
    case 'fs_delete_inside': return `Eliminare ${recursiveDir ? 'la cartella' : 'nel workspace'}: ${p}`;
    case 'fs_delete_outside': return `Eliminare fuori dal workspace: ${p}`;
    default: return p;
  }
}
