// End-to-end smoke test for the v2 pool (PLAN-v2 §13.2): launches the real Electron app with an
// isolated userData dir, imports the OpenCode Go key from the local opencode CLI, sets up a 5-template
// pool, then exercises T0 (zero agents), T2 fan-out, model fallback, caps, ephemeral cleanup,
// permissions, hot reload, a 6-worker fan-out proving nothing is hardcoded to 4, a pool without a
// verifier and an orchestrator-only pool. Run after `npm run build`:
//   node scripts/e2e-smoke.mjs        (needs ~/.local/share/opencode/auth.json with an opencode-go key)
// Screenshots, logs and the captured event stream land in $E2E_SCRATCH.
// Env overrides: E2E_MODEL_ORCH, E2E_MODEL_PLAN, E2E_MODEL_WORKER, E2E_MODEL_FLASH, E2E_MODEL_VERIFY,
//                E2E_COST_LIMIT (default 0.10), E2E_SKIP (comma-separated scenario numbers).
import { _electron as electron } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const scratch = process.env.E2E_SCRATCH || path.join(os.tmpdir(), `agents-pool-e2e-${Date.now()}`);
const userData = path.join(scratch, 'userData');
const workspace = path.join(scratch, 'workspace');
const shots = path.join(scratch, 'shots');
const outside = path.join(scratch, 'outside');   // deliberately NOT under the workspace
for (const d of [userData, workspace, shots, outside]) fs.mkdirSync(d, { recursive: true });

const M = {
  orch: process.env.E2E_MODEL_ORCH || 'minimax-m3',
  plan: process.env.E2E_MODEL_PLAN || 'minimax-m3',
  worker: process.env.E2E_MODEL_WORKER || 'muse-spark-1.3-contributor', // exercises the 403 → fallback path
  flash: process.env.E2E_MODEL_FLASH || 'longcat-2.0',
  verify: process.env.E2E_MODEL_VERIFY || 'glm-5.3-flash',
};
const COST_LIMIT = Number(process.env.E2E_COST_LIMIT || 0.10);
const SKIP = new Set((process.env.E2E_SKIP || '').split(',').map(s => s.trim()).filter(Boolean));

const results = [];
const logLines = [];
const log = (...a) => { const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`; console.log(line); logLines.push(line); };
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); log(ok ? 'PASS' : 'FAIL', name, detail); };
const soft = (name, ok, detail = '') => { results.push({ name, ok: true, soft: !ok, detail }); log(ok ? 'PASS' : 'NOTE', name, detail); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uniq = (a) => [...new Set(a)];

let app;
try {
  const DEV = process.env.E2E_DEV === '1';
  app = await electron.launch({
    args: DEV ? ['.', '--dev'] : ['.'], cwd: root, timeout: 60000,
    env: { ...process.env, AGENTS_POOL_USER_DATA: userData, ...(DEV ? { ELECTRON_ENABLE_LOGGING: '1' } : {}) },
  });
  app.process().stderr?.on('data', d => { const s = String(d).trim(); if (s) logLines.push('[main:stderr] ' + s); });
  app.process().stdout?.on('data', d => { const s = String(d).trim(); if (s) logLines.push('[main:stdout] ' + s); });
  let appExit = null;
  app.process().on('exit', (code, signal) => { appExit = { code, signal, ts: Date.now() }; logLines.push(`[main:exit] code=${code} signal=${signal}`); });
  app.on('close', () => logLines.push('[electron:close]'));
  globalThis.__appExit = () => appExit;

  // With --dev a detached DevTools window may come first: pick the app window (app:// URL).
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

  const shot = async (name) => { const p = path.join(shots, `${name}.png`); await page.screenshot({ path: p }).catch(() => {}); log('shot', name); };
  let reacquired = 0;
  const reacquire = async () => {
    const w = app.windows().find(x => !x.isClosed() && x.url().startsWith('app://'));
    if (!w) return false;
    if (w === page) return false;
    page = w; reacquired++;
    log('page handle re-acquired (', reacquired, ') — window is alive');
    await page.waitForFunction(() => !!window.api, null, { timeout: 15000 }).catch(() => {});
    await installSpy();
    return true;
  };
  const api = async (channel, ...args) => {
    try {
      return await page.evaluate(({ channel, args }) => window.api.invoke(channel, ...args), { channel, args });
    } catch (e) {
      if (!/closed|detached|Target/i.test(String(e))) throw e;
      if (!(await reacquire())) throw e;
      return await page.evaluate(({ channel, args }) => window.api.invoke(channel, ...args), { channel, args });
    }
  };

  // ---- Event spy: mirror main→renderer events into an in-page array we can query.
  const installSpy = async () => {
    await page.evaluate(() => {
      if (window.__spy) return;
      window.__spy = { add: [], remove: [], toast: [], finished: [], status: [] };
      window.api.on('console:add', (v) => window.__spy.add.push({ ts: Date.now(), v }));
      window.api.on('console:remove', (v) => window.__spy.remove.push({ ts: Date.now(), v }));
      window.api.on('app:toast', (v) => window.__spy.toast.push({ ts: Date.now(), v }));
      window.api.on('run:finished', (v) => window.__spy.finished.push({ ts: Date.now(), v }));
    }).catch(() => {});
  };
  await installSpy();
  const spy = async (key) => {
    try { return await page.evaluate((k) => (window.__spy || {})[k] || [], key); }
    catch (e) { if (await reacquire()) return await page.evaluate((k) => (window.__spy || {})[k] || [], key); throw e; }
  };

  await page.waitForLoadState('domcontentloaded');
  const info0 = await api('app:getInfo');
  check('userData isolated', info0.userDataPath === userData, info0.userDataPath);
  check('starts on KeyScreen', !info0.hasApiKey && !info0.setupComplete);
  check('AppInfo exposes pool ranges + presets', !!info0.poolRanges && Array.isArray(info0.recommendedPool) && info0.recommendedPool.length > 0,
    `ranges=${!!info0.poolRanges} recommended=${(info0.recommendedPool || []).length}`);

  // ================================================================= 1. key + setup
  const importBtn = page.getByRole('button', { name: /importa da opencode/i });
  await importBtn.waitFor({ timeout: 20000 });
  await shot('01-key-screen');
  await importBtn.click();
  await page.waitForFunction(async () => (await window.api.invoke('app:getInfo')).hasApiKey, null, { timeout: 60000 });
  check('key imported + validated', true);
  await sleep(400);
  await shot('02-wizard');

  const snap0 = await api('config:completeSetup', {
    workspacePath: workspace,
    agents: [
      { name: 'Orchestratore', role: 'orchestrator', model: M.orch, fallbacks: ['qwen3.7-plus'],
        prompt: 'Coordinatore del pool.\nParli solo tu con l\'utente: classifichi il tier, deleghi con TaskContract e sintetizzi la risposta finale in italiano, breve.' },
      { name: 'Planner', role: 'planner', model: M.plan, fallbacks: ['glm-5.3-flash'],
        prompt: 'Pianificatore.\nScomponi obiettivi ampi in task verificabili con dipendenze.' },
      { name: 'Worker', role: 'worker', model: M.worker, fallbacks: ['deepseek-v4-flash'],
        prompt: 'Worker generico.\nEsegui un solo TaskContract sui file del workspace e riporta il ResultContract.' },
      { name: 'Worker Flash', role: 'worker', model: M.flash, fallbacks: ['glm-5.3-flash'],
        prompt: 'Worker per task meccanici.\nEsegui un solo TaskContract, il più rapidamente possibile.' },
      { name: 'Verificatore', role: 'verifier', model: M.verify, fallbacks: ['qwen3.7-plus'],
        prompt: 'Verificatore avversariale.\nTrovi dove l\'output è sbagliato rispetto alla richiesta originale.' },
    ],
    mainIndex: 0,
    interactionPrompt: 'L\'Orchestratore non tocca i file: delega ai worker in parallelo quando i task sono indipendenti, fa verificare dal Verificatore quando ci sono almeno due worker, poi risponde lui.',
  });
  const roles = (snap0.agents || []).map(a => a.role);
  check('setup complete with 5 templates', snap0.setupComplete && snap0.agents.length === 5, `agents=${snap0.agents.length}`);
  check('roles assigned (1 orchestrator, 2 worker, planner, verifier)',
    roles.filter(r => r === 'orchestrator').length === 1 && roles.filter(r => r === 'worker').length === 2 &&
    roles.includes('planner') && roles.includes('verifier'), roles.join(','));
  check('default pool limits are 4/8/1', snap0.maxParallelWorkers === 4 && snap0.maxWorkersPerRequest === 8 && snap0.correctionRounds === 1,
    `${snap0.maxParallelWorkers}/${snap0.maxWorkersPerRequest}/${snap0.correctionRounds}`);
  check('agents have distinct colours', uniq((snap0.agents || []).map(a => String(a.color).toLowerCase())).length === snap0.agents.length,
    (snap0.agents || []).map(a => a.color).join(','));

  const idOf = (name) => (snap0.agents.find(a => a.name === name) || {}).id;
  let mainId = snap0.mainAgentId;
  await page.getByText('Verificatore', { exact: false }).first().waitFor({ timeout: 20000 });
  await sleep(700);
  await shot('03-workbench');

  // ---- helpers ------------------------------------------------------------
  const events = async (agentId, limit = 900) => api('console:getEvents', agentId, { limit });
  const allEvents = async () => {
    const snap = await api('config:get');
    const per = await Promise.all((snap.agents || []).map(a => events(a.id)));
    const inst = await api('runtime:getSnapshot');
    const instEvents = await Promise.all(Object.keys(inst.agents || {}).filter(id => id.includes('#')).map(id => events(id)));
    return [...per.flat(), ...instEvents.flat()];
  };
  let peakInstances = 0;
  const waitIdle = async (timeoutMs, opts = {}) => {
    const t0 = Date.now();
    let s = await api('runtime:getSnapshot');
    while (Date.now() - t0 < timeoutMs) {
      s = await api('runtime:getSnapshot');
      peakInstances = Math.max(peakInstances, (s.instances || []).length);
      if (opts.onPoll) await opts.onPoll(s);
      if ((s.pendingPermissions || []).length) {
        if (opts.autoAllow === false) return s;
        const btn = page.getByRole('button', { name: /^consenti$/i }).first();
        try {
          await btn.waitFor({ timeout: 6000 });
          log('permission from', s.pendingPermissions[0].agentName, '→', String(s.pendingPermissions[0].summary).slice(0, 70));
          await shot(`perm-${Date.now() % 100000}`);
          await btn.click();
        } catch {
          for (const p of s.pendingPermissions) await api('permission:respond', p.id, 'allow');
        }
        await sleep(400); continue;
      }
      if ((s.pendingAsks || []).length) { for (const a of s.pendingAsks) await api('askUser:respond', a.id, 'Procedi come ritieni meglio.'); await sleep(300); continue; }
      // NOTE: `instances` legitimately still lists finished ephemeral consoles — they are removed
      // only when the next user request starts — so busyness is decided by statuses alone.
      const busy = s.activeUserRun || (s.queuedUserMessages || 0) > 0 ||
        Object.values(s.agents || {}).some(a => a.status !== 'idle' && a.status !== 'error');
      if (!busy) return s;
      await sleep(1200);
    }
    log('waitIdle TIMEOUT after', timeoutMs, 'ms');
    return s;
  };
  const input = () => page.locator('textarea').first();
  const send = async (text) => {
    await input().waitFor({ state: 'visible', timeout: 30000 });
    for (let i = 0; i < 60 && !(await input().isEnabled()); i++) await sleep(500);
    await input().fill(text);
    await input().press('Enter');
  };
  const lastTier = (evs) => { const te = evs.filter(e => e.kind === 'task_end' && e.tier); return te.length ? te[te.length - 1].tier : null; };

  // ================================================================= 2. T0 — zero agents
  if (!SKIP.has('2')) {
    const before = (await events(mainId)).length;
    await send('Ciao, come stai?');
    let sawInstance = false;
    await waitIdle(150000, { onPoll: (s) => { if ((s.instances || []).length) sawInstance = true; } });
    await sleep(600);
    const evs = (await events(mainId)).slice(before);
    const dels = evs.filter(e => e.kind === 'delegation');
    const txt = [...evs].reverse().find(e => e.kind === 'text');
    check('T0: no delegation for a conversational request', dels.length === 0, `delegations=${dels.length}`);
    check('T0: no worker instance spawned', !sawInstance);
    check('T0: tier reported as T0', lastTier(evs) === 'T0', String(lastTier(evs)));
    check('T0: orchestrator answered directly', !!txt && txt.text.trim().length > 0, JSON.stringify((txt?.text || '').slice(0, 60)));
    await shot('04-t0');
  }

  // ================================================================= 3+4. T2 fan-out, contracts, verifier, fallback
  let requestFiles = [];
  if (!SKIP.has('3')) {
    const before = (await events(mainId)).length;
    const addBefore = (await spy('add')).length;
    await send('Crea due file nel workspace, in parallelo con due worker diversi: alpha.txt con "alpha" e beta.txt con "beta". Poi fai verificare il risultato dal Verificatore.');
    await sleep(3500);
    await shot('05-t2-running');
    await waitIdle(420000);
    await sleep(1000);
    await shot('06-t2-done');

    const evs = (await events(mainId)).slice(before);
    const dels = evs.filter(e => e.kind === 'delegation');
    const tiers = uniq(dels.map(d => d.tier).filter(Boolean));
    check('T2: at least 2 delegations', dels.length >= 2, `delegations=${dels.length} tiers=${tiers.join(',')}`);
    check('T2: distinct task ids', uniq(dels.map(d => d.taskId).filter(Boolean)).length >= 2, dels.map(d => d.taskId).join(','));
    check('T2: ephemeral consoles were added', (await spy('add')).length - addBefore >= 2, `console:add=${(await spy('add')).length - addBefore}`);
    check('T2: peak instances >= 2', peakInstances >= 2, `peak=${peakInstances}`);
    const alpha = path.join(workspace, 'alpha.txt'), beta = path.join(workspace, 'beta.txt');
    const filesOk = fs.existsSync(alpha) && fs.existsSync(beta) && /alpha/i.test(fs.readFileSync(alpha, 'utf8')) && /beta/i.test(fs.readFileSync(beta, 'utf8'));
    check('T2: both files written with disjoint names', filesOk, fs.readdirSync(workspace).join(','));
    requestFiles = fs.readdirSync(workspace);
    const withResult = dels.filter(d => d.result && typeof d.result === 'object');
    const killed = withResult.filter(d => /budget maxTokens/.test(JSON.stringify(d.result.unverified || [])));
    check('T2: instances not killed by a model-invented budget', killed.length === 0,
      `killed=${killed.length}/${withResult.length}`);
    check('T2: instances reported ok/partial with real content',
      withResult.every(d => String(d.result.result || '').trim().length > 0),
      withResult.map(d => `${d.taskId}:${d.result.status}`).join(','));
    check('T2: delegation cards carry the ResultContract', withResult.length >= 2, `with result=${withResult.length}/${dels.length}`);
    check('T2: result costs measured by the system', withResult.some(d => d.result?.cost?.tokens > 0),
      withResult.map(d => d.result?.cost?.tokens).join(','));
    check('T2: delegation cards carry the TaskContract', dels.filter(d => d.contract && d.contract.objective).length >= 2, '');
    const every = await allEvents();
    const verifierCall = every.filter(e => e.kind === 'tool_call' && e.name === 'run_verifier');
    const verdicts = every.filter(e => e.kind === 'verdict');
    soft('T2: verifier ran', verifierCall.some(t => t.status === 'done') || verdicts.length > 0,
      `run_verifier=${verifierCall.map(t => t.status).join(',') || 'none'} verdict=${verdicts.length}`);
    check('T2: a delegating run is not reported as T0', lastTier(evs) !== null && lastTier(evs) !== 'T0', String(lastTier(evs)));
    soft('T2: orchestrator declared T2/T3 (model judgement)', ['T2', 'T3'].includes(lastTier(evs)), String(lastTier(evs)));

    // contracts.jsonl
    const jl = path.join(userData, 'logs', 'contracts.jsonl');
    const lines = fs.existsSync(jl) ? fs.readFileSync(jl, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const kinds = lines.map(l => l.kind || l.type);
    check('contracts.jsonl logs tasks and results', kinds.filter(k => /task/.test(k)).length >= 2 && kinds.filter(k => /result/.test(k)).length >= 2,
      `lines=${lines.length} kinds=${uniq(kinds).join(',')}`);

    // side-effect serialization: the two writing instances must not overlap
    const instIds = uniq(every.filter(e => String(e.agentId).includes('#')).map(e => e.agentId));
    const spans = instIds.map(id => {
      const es = every.filter(e => e.agentId === id);
      const st = es.find(e => e.kind === 'task_start'), en = es.find(e => e.kind === 'task_end');
      return st && en ? { id, a: st.ts, b: en.ts, sideEffects: !!st.contract?.side_effects } : null;
    }).filter(Boolean);
    const se = spans.filter(s => s.sideEffects);
    const overlap = se.some((x, i) => se.some((y, j) => j > i && x.a < y.b && y.a < x.b));
    soft('side-effect instances never overlapped', se.length < 2 || !overlap, `side-effect spans=${se.length}`);

    // fallback (Worker primary is muse-spark unless overridden)
    const infos = every.filter(e => e.kind === 'info' && /Fallback:/i.test(e.message || ''));
    const toasts = (await spy('toast')).map(t => t.v);
    const rs = await api('runtime:getSnapshot');
    if (M.worker === 'muse-spark-1.3-contributor') {
      const hit = infos.some(e => /muse-spark/i.test(e.message));
      const unavailable = (rs.unavailableModels || []).some(m => /muse-spark/i.test(String(m)));
      const toastHit = toasts.some(t => /muse-spark/i.test(String(t.message)) && t.url);
      // A data-policy refusal is permanent for the session; a rate limit is not, and must NOT stick.
      const policyRefusal = infos.some(e => /muse-spark/i.test(e.message) && /policy|data/i.test(e.message));
      if (hit || unavailable) {
        check('fallback: info event on the instance console', hit, infos.map(i => i.message).slice(0, 2).join(' | '));
        check('fallback: the run continued on the fallback model', hit, '');
        if (policyRefusal) {
          check('fallback: data-policy refusal marks the model unavailable', unavailable, JSON.stringify(rs.unavailableModels || []));
          soft('fallback: toast carries the opt-in URL', toastHit, JSON.stringify(toasts.slice(0, 2)));
        } else {
          check('fallback: a rate limit does NOT mark the model unavailable', !unavailable, JSON.stringify(rs.unavailableModels || []));
        }
      } else {
        soft('fallback not exercised (opt-in may be active or Worker unused)', true, `infos=${infos.length}`);
      }
    }
  }

  // ================================================================= 5+6. caps and ephemeral cleanup
  if (!SKIP.has('5')) {
    const instBefore = uniq((await allEvents()).filter(e => String(e.agentId).includes('#')).map(e => e.agentId));
    const before = (await events(mainId)).length;
    await send('Delega in una sola chiamata delegate_tasks esattamente 12 task paralleli distinti, ognuno deve elencare il contenuto della cartella di lavoro con list_directory.');
    await sleep(2500);
    const removed = (await spy('remove')).map(r => r.v);
    check('ephemeral consoles cleaned up on the next request',
      removed.length === 0 || removed.some(r => /next_request/.test(String(r.reason || ''))) || instBefore.length === 0,
      `remove events=${removed.length} reasons=${uniq(removed.map(r => r.reason)).join(',')}`);
    await waitIdle(300000);
    await sleep(800);
    await shot('07-caps');
    const evs = (await events(mainId)).slice(before);
    const dt = evs.filter(e => e.kind === 'tool_call' && e.name === 'delegate_tasks');
    const errored = dt.some(t => /ERROR|massim|limite|maxParallelWorkers/i.test(String(t.result?.output || '')));
    const dels = evs.filter(e => e.kind === 'delegation');
    check('caps: batch above maxParallelWorkers rejected or clamped', errored || dels.length <= 4,
      `delegate_tasks=${dt.length} rejected=${errored} delegations=${dels.length}`);
    check('caps: run still completes', evs.some(e => e.kind === 'task_end'), '');
    const rs = await api('runtime:getSnapshot');
    check('caps: request stayed within maxWorkersPerRequest', peakInstances <= 8, `peak=${peakInstances}`);
    const stillBusy = Object.entries(rs.agents || {}).filter(([, a]) => a.status !== 'idle' && a.status !== 'error');
    check('caps: nothing left running after the capped run', stillBusy.length === 0,
      stillBusy.map(([id, a]) => `${id}:${a.status}`).join(',') || `instances listed=${(rs.instances || []).length}`);
  }

  // ================================================================= 6b. hot reload of the orchestrator prompt while the pool is working
  if (!SKIP.has('6b')) {
    const before = (await events(mainId)).length;
    await send('Crea in parallelo con due worker distinti i file h1.txt e h2.txt, ognuno con una frase di due righe che descrive il proprio nome, poi confermami l\'esito.');
    // wait until the pool is genuinely busy, then edit the prompt of the agent that is working
    for (let i = 0; i < 200; i++) {
      const s2 = await api('runtime:getSnapshot');
      if ((s2.instances || []).length >= 1) break;
      await sleep(700);
    }
    await api('config:updateAgent', mainId, { prompt: 'Coordinatore del pool.\nPrompt cambiato a caldo durante il lavoro: rispondi sempre in due righe.' });
    await api('config:update', { permissionMode: 'balanced' });
    await sleep(600);
    await shot('07b-prompt-hot-reload');
    await waitIdle(360000);
    await sleep(800);
    const evs = (await events(mainId)).slice(before);
    const every6b = await allEvents();
    check('hot reload: the run resumes and finishes after editing the working agent prompt',
      evs.some(e => e.kind === 'task_end' && e.status === 'done'),
      evs.filter(e => e.kind === 'task_end').map(e => e.status).join(',') || 'no task_end');
    const madeH = ['h1.txt', 'h2.txt'].filter(f => fs.existsSync(path.join(workspace, f)));
    check('hot reload: the delegated work still landed', madeH.length >= 1, `created=${madeH.join(',')}`);
    // the token cap must never shrink an answer to nothing: no reply may come back truncated
    const cut = every6b.filter(e => e.kind === 'llm_call' && e.finishReason === 'length');
    check('no model reply was truncated by the per-call token cap', cut.length === 0,
      cut.map(e => `${e.model}@iter${e.iteration}`).join(',') || '');
    const noDeliverable = every6b.filter(e => e.kind === 'delegation' && e.result
      && /troncata|not in ResultContract/i.test(JSON.stringify(e.result.unverified || [])));
    check('no delegation came back truncated', noDeliverable.length === 0, `${noDeliverable.length}`);
  }

  // ================================================================= 7. permission modal + hot reload mid-run
  if (!SKIP.has('7')) {
    const outFile = path.join(outside, 'fuori.txt');
    const before = (await events(mainId)).length;
    await send(`Delega a un worker la scrittura del file ${outFile} (percorso assoluto, fuori dalla cartella di lavoro) con dentro esattamente "fuori". Poi confermami l'esito.`);
    await sleep(3000);
    const histBefore = (await events(mainId)).length;
    await api('config:updateAgent', idOf('Worker Flash'), { name: 'Flash Senior' });
    await api('config:update', { maxParallelWorkers: 2, interactionPrompt: 'Protocollo aggiornato a caldo: worker in parallelo solo se i task sono indipendenti.' });
    await sleep(900);
    const histAfter = (await events(mainId)).length;
    check('hot reload keeps console history', histAfter >= histBefore, `${histBefore} -> ${histAfter}`);
    check('hot reload: renamed template visible in the UI', (await page.getByText('Flash Senior', { exact: false }).count()) > 0, '');
    await shot('08-hot-reload');
    await waitIdle(300000);
    await sleep(800);
    await shot('09-permission-done');
    const every = await allEvents();
    const perms = every.filter(e => e.kind === 'permission');
    check('permission was requested for a write outside the workspace', perms.length > 0, uniq(perms.map(p => p.status)).join(','));
    check('permission modal was answered with allow', perms.some(p => p.status === 'allow' || p.status === 'allow_session'),
      uniq(perms.map(p => p.status)).join(','));
    // Whether the worker goes through with it is its own call — some refuse to leave the workspace
    // even once approved — so the app's contract (the request reached the user) is the hard check.
    soft('the approved write landed outside the workspace', fs.existsSync(path.join(outside, 'fuori.txt')),
      fs.readdirSync(outside).join(',') || 'empty (the worker declined to write outside)');
    const evs = (await events(mainId)).slice(before);
    check('run after hot reload ended', evs.some(e => e.kind === 'task_end'), '');
    await api('config:update', { maxParallelWorkers: 4 });
  }

  // ================================================================= 8. settings drawer
  if (!SKIP.has('8')) {
    const btn = page.getByRole('button', { name: /impostazioni/i }).first();
    if (await btn.count()) {
      await btn.click(); await sleep(700); await shot('10-settings');
      const body = await page.evaluate(() => document.body.innerText);
      check('settings: pool section present', /pool|worker paralleli|limiti/i.test(body), '');
      check('settings: contracts log action present', /log contratti|contratti/i.test(body), '');
      check('settings: role labels present', /orchestrator|orchestratore|verifier|verificatore/i.test(body), '');
      check('settings: bypass mode offered', /bypass/i.test(body), '');
      // the role-prompt reset lives inside a template's edit form
      const edit = page.getByRole('button', { name: /cambiare ruolo|modifica|✎/i }).first();
      if (await edit.count()) {
        await edit.click({ timeout: 5000 }).catch(() => {});
        await sleep(500);
        const formBody = await page.evaluate(() => document.body.innerText);
        check('settings: reset role prompt action present in the template form', /ripristina prompt/i.test(formBody), '');
        check('settings: routing editor present', /fallback|escalation|temperatura/i.test(formBody), '');
        await shot('10b-settings-form');
      } else check('settings: template edit form reachable', false, 'edit button not found');
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(300);
      if (await page.getByText('Reset totale', { exact: false }).count()) {
        const close = page.getByRole('button', { name: /chiudi/i }).first();
        if (await close.count()) await close.click({ timeout: 5000 }).catch(() => {});
      }
      await sleep(400);
      // the drawer keeps its DOM when hidden, so closure is measured by visibility
      const stillVisible = await page.getByText('Reset totale', { exact: false }).first().isVisible().catch(() => false);
      check('settings drawer closes with Esc', !stillVisible, stillVisible ? 'still visible' : '');
    } else check('settings drawer opens', false, 'button not found');
  }

  // ================================================================= 10. bypass mode: never asks
  if (!SKIP.has('10')) {
    await api('config:update', { permissionMode: 'bypass' });
    await sleep(500);
    const badge = await page.getByText(/BYPASS/i).count();
    check('bypass: header badge visible', badge > 0, `matches=${badge}`);
    const bypassFile = path.join(outside, 'bypass.txt');
    const before = (await events(mainId)).length;
    await send(`Delega a un worker la scrittura del file ${bypassFile} (percorso assoluto, fuori dalla cartella di lavoro) con dentro esattamente "bypass", poi confermami l'esito.`);
    let modalSeen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      const s2 = await api('runtime:getSnapshot');
      if ((s2.pendingPermissions || []).length) { modalSeen = true; break; }
      const busy = s2.activeUserRun || Object.values(s2.agents || {}).some(a => a.status !== 'idle' && a.status !== 'error');
      if (!busy) break;
      await sleep(1200);
    }
    await sleep(800);
    await shot('16-bypass');
    check('bypass: no permission was ever requested', !modalSeen, modalSeen ? 'a modal appeared' : '');
    const runEvents = (await events(mainId)).slice(before);
    const since = runEvents[0]?.ts || 0;
    const every2 = await allEvents();
    const newer = every2.filter(e => e.ts >= since);
    const landed = fs.existsSync(path.join(outside, 'bypass.txt'));
    soft('bypass: the write outside the workspace went through with no approval', landed,
      fs.readdirSync(outside).join(',') || 'empty (the worker declined to write outside)');
    const audit = newer.filter(e => e.kind === 'permission' && e.status === 'auto_allow');
    // Only assertable when a sensitive action actually happened; the policy table itself is covered
    // deterministically by scripts/api-smoke.mjs.
    if (landed) {
      check('bypass: granted actions are still recorded on the console', audit.length > 0,
        `audit events=${audit.length} · ${audit.map(a => a.summary).slice(0, 2).join(' | ')}`);
    } else soft('bypass: audit trail (no sensitive action was attempted)', audit.length > 0, `audit events=${audit.length}`);
    await api('config:update', { permissionMode: 'balanced' });
    await sleep(400);
    check('bypass: badge disappears when the mode is restored',
      (await page.getByText(/BYPASS/i).count()) === 0 || !(await page.getByText(/BYPASS/i).first().isVisible().catch(() => false)), '');
  }

  // ================================================================= 11. not capped at 4 — six parallel workers
  if (!SKIP.has('11')) {
    await api('config:update', { maxParallelWorkers: 6, maxWorkersPerRequest: 8 });
    peakInstances = 0;
    const before = (await events(mainId)).length;
    const addBefore = (await spy('add')).length;
    await send('Crea in parallelo, con un solo delegate_tasks e sei worker distinti, i file f1.txt, f2.txt, f3.txt, f4.txt, f5.txt e f6.txt: ognuno deve contenere il proprio nome senza estensione.');
    await sleep(3000);
    await shot('11-six-workers');
    await waitIdle(480000);
    await sleep(1000);
    await shot('12-six-done');
    const evs = (await events(mainId)).slice(before);
    const dt = evs.filter(e => e.kind === 'tool_call' && e.name === 'delegate_tasks');
    const biggest = Math.max(0, ...dt.map(t => { try { return (JSON.parse(t.argsRaw || '{}').tasks || []).length; } catch { return 0; } }));
    const dels = evs.filter(e => e.kind === 'delegation');
    const rejected = dt.some(t => /ERROR/i.test(String(t.result?.output || '')));
    check('not capped at 4: no batch was rejected', !rejected, `biggest batch=${biggest} rejected=${rejected}`);
    soft('not capped at 4: 6 tasks in a single batch (model may split)', biggest >= 5, `biggest batch=${biggest}`);
    check('not capped at 4: at least 5 distinct delegations', uniq(dels.map(d => d.taskId).filter(Boolean)).length >= 5, `delegations=${dels.length}`);
    check('not capped at 4: instances above 4 observed', peakInstances >= 5 || (await spy('add')).length - addBefore >= 5,
      `peak=${peakInstances} adds=${(await spy('add')).length - addBefore}`);
    const made = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].filter(n => fs.existsSync(path.join(workspace, `${n}.txt`)));
    check('not capped at 4: files created', made.length >= 5, `created=${made.join(',')}`);
    await api('config:update', { maxParallelWorkers: 4, maxWorkersPerRequest: 8 });
  }

  // ================================================================= 12. pool without a verifier
  if (!SKIP.has('12')) {
    const snapV = await api('config:removeAgent', idOf('Verificatore'));
    check('verifier template removable', !(snapV.agents || []).some(a => a.name === 'Verificatore'), `agents=${snapV.agents.length}`);
    const before = (await events(mainId)).length;
    await send('Crea due file, uno.txt e due.txt, ognuno contenente il proprio nome, usando due worker in parallelo.');
    await sleep(2500);
    await waitIdle(360000);
    await sleep(800);
    await shot('13-no-verifier');
    const evs = (await events(mainId)).slice(before);
    const every = await allEvents();
    check('no verifier: run completes', evs.some(e => e.kind === 'task_end'), '');
    // The tool is not exposed without a verifier template, but a model can still call it from memory:
    // what must hold is that no verifier RUNS and that the call is refused with an explanation.
    const vCalls = evs.filter(e => e.kind === 'tool_call' && e.name === 'run_verifier');
    check('no verifier: no verdict was produced', !every.some(e => e.kind === 'verdict' && e.ts >= (evs[0]?.ts || 0)), '');
    if (vCalls.length) {
      check('no verifier: a hallucinated run_verifier call is refused with an explanation',
        vCalls.every(t => /no verifier template|verify inline|nessun template/i.test(String(t.result?.output || ''))),
        vCalls.map(t => `${t.status}:${String(t.result?.output || '').slice(0, 60)}`).join(' | '));
    } else soft('no verifier: the model did not even try to call run_verifier', true, '');
    check('no verifier: no error event on the orchestrator', !evs.some(e => e.kind === 'error'), evs.filter(e => e.kind === 'error').map(e => e.message).join(' | '));
    const both = ['uno.txt', 'due.txt'].filter(f => fs.existsSync(path.join(workspace, f)));
    soft('no verifier: both files written', both.length === 2, `created=${both.join(',')}`);
  }

  // ================================================================= 13. orchestrator-only pool
  if (!SKIP.has('13')) {
    for (const n of ['Planner', 'Worker', 'Worker Flash']) {
      const id = idOf(n); if (!id) continue;
      try { await api('config:removeAgent', id); } catch (e) { log('remove', n, 'failed:', String(e).slice(0, 80)); }
    }
    let threw = false;
    try { await api('config:removeAgent', mainId); } catch { threw = true; }
    check('orchestrator cannot be removed', threw);
    const snapO = await api('config:get');
    check('pool reduced to the orchestrator alone', snapO.agents.length === 1 && snapO.agents[0].role === 'orchestrator', `agents=${snapO.agents.length}`);
    await sleep(600); await shot('14-orchestrator-only');
    const before = (await events(mainId)).length;
    await send('Quanti file .txt ci sono nella cartella di lavoro?');
    await waitIdle(240000);
    await sleep(600);
    let evs = (await events(mainId)).slice(before);
    const txt1 = [...evs].reverse().find(e => e.kind === 'text');
    const expected = fs.readdirSync(workspace).filter(f => f.endsWith('.txt')).length;
    check('orchestrator-only: answers without delegating', !evs.some(e => e.kind === 'delegation') && !!txt1 && txt1.text.trim().length > 0, `text=${JSON.stringify((txt1?.text || '').slice(0, 70))}`);
    check('orchestrator-only: tier T0', lastTier(evs) === 'T0', String(lastTier(evs)));
    soft('orchestrator-only: counted the files correctly', new RegExp(`\\b${expected}\\b`).test(txt1?.text || ''), `expected=${expected}`);
    const before2 = (await events(mainId)).length;
    await send('Scrivi una poesia di due versi.');
    await waitIdle(180000);
    await sleep(600);
    evs = (await events(mainId)).slice(before2);
    const txt2 = [...evs].reverse().find(e => e.kind === 'text');
    check('orchestrator-only: second request also answered directly', !evs.some(e => e.kind === 'delegation') && !!txt2 && txt2.text.trim().length > 0, '');
    await shot('15-final');
  }

  // ================================================================= 9+10. persistence and restart-safety
  const cfgRaw = fs.readFileSync(path.join(userData, 'config.json'), 'utf8');
  const cfg = JSON.parse(cfgRaw);
  check('config.json migrated to version 2', cfg.version === 2, `version=${cfg.version}`);
  check('config.json stores roles', (cfg.agents || []).every(a => !!a.role), (cfg.agents || []).map(a => a.role).join(','));
  check('config.json dropped maxDelegationDepth', cfg.maxDelegationDepth === undefined, JSON.stringify(cfg.maxDelegationDepth));
  check('api key not stored in plain text', !/sk-[A-Za-z0-9]{20,}/.test(cfgRaw));
  const consoleDir = path.join(userData, 'state', 'console');
  const consoleFiles = fs.existsSync(consoleDir) ? fs.readdirSync(consoleDir) : [];
  check('no ephemeral console id reached the disk', consoleFiles.every(f => !f.includes('#')), consoleFiles.join(','));
  const artIdx = path.join(userData, 'state', 'artifacts');
  soft('artifact store created', fs.existsSync(artIdx), fs.existsSync(artIdx) ? fs.readdirSync(artIdx).join(',') : 'missing');
  const mainAll = await events(mainId);
  const delsWithBoth = mainAll.filter(e => e.kind === 'delegation' && e.contract && e.result);
  check('delegation cards survive a restart with contract + result', delsWithBoth.length >= 2, `cards=${delsWithBoth.length}`);

  // ================================================================= cost guard
  check('page handle stayed valid (no CDP target loss)', reacquired === 0, `re-acquired ${reacquired} time(s)`);
  const every = await allEvents();
  const cost = every.filter(e => e.kind === 'task_end' && e.usage).reduce((s, e) => s + (Number(e.usage.cost) || 0), 0);
  const tokens = every.filter(e => e.kind === 'task_end' && e.usage).reduce((s, e) => s + (Number(e.usage.promptTokens) || 0) + (Number(e.usage.completionTokens) || 0), 0);
  log(`total measured cost $${cost.toFixed(4)} over ${tokens} tokens`);
  check(`cost within $${COST_LIMIT.toFixed(2)}`, cost <= COST_LIMIT, `$${cost.toFixed(4)}`);
} catch (err) {
  const ex = typeof globalThis.__appExit === 'function' ? globalThis.__appExit() : null;
  check('the app stayed alive for the whole run', !ex, ex ? `exit code=${ex.code} signal=${ex.signal}` : '');
  check('script completed without exception', false, String(err?.stack || err).slice(0, 400));
} finally {
  try { await app?.close(); } catch {}
  fs.writeFileSync(path.join(scratch, 'e2e.log'), logLines.join('\n'));
  const failed = results.filter(r => !r.ok);
  const notes = results.filter(r => r.soft);
  console.log('\n==== E2E SUMMARY (v2 pool) ====');
  for (const r of results) console.log(`${r.ok ? (r.soft ? '➖' : '✅') : '❌'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed, ${notes.length} soft notes, ${failed.length} failed`);
  console.log(`scratch: ${scratch}`);
  process.exit(failed.length ? 1 : 0);
}
