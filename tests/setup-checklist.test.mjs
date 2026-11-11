// tests/setup-checklist.test.mjs - the first-run checklist and the provider re-check. Pure inputs and fakes: no provider is
// called and the real store/ is never read or written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { buildChecklist, recheckProvider, RECHECKABLE } from '../dist/setup-checklist.js';
import { mountSetup } from '../dist/setup-routes.js';

const h = (id, available, detail = '', configured = true) => ({ id, available, detail, configured });
const GOOD = { envFile: true, warroomRunning: true, runs: 3, telegramToken: true, telegramChat: true,
  providers: [h('claude', true, 'SDK/CLI installed'), h('codex', true, 'Logged in'), h('gemini', true, 'configured')] };
const state = (c, id) => c.items.find((i) => i.id === id).state;

test('checklist: everything set up means ready, with no problems and nothing left to do', () => {
  const c = buildChecklist(GOOD);
  assert.equal(c.ready, true);
  assert.deepEqual(c.problems, []);
  assert.ok(c.items.every((i) => i.state === 'ok' && i.fix === null));
});

test('checklist: a fresh clone lists every required step, each with a concrete fix, and is not ready', () => {
  const c = buildChecklist({ envFile: false, warroomRunning: false, runs: 0, telegramToken: false, telegramChat: false,
    providers: [h('claude', false, 'signed out'), h('gemini', false, 'GOOGLE_API_KEY missing', false)] });
  assert.equal(c.ready, false);
  for (const id of ['env', 'claude', 'fallback', 'warroom', 'firstrun']) {
    assert.equal(state(c, id), 'todo', id);
    assert.ok(c.items.find((i) => i.id === id).fix.length > 20, `${id} must say what to do`);
  }
  assert.match(c.items.find((i) => i.id === 'env').fix, /\.env\.example/);
  assert.deepEqual(c.problems, [], 'a provider you never set up is a step, not a problem');
});

test('checklist: Telegram is optional, so it never blocks ready', () => {
  const c = buildChecklist({ ...GOOD, telegramToken: true, telegramChat: false });
  assert.equal(state(c, 'telegram'), 'todo');
  const tg = c.items.find((i) => i.id === 'telegram');
  assert.match(tg.detail, /ALLOWED_CHAT_ID missing/, 'names the half that is missing');
  assert.equal(tg.fix, 'Set ALLOWED_CHAT_ID in .env, then restart.', 'and asks only for that half');
  assert.equal(c.items.find((i) => i.id === 'telegram').required, false);
  assert.equal(c.ready, true);
});

test('checklist: the fallback step counts routes other than Claude', () => {
  const claudeOnly = buildChecklist({ ...GOOD, providers: [h('claude', true, 'ok')] });
  assert.equal(state(claudeOnly, 'fallback'), 'todo', 'when Claude runs out there would be nothing to fall back to');
  assert.equal(claudeOnly.ready, false);
});

test('checklist: a key that is set but the account is out of credit is a problem with the billing page and a re-check, not an auth failure', () => {
  const c = buildChecklist({ ...GOOD, providers: [...GOOD.providers,
    h('openai', false, 'OPENAI_API_KEY configured; quota / credits exhausted (gpt-4.1-mini, 2026-11-03 04:40:51)')] });
  assert.equal(c.ready, true, 'the essentials are fine; this is a warning on top');
  assert.equal(c.problems.length, 1);
  const p = c.problems[0];
  assert.equal(p.id, 'openai');
  assert.equal(p.recheck, true);
  assert.match(p.fix, /Out of credit/);
  assert.match(p.fix, /platform\.openai\.com\/settings\/organization\/billing/);
  assert.doesNotMatch(p.fix, /key was rejected/i);
});

test('checklist: a rejected key says so, and a provider that is not re-checkable offers no button', () => {
  const c = buildChecklist({ ...GOOD, providers: [...GOOD.providers, h('openrouter', false, 'OPENROUTER_API_KEY configured; authentication failed (x)'), h('ollama', false, 'running, no models installed')] });
  const byId = Object.fromEntries(c.problems.map((p) => [p.id, p]));
  assert.match(byId.openrouter.fix, /key was rejected/);
  assert.equal(byId.ollama.recheck, false);
  assert.ok(!RECHECKABLE.includes('ollama') && !RECHECKABLE.includes('claude') && !RECHECKABLE.includes('codex'), 'only plain API-key providers can be tested with one call');
});

function fakes(over = {}) {
  const calls = { run: [], record: [] };
  return { calls, deps: {
    run: async (target, opts) => { calls.run.push([target, opts]); return { text: 'OK' }; },
    targets: () => [{ provider: 'openai', model: 'gpt-4.1-mini' }, { provider: 'gemini', model: 'g-flash' }],
    record: (...a) => calls.record.push(a),
    observed: () => ({ openai: { detail: 'quota / credits exhausted' } }),
    ...over } };
}

test('re-check: one tiny call to the model you actually route to, recorded as a success', async () => {
  const { calls, deps } = fakes();
  assert.deepEqual(await recheckProvider('openai', deps), { ok: true, detail: 'Answered (gpt-4.1-mini).' });
  assert.equal(calls.run.length, 1, 'exactly one call');
  assert.deepEqual(calls.run[0][0], { provider: 'openai', model: 'gpt-4.1-mini' });
  assert.ok(calls.run[0][1].message.length < 60, 'a tiny prompt, so it costs a fraction of a cent');
  assert.deepEqual(calls.record, [['openai', 'gpt-4.1-mini', true]]);
});

test('re-check: a failure is recorded and reported in the cleaned-up words, not the raw API error', async () => {
  const { calls, deps } = fakes({ run: async () => { throw new Error('HTTP 429 {"error":{"type":"insufficient_quota"}}'); } });
  assert.deepEqual(await recheckProvider('openai', deps), { ok: false, detail: 'quota / credits exhausted' });
  assert.equal(calls.record[0][2], false);
  assert.match(calls.record[0][3], /insufficient_quota/, 'the raw text goes to the recorder, which cleans it before saving');
});

test('re-check: an empty reply counts as a failure, and a provider with no route is refused without any call', async () => {
  const empty = fakes({ run: async () => ({ text: '' }) });
  assert.equal((await recheckProvider('gemini', empty.deps)).ok, false);
  const none = fakes({ targets: () => [] });
  const r = await recheckProvider('openai', none.deps);
  assert.equal(r.ok, false);
  assert.match(r.detail, /No route uses this provider/);
  assert.equal(none.calls.run.length, 0);
});

test('re-check: anything that is not a plain API-key provider is refused before any work', async () => {
  const { calls, deps } = fakes();
  for (const id of ['claude', 'codex', 'ollama', '../x', '']) assert.equal(await recheckProvider(id, deps), null, id);
  assert.equal(calls.run.length, 0);
});

test('routes: GET /api/setup is never cached; POST re-check works, and an unsupported provider is a 404', async () => {
  const app = new Hono();
  const checklist = buildChecklist(GOOD);
  mountSetup(app, { collect: async () => checklist, recheck: async (id) => (id === 'openai' ? { ok: true, detail: 'x' } : null) });
  const get = await app.request('/api/setup');
  assert.equal(get.status, 200);
  assert.equal(get.headers.get('cache-control'), 'no-store');
  assert.equal((await get.json()).ready, true);
  assert.deepEqual(await (await app.request('/api/providers/openai/check', { method: 'POST' })).json(), { ok: true, detail: 'x' });
  assert.equal((await app.request('/api/providers/claude/check', { method: 'POST' })).status, 404);
  assert.equal((await app.request('/api/providers/openai/check')).status, 404, 'a plain GET (prefetch, stray link) must never spend tokens');
});
