// tests/agent-cost-routes.test.mjs
// Executes the real runAgent route loop with the SDK, routing, external runner, skills and DB faked at their module
// edges (needs --experimental-test-module-mocks, set in the npm test script). Nothing here touches store/.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (f) => pathToFileURL(resolve('dist', f)).href;
const state = { routes: [], claudeRuns: [], external: [], externalCalls: [], queryCalls: [], tokenRows: [], loggedIn: true, tiers: null };

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (args) => {
      state.queryCalls.push(args);
      const script = state.claudeRuns.shift();
      assert.ok(script, 'unexpected extra Claude run');
      return (async function* () { for (const e of script) { if (e instanceof Error) throw e; yield e; } })();
    },
  },
});
// The route loop asks "is Claude signed in?" before each Claude attempt; fake it so these tests never depend on the host's login.
mock.module(dist('claude-auth.js'), {
  namedExports: { claudeAuth: async () => ({ loggedIn: state.loggedIn, detail: '' }), CLAUDE_LOGGED_OUT: 'Claude Code is logged out (test)' },
});
mock.module(dist('provider-config.js'), {
  namedExports: { routesFor: () => state.routes, loadTierConfig: () => state.tiers, providerHasTools: (id) => id !== 'chatgpt', recordProviderOutcome: () => {} },
});
mock.module(dist('provider-runner.js'), {
  namedExports: {
    runExternalProvider: async (target, opts) => {
      state.externalCalls.push({ target, message: opts.message });
      const next = state.external.shift();
      assert.ok(next, 'unexpected extra external run');
      if (next instanceof Error) throw next;
      return { ...next };
    },
  },
});
mock.module(dist('skills.js'), {
  namedExports: { skillContext: async () => '', agentEnv: () => ({}), claudeSkillOptions: () => ({}) },
});
mock.module(dist('db.js'), { namedExports: { logTokenUsage: (...row) => { state.tokenRows.push(row); } } });

const agent = await import(dist('agent.js'));

const CLAUDE = { provider: 'claude', model: 'c1' };
const CODEX = { provider: 'codex', model: 'x1' };
const NOTE = 'found: users table has no index on user_id';
const CAP = 'Reached maximum number of turns (6)';

function reset(routes = [CLAUDE, CODEX]) {
  Object.assign(state, { routes, claudeRuns: [], external: [], externalCalls: [], queryCalls: [], tokenRows: [], loggedIn: true, tiers: null });
}
const init = { type: 'system', subtype: 'init', session_id: 'sess-1' };
const said = { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: NOTE }] } };
const usage = { input_tokens: 100, output_tokens: 50 };
const done = (cost, text = 'answer') => ({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: cost, usage });
const failed = (subtype, cost, errors = []) => ({ type: 'result', subtype, is_error: true, errors, total_cost_usd: cost, usage });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`);
const run = (extra = {}) => agent.runAgent({ message: 'do the thing', chatId: 'chat1', ...extra });

test('returned Claude failure: its cost lands in attempts once and the next route gets the handoff', async () => {
  reset();
  state.claudeRuns.push([init, said, failed('error_during_execution', 0.2)]);
  state.external.push({ text: 'ok', costUsd: 0.01, inputTokens: 10, outputTokens: 5 });
  const r = await run();
  assert.equal(r.provider, 'codex');
  assert.equal(r.attempts[0].costUsd, 0.2);
  assert.match(r.attempts[0].error, /error_during_execution/);
  close(r.costUsd, 0.21);
  assert.ok(state.externalCalls[0].message.startsWith('[Handoff]'));
  assert.ok(state.externalCalls[0].message.includes(NOTE));
  assert.ok(state.externalCalls[0].message.endsWith('do the thing'));
});

test('zero reported cost is not recorded as spend; a nonzero one is', async () => {
  reset();
  state.claudeRuns.push([init, failed('error_during_execution', 0)]);
  state.external.push({ text: 'ok', costUsd: 0.01 });
  const free = await run();
  assert.equal('costUsd' in free.attempts[0], false);
  close(free.costUsd, 0.01);
  reset();
  state.claudeRuns.push([init, failed('error_during_execution', 0.2)]);
  state.external.push({ text: 'ok', costUsd: 0.01 });
  assert.equal((await run()).attempts[0].costUsd, 0.2);
});

test('salvage that returns an error keeps both the capped cost and the wrap cost, plus the handoff', async () => {
  reset();
  state.claudeRuns.push([init, said, failed('error_max_turns', 0.2, [CAP])]);
  state.claudeRuns.push([failed('error_during_execution', 0.05)]);
  state.external.push({ text: 'ok', costUsd: 0.01 });
  const r = await run();
  assert.equal(r.provider, 'codex');
  close(r.attempts[0].costUsd, 0.25);
  close(r.costUsd, 0.26);
  assert.equal(state.queryCalls[1].options.resume, 'sess-1');
  assert.ok(state.externalCalls[0].message.includes(NOTE));
});

test('salvage that succeeds answers on Claude with the combined cost and no failed attempt', async () => {
  reset();
  state.claudeRuns.push([init, said, failed('error_max_turns', 0.2, [CAP])]);
  state.claudeRuns.push([done(0.05, 'wrapped answer')]);
  const r = await run();
  assert.equal(r.provider, 'claude');
  assert.equal(r.attempts[0].salvaged, true);
  close(r.costUsd, 0.25);
  assert.equal(state.externalCalls.length, 0);
});

test('a tool-required request skips a tool-less route without spend', async () => {
  reset([{ provider: 'chatgpt', model: 'g1' }, CLAUDE]);
  state.claudeRuns.push([init, done(0.3)]);
  const r = await run({ toolNeed: 'required' });
  assert.equal(r.provider, 'claude');
  assert.equal(r.attempts[0].error, 'skipped: tools required');
  assert.equal('costUsd' in r.attempts[0], false);
  assert.equal(state.externalCalls.length, 0);
  close(r.costUsd, 0.3);
});

test('attachReportedCost / reportedCost keep only a finite, non-negative reported cost', () => {
  const { attachReportedCost, reportedCost } = agent;
  assert.equal(reportedCost(attachReportedCost(new Error('x'), 0.12)), 0.12);
  assert.equal(reportedCost(attachReportedCost(new Error('x'), 0)), 0);
  for (const bad of [undefined, NaN, Infinity, -1]) assert.equal(reportedCost(attachReportedCost(new Error('x'), bad)), undefined);
  assert.equal(reportedCost('plain string'), undefined);
  assert.equal(reportedCost(new Error('never tagged')), undefined);
  const wrapped = attachReportedCost('plain string', 0.3);
  assert.ok(wrapped instanceof Error);
  assert.equal(reportedCost(wrapped), 0.3);
});

test('a Claude route that throws after reporting cost: the cost is recorded once and carried to the fallback', async () => {
  reset();
  state.claudeRuns.push([init, said, done(0.2), new Error('stream crashed')]);
  state.external.push({ text: 'ok', costUsd: 0.01 });
  const r = await run();
  assert.equal(r.provider, 'codex');
  assert.equal(r.attempts[0].costUsd, 0.2);
  assert.match(r.attempts[0].error, /stream crashed/);
  close(r.costUsd, 0.21);
});

test('a Claude route that throws before reporting any cost adds none', async () => {
  reset();
  state.claudeRuns.push([init, new Error('spawn failed')]);
  state.external.push({ text: 'ok', costUsd: 0.01 });
  const r = await run();
  assert.equal('costUsd' in r.attempts[0], false);
  close(r.costUsd, 0.01);
});

test('a salvage wrap that throws after reporting cost adds it to the capped attempt', async () => {
  reset();
  state.claudeRuns.push([init, said, failed('error_max_turns', 0.2, [CAP])]);
  state.claudeRuns.push([done(0.05), new Error('wrap crashed')]);
  state.external.push({ text: 'ok', costUsd: 0.01 });
  const r = await run();
  assert.equal(r.provider, 'codex');
  close(r.attempts[0].costUsd, 0.25);
  close(r.costUsd, 0.26);
  assert.ok(state.externalCalls[0].message.includes(NOTE));
});

test('a salvage wrap that throws with no reported cost leaves the capped cost unchanged', async () => {
  reset();
  state.claudeRuns.push([init, said, failed('error_max_turns', 0.2, [CAP])]);
  state.claudeRuns.push([new Error('wrap crashed')]);
  state.external.push({ text: 'ok', costUsd: 0.01 });
  const r = await run();
  close(r.attempts[0].costUsd, 0.2);
  close(r.costUsd, 0.21);
});

test('exhausted routes still throw ProviderRoutesError carrying every thrown cost', async () => {
  reset();
  state.claudeRuns.push([init, said, done(0.2), new Error('stream crashed')]);
  state.external.push(new Error('codex down'));
  await assert.rejects(run(), (err) => {
    assert.ok(err instanceof agent.ProviderRoutesError);
    close(agent.wastedCost(err.attempts), 0.2);
    return true;
  });
});

test('token ledger: a failed Claude route and the fallback that answers sum to the result cost, not more', async () => {
  reset();
  state.claudeRuns.push([init, said, failed('error_during_execution', 0.2)]);
  state.external.push({ text: 'ok', costUsd: 0.01, inputTokens: 10, outputTokens: 5 });
  const r = await run();
  close(r.costUsd, 0.21);
  const rows = state.tokenRows.map((row) => row[5]);
  assert.equal(rows.length, 2);
  close(rows[0], 0.2);
  close(rows[1], 0.01);
  close(rows.reduce((a, b) => a + b, 0), r.costUsd);
});

test('runAgentWithRetry contract: each runAgent call owns its ledger, so a failed earlier run is not added to a later success', async () => {
  reset();
  state.claudeRuns.push([init, said, failed('error_during_execution', 0.2)]);
  state.external.push(new Error('codex down'));
  state.claudeRuns.push([init, done(0.3)]);
  const r = await agent.runAgentWithRetry({ message: 'do the thing' }, 1);
  assert.equal(r.provider, 'claude');
  assert.equal(r.attempts.length, 1);
  close(r.costUsd, 0.3);
});

const TIERS = { enabled: true, high: { provider: 'claude', model: 'opus-x' }, mid: { provider: 'claude', model: 'sonnet-x' }, low: { provider: 'claude', model: 'haiku-x' } };

test('tiers: a trivial message runs on the low model, a planning stage on the high one, and the role routes stay as fallbacks', async () => {
  reset();
  state.tiers = TIERS;
  state.claudeRuns.push([init, done(0.01)]);
  const low = await run({ message: 'hi' });
  assert.equal(state.queryCalls[0].options.model, 'haiku-x');
  assert.equal(low.tier.tier, 'low');
  state.claudeRuns.push([init, done(0.01)]);
  const high = await run({ message: 'hi', stage: 'plan' });
  assert.equal(state.queryCalls[1].options.model, 'opus-x');
  assert.deepEqual(high.tier.reasons, ['stage: plan']);
  // The tier's model fails -> the role's own route is still tried next.
  state.claudeRuns.push([init, failed('error_during_execution', 0)]);
  state.claudeRuns.push([init, done(0.01)]);
  const fell = await run({ message: 'hi' });
  assert.equal(state.queryCalls[3].options.model, 'c1');
  assert.equal(fell.provider, 'claude');
});

test('tiers: off by default, and roles outside the tier list keep their fixed model', async () => {
  reset();
  state.claudeRuns.push([init, done(0.01)]);
  const plain = await run({ message: 'hi' });
  assert.equal(state.queryCalls[0].options.model, 'c1');
  assert.equal(plain.tier, undefined);
  state.tiers = { ...TIERS, roles: ['ops'] };
  state.claudeRuns.push([init, done(0.01)]);
  await run({ message: 'hi', agentId: 'main' });
  assert.equal(state.queryCalls[1].options.model, 'c1');
  state.tiers = { ...TIERS, enabled: false };
  state.claudeRuns.push([init, done(0.01)]);
  await run({ message: 'hi' });
  assert.equal(state.queryCalls[2].options.model, 'c1');
});

test('logged-out Claude is skipped without a call, salvage or spend, and the fallback answers', async () => {
  reset();
  state.loggedIn = false;
  state.external.push({ text: 'ok', costUsd: 0.01 });
  const r = await run();
  assert.equal(r.provider, 'codex');
  assert.equal(state.queryCalls.length, 0); // the failing SDK call (and its salvage re-run) never happens
  assert.match(r.attempts[0].error, /logged out/);
  assert.equal('costUsd' in r.attempts[0], false);
});

test('logged-out Claude with no fallback throws ProviderRoutesError and is not retried', async () => {
  reset([CLAUDE]);
  state.loggedIn = false;
  await assert.rejects(agent.runAgentWithRetry({ message: 'do the thing' }, 2), (err) => err.name === 'ProviderRoutesError' && /logged out/.test(err.attempts[0].error));
  assert.equal(state.queryCalls.length, 0);
});
