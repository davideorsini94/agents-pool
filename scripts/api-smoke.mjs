#!/usr/bin/env node
// Headless verification of the main-process API client, command classifier and path sandbox.
// Run after `npx tsc -p tsconfig.main.json`:
//
//   OPENCODE_API_KEY=$(node -e '...') node scripts/api-smoke.mjs
//
// The key is never printed. PLAN §13.3.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const distApi = path.join(here, '..', 'dist', 'main', 'api.js');
if (!fs.existsSync(distApi)) {
  console.error('dist/main not found — run: npx tsc -p tsconfig.main.json');
  process.exit(2);
}

const { OpenCodeClient } = require('../dist/main/api.js');
const { classifyCommand, matchesAllowlist, resolvePath } = require('../dist/main/permissions.js');

const key = process.env.OPENCODE_API_KEY;
if (!key) {
  console.error('set OPENCODE_API_KEY');
  process.exit(2);
}

const MODEL = 'glm-5.3-flash';
let failures = 0;
let warnings = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}
function warn(name, detail = '') {
  console.log(`  warn  ${name}${detail ? ` — ${detail}` : ''}`);
  warnings++;
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ---------------------------------------------------------------- 1. validateKey

section('validateKey');
const client = new OpenCodeClient(() => key, '0.0.0-smoke');

const bad = await client.validateKey('sk-invalid');
check('invalid key rejected as AuthError', bad.ok === false && bad.reason === 'auth', JSON.stringify(bad));

const good = await client.validateKey(key);
check('valid key accepted', good.ok === true, good.ok ? `masked=${good.masked}` : JSON.stringify(good));
if (good.ok) {
  check('masked form leaks only 4 chars', /^sk-….{4}$/u.test(good.masked), good.masked);
}

// ---------------------------------------------------------------- 2. listModels

section('listModels');
const models = await client.listModels();
check('model list is non-empty', Array.isArray(models) && models.length > 0, `${models.length} models`);
check(`${MODEL} present`, models.some((m) => m.id === MODEL));
const enriched = models.filter((m) => typeof m.contextLimit === 'number');
if (enriched.length) {
  console.log(`  info  models.dev metadata for ${enriched.length}/${models.length} models`);
  check('context limit known for probe model', client.contextLimit(MODEL) > 1000, String(client.contextLimit(MODEL)));
} else {
  warn('models.dev enrichment unavailable (offline?) — raw ids only');
}
console.log('  info ', models.slice(0, 3).map((m) => `${m.id}${m.costIn !== undefined ? ` $${m.costIn}/M` : ''}`).join(' | '));

// ---------------------------------------------------------------- 3. streaming + tool call

section('streamChat with a tool call');
const tools = [{
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Current time in a timezone',
    parameters: {
      type: 'object',
      properties: { tz: { type: 'string', description: 'IANA timezone, e.g. Europe/Rome' } },
      required: ['tz'],
    },
  },
}];

const acc = {};
let reasoningChars = 0;
let textChars = 0;
let usageSeen = null;

const stream = await client.streamChat(
  {
    model: MODEL,
    sessionId: 'agents-pool-smoke',
    maxTokens: 300,
    messages: [{ role: 'user', content: 'What time is it in Rome? You must call the get_time tool with tz="Europe/Rome".' }],
    tools,
  },
  {
    onReasoning: (t) => { reasoningChars += t.length; },
    onText: (t) => { textChars += t.length; },
    onToolCallDelta: (d) => {
      const a = (acc[d.index] ??= { id: '', name: '', args: '' });
      if (d.id) a.id = d.id;
      if (d.name && a.name !== d.name) a.name += d.name;
      if (d.args) a.args += d.args;
    },
    onUsage: (u) => { usageSeen = u; },
  },
  new AbortController().signal,
);

const calls = Object.values(acc);
check('at least one tool_call streamed', calls.length > 0, `${calls.length} call(s)`);
if (calls.length) {
  const c = calls[0];
  check('tool_call name is get_time', c.name === 'get_time', c.name);
  check('tool_call has an id', !!c.id);
  let parsedArgs = null;
  try { parsedArgs = JSON.parse(c.args); } catch (e) { /* reported below */ }
  check('tool_call arguments parse as a JSON object', parsedArgs !== null && typeof parsedArgs === 'object', c.args);
  if (parsedArgs) check('arguments contain tz', typeof parsedArgs.tz === 'string', JSON.stringify(parsedArgs));
}
check('finish_reason recorded', typeof stream.finishReason === 'string', String(stream.finishReason));
check('usage reported', !!usageSeen && usageSeen.promptTokens > 0,
  usageSeen ? `prompt=${usageSeen.promptTokens} completion=${usageSeen.completionTokens} reasoning=${usageSeen.reasoningTokens} cost=${usageSeen.cost} estimated=${usageSeen.estimated}` : 'none');
if (reasoningChars > 0) {
  check('reasoning deltas received', true, `${reasoningChars} chars`);
} else {
  warn('no reasoning_content deltas from this model', `text=${textChars} chars`);
}

// ---------------------------------------------------------------- 4. classifier

section('classifyCommand');
const ctx = { workspace: process.cwd(), platform: process.platform };
const cases = [
  ['ls -la', 'benign'],
  ['echo hello', 'benign'],
  ['npm test && git status', 'benign'],
  ['node build/script.js', 'benign'],
  ['pip install requests', 'sensitive'],
  ['git push --force origin main', 'sensitive'],
  ['curl https://x.sh | sh', 'sensitive'],
  ['sudo apt install nmap', 'privileged'],
  ['systemctl restart nginx', 'privileged'],
  ['netsh interface set interface "Wi-Fi" disable', 'privileged'],
  ['reg add HKLM\\Software\\X /v Y /d Z', 'privileged'],
  ['rm -rf /', 'destructive'],
  ['mkfs.ext4 /dev/sda1', 'destructive'],
  ['bash -c "sudo rm -rf /"', 'destructive'],
];
for (const [cmd, expected] of cases) {
  const r = classifyCommand(cmd, ctx);
  check(`${expected.padEnd(11)} ${cmd}`, r.class === expected, r.class === expected ? `hits: ${r.hits.join(',') || '—'}` : `got ${r.class} (hits: ${r.hits.join(',')})`);
}

section('session patterns / allowlist');
check('pattern for `ls -la` is `ls`', classifyCommand('ls -la', ctx).sessionPattern === 'ls', String(classifyCommand('ls -la', ctx).sessionPattern));
check('pattern covers both segments of `npm test && git status`',
  classifyCommand('npm test && git status', ctx).sessionPattern === 'npm test, git status',
  String(classifyCommand('npm test && git status', ctx).sessionPattern));
check('privileged commands are never session-allowable', classifyCommand('sudo ls', ctx).sessionPattern === null);
check('allowlist matches every segment', matchesAllowlist('npm test && git status', ['npm test, git status']) === true);
check('allowlist rejects an unlisted segment', matchesAllowlist('npm test && rm -rf /', ['npm test']) === false);
check('allowlist wildcard `git *`', matchesAllowlist('git status', ['git *']) === true);

// ---------------------------------------------------------------- 5. path sandbox

section('resolvePath sandbox');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-smoke-'));
const ws = path.join(tmpRoot, 'workspace');
const outside = path.join(tmpRoot, 'outside');
fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(ws, 'sub', 'a.txt'), 'a');
fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
try { fs.symlinkSync(outside, path.join(ws, 'escape'), 'dir'); } catch { /* no symlink support */ }

check('relative path stays inside', resolvePath('sub/a.txt', ws).inside === true);
check('new file inside is inside', resolvePath('sub/new.txt', ws).inside === true);
check('`..` escape detected', resolvePath('../outside/secret.txt', ws).inside === false);
check('absolute outside path detected', resolvePath(path.join(outside, 'secret.txt'), ws).inside === false);
if (fs.existsSync(path.join(ws, 'escape'))) {
  check('symlink escape detected via realpath', resolvePath('escape/secret.txt', ws).inside === false,
    resolvePath('escape/secret.txt', ws).real);
} else {
  warn('symlink not created — escape check skipped');
}
check('~/.ssh/id_rsa is protected', resolvePath('~/.ssh/id_rsa', ws).isProtected === true, resolvePath('~/.ssh/id_rsa', ws).hits.join(','));
check('opencode auth.json is protected',
  resolvePath(path.join(os.homedir(), '.local/share/opencode/auth.json'), ws).isProtected === true);
check('/etc/sudoers is protected', resolvePath('/etc/sudoers', ws).isProtected === true);
check('.env outside the workspace is protected', resolvePath(path.join(outside, '.env'), ws).isProtected === true);
check('.env inside the workspace is not protected', resolvePath('.env', ws).isProtected === false);
check('~ expands to the home directory', resolvePath('~', ws).real === fs.realpathSync(os.homedir()));
fs.rmSync(tmpRoot, { recursive: true, force: true });

// ---------------------------------------------------------------- 6. SSE parser edge cases

section('SSE parser (offline, synthetic stream)');
// Split the SSE bytes at awkward boundaries (mid-line, mid-JSON, mid-UTF-8) to prove the
// buffering handles partial lines, and put the cost chunk AFTER [DONE] like the real gateway.
const sse = [
  'data: {"choices":[{"index":0,"delta":{"reasoning_content":"pen','sando… "}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"reasoning":"ancora"}}]}\n',
  '\ndata: {"choices":[{"index":0,"delta":{"content":"Ciao "}}]}\n\ndata: {"choices":[{"index":0,',
  '"delta":{"content":"mondo"}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"beta","arguments":"{\\"y\\":"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"alpha","arguments":"{\\"x\\":1}"}}]}}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"2}"}}]}}]}\n\n',
  ': keep-alive comment\ndata: {"choices":[{"index":0,"finish_reason":"tool_calls","delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":3},"completion_tokens_details":{"reasoning_tokens":5}}}\n\n',
  'data: [DONE]\n\ndata: {"choices":[],"cost":"0.0042"}\n\n',
];
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  let stopped = false;
  return new Response(new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      // one raw byte chunk per piece, plus a split inside a multi-byte character
      const all = enc.encode(sse.join(''));
      let i = 0;
      const step = () => {
        if (stopped) return;
        const n = Math.min(all.length - i, i === 0 ? 37 : 91);
        try {
          if (i >= all.length) { controller.close(); return; }
          controller.enqueue(all.slice(i, i + n));
        } catch { return; }
        i += n;
        setTimeout(step, 0);
      };
      step();
    },
    cancel() { stopped = true; },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const off = { reasoning: '', text: '', calls: {}, usage: null };
const offRes = await client.streamChat(
  { model: MODEL, sessionId: 'offline', messages: [{ role: 'user', content: 'hi' }] },
  {
    onReasoning: (t) => { off.reasoning += t; },
    onText: (t) => { off.text += t; },
    onToolCallDelta: (d) => {
      const a = (off.calls[d.index] ??= { id: '', name: '', args: '' });
      if (d.id) a.id = d.id;
      if (d.name && a.name !== d.name) a.name += d.name;
      if (d.args) a.args += d.args;
    },
    onUsage: (u) => { off.usage = u; },
  },
  new AbortController().signal,
);
globalThis.fetch = realFetch;

check('partial lines reassembled across chunks', off.text === 'Ciao mondo', JSON.stringify(off.text));
check('reasoning_content and defensive reasoning both handled', off.reasoning === 'pensando… ancora', JSON.stringify(off.reasoning));
check('tool_call deltas accumulate by index, not arrival order',
  off.calls[0]?.name === 'alpha' && off.calls[1]?.name === 'beta', JSON.stringify(off.calls));
check('split argument JSON reassembles', off.calls[1]?.args === '{"y":2}', off.calls[1]?.args);
check('finish_reason from the usage chunk', offRes.finishReason === 'tool_calls', String(offRes.finishReason));
check('token details normalized', off.usage?.promptTokens === 11 && off.usage?.cachedTokens === 3 && off.usage?.reasoningTokens === 5,
  JSON.stringify(off.usage));
check('cost chunk after [DONE] is captured', off.usage?.cost === 0.0042, String(off.usage?.cost));
check('usage reported exactly once, not estimated', off.usage?.calls === 1 && off.usage?.estimated === false);


// ---------------------------------------------------------------- 7. Responses SSE parser

section('Responses SSE parser (offline, synthetic stream)');
const { toResponsesInput, buildResponsesBody, normalizeResponsesUsage } = require('../dist/main/responses.js');

/** Streams `pieces` as raw bytes cut at awkward offsets (mid-line, mid-JSON, mid-UTF-8). */
function mockStream(pieces, cut = 43) {
  return async () => {
    let cancelled = false;
    return new Response(new ReadableStream({
      start(controller) {
        const all = new TextEncoder().encode(pieces.join(''));
        let i = 0;
        const step = () => {
          if (cancelled) return;
          try {
            if (i >= all.length) { controller.close(); return; }
            const n = Math.min(all.length - i, i === 0 ? 17 : cut);
            controller.enqueue(all.slice(i, i + n));
          } catch { return; }        // the consumer stopped reading (reader.cancel)
          i += n0(all.length, i, cut);
          setTimeout(step, 0);
        };
        step();
      },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}
function n0(len, i, cut) { return Math.min(len - i, i === 0 ? 17 : cut); }

const ev = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const respPieces = [
  ev({ type: 'response.created', response: { id: 'r1' } }),
  ev({ type: 'response.in_progress' }),
  ev({ type: 'response.output_item.added', item: { id: 'rs1', type: 'reasoning' } }),
  ev({ type: 'response.reasoning_summary_part.added', item_id: 'rs1' }),
  ev({ type: 'response.reasoning_summary_text.delta', item_id: 'rs1', delta: 'Pens' }),
  ev({ type: 'response.reasoning_summary_text.delta', item_id: 'rs1', delta: 'o…' }),
  ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'call_1', name: 'get_time', arguments: '' } }),
  ev({ type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '{"tz":' }),
  ev({ type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 0, delta: '"Europe/Rome"}' }),
  ev({ type: 'response.function_call_arguments.done', item_id: 'fc1', output_index: 0, arguments: '{"tz":"Europe/Rome"}' }),
  ev({ type: 'response.output_item.added', item: { id: 'm1', type: 'message' } }),
  ev({ type: 'response.output_text.delta', item_id: 'm1', delta: 'Ciao ' }),
  ev({ type: 'response.output_text.delta', item_id: 'm1', delta: 'mondo' }),
  ev({ type: 'response.output_item.done', item: { id: 'm1', type: 'message' } }),
  ev({ type: 'response.completed', response: { output: [{ type: 'function_call' }], usage: { input_tokens: 11, output_tokens: 7, output_tokens_details: { reasoning_tokens: 5 }, input_tokens_details: { cached_tokens: 3 } } } }),
];

globalThis.fetch = mockStream(respPieces);
const rp = { reasoning: '', text: '', calls: {}, usage: null };
const rpRes = await client.streamChat(
  { model: 'gpt-5.6-luna', format: 'responses', sessionId: 'offline-resp', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] },
  {
    onReasoning: (t) => { rp.reasoning += t; },
    onText: (t) => { rp.text += t; },
    onToolCallDelta: (d) => {
      const a = (rp.calls[d.index] ??= { id: '', name: '', args: '' });
      if (d.id) a.id = d.id;
      if (d.name && a.name !== d.name) a.name += d.name;
      if (d.args) a.args += d.args;
    },
    onUsage: (u) => { rp.usage = u; },
  },
  new AbortController().signal,
);
globalThis.fetch = realFetch;

check('reasoning summary deltas concatenated', rp.reasoning === 'Penso…', JSON.stringify(rp.reasoning));
check('output_text deltas reassembled', rp.text === 'Ciao mondo', JSON.stringify(rp.text));
check('one function_call with call_id as the tool id', Object.keys(rp.calls).length === 1 && rp.calls[0]?.id === 'call_1', JSON.stringify(rp.calls));
check('tool name from output_item.added', rp.calls[0]?.name === 'get_time', rp.calls[0]?.name);
check('arguments.done does not duplicate the deltas', rp.calls[0]?.args === '{"tz":"Europe/Rome"}', rp.calls[0]?.args);
check('finishReason tool_calls from response.completed', rpRes.finishReason === 'tool_calls', String(rpRes.finishReason));
check('responses usage normalized 11/7/5/3',
  rp.usage?.promptTokens === 11 && rp.usage?.completionTokens === 7 && rp.usage?.reasoningTokens === 5 && rp.usage?.cachedTokens === 3,
  JSON.stringify(rp.usage));
check('usage counted once', rp.usage?.calls === 1, String(rp.usage?.calls));

// .done-only server (no deltas at all) must still produce full arguments
globalThis.fetch = mockStream([
  ev({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc9', type: 'function_call', call_id: 'call_9', name: 'x', arguments: '' } }),
  ev({ type: 'response.function_call_arguments.done', item_id: 'fc9', output_index: 0, arguments: '{"a":1}' }),
  ev({ type: 'response.completed', response: { output: [{ type: 'function_call' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
]);
const doneOnly = {};
await client.streamChat(
  { model: 'gpt-5.6-luna', format: 'responses', sessionId: 'o2', messages: [{ role: 'user', content: 'hi' }] },
  { onReasoning() {}, onText() {}, onToolCallDelta: (d) => { const a = (doneOnly[d.index] ??= { args: '' }); if (d.args) a.args += d.args; }, onUsage() {} },
  new AbortController().signal,
);
globalThis.fetch = realFetch;
check('arguments.done alone yields the whole JSON', doneOnly[0]?.args === '{"a":1}', doneOnly[0]?.args);

// response.failed carrying a DataPolicyError
globalThis.fetch = mockStream([
  ev({ type: 'response.created' }),
  ev({ type: 'response.failed', response: { error: { type: 'DataPolicyError', message: 'accept the data policy at https://opencode.ai/workspace/x' } } }),
]);
let policyErr = null;
try {
  await client.streamChat(
    { model: 'muse-spark-1.3-contributor', format: 'responses', sessionId: 'o3', messages: [{ role: 'user', content: 'hi' }] },
    { onReasoning() {}, onText() {}, onToolCallDelta() {}, onUsage() {} },
    new AbortController().signal,
  );
} catch (e) { policyErr = e; }
globalThis.fetch = realFetch;
check('response.failed maps to ApiError DataPolicyError', policyErr?.type === 'DataPolicyError', `${policyErr?.type}: ${policyErr?.message ?? ''}`);
check('DataPolicyError is not retryable', policyErr?.retryable === false);
check('opt-in URL survives in the message', /https:\/\/opencode\.ai\/workspace\/x/.test(policyErr?.message ?? ''));

// ---------------------------------------------------------------- 8. history conversion

section('toResponsesInput / buildResponsesBody');
const hist = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'ciao' },
  { role: 'assistant', content: 'penso', reasoning_content: 'segreto', tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
    { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
  ] },
  { role: 'tool', tool_call_id: 'c1', content: 'ra' },
  { role: 'tool', tool_call_id: 'c2', content: 'rb' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c3', type: 'function', function: { name: 'c', arguments: '{}' } }] },
];
const inputItems = toResponsesInput(hist);
check('7 input items', inputItems.length === 7, String(inputItems.length));
check('order user, assistant, function_call x2, function_call_output x2, function_call',
  inputItems.map((i) => i.type ?? i.role).join(',') === 'user,assistant,function_call,function_call,function_call_output,function_call_output,function_call',
  inputItems.map((i) => i.type ?? i.role).join(','));
check('system message dropped from input', !inputItems.some((i) => i.role === 'system'));
check('reasoning is never echoed', !JSON.stringify(inputItems).includes('segreto'));
check('call_id preserved on calls and outputs',
  inputItems[2].call_id === 'c1' && inputItems[4].call_id === 'c1' && inputItems[6].call_id === 'c3',
  JSON.stringify([inputItems[2].call_id, inputItems[4].call_id, inputItems[6].call_id]));
const body = buildResponsesBody({
  model: 'gpt-5.6-luna', sessionId: 's', messages: hist, maxTokens: 60, temperature: 0.2,
  tools: [{ type: 'function', function: { name: 'a', description: 'd', parameters: { type: 'object', properties: {} } } }],
});
check('instructions carries the system prompt', body.instructions === 'SYS');
check('tools are flat (name at the top level, no nested function)',
  body.tools[0].type === 'function' && body.tools[0].name === 'a' && body.tools[0].function === undefined,
  JSON.stringify(body.tools[0]));
check('max_output_tokens / temperature / stream set', body.max_output_tokens === 60 && body.temperature === 0.2 && body.stream === true);
check('no reasoning parameter is sent', body.reasoning === undefined);
check('normalizeResponsesUsage tolerates a missing usage object', normalizeResponsesUsage(undefined).calls === 1);

// ---------------------------------------------------------------- 9. live /responses call

section('live /responses call (gpt-5.6-luna, max_output_tokens 60)');
{
  const live = { text: '', usage: null };
  try {
    const r = await client.streamChat(
      {
        model: 'gpt-5.6-luna',
        format: 'responses',
        sessionId: 'agents-pool-smoke-responses',
        maxTokens: 60,
        messages: [{ role: 'user', content: 'Rispondi solo con la parola ok.' }],
      },
      {
        onReasoning() {},
        onText: (t) => { live.text += t; },
        onToolCallDelta() {},
        onUsage: (u) => { live.usage = u; },
      },
      new AbortController().signal,
    );
    check('live responses text non-empty', live.text.trim().length > 0, JSON.stringify(live.text.slice(0, 40)));
    check('live responses usage reported', !!live.usage && live.usage.promptTokens > 0,
      live.usage ? `prompt=${live.usage.promptTokens} completion=${live.usage.completionTokens} cost=${live.usage.cost}` : 'none');
    console.log(`  info  finishReason=${r.finishReason}`);
  } catch (e) {
    if (e?.type === 'DataPolicyError' || e?.type === 'RateLimit' || e?.status === 403 || e?.status === 429) {
      warn('live /responses skipped', `${e.type}: ${e.message}`);
    } else {
      check('live /responses call', false, `${e?.type}: ${e?.message}`);
    }
  }
}

// ---------------------------------------------------------------- 10. ModelRouter

section('ModelRouter');
const { ModelRouter } = require('../dist/main/router.js');
const { ApiError } = require('../dist/main/api.js');
{
  const rcfg = { modelFormats: {} };
  const toasts = [];
  const router = new ModelRouter({ cfg: () => rcfg, send: (ch, p) => { if (ch === 'app:toast') toasts.push(p); } });
  const tpl = { id: 'a_1', name: 'T', model: 'a', fallbacks: ['b', 'c'], escalation: 'e', prompt: '', color: '#fff', maxIterations: 40, createdAt: 0, role: 'worker' };
  check('chain is [primary, ...fallbacks]', router.chain(tpl).join(',') === 'a,b,c', router.chain(tpl).join(','));
  check('escalation goes first', router.chain(tpl, { escalate: true }).join(',') === 'e,a,b,c', router.chain(tpl, { escalate: true }).join(','));
  router.markUnavailable('a', new ApiError('ModelError', 'gone', 401));
  check('unavailable model is skipped', router.chain(tpl).join(',') === 'b,c', router.chain(tpl).join(','));
  router.markUnavailable('b', new ApiError('ModelError', 'gone', 401));
  router.markUnavailable('c', new ApiError('ModelError', 'gone', 401));
  check('all marked → the primary is tried anyway', router.chain(tpl).join(',') === 'a', router.chain(tpl).join(','));
  check('pick past the end clamps and reports last', router.pick(tpl, 9).last === true);
  check('one toast per model, not per failure', toasts.length === 3, `${toasts.length} toasts`);
  router.markUnavailable('a', new ApiError('ModelError', 'again', 401));
  check('re-marking the same model is a no-op', toasts.length === 3, `${toasts.length} toasts`);
  check('unavailableModels lists them', router.unavailableModels().sort().join(',') === 'a,b,c');
  router.clear();
  check('clear() forgets the session marks', router.chain(tpl).join(',') === 'a,b,c');
  check('formatOf grok-* is responses', router.formatOf('grok-4.6') === 'responses');
  check('formatOf gpt-* is responses', router.formatOf('gpt-x') === 'responses');
  check('formatOf muse-spark-* is responses', router.formatOf('muse-spark-1.3-contributor') === 'responses');
  check('formatOf an unknown id is chat', router.formatOf('hy3') === 'chat');
  rcfg.modelFormats = { hy3: 'responses' };
  check('cfg.modelFormats overrides the prefix map', router.formatOf('hy3') === 'responses');
  const tableRouter = new ModelRouter({ cfg: () => ({ modelFormats: {} }), send: () => {}, modelTable: { zzz: { format: 'responses', privacy: 'zdr' } } });
  check('MODEL_TABLE format wins over the default', tableRouter.formatOf('zzz') === 'responses');
  const policy = new ApiError('DataPolicyError', 'opt in at https://opencode.ai/workspace/abc).', 403);
  const t2 = [];
  const r2 = new ModelRouter({ cfg: () => ({ modelFormats: {} }), send: (ch, p) => { if (ch === 'app:toast') t2.push(p); } });
  r2.markUnavailable('muse-spark-1.3-contributor', policy);
  check('DataPolicyError toast carries the opt-in url', t2[0]?.url === 'https://opencode.ai/workspace/abc', String(t2[0]?.url));
  check('DataPolicyError toast mentions the data policy', /data policy/i.test(t2[0]?.message ?? ''), t2[0]?.message);
}

// ---------------------------------------------------------------- 11. contracts

section('contracts: validation, parsing, artifacts, log');
const {
  validateTaskContract, validateBatch, parseResultContract, parsePlan, parseVerdict,
  effectiveBudget, poolLimits, POOL_RANGES, ContractsLog,
} = require('../dist/main/contracts.js');
const { ArtifactStore } = require('../dist/main/artifacts.js');

const cRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-contracts-'));
const cWs = path.join(cRoot, 'ws');
fs.mkdirSync(cWs, { recursive: true });
fs.writeFileSync(path.join(cWs, 'in.txt'), 'file content');

const okRaw = {
  task_id: 't1', role: 'Worker', objective: 'Elenca i file .txt nella cartella di lavoro e contali.',
  inputs: [{ type: 'text', content: 'nessun contesto' }, { type: 'file', path: 'in.txt' }],
  constraints: ['non modificare nulla'], deliverable: 'una riga con il conteggio',
  acceptance: 'il numero corrisponde ai file presenti', side_effects: false,
  budget: { max_tokens: 999999, max_tool_calls: 3 },
};
const v1 = validateTaskContract(okRaw, 0, { workspacePath: cWs });
check('valid contract passes', !!v1.ok, JSON.stringify(v1).slice(0, 120));
check('snake_case budget normalized', v1.ok?.budget?.maxTokens === 999999 && v1.ok?.budget?.maxToolCalls === 3, JSON.stringify(v1.ok?.budget));
check('HARD_MAX clamps the budget', effectiveBudget(v1.ok.budget, undefined).maxTokens === 60000, JSON.stringify(effectiveBudget(v1.ok.budget, undefined)));
check('missing acceptance is rejected',
  !!validateTaskContract({ ...okRaw, acceptance: '' }, 0, { workspacePath: cWs }).error,
  validateTaskContract({ ...okRaw, acceptance: '' }, 0, { workspacePath: cWs }).error);
check('objective referring to the conversation is rejected',
  /self-contained/.test(validateTaskContract({ ...okRaw, objective: 'fallo come detto sopra nella chat' }, 0, { workspacePath: cWs }).error ?? ''),
  validateTaskContract({ ...okRaw, objective: 'fallo come detto sopra nella chat' }, 0, { workspacePath: cWs }).error);
check('objective starting with a pronoun is rejected',
  !!validateTaskContract({ ...okRaw, objective: 'questo va completato entro oggi' }, 0, { workspacePath: cWs }).error);
check('file input outside the workspace is rejected',
  /outside the workspace/.test(validateTaskContract({ ...okRaw, inputs: [{ type: 'file', path: '../secret.txt' }] }, 0, { workspacePath: cWs }).error ?? ''));
check('empty task_id defaults to tN', validateTaskContract({ ...okRaw, task_id: '' }, 3, { workspacePath: cWs }).ok?.task_id === 't4');
check('side_effects accepts the string "true"', validateTaskContract({ ...okRaw, side_effects: 'true' }, 0, { workspacePath: cWs }).ok?.side_effects === true);

const b1 = validateTaskContract({ ...okRaw, task_id: 't1' }, 0, { workspacePath: cWs }).ok;
const b2 = validateTaskContract({ ...okRaw, task_id: 't2', objective: 'Conta le righe totali dei file di testo presenti.' }, 1, { workspacePath: cWs }).ok;
check('batch with equal deliverables is rejected naming both ids',
  /t1 ≈ t2/.test(validateBatch([b1, b2]) ?? ''), String(validateBatch([b1, b2])));
const b3 = validateTaskContract({ ...okRaw, task_id: 't3', objective: 'Conta le righe totali dei file di testo presenti.', deliverable: 'un numero' }, 2, { workspacePath: cWs }).ok;
check('disjoint batch passes', validateBatch([b1, b3]) === null, String(validateBatch([b1, b3])));

const store = new ArtifactStore(cRoot);
const runOk = { status: 'done', usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 0, cachedTokens: 0, cost: 0.002, calls: 1, estimated: false }, toolCalls: 4 };
const strict = await parseResultContract(
  '{"task_id":"WRONG","status":"ok","result":"5 file","assumptions":["a"],"unverified":[],"blocking_question":null,"cost":{"tokens":1}}',
  b1, runOk, { requestId: 'req_1', model: 'deepseek-v4-flash', durationMs: 41000, artifactThresholdChars: 4000, artifacts: store });
check('strict JSON parses at stage 1', strict.stage === 1 && strict.result.status === 'ok', `stage=${strict.stage} status=${strict.result.status}`);
check('task_id is forced from the contract', strict.result.task_id === 't1', strict.result.task_id);
check('cost is overwritten from real usage',
  strict.result.cost.tokens === 150 && strict.result.cost.tool_calls === 4 && strict.result.cost.seconds === 41 && strict.result.cost.usd === 0.002 && strict.result.cost.model === 'deepseek-v4-flash',
  JSON.stringify(strict.result.cost));
const fenced = await parseResultContract(
  'Ecco il risultato:\n```json\n{"task_id":"t1","status":"ok","result":"fatto","assumptions":[],"unverified":[],"blocking_question":null}\n```\nSpero vada bene.',
  b1, runOk, { requestId: 'req_1', model: 'minimax-m3', durationMs: 1000, artifactThresholdChars: 4000, artifacts: store });
check('JSON wrapped in prose parses at stage 2 with its own status', fenced.stage === 2 && fenced.result.status === 'ok', `stage=${fenced.stage} status=${fenced.result.status}`);
const prose = await parseResultContract('Ho finito, tutto a posto.', b1, runOk,
  { requestId: 'req_1', model: 'x', durationMs: 1000, artifactThresholdChars: 4000, artifacts: store });
check('free text degrades to partial at stage 3', prose.stage === 3 && prose.result.status === 'partial', `stage=${prose.stage} status=${prose.result.status}`);
check('stage 3 notes the format problem', prose.result.unverified.includes('output not in ResultContract format'), JSON.stringify(prose.result.unverified));
const cancelled = await parseResultContract(
  '{"task_id":"t1","status":"ok","result":"fatto","assumptions":[],"unverified":[],"blocking_question":null}',
  b1, { ...runOk, status: 'cancelled' }, { requestId: 'req_1', model: 'x', durationMs: 1000, artifactThresholdChars: 4000, artifacts: store });
check('a cancelled run forces partial', cancelled.result.status === 'partial' && cancelled.result.unverified.some((u) => u.includes('run cancelled')), JSON.stringify(cancelled.result.unverified));
const budgetKilled = await parseResultContract('parziale', b1, { ...runOk, status: 'partial', budgetHit: 'maxTokens' },
  { requestId: 'req_1', model: 'x', durationMs: 1000, artifactThresholdChars: 4000, artifacts: store });
check('budgetHit is reported in unverified', budgetKilled.result.unverified.some((u) => u.includes('budget maxTokens')), JSON.stringify(budgetKilled.result.unverified));
const blockedNoQ = await parseResultContract('{"task_id":"t1","status":"blocked","result":"","blocking_question":null}', b1, runOk,
  { requestId: 'req_1', model: 'x', durationMs: 1, artifactThresholdChars: 4000, artifacts: store });
check('blocked without a question becomes partial', blockedNoQ.result.status === 'partial' && blockedNoQ.result.unverified.includes('blocked without question'));

const big = 'x'.repeat(5000);
const withArt = await parseResultContract(JSON.stringify({ task_id: 't1', status: 'ok', result: big }), b1, runOk,
  { requestId: 'req_art', model: 'x', durationMs: 1000, artifactThresholdChars: 4000, artifacts: store });
check('a result over the threshold becomes an artifact_ref',
  typeof withArt.result.result === 'object' && /^art_[0-9a-f]{6}$/.test(withArt.result.result.artifact_ref),
  JSON.stringify(withArt.result.result).slice(0, 80));
check('artifact summary is 400 chars and chars is exact',
  withArt.result.result.summary.length === 400 && withArt.result.result.chars === 5000,
  `${withArt.result.result.summary.length} / ${withArt.result.result.chars}`);
check('artifact file exists on disk',
  fs.existsSync(path.join(cRoot, 'state', 'artifacts', 'req_art', `${withArt.result.result.artifact_ref}.json`)));
check('artifact index exists', fs.existsSync(path.join(cRoot, 'state', 'artifacts', 'index.json')));
const slice = await store.get(withArt.result.result.artifact_ref, 0, 6000);
check('read_artifact slice carries a header with the range', /· 5000 chars · 0–5000\]$/.test(slice.header), slice.header);
check('unknown artifact returns null', (await store.get('art_zzzzzz')) === null);

const planTasks = [];
for (let i = 1; i <= 8; i++) {
  planTasks.push({ ...okRaw, task_id: `t${i}`, objective: `Analizza il modulo numero ${i} e riassumine lo scopo.`, deliverable: `riassunto ${i}`, depends_on: i > 1 ? ['t1'] : [] });
}
const plan = parsePlan(JSON.stringify({ tasks: planTasks, assumptions: ['a'], if_false: ['b'] }), { workspacePath: cWs });
check('plan is truncated to 6 tasks with a warning',
  plan.tasks.length === 6 && plan.warnings.some((w) => /truncated to 6/.test(w)), `${plan.tasks.length} tasks / ${JSON.stringify(plan.warnings)}`);
check('depends_on is preserved', plan.tasks[1].depends_on?.[0] === 't1', JSON.stringify(plan.tasks[1].depends_on));
const badPlan = parsePlan(JSON.stringify({ tasks: [planTasks[0], { role: 'Worker' }] }), { workspacePath: cWs });
check('invalid plan tasks are dropped with a warning', badPlan.tasks.length === 1 && badPlan.warnings.length === 1, JSON.stringify(badPlan.warnings));
check('non-JSON plan degrades', parsePlan('non ho capito', { workspacePath: cWs }).warnings[0] === 'plan not in JSON format');

const verdict = parseVerdict('{"findings":[{"severity":"blocker","task_id":"t2","issue":"conteggio errato","fix":"ricontare"},{"severity":"strano","issue":"stile"}],"verdict":"no_blocker","summary":"c\'è un problema"}');
check('verdict is derived from the findings, not trusted', verdict.verdict === 'blocker', verdict.verdict);
check('unknown severity coerces to minor', verdict.findings[1].severity === 'minor', verdict.findings[1].severity);
const proseVerdict = parseVerdict('Tutto corretto, nessun problema rilevato.');
check('prose verdict degrades to no_blocker + summary',
  proseVerdict.verdict === 'no_blocker' && proseVerdict.summary.startsWith('Tutto corretto'), JSON.stringify(proseVerdict));

check('poolLimits fills the documented defaults from an empty config',
  JSON.stringify(poolLimits({})) === JSON.stringify({ maxParallelWorkers: 4, maxWorkersPerRequest: 8, correctionRounds: 1, allowWorkerDelegation: false, maxDepth: 2, artifactThresholdChars: 4000 }),
  JSON.stringify(poolLimits({})));
check('poolLimits clamps out-of-range values',
  poolLimits({ maxParallelWorkers: 999, correctionRounds: -5 }).maxParallelWorkers === POOL_RANGES.maxParallelWorkers.max
  && poolLimits({ maxParallelWorkers: 999, correctionRounds: -5 }).correctionRounds === 0);

const clog = new ContractsLog(cRoot);
clog.append({ requestId: 'req_1', kind: 'task', taskId: 't1', data: b1 });
clog.append({ requestId: 'req_1', kind: 'result', taskId: 't1', data: strict.result });
await clog.flush();
const logLines = fs.readFileSync(path.join(cRoot, 'logs', 'contracts.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
check('contracts.jsonl has one JSON line per record', logLines.length === 2, `${logLines.length} lines`);
check('each line parses and carries ts/kind/requestId',
  logLines.every((l) => { const o = JSON.parse(l); return o.ts > 0 && o.kind && o.requestId === 'req_1'; }));

// ---------------------------------------------------------------- 12. scheduler with a fake model

section('InstancePool scheduler (fake model)');
const { InstancePool } = require('../dist/main/pool.js');
const { PermissionGate } = require('../dist/main/permissions.js');
const { StateStore, ConsoleBus } = require('../dist/main/state.js');
const { toolNamesFor } = require('../dist/main/tools.js');

const RESULT_JSON = (id) => `{"task_id":"${id}","status":"ok","result":"fatto ${id}","assumptions":[],"unverified":[],"blocking_question":null}`;
const VERDICT_JSON = '{"findings":[],"verdict":"no_blocker","summary":"nessun blocker"}';
const PLAN_JSON = JSON.stringify({
  tasks: [{ task_id: 't1', role: 'Worker', objective: 'Analizza il modulo di ingresso e riassumine lo scopo.', inputs: [], constraints: [], deliverable: 'riassunto', acceptance: 'una riga', side_effects: false }],
  assumptions: [], if_false: [],
});

function tpl(id, name, role, extra = {}) {
  return { id, name, role, model: `m-${name.toLowerCase()}`, fallbacks: [], prompt: `descrizione: ${name}`, color: '#3B82F6', maxIterations: 6, createdAt: 0, ...extra };
}

function harness(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-pool-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'a');
  const cfg = {
    version: 2, apiKey: null, apiKeyEnc: null, workspacePath: ws, mainAgentId: 'a_orc',
    interactionPrompt: '', permissionMode: 'relaxed', commandAllowlist: [], showReasoning: true,
    permissionTimeoutMs: 300000, setupComplete: true, modelFormats: {},
    agents: opts.agents ?? [
      tpl('a_orc', 'Orchestratore', 'orchestrator'),
      tpl('a_wk', 'Worker', 'worker'),
      tpl('a_wk2', 'Worker Flash', 'worker'),
      tpl('a_pl', 'Planner', 'planner'),
      tpl('a_vf', 'Verificatore', 'verifier'),
    ],
    ...(opts.limits ?? {}),
  };
  const config = {
    get: () => cfg,
    getApiKey: () => 'fake',
    agent: (id) => cfg.agents.find((a) => a.id === id),
    agentView: (a) => ({ ...a, description: a.name, isMain: a.id === cfg.mainAgentId }),
    agentViews: () => cfg.agents.map((a) => ({ ...a, description: a.name, isMain: a.id === cfg.mainAgentId })),
    templatesOfRole: (role) => cfg.agents.filter((a) => (a.role ?? 'worker') === role),
    firstOfRole: (role) => cfg.agents.filter((a) => (a.role ?? 'worker') === role)[0],
    orchestrator: () => cfg.agents.find((a) => a.id === cfg.mainAgentId),
  };
  const sent = [];
  const send = (ch, p) => { sent.push({ ch, p }); };
  const state = new StateStore(root);
  const bus = new ConsoleBus(state, send);
  const gate = new PermissionGate({ cfg: () => cfg, bus, send, setStatus: () => {} });
  const router = new ModelRouter({ cfg: () => cfg, send });
  const artifacts = new ArtifactStore(root);
  const contracts = new ContractsLog(root);

  const calls = [];
  const liveByTask = new Map();
  const peak = new Map();
  const fake = {
    contextLimit: () => 128000,
    estimateCost: () => 0,
    modelInfo: () => undefined,
    async streamChat(req, h, signal) {
      const userMsg = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const taskId = /## Obiettivo/.test(userMsg) ? 'PLAN'
        : (/## Richiesta originale/.test(userMsg) ? 'VERIFY'
          : (/"task_id":\s*"([^"]+)"/.exec(userMsg)?.[1] ?? '?'));
      calls.push({ model: req.model, sessionId: req.sessionId, format: req.format ?? 'chat', tools: (req.tools ?? []).map((t) => t.function.name), taskId, maxTokens: req.maxTokens });
      liveByTask.set(taskId, (liveByTask.get(taskId) ?? 0) + 1);
      const nowLive = [...liveByTask.entries()].filter(([, n]) => n > 0);
      for (const [k] of nowLive) peak.set(k, Math.max(peak.get(k) ?? 0, nowLive.length));
      peak.set('__all__', Math.max(peak.get('__all__') ?? 0, nowLive.length));
      try {
        await new Promise((res, rej) => {
          const t = setTimeout(res, opts.latencyMs ?? 60);
          signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }, { once: true });
        });
      } finally {
        liveByTask.set(taskId, (liveByTask.get(taskId) ?? 1) - 1);
      }
      const usage = { promptTokens: 100, completionTokens: opts.completionTokens ?? 50, reasoningTokens: 0, cachedTokens: 0, cost: 0.0001, calls: 1, estimated: false };
      const scripted = opts.script?.(req, { taskId, calls });
      if (scripted?.toolCall) {
        h.onToolCallDelta({ index: 0, id: `call_${calls.length}`, name: scripted.toolCall.name, args: JSON.stringify(scripted.toolCall.args ?? {}) });
        h.onUsage(usage);
        return { finishReason: 'tool_calls', usage };
      }
      const text = scripted?.text
        ?? (taskId === 'PLAN' ? PLAN_JSON : (taskId === 'VERIFY' ? VERDICT_JSON : RESULT_JSON(taskId.split('.').pop())));
      h.onText(text);
      h.onUsage(usage);
      return { finishReason: 'stop', usage };
    },
  };

  const runs = new Map();
  let pool;
  const host = {
    roster: () => config.agentViews(),
    findRun: (id) => runs.get(id)?.run ?? null,
    cancelRun: (id, reason) => { runs.get(id)?.runtime.cancelRun(id, reason); },
    registerRun: (run, runtime) => { runs.set(run.runId, { run, runtime }); },
    unregisterRun: (id) => { runs.delete(id); },
    onRunFinished: () => {},
    requestTier: (rid) => pool.requestTier(rid),
    delegateTasks: (from, args, callId) => pool.delegateTasks(from, args, callId),
    runPlanner: (from, args, callId) => pool.runPlanner(from, args, callId),
    runVerifier: (from, args, callId) => pool.runVerifier(from, args, callId),
    readArtifact: (args) => pool.readArtifact(args),
  };
  pool = new InstancePool({
    config, state, bus, client: fake, gate, send,
    env: { platform: 'darwin', release: '25.0', arch: 'arm64', shell: '/bin/zsh', locale: 'it-IT' },
    appVersion: '0.0.0-smoke', router, artifacts, contracts, host,
    setAgentStatus: () => {},
  });

  const requestId = 'run_smoke1';
  const orc = config.agent('a_orc');
  const from = {
    agent: orc,
    run: {
      runId: requestId, taskId: 'task_1', agentId: 'a_orc', origin: { kind: 'user' }, status: 'running',
      iteration: 1, startedAt: Date.now(), usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, cost: 0, calls: 0, estimated: false },
      ancestry: ['a_orc'], childRunIds: [], requestId, role: 'orchestrator', toolCalls: 0,
    },
  };
  runs.set(requestId, { run: from.run, runtime: { cancelRun: () => {} } });
  pool.startRequest(requestId, 'crea due file in parallelo');
  return { root, ws, cfg, config, pool, from, sent, calls, peak, state, requestId, contracts, artifacts };
}

function task(id, role, objective, sideEffects = false) {
  return { task_id: id, role, objective, inputs: [], constraints: [], deliverable: `deliverable ${id}`, acceptance: `acceptance ${id}`, side_effects: sideEffects };
}

// 12.1 parallel read-only vs serialized side effects
{
  const H = harness({ limits: { maxParallelWorkers: 5 } });
  const out = await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [
      task('t1', 'Worker', 'Leggi il primo modulo e riassumilo in una riga.'),
      task('t2', 'Worker', 'Leggi il secondo modulo e riassumilo in una riga.'),
      task('t3', 'Worker Flash', 'Leggi il terzo modulo e riassumilo in una riga.'),
      task('t4', 'Worker', 'Scrivi il file alpha.txt con la parola alpha.', true),
      task('t5', 'Worker', 'Scrivi il file beta.txt con la parola beta.', true),
    ],
  }, 'call_1');
  const parsed = JSON.parse(out);
  check('batch of 5 returns 5 ResultContracts', parsed.results.length === 5, `${parsed.results.length}`);
  check('every result carries a system-filled cost', parsed.results.every((r) => r.cost && r.cost.tokens === 150 && r.cost.model), JSON.stringify(parsed.results[0]?.cost));
  check('tier is echoed and instances counted', parsed.tier === 'T2' && parsed.instances_used === 5, JSON.stringify({ tier: parsed.tier, used: parsed.instances_used }));
  check('limits are echoed to the model', parsed.limits.maxParallelWorkers === 5 && parsed.limits.maxWorkersPerRequest === 8);
  const addEvents = H.sent.filter((s) => s.ch === 'console:add');
  check('one console:add per instance', addEvents.length === 5, `${addEvents.length}`);
  check('instance ids are <template>#<task>', addEvents.every((e) => /^a_wk2?#t[1-5]$/.test(e.p.id)), addEvents.map((e) => e.p.id).join(','));
  check('instance views are flagged ephemeral with parentId/taskId', addEvents.every((e) => e.p.ephemeral === true && e.p.parentId && e.p.taskId));
  // console:add must precede every console:event of that instance
  let orderOk = true;
  for (const e of addEvents) {
    const addAt = H.sent.findIndex((s) => s.ch === 'console:add' && s.p.id === e.p.id);
    const firstEv = H.sent.findIndex((s) => s.ch === 'console:event' && s.p.agentId === e.p.id);
    if (firstEv >= 0 && firstEv < addAt) orderOk = false;
  }
  check('console:add always precedes the first console:event of an instance', orderOk);
  check('x-opencode-session equals the requestId on every call',
    H.calls.length > 0 && H.calls.every((c) => c.sessionId === H.requestId), `${H.calls.length} calls`);
  check('worker instances never receive delegation tools by default',
    H.calls.filter((c) => c.taskId.startsWith('t')).every((c) => !c.tools.includes('delegate_tasks')),
    JSON.stringify(H.calls[0]?.tools));
  check('read-only instances ran in parallel', (H.peak.get('__all__') ?? 0) >= 2, `peak ${H.peak.get('__all__')}`);
  check('no `#` id ever reached the state directory',
    !fs.existsSync(path.join(H.root, 'state', 'console')) || fs.readdirSync(path.join(H.root, 'state', 'console')).every((f) => !f.includes('#')),
    fs.existsSync(path.join(H.root, 'state', 'console')) ? fs.readdirSync(path.join(H.root, 'state', 'console')).join(',') : '(no dir)');
  await H.contracts.flush();
  const lines = fs.readFileSync(path.join(H.root, 'logs', 'contracts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('contracts log holds 5 task + 5 result records',
    lines.filter((l) => l.kind === 'task').length === 5 && lines.filter((l) => l.kind === 'result').length === 5,
    JSON.stringify(lines.reduce((a, l) => ({ ...a, [l.kind]: (a[l.kind] ?? 0) + 1 }), {})));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.2 side-effect serialization observed through the instance consoles
{
  const H = harness({ latencyMs: 120 });
  await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [
      task('s1', 'Worker', 'Scrivi il file uno.txt con la parola uno.', true),
      task('s2', 'Worker', 'Scrivi il file due.txt con la parola due.', true),
      task('s3', 'Worker', 'Scrivi il file tre.txt con la parola tre.', true),
    ],
  }, 'call_se');
  const spans = [];
  for (const id of ['a_wk#s1', 'a_wk#s2', 'a_wk#s3']) {
    const evs = H.state.getConsole(id, { limit: 100 });
    const start = evs.find((e) => e.kind === 'task_start');
    const end = evs.find((e) => e.kind === 'task_end');
    if (start && end) spans.push([start.ts, end.ts]);
  }
  let overlap = false;
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      if (spans[i][0] < spans[j][1] && spans[j][0] < spans[i][1]) overlap = true;
    }
  }
  check('three side-effect instances never overlapped', spans.length === 3 && !overlap, JSON.stringify(spans));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.3 caps, duplicates, correction rounds
{
  const H = harness();
  const tooMany = await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: Array.from({ length: 9 }, (_, i) => task(`x${i}`, 'Worker', `Analizza il modulo numero ${i} e riassumilo.`)),
  }, 'call_big');
  check('a batch larger than maxParallelWorkers is rejected quoting the setting',
    tooMany.startsWith('ERROR') && /maxParallelWorkers=4/.test(tooMany), tooMany.slice(0, 120));
  check('a rejected batch spawns nothing', H.pool.requestSummary(H.requestId).instances === 0);
  const dup = await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [task('d1', 'Worker', 'Leggi il modulo di ingresso e riassumilo.'), task('d2', 'Worker', 'Leggi il modulo di ingresso e riassumilo.')],
  }, 'call_dup');
  check('duplicate objectives are rejected naming both ids', /duplicate tasks: d1 ≈ d2/.test(dup), dup.slice(0, 120));
  check('an invalid tier is rejected', (await H.pool.delegateTasks(H.from, { tier: 'T9', tasks: [task('z', 'Worker', 'Leggi qualcosa e riassumilo.')] }, 'c')).startsWith('ERROR'));

  await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('t1', 'Worker', 'Leggi il modulo di ingresso e riassumilo.')] }, 'call_a');
  const rerun = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('t1', 'Worker', 'Leggi il modulo di ingresso e riassumilo.')] }, 'call_b');
  check('re-running a task_id without run_verifier is rejected',
    rerun.startsWith('ERROR') && /needs run_verifier first/.test(rerun), rerun.slice(0, 140));
  const vOut = await H.pool.runVerifier(H.from, {}, 'call_v');
  check('run_verifier returns a Verdict', JSON.parse(vOut).verdict === 'no_blocker', vOut.slice(0, 80));
  check('verdict event lands on the verifier console',
    H.state.getConsole('a_vf', { limit: 50 }).some((e) => e.kind === 'verdict'),
    H.state.getConsole('a_vf', { limit: 50 }).map((e) => e.kind).join(','));
  const corrected = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('t1', 'Worker', 'Leggi il modulo di ingresso e riassumilo.')] }, 'call_c');
  check('a correction is allowed after run_verifier', !corrected.startsWith('ERROR'), corrected.slice(0, 140));
  check('the correction instance id carries -r2',
    H.sent.some((s) => s.ch === 'console:add' && s.p.id === 'a_wk#t1-r2'),
    H.sent.filter((s) => s.ch === 'console:add').map((s) => s.p.id).join(','));
  const third = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('t1', 'Worker', 'Leggi il modulo di ingresso e riassumilo.')] }, 'call_d');
  check('a second correction is rejected at correctionRounds=1',
    third.startsWith('ERROR') && /correctionRounds=1/.test(third), third.slice(0, 140));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.4 blocked continuation does not consume a correction round
{
  const H = harness({ script: (req, { taskId, calls }) => {
    const attempts = calls.filter((c) => c.taskId === taskId).length;
    if (taskId === 'b1' && attempts === 1) {
      return { text: '{"task_id":"b1","status":"blocked","result":"","assumptions":[],"unverified":[],"blocking_question":"quale cartella?"}' };
    }
    return undefined;
  } });
  const first = JSON.parse(await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('b1', 'Worker', 'Conta i file della cartella indicata negli input.')] }, 'c1'));
  check('a blocked ResultContract keeps its status and question',
    first.results[0].status === 'blocked' && first.results[0].blocking_question === 'quale cartella?', JSON.stringify(first.results[0]).slice(0, 140));
  const cont = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('b1', 'Worker', 'Conta i file della cartella indicata negli input.')] }, 'c2');
  check('a blocked task may be continued without run_verifier', !cont.startsWith('ERROR'), cont.slice(0, 140));
  const again = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('b1', 'Worker', 'Conta i file della cartella indicata negli input.')] }, 'c3');
  check('only one blocked continuation is allowed', again.startsWith('ERROR'), again.slice(0, 140));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.5 budgets: tool calls and wall clock
{
  const H = harness({ script: () => ({ toolCall: { name: 'list_directory', args: { path: '.' } } }) });
  H.cfg.agents.find((a) => a.id === 'a_wk').budget = { maxTokens: 60000, maxToolCalls: 2, maxSeconds: 600 };
  const out = JSON.parse(await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('c1', 'Worker', 'Elenca ripetutamente la cartella di lavoro fino al limite.')] }, 'c'));
  check('a chatty model hits maxToolCalls and returns partial', out.results[0].status === 'partial', JSON.stringify(out.results[0]).slice(0, 160));
  const endEv = H.state.getConsole('a_wk#c1', { limit: 100 }).find((e) => e.kind === 'task_end');
  check('task_end reports budgetHit=maxToolCalls and the tool count',
    endEv?.budgetHit === 'maxToolCalls' && endEv?.toolCalls === 2, JSON.stringify({ budgetHit: endEv?.budgetHit, toolCalls: endEv?.toolCalls }));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}
{
  const H = harness({ latencyMs: 1500 });
  H.cfg.agents.find((a) => a.id === 'a_wk').budget = { maxTokens: 60000, maxToolCalls: 10, maxSeconds: 1 };
  const out = JSON.parse(await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('s1', 'Worker', 'Esegui un lavoro lento e riassumilo.')] }, 'c'));
  check('maxSeconds kill returns partial', out.results[0].status === 'partial', JSON.stringify(out.results[0]).slice(0, 160));
  const endEv = H.state.getConsole('a_wk#s1', { limit: 100 }).find((e) => e.kind === 'task_end');
  check('task_end reports budgetHit=maxSeconds', endEv?.budgetHit === 'maxSeconds', String(endEv?.budgetHit));
  check('max_tokens per call is derived from the remaining budget',
    H.calls[0].maxTokens === 8192, String(H.calls[0].maxTokens));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.6 cancellation cascade
{
  const H = harness({ latencyMs: 800 });
  const p = H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [task('k1', 'Worker', 'Esegui un lavoro lento e riassumilo.'), task('k2', 'Worker Flash', 'Esegui un altro lavoro lento e riassumilo.')],
  }, 'c');
  setTimeout(() => H.pool.cancelAll('annullato dall\'utente'), 120);
  const out = JSON.parse(await p);
  check('cancelAll turns every pending instance into partial',
    out.results.length === 2 && out.results.every((r) => r.status === 'partial'), JSON.stringify(out.results.map((r) => r.status)));
  check('the cancellation is recorded in unverified',
    out.results.every((r) => r.unverified.some((u) => /cancelled/.test(u))), JSON.stringify(out.results[0].unverified));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.7 config-driven limits
{
  const H = harness();
  H.cfg.maxParallelWorkers = 2;
  const three = await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [task('p1', 'Worker', 'Analizza il primo modulo e riassumilo.'), task('p2', 'Worker', 'Analizza il secondo modulo e riassumilo.'), task('p3', 'Worker', 'Analizza il terzo modulo e riassumilo.')],
  }, 'c1');
  check('maxParallelWorkers=2 rejects a batch of 3', /maxParallelWorkers=2/.test(three), three.slice(0, 120));
  const two = await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [task('p1', 'Worker', 'Analizza il primo modulo e riassumilo.'), task('p2', 'Worker', 'Analizza il secondo modulo e riassumilo.')],
  }, 'c2');
  check('maxParallelWorkers=2 accepts a batch of 2', !two.startsWith('ERROR'), two.slice(0, 80));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}
{
  const H = harness({ latencyMs: 150, limits: { maxParallelWorkers: 6 } });
  const six = await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: Array.from({ length: 6 }, (_, i) => task(`f${i + 1}`, 'Worker', `Scrivi il file f${i + 1}.txt con il proprio nome e riassumi.`)),
  }, 'c');
  check('the pool is not capped at 4: 6 tasks accepted', !six.startsWith('ERROR'), six.slice(0, 100));
  check('observed concurrency reaches 6, not 4', (H.peak.get('__all__') ?? 0) === 6, `peak ${H.peak.get('__all__')}`);
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}
{
  const H = harness({ limits: { maxWorkersPerRequest: 3 } });
  await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [task('q1', 'Worker', 'Analizza il primo modulo e riassumilo.'), task('q2', 'Worker', 'Analizza il secondo modulo e riassumilo.'), task('q3', 'Worker', 'Analizza il terzo modulo e riassumilo.')],
  }, 'c1');
  const fourth = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('q4', 'Worker', 'Analizza il quarto modulo e riassumilo.')] }, 'c2');
  check('maxWorkersPerRequest=3 rejects the 4th instance with "left 0"',
    /maxWorkersPerRequest=3 \(used 3, left 0\)/.test(fourth), fourth.slice(0, 140));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}
{
  const H = harness({ limits: { correctionRounds: 0 } });
  await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('r1', 'Worker', 'Analizza il modulo e riassumilo.')] }, 'c1');
  await H.pool.runVerifier(H.from, {}, 'cv');
  const c0 = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('r1', 'Worker', 'Analizza il modulo e riassumilo.')] }, 'c2');
  check('correctionRounds=0 rejects a correction even after run_verifier',
    c0.startsWith('ERROR') && /correctionRounds=0/.test(c0), c0.slice(0, 140));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}
{
  const H = harness({ limits: { correctionRounds: 2 } });
  const go = () => H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('r1', 'Worker', 'Analizza il modulo e riassumilo.')] }, 'c');
  await go();
  await H.pool.runVerifier(H.from, {}, 'v1');
  const c1 = await go();
  await H.pool.runVerifier(H.from, {}, 'v2');
  const c2 = await go();
  await H.pool.runVerifier(H.from, {}, 'v3');
  const c3 = await go();
  check('correctionRounds=2 allows two corrections', !c1.startsWith('ERROR') && !c2.startsWith('ERROR'), `${c1.slice(0, 40)} | ${c2.slice(0, 40)}`);
  check('the third correction is rejected', c3.startsWith('ERROR') && /correctionRounds=2/.test(c3), c3.slice(0, 140));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}
{
  const H = harness({ latencyMs: 150 });
  H.cfg.agents.find((a) => a.id === 'a_wk').maxConcurrent = 1;
  await H.pool.delegateTasks(H.from, {
    tier: 'T2',
    tasks: [
      task('m1', 'Worker', 'Analizza il primo modulo e riassumilo.'),
      task('m2', 'Worker', 'Analizza il secondo modulo e riassumilo.'),
      task('m3', 'Worker Flash', 'Analizza il terzo modulo e riassumilo.'),
    ],
  }, 'c');
  const span = (id) => {
    const evs = H.state.getConsole(id, { limit: 100 });
    const s = evs.find((e) => e.kind === 'task_start');
    const e = evs.find((e2) => e2.kind === 'task_end');
    return s && e ? [s.ts, e.ts] : null;
  };
  const a = span('a_wk#m1');
  const b = span('a_wk#m2');
  const c = span('a_wk2#m3');
  const overlaps = (x, y) => !!x && !!y && x[0] < y[1] && y[0] < x[1];
  check('maxConcurrent=1 serializes that template', !overlaps(a, b), JSON.stringify([a, b]));
  check('another template still runs in parallel', overlaps(a, c) || overlaps(b, c), JSON.stringify([a, b, c]));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.8 hub-and-spoke vs nested delegation
{
  // Two worker templates: a worker may only delegate to a template that is NOT above it.
  const roster = [tpl('a_orc', 'Orchestratore', 'orchestrator'), tpl('a_wk', 'Worker', 'worker'), tpl('a_wk2', 'Worker Flash', 'worker'), tpl('a_pl', 'Planner', 'planner'), tpl('a_vf', 'Verificatore', 'verifier')];
  const H = harness({
    agents: roster,
    limits: { allowWorkerDelegation: true, maxDepth: 3 },
    script: (req, { taskId, calls }) => {
      const mine = calls.filter((c) => c.taskId === taskId).length;
      if (taskId === 'n1' && mine === 1) {
        return { toolCall: { name: 'delegate_tasks', args: { tier: 'T1', tasks: [task('t1', 'Worker Flash', 'Analizza il sotto-modulo indicato e riassumilo.')] } } };
      }
      return undefined;
    },
  });
  check('with allowWorkerDelegation+maxDepth 3 a worker gets delegate_tasks',
    toolNamesFor('worker', H.cfg, H.config.agentViews(), 1).includes('delegate_tasks'));
  const out = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('n1', 'Worker', 'Scomponi il modulo e delega il sotto-lavoro.')] }, 'c');
  check('nested delegation runs and the batch still returns', !out.startsWith('ERROR'), out.slice(0, 100));
  const ids = H.sent.filter((s) => s.ch === 'console:add').map((s) => s.p.id);
  check('nested instance ids are dotted paths (t path never collides)', ids.includes('a_wk2#n1.t1'), ids.join(','));
  check('a level-3 instance no longer gets delegate_tasks (maxDepth 3)',
    !toolNamesFor('worker', H.cfg, H.config.agentViews(), 2).includes('delegate_tasks'));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}
{
  const H = harness({ limits: { allowWorkerDelegation: true, maxDepth: 3 } });
  check('maxDepth=2 hides delegate_tasks from workers (hub-and-spoke)',
    !toolNamesFor('worker', { ...H.cfg, maxDepth: 2 }, H.config.agentViews(), 1).includes('delegate_tasks'));
  check('allowWorkerDelegation=false hides it too',
    !toolNamesFor('worker', { ...H.cfg, allowWorkerDelegation: false, maxDepth: 4 }, H.config.agentViews(), 1).includes('delegate_tasks'));
  // a worker delegating back to its own template is a cycle
  const workerRun = {
    agent: H.config.agent('a_wk'),
    run: {
      runId: 'run_child', taskId: 'task_c', agentId: 'a_wk#t1',
      origin: { kind: 'delegation', fromAgentId: 'a_orc', fromName: 'Orchestratore', parentRunId: H.requestId, callId: 'c', depth: 1, requestId: H.requestId, taskId: 't1', role: 'worker', attempt: 1 },
      status: 'running', iteration: 1, startedAt: Date.now(),
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedTokens: 0, cost: 0, calls: 0, estimated: false },
      ancestry: ['a_orc', 'a_wk'], childRunIds: [], requestId: H.requestId, role: 'worker', toolCalls: 0,
    },
  };
  const cycle = await H.pool.delegateTasks(workerRun, { tier: 'T1', tasks: [task('z1', 'Worker', 'Analizza di nuovo lo stesso modulo e riassumilo.')] }, 'c');
  check('the cycle check rejects delegating back up the chain',
    cycle.startsWith('ERROR') && /cycle: Worker is above you/.test(cycle), cycle.slice(0, 160));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.9 tool exposure follows the live pool
{
  const orcOnly = [tpl('a_orc', 'Orchestratore', 'orchestrator')];
  const H = harness({ agents: orcOnly });
  const names = toolNamesFor('orchestrator', H.cfg, H.config.agentViews(), 0);
  check('no worker/planner/verifier template → no pool tools',
    !names.includes('delegate_tasks') && !names.includes('run_planner') && !names.includes('run_verifier'), names.join(','));
  check('the orchestrator keeps read-only lookups and ask_user',
    ['read_artifact', 'ask_user', 'read_file', 'list_directory'].every((n) => names.includes(n)), names.join(','));
  check('the orchestrator never gets write or command tools',
    !names.includes('write_file') && !names.includes('run_command'), names.join(','));
  const direct = await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('t1', 'Worker', 'Analizza il modulo e riassumilo.')] }, 'c');
  check('delegate_tasks called anyway returns the "no worker template" error',
    /no worker template configured/.test(direct), direct.slice(0, 140));
  check('run_planner without a planner template degrades to an error, not a stall',
    /no planner template configured/.test(await H.pool.runPlanner(H.from, { objective: 'obiettivo ampio' }, 'c')));
  check('run_verifier without a verifier template degrades to an error',
    /no verifier template configured/.test(await H.pool.runVerifier(H.from, {}, 'c')));
  check('planner/verifier toolsets are read-only',
    toolNamesFor('planner', H.cfg, H.config.agentViews(), 0).join(',') === 'read_file,list_directory,search_files');
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.10 run_planner, tier and the ephemeral console lifecycle
{
  const H = harness();
  const planOut = await H.pool.runPlanner(H.from, { objective: 'Rifattorizza il progetto in tre aree distinte.', context: 'nessun contesto' }, 'c');
  const plan = JSON.parse(planOut);
  check('run_planner returns a parsed plan', Array.isArray(plan.tasks) && plan.tasks.length === 1, planOut.slice(0, 120));
  check('run_planner forces tier T3', H.pool.requestTier(H.requestId) === 'T3', String(H.pool.requestTier(H.requestId)));
  check('the planner instance uses the template console, not an ephemeral one',
    !H.sent.some((s) => s.ch === 'console:add') && H.state.getConsole('a_pl', { limit: 20 }).some((e) => e.kind === 'task_end'));
  check('planner escalation is requested even without an escalation model',
    H.calls.some((c) => c.taskId === 'PLAN'), JSON.stringify(H.calls.map((c) => c.taskId)));
  await H.pool.delegateTasks(H.from, { tier: 'T3', tasks: [task('t1', 'Worker', 'Analizza la prima area e riassumila.')] }, 'c2');
  check('tier T3 is never lowered by a later batch', H.pool.requestTier(H.requestId) === 'T3');
  check('instances count planner + workers', H.pool.requestSummary(H.requestId).instances === 2, JSON.stringify(H.pool.requestSummary(H.requestId)));

  // instance:close
  H.pool.closeInstance('a_wk#t1');
  check('instance:close removes the console', H.sent.some((s) => s.ch === 'console:remove' && s.p.agentId === 'a_wk#t1' && s.p.reason === 'closed'));
  check('a closed instance disappears from the snapshot list', !H.pool.instances().some((v) => v.id === 'a_wk#t1'));

  // next request drops the remaining ephemeral consoles
  await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('t2', 'Worker', 'Analizza la seconda area e riassumila.')] }, 'c3');
  H.pool.startRequest('run_smoke2', 'seconda richiesta');
  check('starting a request removes the previous ephemeral consoles',
    H.sent.some((s) => s.ch === 'console:remove' && s.p.reason === 'next_request'));
  check('the new request starts at tier null (T0 until it delegates)', H.pool.requestTier('run_smoke2') === null);
  check('requestSummary reports T0 for a request that never delegated',
    H.pool.requestSummary('run_smoke2').tier === 'T0' && H.pool.requestSummary('run_smoke2').instances === 0);
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

// 12.11 artifacts flow end to end through a worker result
{
  const H = harness({ script: () => ({ text: JSON.stringify({ task_id: 'a1', status: 'ok', result: 'y'.repeat(5000) }) }), limits: { artifactThresholdChars: 1000 } });
  const out = JSON.parse(await H.pool.delegateTasks(H.from, { tier: 'T1', tasks: [task('a1', 'Worker', 'Produci un output molto lungo e restituiscilo.')] }, 'c'));
  const res = out.results[0];
  check('a long worker result is replaced by an artifact_ref', typeof res.result === 'object' && !!res.result.artifact_ref, JSON.stringify(res.result).slice(0, 80));
  const readBack = await H.pool.readArtifact({ id: res.result.artifact_ref, limit: 50 });
  check('read_artifact returns the header + slice', /^\[art_[0-9a-f]{6} · 5000 chars · 0–50\]\nyyy/.test(readBack), readBack.slice(0, 60));
  check('read_artifact on an unknown id errors', (await H.pool.readArtifact({ id: 'art_000000' })).startsWith('ERROR'));
  await H.contracts.flush();
  fs.rmSync(H.root, { recursive: true, force: true });
}

fs.rmSync(cRoot, { recursive: true, force: true });

// ---------------------------------------------------------------- summary

console.log(`\n${failures === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED'} — ${failures} failure(s), ${warnings} warning(s)`);
process.exit(failures === 0 ? 0 : 1);
