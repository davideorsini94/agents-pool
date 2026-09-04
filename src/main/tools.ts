// Tool catalogue: JSON-schema definitions + executors. PLAN §6.
// Everything the agents can do to the machine funnels through here and through PermissionGate.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  AgentConfig, AgentStatus, AgentView, AppConfig, RunState,
} from '../shared/types';
import type { ToolDef } from './api';
import { PermissionGate, resolvePath } from './permissions';
import { fmtErr, isRecord, truncate } from './util';

export interface ToolResult { ok: boolean; output: string; denied?: boolean }

/** Implemented by Orchestrator; declared here so tools.ts never imports orchestrator.ts. */
export interface OrchestratorApi {
  delegate(
    from: { agent: AgentConfig; run: RunState },
    ref: string,
    task: string,
    context: string | undefined,
    callId: string,
  ): Promise<string>;
  rosterInfo(): Array<{ id: string; name: string; description: string; model: string; status: AgentStatus; isMain: boolean }>;
}

export interface ToolCtx {
  agent: AgentConfig;
  agentView: AgentView;
  run: RunState;
  signal: AbortSignal;
  cfg: () => AppConfig;
  gate: PermissionGate;
  orchestrator: OrchestratorApi;
  callId: string;
  setStatus: (status: AgentStatus, detail?: string) => void;
  appVersion: string;
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.DS_Store']);
const READ_CAP = 64 * 1024;
const SEARCH_FILE_CAP = 2 * 1024 * 1024;
const OUTPUT_BUFFER_CAP = 1024 * 1024;

// ================================================================ definitions

export function toolDefs(): ToolDef[] {
  return [
    def('read_file', 'Read a UTF-8 text file. Relative paths resolve inside the workspace.', {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative to the workspace or absolute)' },
        offset: { type: 'integer', description: 'First line to return, 1-based' },
        limit: { type: 'integer', description: 'How many lines to return' },
      },
      required: ['path'],
    }),
    def('write_file', 'Create or overwrite a text file (parent directories are created).', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    }),
    def('edit_file', 'Replace an exact substring inside an existing file. Fails when the search text is missing or ambiguous.', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        search: { type: 'string', description: 'Exact text to find (include enough context to be unique)' },
        replace: { type: 'string' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'search', 'replace'],
    }),
    def('delete_path', 'Delete a file or a directory (directories need recursive=true).', {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      },
      required: ['path'],
    }),
    def('list_directory', 'List directory entries as "type name size".', {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Default "."' },
        recursive: { type: 'boolean' },
        maxEntries: { type: 'integer', description: 'Default 500' },
      },
    }),
    def('search_files', 'Search file contents and/or file names under a directory.', {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to look for in file contents' },
        glob: { type: 'string', description: 'File name filter, e.g. "**/*.ts"' },
        path: { type: 'string', description: 'Root directory, default "."' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression' },
        caseSensitive: { type: 'boolean' },
        maxResults: { type: 'integer', description: 'Default 200' },
      },
    }),
    def('run_command', 'Run a non-interactive shell command and return its output.', {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Working directory, default the workspace' },
        timeoutMs: { type: 'integer', description: 'Default 120000, max 600000' },
        env: { type: 'object', description: 'Extra environment variables', additionalProperties: { type: 'string' } },
      },
      required: ['command'],
    }),
    def('system_info', 'Report OS, CPU, memory, user, shell and app paths as JSON.', { type: 'object', properties: {} }),
    def('network_info', 'Report network interfaces, routes and DNS configuration as JSON.', { type: 'object', properties: {} }),
    def('delegate_task', 'Delegate a self-contained sub-task to a teammate and wait for its result.', {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Teammate name or id' },
        task: { type: 'string', description: 'Self-contained instructions' },
        context: { type: 'string', description: 'Extra background the teammate needs' },
      },
      required: ['agent', 'task'],
    }),
    def('list_agents', 'List the team: id, name, description, model, status.', { type: 'object', properties: {} }),
    def('ask_user', 'Ask the user a question and wait for the answer. Use only when truly blocked.', {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers' },
      },
      required: ['question'],
    }),
  ];
}

function def(name: string, description: string, parameters: Record<string, unknown>): ToolDef {
  return { type: 'function', function: { name, description, parameters } };
}

export function toolNames(): string[] {
  return toolDefs().map((t) => t.function.name);
}

// ================================================================ dispatch

export async function execute(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'read_file': return await readFile(args, ctx);
      case 'write_file': return await writeFile(args, ctx);
      case 'edit_file': return await editFile(args, ctx);
      case 'delete_path': return await deletePath(args, ctx);
      case 'list_directory': return await listDirectory(args, ctx);
      case 'search_files': return await searchFiles(args, ctx);
      case 'run_command': return await runCommand(args, ctx);
      case 'system_info': return await systemInfo(ctx);
      case 'network_info': return await networkInfo(ctx);
      case 'delegate_task': return await delegateTask(args, ctx);
      case 'list_agents': return listAgents(ctx);
      case 'ask_user': return await askUser(args, ctx);
      default:
        return { ok: false, output: `ERROR: unknown tool ${name}. Available: ${toolNames().join(', ')}` };
    }
  } catch (e) {
    // Never let a tool crash the agent loop (PLAN §5.3).
    return { ok: false, output: `ERROR: ${fmtErr(e)}` };
  }
}

// ---------------------------------------------------------------- arg helpers

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}
function reqStr(args: Record<string, unknown>, key: string): string {
  const v = str(args, key);
  if (v === undefined) throw new Error(`missing required string parameter "${key}"`);
  return v;
}
function int(args: Record<string, unknown>, key: string, dflt: number, lo: number, hi: number): number {
  const v = args[key];
  const n = typeof v === 'number' ? v : (typeof v === 'string' ? Number.parseInt(v, 10) : NaN);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}
function bool(args: Record<string, unknown>, key: string, dflt = false): boolean {
  const v = args[key];
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return dflt;
}

function who(ctx: ToolCtx): { agentId: string; agentName: string; agentColor: string; runId: string } {
  return {
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    agentColor: ctx.agent.color,
    runId: ctx.run.runId,
  };
}

function denied(message: string): ToolResult {
  return { ok: false, output: message, denied: true };
}

// ---------------------------------------------------------------- fs tools

async function readFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const p = reqStr(args, 'path');
  const r = resolvePath(p, ctx.cfg().workspacePath);
  const gate = await ctx.gate.checkPath(who(ctx), 'read', 'read_file', args, r);
  if (!gate.allowed) return denied(gate.message);

  let st: fs.Stats;
  try { st = await fsp.stat(r.real); } catch { return { ok: false, output: `ERROR: file not found: ${r.real}` }; }
  if (st.isDirectory()) return { ok: false, output: `ERROR: ${r.real} is a directory — use list_directory` };

  const fh = await fsp.open(r.real, 'r');
  try {
    const probe = Buffer.alloc(Math.min(8192, st.size));
    if (probe.length) await fh.read(probe, 0, probe.length, 0);
    if (probe.includes(0)) return { ok: false, output: `ERROR: ${r.real} looks like a binary file (${st.size} bytes)` };
    const buf = Buffer.alloc(Math.min(st.size, READ_CAP + 1));
    await fh.read(buf, 0, buf.length, 0);
    let text = decodeOutput(buf.subarray(0, Math.min(buf.length, READ_CAP)));
    const clipped = st.size > READ_CAP;

    const offset = int(args, 'offset', 0, 1, 10_000_000);
    const limit = int(args, 'limit', 0, 1, 1_000_000);
    if (offset || limit) {
      const lines = text.split('\n');
      const from = offset ? offset - 1 : 0;
      const to = limit ? from + limit : lines.length;
      text = lines.slice(from, to).join('\n');
      return { ok: true, output: `[${r.real} lines ${from + 1}-${Math.min(to, lines.length)} of ${lines.length}]\n${text}` };
    }
    const header = `[${r.real} · ${st.size} bytes${clipped ? `, showing first ${READ_CAP}` : ''}]`;
    return { ok: true, output: `${header}\n${text}${clipped ? '\n… [truncated: use offset/limit to read further]' : ''}` };
  } finally {
    await fh.close();
  }
}

async function writeFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const p = reqStr(args, 'path');
  const content = reqStr(args, 'content');
  const r = resolvePath(p, ctx.cfg().workspacePath);
  const gate = await ctx.gate.checkPath(who(ctx), 'write', 'write_file', args, r);
  if (!gate.allowed) return denied(gate.message);
  await fsp.mkdir(path.dirname(r.real), { recursive: true });
  await fsp.writeFile(r.real, content, 'utf8');
  return { ok: true, output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${r.real}` };
}

async function editFile(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const p = reqStr(args, 'path');
  const search = reqStr(args, 'search');
  const replace = reqStr(args, 'replace');
  const replaceAll = bool(args, 'replaceAll');
  if (!search) return { ok: false, output: 'ERROR: "search" cannot be empty' };
  const r = resolvePath(p, ctx.cfg().workspacePath);
  const gate = await ctx.gate.checkPath(who(ctx), 'write', 'edit_file', args, r);
  if (!gate.allowed) return denied(gate.message);

  let text: string;
  try { text = await fsp.readFile(r.real, 'utf8'); } catch { return { ok: false, output: `ERROR: file not found: ${r.real}` }; }
  const count = countOccurrences(text, search);
  if (count === 0) return { ok: false, output: `ERROR: search text not found in ${r.real}` };
  if (count > 1 && !replaceAll) {
    return { ok: false, output: `ERROR: search text occurs ${count} times in ${r.real} — add context to make it unique or set replaceAll=true` };
  }
  const next = replaceAll ? text.split(search).join(replace) : text.replace(search, replace);
  await fsp.writeFile(r.real, next, 'utf8');
  return { ok: true, output: `Replaced ${replaceAll ? count : 1} occurrence${(replaceAll ? count : 1) === 1 ? '' : 's'} in ${r.real}` };
}

async function deletePath(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const p = reqStr(args, 'path');
  const recursive = bool(args, 'recursive');
  const r = resolvePath(p, ctx.cfg().workspacePath);
  let st: fs.Stats;
  try { st = await fsp.lstat(r.real); } catch { return { ok: false, output: `ERROR: path not found: ${r.real}` }; }
  const isDir = st.isDirectory();
  if (isDir && !recursive) return { ok: false, output: `ERROR: ${r.real} is a directory — pass recursive=true to delete it` };
  const gate = await ctx.gate.checkPath(who(ctx), 'delete', 'delete_path', args, r, { recursiveDir: isDir });
  if (!gate.allowed) return denied(gate.message);
  await fsp.rm(r.real, { recursive: isDir, force: false });
  return { ok: true, output: `Deleted ${isDir ? 'directory' : 'file'} ${r.real}` };
}

async function listDirectory(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const p = str(args, 'path') ?? '.';
  const recursive = bool(args, 'recursive');
  const maxEntries = int(args, 'maxEntries', 500, 1, 5000);
  const r = resolvePath(p, ctx.cfg().workspacePath);
  const gate = await ctx.gate.checkPath(who(ctx), 'read', 'list_directory', args, r);
  if (!gate.allowed) return denied(gate.message);

  const rows: string[] = [];
  let truncatedList = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (rows.length >= maxEntries) { truncatedList = true; return; }
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (rows.length >= maxEntries) { truncatedList = true; return; }
      if (recursive && IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      const rel = path.relative(r.real, full) || e.name;
      if (e.isDirectory()) {
        rows.push(`dir   ${rel}/`);
        if (recursive && depth < 24) await walk(full, depth + 1);
      } else if (e.isSymbolicLink()) {
        rows.push(`link  ${rel}`);
      } else {
        let size = 0;
        try { size = (await fsp.stat(full)).size; } catch { /* ignore */ }
        rows.push(`file  ${rel}  ${size}`);
      }
    }
  };
  try {
    const st = await fsp.stat(r.real);
    if (!st.isDirectory()) return { ok: false, output: `ERROR: ${r.real} is not a directory` };
  } catch {
    return { ok: false, output: `ERROR: directory not found: ${r.real}` };
  }
  await walk(r.real, 0);
  const head = `[${r.real} · ${rows.length} entries${truncatedList ? `, capped at ${maxEntries}` : ''}]`;
  return { ok: true, output: `${head}\n${rows.join('\n')}` };
}

async function searchFiles(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const query = str(args, 'query');
  const glob = str(args, 'glob');
  const root = str(args, 'path') ?? '.';
  const useRegex = bool(args, 'regex');
  const caseSensitive = bool(args, 'caseSensitive');
  const maxResults = int(args, 'maxResults', 200, 1, 5000);
  if (!query && !glob) return { ok: false, output: 'ERROR: provide "query" and/or "glob"' };

  const r = resolvePath(root, ctx.cfg().workspacePath);
  const gate = await ctx.gate.checkPath(who(ctx), 'read', 'search_files', args, r);
  if (!gate.allowed) return denied(gate.message);

  const globRe = glob ? globToRegExp(glob) : null;
  let re: RegExp | null = null;
  if (query) {
    const src = useRegex ? query : escapeRe(query);
    try { re = new RegExp(src, caseSensitive ? '' : 'i'); } catch (e) { return { ok: false, output: `ERROR: invalid regex: ${fmtErr(e)}` }; }
  }

  const results: string[] = [];
  let scanned = 0;
  let capped = false;

  const walk = async (dir: string): Promise<void> => {
    if (capped || ctx.signal.aborted) return;
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (capped || ctx.signal.aborted) return;
      if (IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(r.real, full).split(path.sep).join('/');
      if (globRe && !globRe.test(rel)) continue;
      if (!re) {
        results.push(rel);
        if (results.length >= maxResults) capped = true;
        continue;
      }
      let st: fs.Stats;
      try { st = await fsp.stat(full); } catch { continue; }
      if (st.size > SEARCH_FILE_CAP) continue;
      let buf: Buffer;
      try { buf = await fsp.readFile(full); } catch { continue; }
      if (buf.subarray(0, 8192).includes(0)) continue;
      scanned++;
      const lines = decodeOutput(buf).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
        if (results.length >= maxResults) { capped = true; return; }
      }
    }
  };

  try {
    const st = await fsp.stat(r.real);
    if (!st.isDirectory()) return { ok: false, output: `ERROR: ${r.real} is not a directory` };
  } catch {
    return { ok: false, output: `ERROR: directory not found: ${r.real}` };
  }
  await walk(r.real);
  const head = re
    ? `[${results.length} match${results.length === 1 ? '' : 'es'} in ${scanned} files under ${r.real}${capped ? `, capped at ${maxResults}` : ''}]`
    : `[${results.length} file${results.length === 1 ? '' : 's'} under ${r.real}${capped ? `, capped at ${maxResults}` : ''}]`;
  return { ok: true, output: `${head}\n${results.join('\n')}` };
}

// ---------------------------------------------------------------- run_command

interface ShellResult { code: number | null; signalName: string | null; timedOut: boolean; stdout: string; stderr: string; overflow: boolean }

async function runCommand(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const command = reqStr(args, 'command');
  if (!command.trim()) return { ok: false, output: 'ERROR: empty command' };
  const cfg = ctx.cfg();
  const timeoutMs = int(args, 'timeoutMs', 120000, 1000, 600000);
  const cwdRaw = str(args, 'cwd');
  const cwdResolved = resolvePath(cwdRaw ?? '.', cfg.workspacePath);
  const cwd = cwdResolved.real;
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { ok: false, output: `ERROR: working directory does not exist: ${cwd}` };
  }

  const gate = await ctx.gate.checkCommand(who(ctx), 'run_command', args, command, { path: cwd, inside: cwdResolved.inside });
  if (!gate.allowed) return denied(gate.message);
  ctx.setStatus('tool', `run_command · ${truncate(command, 60).text}`);

  const extraEnv: Record<string, string> = {};
  const rawEnv = args.env;
  if (isRecord(rawEnv)) {
    for (const [k, v] of Object.entries(rawEnv)) {
      if (/^(PATH|HOME|USERPROFILE)$/i.test(k)) continue; // cannot be overridden (PLAN §6.2)
      if (typeof v === 'string') extraEnv[k] = v;
    }
  }

  const r = await runShell(command, cwd, timeoutMs, extraEnv, ctx.signal);
  const parts = [
    `exit=${r.code ?? (r.signalName ? `signal:${r.signalName}` : 'null')} timedOut=${r.timedOut}${r.overflow ? ' outputOverflow=true' : ''}`,
    '--- stdout ---',
    r.stdout,
    '--- stderr ---',
    r.stderr,
  ];
  return { ok: r.code === 0 && !r.timedOut, output: parts.join('\n') };
}

function shellFor(command: string): { file: string; argv: string[] } {
  if (process.platform === 'win32') return { file: 'cmd.exe', argv: ['/d', '/s', '/c', command] };
  return { file: '/bin/sh', argv: ['-c', command] };
}

export function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string>,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const { file, argv } = shellFor(command);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      AGENTS_POOL: '1',
      NO_COLOR: '1',
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...extraEnv,
    };
    const isWin32 = process.platform === 'win32';
    const child = spawn(file, argv, {
      cwd,
      env,
      detached: !isWin32,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const killTree = (): void => {
      if (!child.pid) return;
      try {
        if (isWin32) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };

    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    const onAbort = (): void => { killTree(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (b: Buffer) => {
      outLen += b.length;
      if (outLen > OUTPUT_BUFFER_CAP) { if (!overflow) { overflow = true; killTree(); } return; }
      out.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      errLen += b.length;
      if (errLen > OUTPUT_BUFFER_CAP) { if (!overflow) { overflow = true; killTree(); } return; }
      err.push(b);
    });

    const finish = (code: number | null, signalName: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        signalName,
        timedOut,
        overflow,
        stdout: decodeOutput(Buffer.concat(out)),
        stderr: decodeOutput(Buffer.concat(err)),
      });
    };

    child.on('error', (e) => {
      err.push(Buffer.from(`spawn error: ${fmtErr(e)}`));
      finish(null, null);
    });
    child.on('close', (code, sig) => finish(code, sig));
  });
}

/** UTF-8 with a latin1 fallback for legacy Windows console output (PLAN §6.2). */
export function decodeOutput(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

// ---------------------------------------------------------------- info tools

async function systemInfo(ctx: ToolCtx): Promise<ToolResult> {
  const cpus = os.cpus();
  const info = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    hostname: os.hostname(),
    cpus: { count: cpus.length, model: cpus[0]?.model ?? 'unknown' },
    memory: { total: os.totalmem(), free: os.freemem() },
    uptime: Math.round(os.uptime()),
    homedir: os.homedir(),
    username: os.userInfo().username,
    shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
    PATH: process.env.PATH ?? '',
    versions: {
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      app: ctx.appVersion,
    },
    workspacePath: ctx.cfg().workspacePath,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env).sort(),
  };
  return { ok: true, output: JSON.stringify(info, null, 2) };
}

const NETWORK_COMMANDS: Record<string, string[]> = {
  darwin: ['ifconfig', 'netstat -rn', 'scutil --dns', 'networksetup -listallnetworkservices'],
  linux: ['ip -brief addr', 'ip route', 'cat /etc/resolv.conf'],
  win32: ['ipconfig /all', 'route print', 'netsh interface show interface'],
};

async function networkInfo(ctx: ToolCtx): Promise<ToolResult> {
  const cmds = NETWORK_COMMANDS[process.platform] ?? NETWORK_COMMANDS.linux;
  const cwd = ctx.cfg().workspacePath && fs.existsSync(ctx.cfg().workspacePath as string)
    ? (ctx.cfg().workspacePath as string)
    : os.homedir();
  const commands: Record<string, string> = {};
  for (const cmd of cmds) {
    try {
      const r = await runShell(cmd, cwd, 10000, {}, ctx.signal);
      commands[cmd] = r.timedOut
        ? '[timeout after 10s]'
        : truncate((r.stdout || r.stderr || '[no output]').trim(), 8000).text;
    } catch (e) {
      commands[cmd] = `[failed: ${fmtErr(e)}]`;
    }
  }
  return {
    ok: true,
    output: JSON.stringify({ interfaces: os.networkInterfaces(), commands }, null, 2),
  };
}

// ---------------------------------------------------------------- team tools

async function delegateTask(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const ref = reqStr(args, 'agent');
  const task = reqStr(args, 'task');
  const context = str(args, 'context');
  const text = await ctx.orchestrator.delegate(
    { agent: ctx.agent, run: ctx.run },
    ref,
    task,
    context,
    ctx.callId,
  );
  // Only a completed delegation starts with "Result from"; every rejection/failure path does not.
  return { ok: text.startsWith('Result from '), output: text };
}

function listAgents(ctx: ToolCtx): ToolResult {
  return { ok: true, output: JSON.stringify(ctx.orchestrator.rosterInfo(), null, 2) };
}

async function askUser(args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const question = reqStr(args, 'question');
  const rawOptions = args.options;
  const options = Array.isArray(rawOptions)
    ? rawOptions.filter((o): o is string => typeof o === 'string').slice(0, 8)
    : undefined;
  ctx.setStatus('waiting_user', question.slice(0, 80));
  const answer = await ctx.gate.ask(who(ctx), question, options);
  if (answer === null) return { ok: true, output: 'No answer from user (dismissed/timeout)' };
  return { ok: true, output: answer };
}

// ---------------------------------------------------------------- misc

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Minimal glob: `**`, `*`, `?`. Matched against workspace-relative posix paths. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}
