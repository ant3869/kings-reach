// tests/routing-advice.test.mjs - outcome-informed route advice: classification, thresholds, attribution, honesty, and the read-only contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { buildRoutingAdvice, classify, MIN_ATTEMPTS, SOLID_ATTEMPTS, ROUTING_LIMITS } from '../dist/routing-advice.js';
import { renderRouting } from '../dist/routing-html.js';
import { mountRouting } from '../dist/routing-routes.js';

const ROOT = join(import.meta.dirname, '..');
let n = 0;
const A = (provider, model, error) => ({ provider, model, ...(error ? { error } : {}) });
/** One summit with one role. `attempts` is that role's attempt chain; seconds/cost are per ROLE, as the ledger records them. */
function summit(attempts, { role = 'ops', outcome = 'verdict', id = `run${++n}`, seconds = 10, cost = 0.5 } = {}) {
  return { kind: 'summit', id, outcome, agents: { [role]: { attempts, seconds, cost_usd: cost } } };
}
const many = (count, make) => Array.from({ length: count }, (_, i) => make(i));
const route = (adv, role, provider, model) => adv.roles.find((r) => r.role === role)?.routes.find((r) => r.provider === provider && r.model === model);
const OK = (p = 'claude', m = 'm1') => [A(p, m)];

test('classify: skipped, access problems, turn limit, connection, and everything else are told apart', () => {
  assert.equal(classify('skipped: tools required'), 'skipped');
  for (const e of ['Error: Claude Code returned an error result: Not logged in \u00B7 Please run /login', 'Error: Claude is logged out. Press "Sign in to Claude"', 'hermes exited 1: No usable credentials found']) assert.equal(classify(e), 'auth', e);
  for (const e of ["Error: You're out of extra usage", 'rate limit exceeded', 'insufficient credit balance']) assert.equal(classify(e), 'quota', e);
  assert.equal(classify('Error: Reached maximum number of turns (10)'), 'turn-limit');
  for (const e of ['ERROR rmcp::transport::worker: worker quit', 'ETIMEDOUT', 'API Error: 503 overloaded', 'http status 502']) assert.equal(classify(e), 'transport', e);
  for (const e of ['Invalid schema for response_format', 'something odd', 'took 512 ms and used 530 tokens', 'x'.repeat(5)]) assert.equal(classify(e), 'other', e);
});

test('reliability: access problems (signed out, no credit, unreachable) never count against a model; other failures do', () => {
  const chains = [...many(6, () => OK()), [A('claude', 'm1', 'Not logged in')], [A('claude', 'm1', "You're out of extra usage")], [A('claude', 'm1', 'ECONNRESET network down')], [A('claude', 'm1', 'Reached maximum number of turns (10)')], [A('claude', 'm1', 'Invalid schema')]];
  const s = route(buildRoutingAdvice(chains.map((c) => summit(c))), 'ops', 'claude', 'm1');
  assert.deepEqual([s.attempts, s.succeeded, s.failures.auth, s.failures.quota, s.failures.transport, s.failures['turn-limit'], s.failures.other], [11, 6, 1, 1, 1, 1, 1]);
  assert.equal(s.reliability, 6 / 8, '6 finished; only the turn-limit and the unclassified error count against it');
});

test('skipped is not an attempt: a capability gate that never ran is neither a success nor a failure, and is reported on its own', () => {
  const chains = many(4, () => [A('gemini', 'g', 'skipped: tools required'), A('claude', 'm1')]);
  const adv = buildRoutingAdvice(chains.map((c) => summit(c)));
  const g = route(adv, 'ops', 'gemini', 'g');
  assert.deepEqual([g.attempts, g.skipped, g.reliability, g.skipReasons], [0, 4, null, ['tools required']]);
  assert.equal(route(adv, 'ops', 'claude', 'm1').attempts, 4);
});

test('cancelled runs are left out entirely (their errors may be artifacts of stopping), and the count is reported', () => {
  const adv = buildRoutingAdvice([...many(3, () => summit(OK())), ...many(5, () => summit([A('claude', 'm1', 'aborted by user')], { outcome: 'cancelled' }))]);
  assert.equal(route(adv, 'ops', 'claude', 'm1').attempts, 3);
  assert.equal(route(adv, 'ops', 'claude', 'm1').failures.other, 0);
  assert.deepEqual([adv.coverage.summits, adv.coverage.cancelledLeftOut, adv.coverage.usable], [8, 5, 3]);
});

test('thresholds: below the minimum a route is "insufficient" and gets NO advice, however bad it looks', () => {
  const chains = many(MIN_ATTEMPTS - 1, () => [A('claude', 'bad', 'Invalid schema')]);
  const adv = buildRoutingAdvice(chains.map((c) => summit(c)));
  const s = route(adv, 'ops', 'claude', 'bad');
  assert.equal(s.reliability, 0);
  assert.equal(s.confidence, 'insufficient');
  assert.deepEqual(adv.roles[0].advice, []);
});

test('thresholds: insufficient < 5 <= limited < 20 <= reasonable, exactly at the edges', () => {
  const conf = (k) => route(buildRoutingAdvice(many(k, () => summit(OK()))), 'ops', 'claude', 'm1').confidence;
  assert.deepEqual([conf(MIN_ATTEMPTS - 1), conf(MIN_ATTEMPTS), conf(SOLID_ATTEMPTS - 1), conf(SOLID_ATTEMPTS)], ['insufficient', 'limited', 'limited', 'reasonable']);
});

test('advice "unreliable": an evidenced route that fails most of the time is flagged as a suggestion, with its numbers and evidence level', () => {
  const chains = [...many(2, () => OK('claude', 'flaky')), ...many(4, () => [A('claude', 'flaky', 'Invalid schema')])];
  const a = buildRoutingAdvice(chains.map((c) => summit(c))).roles[0].advice.find((x) => x.kind === 'unreliable');
  assert.equal(a.level, 'suggestion');
  assert.match(a.text, /claude \u00B7 flaky finished 33% of its 6 attempts for ops \(limited evidence\)/);
});

test('advice "environment": repeated sign-in/credit failures are a heads-up that is explicitly NOT a verdict on the model', () => {
  const chains = [...many(5, () => OK()), ...many(3, () => [A('claude', 'm1', 'Not logged in')])];
  const adv = buildRoutingAdvice(chains.map((c) => summit(c))).roles[0].advice;
  const e = adv.find((x) => x.kind === 'environment');
  assert.equal(e.level, 'heads-up');
  assert.match(e.text, /3 sign-in, credit or connection failures/);
  assert.match(e.text, /not a verdict on the model/);
  assert.equal(adv.some((x) => x.kind === 'unreliable'), false, 'and the same failures do not also mark it unreliable');
  const two = buildRoutingAdvice([...many(5, () => summit(OK())), ...many(2, () => summit([A('claude', 'm1', 'Not logged in')]))]).roles[0].advice;
  assert.equal(two.some((x) => x.kind === 'environment'), false, 'two is not a pattern');
});

test('advice "inert": a route skipped every time for a role is called out as adding nothing', () => {
  const chains = many(3, () => [A('openai', 'mini', 'skipped: tools required'), A('claude', 'm1')]);
  const a = buildRoutingAdvice(chains.map((c) => summit(c))).roles[0].advice.find((x) => x.kind === 'inert');
  assert.match(a.text, /openai \u00B7 mini was skipped 3 times for ops \(tools required\) and never ran/);
  const ran = buildRoutingAdvice([...chains, summit(OK('openai', 'mini'))].map((c) => (Array.isArray(c) ? summit(c) : c))).roles[0].advice;
  assert.equal(ran.some((x) => x.kind === 'inert'), false, 'a route that sometimes runs is not inert');
});

test('advice "observed-leader": needs two evidenced routes and a 20-point gap; it says it measures completion, not quality', () => {
  const gap = buildRoutingAdvice([...many(10, () => summit(OK('claude', 'steady'))), ...many(5, () => summit(OK('codex', 'shaky'))), ...many(5, () => summit([A('codex', 'shaky', 'Invalid schema')]))]);
  const lead = gap.roles[0].advice.find((x) => x.kind === 'observed-leader');
  assert.match(lead.text, /claude \u00B7 steady finished 100% of 10 attempts against 50% of 10 for codex \u00B7 shaky/);
  assert.match(lead.text, /says nothing about answer quality/);
  const close = buildRoutingAdvice([...many(10, () => summit(OK('claude', 'steady'))), ...many(9, () => summit(OK('codex', 'shaky'))), ...many(1, () => summit([A('codex', 'shaky', 'Invalid schema')]))]);
  assert.equal(close.roles[0].advice.some((x) => x.kind === 'observed-leader'), false, '100% vs 90%: no clear leader');
  const lone = buildRoutingAdvice(many(30, () => summit(OK())));
  assert.equal(lone.roles[0].advice.some((x) => x.kind === 'observed-leader'), false, 'one route cannot lead');
  const thin = buildRoutingAdvice([...many(10, () => summit(OK('claude', 'steady'))), ...many(3, () => summit([A('codex', 'new', 'Invalid schema')]))]);
  assert.equal(thin.roles[0].advice.some((x) => x.kind === 'observed-leader'), false, 'an insufficient route is never the loser of a comparison');
});

test('attribution: time and cost count only when ONE route did the whole role; a fallback chain cannot be split, so it is not guessed', () => {
  const adv = buildRoutingAdvice([
    summit(OK('claude', 'solo'), { seconds: 10, cost: 1 }), summit(OK('claude', 'solo'), { seconds: 30, cost: 3 }),
    summit([A('claude', 'solo', 'Invalid schema'), A('codex', 'fallback')], { seconds: 999, cost: 99 }),
  ]);
  const s = route(adv, 'ops', 'claude', 'solo');
  assert.deepEqual([s.seconds.samples, s.seconds.avg, s.cost.samples, s.cost.avgUsd], [2, 20, 2, 2], 'the 999s/$99 chain is not pinned on either route');
  assert.deepEqual([route(adv, 'ops', 'codex', 'fallback').seconds.samples, route(adv, 'ops', 'codex', 'fallback').cost.avgUsd], [0, null]);
});

test('cost honesty: a missing cost is unknown (null), and a recorded $0 is counted separately, never treated as proof of free', () => {
  const rows = [summit(OK('meta', 'muse'), { cost: 0 }), summit(OK('meta', 'muse'), { cost: 0 }), { kind: 'summit', id: 'nocost', outcome: 'verdict', agents: { ops: { attempts: OK('meta', 'muse'), seconds: 5 } } }];
  const s = route(buildRoutingAdvice(rows), 'ops', 'meta', 'muse');
  assert.deepEqual([s.cost.samples, s.cost.avgUsd, s.cost.recordedZero], [2, 0, 2], 'the row with no cost field is not a $0 sample');
  const none = route(buildRoutingAdvice([{ kind: 'summit', id: 'x', outcome: 'verdict', agents: { ops: { attempts: OK() } } }]), 'ops', 'claude', 'm1');
  assert.deepEqual([none.cost.avgUsd, none.cost.samples, none.seconds.avg], [null, 0, null]);
});

test('outcomes: verdicts, linked builds, and ratings count only for runs the route actually finished; ratings of 0 / missing are not thumbs', () => {
  const finished = summit(OK('claude', 'm1'), { id: 'v1' }), failedRun = summit([A('claude', 'm1', 'Invalid schema')], { id: 'v2' }), noVerdict = summit(OK('claude', 'm1'), { outcome: 'no_quorum', id: 'v3' });
  const builds = [{ kind: 'build', id: 'b1', verdict_run: 'v1', outcome: 'built' }, { kind: 'build', id: 'b2', verdict_run: 'v1', outcome: 'needs_work' }, { kind: 'build', id: 'b3', verdict_run: 'v2', outcome: 'built' }, { kind: 'build', id: 'b4', verdict_run: '', outcome: 'built' }];
  const s = route(buildRoutingAdvice([finished, failedRun, noVerdict, ...builds], new Map([['v1', { value: 1 }], ['v2', { value: -1 }], ['v3', { value: 1 }]])), 'ops', 'claude', 'm1');
  assert.deepEqual([s.runs, s.verdictRuns, s.builds, s.built], [3, 1, 2, 1], 'v2 failed (its build is not credited), v3 reached no verdict');
  assert.deepEqual([s.thumbsUp, s.thumbsDown], [2, 0], 'v1 and v3 finished and were rated up; v2 was rated down but this route failed it');
});

test('salvaged: an attempt that errored but was recovered is neither a success nor a failure, so it cannot sink or flatter reliability', () => {
  const chains = [...many(4, () => OK()), [{ ...A('claude', 'm1', 'Invalid schema'), salvaged: true }], [A('claude', 'm1', 'Invalid schema')]];
  const s = route(buildRoutingAdvice(chains.map((c) => summit(c))), 'ops', 'claude', 'm1');
  assert.deepEqual([s.attempts, s.succeeded, s.salvaged, s.failures.other], [6, 4, 1, 1]);
  assert.equal(s.reliability, 4 / 5, 'only the unrecovered failure counts against it');
});

test('one run is counted once per route even if the route appears twice in its chain', () => {
  const s = route(buildRoutingAdvice([summit([A('claude', 'm1'), A('claude', 'm1')], { id: 'dup' })], new Map([['dup', { value: 1 }]])), 'ops', 'claude', 'm1');
  assert.deepEqual([s.attempts, s.runs, s.verdictRuns, s.thumbsUp], [2, 1, 1, 1]);
});

test('coverage: role-runs with no attempt data are counted, not dropped or guessed at', () => {
  const adv = buildRoutingAdvice([summit(OK()), { kind: 'summit', id: 'old', outcome: 'verdict', agents: { ops: { seconds: 5 } } }, { kind: 'summit', id: 'older', outcome: 'verdict' }]);
  assert.deepEqual([adv.coverage.roleRuns, adv.coverage.roleRunsWithoutAttempts, adv.coverage.rows], [2, 1, 3]);
});

test('malformed ledger rows never throw: junk records, non-object agents, non-array attempts, attempts with no model', () => {
  assert.doesNotThrow(() => buildRoutingAdvice([null, 5, 'x', [], {}, { kind: 'summit' }, { kind: 'summit', agents: 'no' }, { kind: 'summit', agents: { a: null, b: { attempts: 'no' }, c: { attempts: [null, {}, { model: '' }, { model: 'ok' }] } } }, { kind: 'build', verdict_run: 5 }]));
  const adv = buildRoutingAdvice([{ kind: 'summit', id: 'k', outcome: 'verdict', agents: { c: { attempts: [null, {}, { model: '' }, { provider: 'p', model: 'ok' }] } } }]);
  assert.deepEqual(adv.roles.map((r) => r.routes.map((x) => x.model)), [['ok']]);
  assert.deepEqual(buildRoutingAdvice([]).roles, []);
});

test('deterministic: the same ledger always gives the same answer, roles and routes in a stable order', () => {
  const rows = [summit(OK('b', 'm'), { role: 'z' }), summit(OK('a', 'm'), { role: 'a' }), summit(OK('a', 'm'), { role: 'a' }), summit(OK('c', 'm'), { role: 'a' })];
  const x = buildRoutingAdvice(rows), y = buildRoutingAdvice([...rows].reverse());
  assert.deepEqual(x.roles.map((r) => r.role), ['a', 'z']);
  assert.deepEqual(x.roles[0].routes.map((r) => r.provider), ['a', 'c'], 'most attempts first');
  assert.deepEqual(x, y);
});

test('honesty: the limits say what this cannot tell you, and the ledger it reads really has no per-route quality signal', () => {
  const all = ROUTING_LIMITS.join(' ');
  for (const re of [/not whether the answer was good/, /not counted against a model/, /Cancelled runs are left out/, /\$0/, /not per route/, /needs 5 real attempts/]) assert.match(all, re);
  assert.equal(MIN_ATTEMPTS, 5);
});

// store/ is gitignored: a fresh checkout has no ledger, so this skips there rather than fail on data it was never given.
const LEDGER = join(ROOT, 'store', 'council-runs.jsonl');
test('the real ledger: reads without throwing and reports its own coverage honestly', { skip: !existsSync(LEDGER) && 'no local ledger (store/ is gitignored)' }, () => {
  const recs = readFileSync(LEDGER, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const adv = buildRoutingAdvice(recs);
  assert.equal(adv.coverage.rows, recs.filter(Boolean).length);
  assert.equal(adv.coverage.usable + adv.coverage.cancelledLeftOut, adv.coverage.summits);
  for (const r of adv.roles) for (const s of r.routes) assert.ok(s.reliability === null || (s.reliability >= 0 && s.reliability <= 1), `${r.role} ${s.model}`);
});

// --- the contract: read-only ---------------------------------------------------------------------------------------------------------------
test('read-only contract: every route is a GET, the client sends no request with a method, and nothing here can write a route', () => {
  const app = new Hono(); mountRouting(app);
  const mine = app.routes.filter((r) => r.method !== 'ALL');
  assert.ok(mine.length >= 3);
  assert.deepEqual([...new Set(mine.map((r) => r.method))], ['GET']);
  assert.doesNotMatch(readFileSync(join(ROOT, 'public', 'routing-app.js'), 'utf8').replace(/\/\/.*$/gm, ''), /method\s*:/i);
  for (const f of ['src/routing-advice.ts', 'src/routing-routes.ts']) assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8').replace(/\/\/.*$/gm, ''), /writeFileSync|appendFileSync|unlinkSync|rmSync|saveProviderConfig|setRouting|agent\.yaml/, `${f} must not write`);
});

test('routes: the advice endpoint answers with coverage, roles and limits; the page and its script are served; the token cannot break out', async () => {
  const app = new Hono(); mountRouting(app);
  const res = await app.request('/api/routing/advice');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()).sort(), ['coverage', 'limits', 'roles']);
  const page = await (await app.request('/routing?token=a%22%3E%3Cscript%3Ealert(1)')).text();
  assert.ok(page.includes('Route advice') && !page.includes('"><script>alert'));
  assert.match(await (await app.request('/routing')).text(), /<a class="kr-link on" aria-current="page" href="\/routing">/);
  assert.equal((await app.request('/routing/routing-app.js')).status, 200);
  assert.equal((await app.request('/routing/other.js')).status, 404);
  assert.doesNotThrow(() => new vm.Script(renderRouting('').match(/<script>([\s\S]*?)<\/script>/)[1]));
});

// --- the client, run for real in a vm -------------------------------------------------------------------------------------------------------
async function runClient(advice, ok = true) {
  const els = {}; const el = (id) => (els[id] ??= { innerHTML: '' });
  const ctx = vm.createContext({ RTE: { token: '' }, document: { getElementById: el }, fetch: async () => ({ ok, status: ok ? 200 : 500, json: async () => advice }) });
  vm.runInContext(readFileSync(join(ROOT, 'public', 'routing-app.js'), 'utf8'), ctx);
  await new Promise((r) => setTimeout(r, 20));
  return els;
}
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>" onmouseover="alert(3)\'';
const live = (h) => h.includes('<img') || h.includes('<script') || h.includes('" onmouseover=') || h.includes(EVIL);
const stat = (extra = {}) => ({ provider: 'p', model: 'm', attempts: 7, succeeded: 6, skipped: 0, salvaged: 0, failures: { auth: 1, quota: 0, transport: 0, 'turn-limit': 0, other: 0 }, reliability: 0.857, runs: 7, verdictRuns: 5, builds: 2, built: 1, thumbsUp: 0, thumbsDown: 0, seconds: { samples: 3, avg: 41.6 }, cost: { samples: 3, avgUsd: 0, recordedZero: 3 }, confidence: 'limited', skipReasons: [], ...extra });
const cov = { rows: 1, summits: 1, cancelledLeftOut: 0, usable: 1, roleRuns: 1, roleRunsWithoutAttempts: 0, ratings: 0, builds: 0 };

test('client: hostile provider, model, role, advice text, skip reasons and limits are escaped everywhere', async () => {
  const els = await runClient({ coverage: cov, limits: [EVIL], roles: [{ role: EVIL, routes: [stat({ provider: EVIL, model: EVIL, skipped: 2, skipReasons: [EVIL], confidence: EVIL })], advice: [{ kind: 'x', level: EVIL, route: EVIL, text: EVIL }] }] });
  for (const id of ['stats', 'advice', 'roles', 'limits']) assert.equal(live(els[id].innerHTML), false, `${id}: ${els[id].innerHTML.slice(0, 200)}`);
  assert.ok(els.roles.innerHTML.includes('&lt;img'));
});

test('client: unknown is shown as "unknown" (never 0 or free); a recorded $0 says so; empty and failed loads are explained', async () => {
  const unknown = (await runClient({ coverage: cov, limits: [], roles: [{ role: 'ops', advice: [], routes: [stat({ reliability: null, seconds: { samples: 0, avg: null }, cost: { samples: 0, avgUsd: null, recordedZero: 0 } })] }] })).roles.innerHTML;
  assert.equal((unknown.match(/unknown/g) || []).length, 3, 'reliability, time and cost are all unknown');
  assert.doesNotMatch(unknown, /\$0\.00|free/);
  const zero = (await runClient({ coverage: cov, limits: [], roles: [{ role: 'ops', advice: [], routes: [stat()] }] })).roles.innerHTML;
  assert.match(zero, /\$0\.00 \(3 runs\) \u00B7 3 recorded as \$0/);
  assert.match(zero, /86%/);
  assert.match((await runClient({ coverage: cov, limits: [], roles: [] })).advice.innerHTML, /No advice\./);
  assert.match((await runClient({ coverage: cov, limits: [], roles: [] })).roles.innerHTML, /No run in the ledger/);
  assert.match((await runClient({}, false)).roles.innerHTML, /Could not load route advice.*500/);
  const adv = (await runClient({ coverage: cov, limits: [], roles: [{ role: 'ops', routes: [], advice: [{ level: 'heads-up', text: 'T1' }, { level: 'suggestion', text: 'T2' }] }] })).advice.innerHTML;
  assert.match(adv, /Heads up \u00B7 ops/);
  assert.match(adv, /Suggestion \u00B7 ops/);
});
