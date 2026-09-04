// End-to-end smoke test: launches the real Electron app with an isolated userData dir,
// imports the OpenCode Go key from the local opencode CLI, completes setup with 3 agents,
// runs a delegation task that writes a file, then a command that needs a permission, and
// finally exercises hot reload. Run after `npm run build`:
//   node scripts/e2e-smoke.mjs            (needs ~/.local/share/opencode/auth.json with opencode-go key)
// Screenshots + log end up in $E2E_SCRATCH (default: os.tmpdir()/agents-windows-e2e-<ts>).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const scratch = process.env.E2E_SCRATCH || path.join(os.tmpdir(), `agents-windows-e2e-${Date.now()}`);
const userData = path.join(scratch, 'userData');
const workspace = path.join(scratch, 'workspace');
const shots = path.join(scratch, 'shots');
for (const d of [userData, workspace, shots]) fs.mkdirSync(d, { recursive: true });

const MODELS = { main: process.env.E2E_MODEL_MAIN || 'deepseek-v4-flash', dev: process.env.E2E_MODEL_DEV || 'glm-5.3-flash', rev: process.env.E2E_MODEL_REV || 'glm-5.3-flash' };
const results = [];
const logLines = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); logLines.push(line); };
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let app;
try {
  app = await electron.launch({ args: ['.', '--dev'], cwd: root, env: { ...process.env, AGENTS_WINDOWS_USER_DATA: userData, ELECTRON_ENABLE_LOGGING: '1' }, timeout: 60000 });
  app.process().stderr?.on('data', d => { const s = String(d).trim(); if (s) logLines.push('[main:stderr] ' + s); });
  // With --dev the detached DevTools window may be created first: pick the app window (app:// URL).
  let page = await app.firstWindow();
  const t0win = Date.now();
  while (!page.url().startsWith('app://') && Date.now() - t0win < 30000) {
    const w = app.windows().find(w => w.url().startsWith('app://'));
    if (w) { page = w; break; }
    await sleep(250);
  }
  await page.waitForFunction(() => !!window.api, null, { timeout: 30000 });
  page.on('console', m => logLines.push(`[renderer:${m.type()}] ${m.text()}`));
  page.on('pageerror', e => { logLines.push('[pageerror] ' + e.message); check('no renderer page errors', false, e.message); });
  const shot = async (name) => { const p = path.join(shots, `${name}.png`); await page.screenshot({ path: p }); log('shot', p); };
  const api = (channel, ...args) => page.evaluate(({ channel, args }) => window.api.invoke(channel, ...args), { channel, args });

  await page.waitForLoadState('domcontentloaded');
  const info0 = await api('app:getInfo');
  check('userData isolated', info0.userDataPath === userData, info0.userDataPath);
  check('starts on KeyScreen', !info0.hasApiKey && !info0.setupComplete);

  // ---- KeyScreen: import key from opencode CLI (the app reads the file itself; the key never passes through this script)
  const importBtn = page.getByRole('button', { name: /importa da opencode/i });
  await importBtn.waitFor({ timeout: 20000 });
  await shot('01-key-screen');
  await importBtn.click();
  await page.waitForFunction(async () => (await window.api.invoke('app:getInfo')).hasApiKey, null, { timeout: 60000 });
  check('key imported + validated', true);
  await sleep(500);
  await shot('02-wizard');

  // ---- Setup (programmatic: the workspace picker is a native dialog)
  const snap = await api('config:completeSetup', {
    workspacePath: workspace,
    agents: [
      { name: 'Coordinatore', model: MODELS.main, prompt: 'Coordinatore del team.\nRicevi le richieste dell\'utente, le scomponi, deleghi il lavoro operativo agli altri agenti e produci la risposta finale in italiano, breve.' },
      { name: 'Sviluppatore', model: MODELS.dev, prompt: 'Sviluppatore.\nEsegui le operazioni sui file del workspace che ti vengono delegate e riporta esattamente cosa hai fatto.' },
      { name: 'Revisore', model: MODELS.rev, prompt: 'Revisore.\nVerifichi il lavoro degli altri leggendo i file e riporti un esito sintetico.' },
    ],
    mainIndex: 0,
    interactionPrompt: 'Il Coordinatore non modifica file direttamente: delega la scrittura allo Sviluppatore e la verifica al Revisore, poi riassume all\'utente.',
  });
  check('setup complete', snap.setupComplete && snap.agents.length === 3, `agents=${snap.agents.length}`);
  const mainId = snap.mainAgentId;
  check('agents have distinct colours', new Set(snap.agents.map(a => a.color.toLowerCase())).size === snap.agents.length, snap.agents.map(a => a.color).join(','));
  const byName = Object.fromEntries(snap.agents.map(a => [a.name, a]));

  await page.getByText('Revisore', { exact: false }).first().waitFor({ timeout: 20000 });
  await sleep(800);
  await shot('03-workbench');
  const consoleCount = await page.evaluate(() => document.querySelectorAll('textarea').length);
  check('workbench shows an input box', consoleCount >= 1, `textareas=${consoleCount}`);

  // ---- Task 1: delegation + file write inside workspace (auto-allowed in balanced mode)
  // Waits until no agent is busy. Pending permission requests are answered through the REAL modal
  // (click "Consenti"), which also verifies that the modal reaches the user regardless of which agent asked.
  let permissionsSeen = 0;
  const waitIdle = async (timeoutMs) => {
    const t0 = Date.now();
    let s = await api('runtime:getSnapshot');
    while (Date.now() - t0 < timeoutMs) {
      s = await api('runtime:getSnapshot');
      if (s.pendingPermissions.length) {
        const btn = page.getByRole('button', { name: /^consenti$/i }).first();
        try {
          await btn.waitFor({ timeout: 5000 });
          permissionsSeen++;
          await shot(`perm-${permissionsSeen}-${s.pendingPermissions[0].agentName}`);
          log('permission request from', s.pendingPermissions[0].agentName, '→', s.pendingPermissions[0].summary);
          await btn.click();
          await sleep(500);
          continue;
        } catch { log('modal not found for pending permission; answering via API'); for (const p of s.pendingPermissions) await api('permission:respond', p.id, 'allow'); }
      }
      if (s.pendingAsks.length) { for (const a of s.pendingAsks) await api('askUser:respond', a.id, 'Procedi come ritieni meglio.'); }
      const anyBusy = s.activeUserRun || Object.values(s.agents).some(a => a.status !== 'idle' && a.status !== 'error') || s.queuedUserMessages > 0;
      if (!anyBusy) return s;
      await sleep(1500);
    }
    return s;
  };
  const input = page.locator('textarea').first();
  await input.fill('Crea nel workspace un file chiamato hello.txt contenente esattamente il testo "ciao dal team". Delega la scrittura allo Sviluppatore, poi fai verificare al Revisore leggendo il file. Infine rispondimi con una sola riga di conferma.');
  await input.press('Enter');
  await sleep(4000);
  await shot('04-running');
  let s = await waitIdle(300000);
  check('input box re-enabled after run', await page.locator('textarea').first().isEnabled(), '');
  await sleep(1000);
  await shot('05-task1-done');
  const helloPath = path.join(workspace, 'hello.txt');
  const helloOk = fs.existsSync(helloPath) && /ciao dal team/i.test(fs.readFileSync(helloPath, 'utf8'));
  check('hello.txt written by the team', helloOk, fs.existsSync(helloPath) ? JSON.stringify(fs.readFileSync(helloPath, 'utf8').slice(0, 80)) : 'missing');
  const mainEvents = await api('console:getEvents', mainId, { limit: 500 });
  const kinds = new Set(mainEvents.map(e => e.kind));
  check('main console has user_input/text/task_end', kinds.has('user_input') && kinds.has('text') && kinds.has('task_end'), [...kinds].join(','));
  check('main console shows delegation', kinds.has('delegation'), '');
  check('main console shows reasoning', kinds.has('reasoning'), '(model-dependent)');
  const devEvents = await api('console:getEvents', byName['Sviluppatore'].id, { limit: 500 });
  const devKinds = new Set(devEvents.map(e => e.kind));
  check('developer console has task_start + tool_call', devKinds.has('task_start') && devKinds.has('tool_call'), [...devKinds].join(','));
  const lastText = [...mainEvents].reverse().find(e => e.kind === 'text');
  log('final answer:', JSON.stringify((lastText?.text || '').slice(0, 200)));
  check('final answer returned to main', !!lastText && lastText.text.trim().length > 0);

  // ---- Task 2: run_command → permission modal shown directly to the user, plus hot reload mid-run
  const permBefore = permissionsSeen;
  await input.fill('Esegui tu stesso il comando "ls -la" nella cartella di lavoro con lo strumento run_command (non delegare) e riportami solo i nomi dei file trovati.');
  await input.press('Enter');
  await sleep(2500);
  // Hot reload while the run is in flight: rename the developer + change the protocol
  const before = (await api('console:getEvents', mainId, { limit: 800 })).length;
  await api('config:updateAgent', byName['Sviluppatore'].id, { name: 'Dev Senior' });
  await api('config:update', { interactionPrompt: 'Protocollo aggiornato: il Coordinatore delega a Dev Senior e Revisore, e risponde sempre lui per ultimo.' });
  await sleep(800);
  const after = (await api('console:getEvents', mainId, { limit: 800 })).length;
  check('hot reload keeps console history', after >= before, `${before} -> ${after}`);
  const renamed = await page.getByText('Dev Senior', { exact: false }).count();
  check('renamed agent visible in UI', renamed > 0, `matches=${renamed}`);
  await shot('07-hot-reload');
  s = await waitIdle(240000);
  await sleep(1000);
  await shot('08-task2-done');
  check('permission modal shown to the user (any task)', permissionsSeen > 0, `total=${permissionsSeen}, during task2=${permissionsSeen - permBefore}`);
  const mainEvents2 = await api('console:getEvents', mainId, { limit: 800 });
  const allEvents2 = (await Promise.all(snap.agents.map(a => api('console:getEvents', a.id, { limit: 800 })))).flat();
  const perm = allEvents2.filter(e => e.kind === 'permission');
  check('permission events recorded on consoles', perm.length > 0, perm.map(p => p.status).join(','));
  const toolCalls = allEvents2.filter(e => e.kind === 'tool_call' && e.name === 'run_command');
  check('run_command executed after allow', toolCalls.some(t => t.status === 'done'), toolCalls.map(t => t.status).join(','));
  check('task 2 ended on main', mainEvents2.filter(e => e.kind === 'task_end').length >= 2, `task_end=${mainEvents2.filter(e => e.kind === 'task_end').length}`);
  const lastText2 = [...mainEvents2].reverse().find(e => e.kind === 'text');
  log('final answer 2:', JSON.stringify((lastText2?.text || '').slice(0, 200)));

  // ---- Settings drawer opens
  const settingsBtn = page.getByRole('button', { name: /impostazioni/i }).first();
  if (await settingsBtn.count()) { await settingsBtn.click(); await sleep(600); await shot('09-settings'); check('settings drawer opens', true); }
  else check('settings drawer opens', false, 'button not found');

  // ---- Persistence: config + state files exist
  const cfgOk = fs.existsSync(path.join(userData, 'config.json'));
  const stateFiles = fs.existsSync(path.join(userData, 'state')) ? fs.readdirSync(path.join(userData, 'state'), { recursive: true }).filter(f => String(f).endsWith('.json')) : [];
  check('config.json + state persisted', cfgOk && stateFiles.length >= 2, `state files=${stateFiles.length}`);
  const cfgRaw = fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
  check('api key not stored in plain text', !/sk-[A-Za-z0-9]{20,}/.test(cfgRaw));
} catch (err) {
  check('script completed without exception', false, String(err?.stack || err));
} finally {
  try { await app?.close(); } catch {}
  fs.writeFileSync(path.join(scratch, 'e2e.log'), logLines.join('\n'));
  const failed = results.filter(r => !r.ok);
  console.log('\n==== E2E SUMMARY ====');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`scratch: ${scratch}`);
  process.exit(failed.length ? 1 : 0);
}
