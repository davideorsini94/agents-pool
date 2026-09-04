// ipcMain handler registration for every InvokeMap channel. PLAN §3.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow, IpcMainInvokeEvent, dialog, ipcMain, shell } from 'electron';
import type {
  AgentId, AgentInput, AgentRole, AppInfo, ConfigPatch, ConfigSnapshot, ConsoleEvent,
  KeyValidationResult, ModelInfo, PermissionDecision, RuntimeSnapshot, SetupPayload,
} from '../shared/types';
import { OpenCodeClient, reasonOf, toApiError } from './api';
import { ConfigStore, defaultPrompt } from './config';
import { ContractsLog, ROLE_VALUES } from './contracts';
import { PermissionGate } from './permissions';
import { Orchestrator } from './orchestrator';
import { ConsoleBus, StateStore } from './state';
import { Send, fmtErr, isDev, isRecord, log, logError, readJsonSync } from './util';

/** Every channel the preload whitelist exposes (keys of InvokeMap). */
export const INVOKE_CHANNELS = [
  'app:getInfo',
  'key:set',
  'key:importFromOpencode',
  'key:clear',
  'models:list',
  'config:get',
  'config:update',
  'config:completeSetup',
  'config:addAgent',
  'config:updateAgent',
  'config:removeAgent',
  'config:defaultPrompt',
  'config:chooseWorkspace',
  'config:resetAll',
  'chat:send',
  'chat:cancel',
  'agent:cancel',
  'agent:clearHistory',
  'instance:close',
  'console:getEvents',
  'console:clear',
  'runtime:getSnapshot',
  'permission:respond',
  'askUser:respond',
  'shell:openPath',
  'logs:openContracts',
  'shell:openExternal',
] as const;

export interface IpcDeps {
  config: ConfigStore;
  contracts: ContractsLog;
  state: StateStore;
  bus: ConsoleBus;
  client: OpenCodeClient;
  gate: PermissionGate;
  orchestrator: Orchestrator;
  send: Send;
  appInfo: () => AppInfo;
  getWindow: () => BrowserWindow | null;
}

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>;

export function registerHandlers(deps: IpcDeps): void {
  const { config, state, bus, client, gate, orchestrator } = deps;

  const handle = (channel: string, fn: Handler): void => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const win = deps.getWindow();
      if (win && event.sender !== win.webContents) throw new Error('sender non autorizzato');
      if (isDev()) log(`ipc <- ${channel}`);
      try {
        return await fn(event, ...args);
      } catch (e) {
        logError(`ipc ${channel} failed:`, fmtErr(e));
        throw new Error(fmtErr(e));
      }
    });
  };

  // ------------------------------------------------------------ app / key

  handle('app:getInfo', () => deps.appInfo());

  handle('key:set', async (_e, raw) => {
    const key = String(raw ?? '').trim();
    if (!key) return { ok: false, reason: 'auth', message: 'Chiave vuota' } satisfies KeyValidationResult;
    const res = await client.validateKey(key);
    if (res.ok) {
      config.setApiKey(key);
      log('key: set and validated');
      if (config.keyStoredPlain) {
        deps.send('app:toast', { level: 'warn', message: 'Cifratura di sistema non disponibile: la chiave è salvata in chiaro' });
      }
    }
    return res;
  });

  handle('key:importFromOpencode', async () => {
    const file = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json');
    const raw = readJsonSync<unknown>(file);
    if (!isRecord(raw)) {
      return { ok: false, reason: 'unknown', message: 'File auth.json di opencode non trovato' } satisfies KeyValidationResult;
    }
    let key: string | null = null;
    for (const provider of ['opencode-go', 'opencode']) {
      const entry = raw[provider];
      if (isRecord(entry) && typeof entry.key === 'string' && entry.key.trim()) { key = entry.key.trim(); break; }
    }
    if (!key) {
      return { ok: false, reason: 'unknown', message: 'Nessuna chiave opencode-go in auth.json' } satisfies KeyValidationResult;
    }
    const res = await client.validateKey(key);
    if (res.ok) {
      config.setApiKey(key);
      log('key: imported from opencode CLI');
    }
    return res;
  });

  handle('key:clear', () => {
    orchestrator.cancelAll('chiave API rimossa');
    config.clearApiKey();
    log('key: cleared');
  });

  handle('models:list', async (_e, refresh) => {
    try {
      return await client.listModels(refresh === true) satisfies ModelInfo[];
    } catch (e) {
      const err = toApiError(e);
      throw new Error(`Impossibile leggere l'elenco dei modelli (${reasonOf(err)}): ${err.message}`);
    }
  });

  // ------------------------------------------------------------ config

  handle('config:get', () => config.snapshot() satisfies ConfigSnapshot);

  handle('config:update', (_e, patch) => {
    if (!isRecord(patch)) throw new Error('Patch di configurazione non valida');
    return config.update(patch as ConfigPatch);
  });

  handle('config:completeSetup', (_e, payload) => {
    if (!isRecord(payload)) throw new Error('Dati di configurazione non validi');
    return config.completeSetup(payload as unknown as SetupPayload);
  });

  handle('config:addAgent', (_e, agent) => {
    if (!isRecord(agent)) throw new Error('Dati agente non validi');
    return config.addAgent(agent as unknown as AgentInput);
  });

  handle('config:updateAgent', (_e, id, patch) => {
    if (typeof id !== 'string' || !isRecord(patch)) throw new Error('Dati agente non validi');
    return config.updateAgent(id, patch as Partial<AgentInput>);
  });

  handle('config:removeAgent', (_e, id) => {
    if (typeof id !== 'string') throw new Error('Agente non valido');
    return config.removeAgent(id);
  });

  handle('config:defaultPrompt', (_e, role) => {
    if (typeof role !== 'string' || !ROLE_VALUES.includes(role as AgentRole)) {
      throw new Error('Ruolo non valido');
    }
    return defaultPrompt(role as AgentRole);
  });

  handle('config:chooseWorkspace', async () => {
    const win = deps.getWindow();
    const opts = {
      title: 'Scegli la cartella di lavoro',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      defaultPath: config.get().workspacePath ?? os.homedir(),
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  handle('config:resetAll', () => {
    orchestrator.cancelAll('ripristino completo');
    config.resetAll();
    log('config: reset all');
  });

  // ------------------------------------------------------------ chat / agents

  handle('chat:send', (_e, text) => {
    const t = String(text ?? '').trim();
    if (!t) throw new Error('Messaggio vuoto');
    return orchestrator.userMessage(t);
  });

  handle('chat:cancel', (_e, runId) => {
    if (typeof runId === 'string' && runId) orchestrator.cancelRun(runId, 'annullato dall\'utente');
    else orchestrator.cancelAll();
  });

  handle('agent:cancel', (_e, agentId) => {
    if (typeof agentId !== 'string') throw new Error('Agente non valido');
    orchestrator.cancelAgent(agentId as AgentId);
  });

  handle('agent:clearHistory', (_e, agentId) => {
    if (typeof agentId !== 'string') throw new Error('Agente non valido');
    orchestrator.clearHistory(agentId as AgentId);
  });

  handle('instance:close', (_e, instanceId) => {
    if (typeof instanceId !== 'string') throw new Error('Istanza non valida');
    orchestrator.closeInstance(instanceId as AgentId);
  });

  // ------------------------------------------------------------ console

  handle('console:getEvents', (_e, agentId, opts) => {
    if (typeof agentId !== 'string') throw new Error('Agente non valido');
    const o = isRecord(opts) ? opts : {};
    const limit = typeof o.limit === 'number' ? o.limit : 400;
    const beforeSeq = typeof o.beforeSeq === 'number' ? o.beforeSeq : undefined;
    return state.getConsole(agentId, beforeSeq === undefined ? { limit } : { limit, beforeSeq }) satisfies ConsoleEvent[];
  });

  handle('console:clear', (_e, agentId) => {
    if (typeof agentId !== 'string') throw new Error('Agente non valido');
    state.clearConsole(agentId);
    bus.emit(agentId, null, { kind: 'info', message: 'Console svuotata' });
  });

  handle('runtime:getSnapshot', () => orchestrator.snapshot() satisfies RuntimeSnapshot);

  // ------------------------------------------------------------ permissions

  handle('permission:respond', (_e, requestId, decision, pattern) => {
    if (typeof requestId !== 'string') return;
    const d = decision as PermissionDecision;
    if (d !== 'allow' && d !== 'allow_session' && d !== 'deny') return;
    gate.respond(requestId, d, typeof pattern === 'string' ? pattern : undefined);
  });

  handle('askUser:respond', (_e, requestId, answer) => {
    if (typeof requestId !== 'string') return;
    gate.respondAsk(requestId, typeof answer === 'string' ? answer : null);
  });

  // ------------------------------------------------------------ shell

  handle('shell:openPath', async (_e, p) => {
    const target = String(p ?? '');
    const ws = config.get().workspacePath;
    if (!ws) throw new Error('Nessuna cartella di lavoro configurata');
    const abs = path.resolve(ws, target || '.');
    const rel = path.relative(ws, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Percorso fuori dalla cartella di lavoro');
    if (!fs.existsSync(abs)) throw new Error('Percorso inesistente');
    const err = await shell.openPath(abs);
    if (err) throw new Error(err);
  });

  handle('logs:openContracts', async () => {
    const file = await deps.contracts.ensureFile();
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
  });

  // Only the OpenCode workspace opt-in link from a DataPolicyError toast (PLAN-v2 §3).
  handle('shell:openExternal', async (_e, raw) => {
    let url: URL;
    try {
      url = new URL(String(raw ?? ''));
    } catch {
      throw new Error('URL non valido');
    }
    if (url.protocol !== 'https:' || (url.hostname !== 'opencode.ai' && url.hostname !== 'www.opencode.ai')) {
      throw new Error('Collegamento non consentito');
    }
    await shell.openExternal(url.toString());
  });

  log(`ipc: ${INVOKE_CHANNELS.length} handlers registered`);
}

export function removeHandlers(): void {
  for (const ch of INVOKE_CHANNELS) ipcMain.removeHandler(ch);
}
