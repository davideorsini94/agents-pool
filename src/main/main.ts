// Electron entry point: privileged app:// scheme, window, wiring, quit flush. PLAN §12.3, §10, §11.

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow, app, protocol, session } from 'electron';
import type { AppInfo } from '../shared/types';
import { OpenCodeClient } from './api';
import { ConfigStore, DEFAULT_MODEL, PALETTE, PROBE_MODEL } from './config';
import { registerHandlers } from './ipc';
import { Orchestrator } from './orchestrator';
import { PermissionGate, registerProtectedPaths } from './permissions';
import { PromptEnv } from './prompt';
import { ConsoleBus, StateStore } from './state';
import { Send, fmtErr, initLog, log, logError, logWarn } from './util';

const DEV = process.argv.includes('--dev');
// Isolated data dir for tests/CI (scripts/e2e-smoke.mjs). Must run before 'ready'.
if (process.env.AGENTS_POOL_USER_DATA) app.setPath('userData', path.resolve(process.env.AGENTS_POOL_USER_DATA));
const SCHEME = 'app';
const HOST = 'root';
const RENDERER_ENTRY = `${SCHEME}://${HOST}/src/renderer/index.html`;

// ES modules over file:// can be blocked by Chromium's CORS rules, so the renderer is served
// from a privileged custom scheme instead (PLAN §14). Must run before 'ready'.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const CSP = [
  "default-src 'none'",
  `script-src 'self' ${SCHEME}:`,
  `style-src 'self' 'unsafe-inline' ${SCHEME}:`,
  `img-src 'self' data: ${SCHEME}:`,
  `font-src 'self' ${SCHEME}:`,
  // DevTools fetches .js.map through connect-src; allowed in dev only.
  DEV ? `connect-src 'self' ${SCHEME}:` : "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

let win: BrowserWindow | null = null;
let quitting = false;

// ---------------------------------------------------------------- singleton

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  void bootstrap();
}

// ---------------------------------------------------------------- bootstrap

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const userData = app.getPath('userData');
  initLog(userData, DEV);
  log(`start: v${app.getVersion()} electron ${process.versions.electron} node ${process.versions.node} dev=${DEV}`);
  process.on('uncaughtException', (e) => logError('uncaughtException', fmtErr(e), (e as Error)?.stack ?? ''));
  process.on('unhandledRejection', (e) => logError('unhandledRejection', fmtErr(e)));

  const send: Send = (channel, payload) => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  const config = new ConfigStore(userData);
  config.load();
  registerProtectedPaths([config.configFile]);

  const state = new StateStore(userData);
  const bus = new ConsoleBus(state, send);
  const client = new OpenCodeClient(() => config.getApiKey(), app.getVersion(), { cacheDir: userData });

  const gate = new PermissionGate({
    cfg: () => config.get(),
    bus,
    send,
    setStatus: (agentId, status, detail) => orchestrator.setAgentStatus(agentId, status, detail),
    attention: () => attention(),
  });

  const env: PromptEnv = {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    shell: process.env.SHELL ?? process.env.ComSpec ?? 'unknown',
    locale: app.getLocale() || 'it-IT',
  };

  const orchestrator = new Orchestrator({
    config, state, bus, client, gate, send, env, appVersion: app.getVersion(),
  });
  orchestrator.start();

  config.onChange((changed) => {
    try { orchestrator.applyConfig(changed); } catch (e) { logWarn('applyConfig failed', e); }
    send('config:changed', changed);
  });

  const appInfo = (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userDataPath: userData,
    palette: [...PALETTE],
    defaultModel: DEFAULT_MODEL,
    probeModel: PROBE_MODEL,
    hasApiKey: config.hasApiKey(),
    setupComplete: config.get().setupComplete,
    locale: env.locale,
  });

  registerHandlers({
    config, state, bus, client, gate, orchestrator, send,
    appInfo,
    getWindow: () => win,
  });

  registerProtocol();
  hardenSession();
  createWindow(config);

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(config); });
  app.on('window-all-closed', () => { app.quit(); });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    log('quit: cancelling runs and flushing state');
    try { orchestrator.cancelAll('chiusura applicazione'); } catch (e) { logWarn('cancelAll on quit', e); }
    try { bus.flushAll(); } catch (e) { logWarn('bus flush on quit', e); }
    const done = state.flushAll().catch((e) => logWarn('state flush on quit', e));
    const cap = new Promise<void>((r) => setTimeout(r, 2000));
    void Promise.race([done, cap]).then(() => app.exit(0));
  });
}

// ---------------------------------------------------------------- app:// scheme

function appRoot(): string { return app.getAppPath(); }

function registerProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname && url.hostname !== HOST) return notFound(`host sconosciuto: ${url.hostname}`);
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const root = appRoot();
      const target = path.resolve(root, rel);
      const relCheck = path.relative(root, target);
      if (!rel || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        return notFound(`percorso non consentito: ${rel}`);
      }
      const body = await fsp.readFile(target);
      const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: {
          'content-type': type,
          'content-security-policy': CSP,
          'cache-control': DEV ? 'no-store' : 'no-cache',
        },
      });
    } catch (e) {
      logWarn(`app:// 404 ${request.url}: ${fmtErr(e)}`);
      return notFound(fmtErr(e));
    }
  });
  log(`protocol: ${SCHEME}://${HOST}/ → ${appRoot()}`);
}

function notFound(message: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>Agents Pool</title>`
    + `<body style="background:#0f1115;color:#e6e6e6;font:14px system-ui;padding:24px">`
    + `<h1 style="font-size:18px">Interfaccia non disponibile</h1>`
    + `<p style="color:#8b93a7">${escapeHtml(message)}</p></body>`;
  return new Response(html, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

// ---------------------------------------------------------------- security

function hardenSession(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  s.setPermissionCheckHandler(() => false);
  s.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    delete headers['content-security-policy'];
    delete headers['Content-Security-Policy'];
    headers['Content-Security-Policy'] = [CSP];
    callback({ responseHeaders: headers });
  });
}

// ---------------------------------------------------------------- window

function createWindow(config: ConfigStore): void {
  const saved = config.get().window;
  win = new BrowserWindow({
    width: saved?.width ?? 1440,
    height: saved?.height ?? 900,
    ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f1115',
    title: 'Agents Pool',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: DEV,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (url !== RENDERER_ENTRY) e.preventDefault(); });
  win.webContents.on('render-process-gone', (_e, d) => logError('renderer gone', d.reason));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logWarn(`load failed ${code} ${desc} ${url}`));
  win.webContents.on('did-finish-load', () => log('window: renderer loaded'));
  win.webContents.on('console-message', (details) => {
    if (!DEV) return;
    // DevTools source-map probes are blocked by the renderer's own CSP meta: pure noise.
    if (/\.js\.map' violates/.test(details.message)) return;
    const line = `renderer[${details.level}] ${details.sourceId}:${details.lineNumber} ${details.message}`;
    if (details.level === 'error') logWarn(line); else log(line);
  });

  let boundsTimer: NodeJS.Timeout | null = null;
  const saveBounds = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      const b = win.getNormalBounds();
      config.setWindowBounds({ width: b.width, height: b.height, x: b.x, y: b.y });
    }, 500);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  void win.loadURL(RENDERER_ENTRY).catch((e) => logError('loadURL failed', fmtErr(e)));
  if (DEV) win.webContents.openDevTools({ mode: 'detach' });
  log(`window: loading ${RENDERER_ENTRY}`);
}

/** Draws the user's attention when a permission/ask request arrives unfocused (PLAN §9.5). */
function attention(): void {
  if (!win || win.isDestroyed() || win.isFocused()) return;
  if (process.platform === 'darwin') app.dock?.bounce('informational');
  else win.flashFrame(true);
}
