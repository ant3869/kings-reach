// tests/run-cancel.test.mjs
// A cancelled run must STOP: it reaches the Claude SDK (abortController), is never retried, and never falls through to the next
// provider. Executes the real runAgent / runAgentWithRetry loops with the SDK, routing and the external runner faked at their edges.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (f) => pathToFileURL(resolve('dist', f)).href;
const state = { routes: [], queryCalls: [], externalCalls: [], onExternal: null, outcomes: [] };

const abortError = () => Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' });
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    // Like the real SDK: runs until its abortController fires, then throws an AbortError.
    query: (args) => {
      state.queryCalls.push(args);
      const signal = args.options.abortController?.signal;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 's1' };
        await new Promise((_, reject) => {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
      })();
    },
  },
});
mock.module(dist('claude-auth.js'), { namedExports: { claudeAuth: async () => ({ loggedIn: true, detail: '' }), CLAUDE_LOGGED_OUT: 'logged out' } });
mock.module(dist('provider-config.js'), {
  namedExports: {
    routesFor: () => state.routes, loadTierConfig: () => null, providerHasTools: () => true,
    recordProviderOutcome: (provider, model, ok) => { state.outcomes.push({ provider, model, ok }); },
  },
});
mock.module(dist('provider-runner.js'), {
  namedExports: { runExternalProvider: async (target, opts) => { state.externalCalls.push(target); return state.onExternal(target, opts); } },
});
mock.module(dist('skills.js'), { namedExports: { skillContext: async () => '', agentEnv: () => ({}), claudeSkillOptions: () => ({}) } });
mock.module(dist('db.js'), { namedExports: { logTokenUsage: () => {} } });

const agent = await import(dist('agent.js'));
const control = await import(dist('run-control.js'));

const CLAUDE = { provider: 'claude', model: 'c1' };
const CODEX = { provider: 'codex', model: 'x1' };
const OTHER = { provider: 'gemini', model: 'g1' };
const reset = (routes) => Object.assign(state, { routes, queryCalls: [], externalCalls: [], onExternal: async () => ({ text: 'ok' }), outcomes: [] });
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };

test('cancelling by chat stops a running Claude run and does NOT fall through to the next provider', async () => {
  reset([CLAUDE, CODEX]);
  const p = agent.runAgent({ message: 'work', chatId: 'chat-a', agentId: 'main' });
  const settled = p.then(() => 'resolved', (e) => e);
  await until(() => state.queryCalls.length === 1);
  assert.ok(state.queryCalls[0].options.abortController instanceof AbortController, 'the SDK is given an abortController');
  assert.equal(typeof state.queryCalls[0].options.spawnClaudeCodeProcess, 'function', 'and a spawner that kills the whole process tree');
  assert.deepEqual(control.activeRuns().map((r) => [r.chatId, r.agentId]), [['chat-a', 'main']]);
  assert.equal(control.cancelRuns({ chatId: 'chat-a' }), 1);
  const err = await settled;
  assert.ok(control.isCancelled(err), `expected RunCancelled, got ${err}`);
  assert.equal(state.externalCalls.length, 0, 'stop must not start the fallback provider');
  assert.deepEqual(state.outcomes, [], 'a cancel is not a provider failure and must not mark one unhealthy');
  assert.deepEqual(control.activeRuns(), [], 'the run is unregistered afterwards');
});

test('a run for a different chat is untouched by a chat-scoped cancel', async () => {
  reset([CLAUDE]);
  const p = agent.runAgent({ message: 'work', chatId: 'chat-b' });
  const settled = p.then(() => 'resolved', (e) => e);
  await until(() => state.queryCalls.length === 1);
  assert.equal(control.cancelRuns({ chatId: 'someone-else' }), 0);
  assert.equal(control.cancelRuns({}), 0, 'no criteria cancels nothing');
  assert.equal(control.activeRuns().length, 1);
  assert.equal(control.cancelRuns({ all: true }), 1);
  assert.ok(control.isCancelled(await settled));
});

test('a caller-supplied signal stops the run; an already-aborted one never starts it', async () => {
  reset([CLAUDE, CODEX]);
  const ac = new AbortController();
  const settled = agent.runAgent({ message: 'work', signal: ac.signal }).then(() => 'resolved', (e) => e);
  await until(() => state.queryCalls.length === 1);
  ac.abort();
  assert.ok(control.isCancelled(await settled));
  assert.equal(state.externalCalls.length, 0);
  const before = state.queryCalls.length;
  const gone = new AbortController(); gone.abort();
  await assert.rejects(agent.runAgent({ message: 'work', signal: gone.signal }), (e) => control.isCancelled(e));
  assert.equal(state.queryCalls.length, before, 'nothing was started');
});

test('cancel that lands while a provider is failing ends the loop instead of trying the next route', async () => {
  reset([CODEX, OTHER]);
  state.onExternal = async () => { control.cancelRuns({ all: true }); throw new Error('boom'); };
  await assert.rejects(agent.runAgent({ message: 'work' }), (e) => control.isCancelled(e));
  assert.deepEqual(state.externalCalls, [CODEX], 'the second route is never asked');
  assert.deepEqual(state.outcomes, []);
});

test('runAgentWithRetry never retries a cancelled run, and a cancel during the retry backoff ends it at once', async () => {
  reset([CODEX]);
  state.onExternal = async () => { throw new Error('429 rate limit'); }; // retryable; the backoff is long (30s)
  const t0 = Date.now();
  const settled = agent.runAgentWithRetry({ message: 'work', chatId: 'chat-c' }).then(() => 'resolved', (e) => e);
  await until(() => state.externalCalls.length === 1);
  await new Promise((r) => setTimeout(r, 100)); // now inside the backoff sleep
  assert.equal(control.activeRuns().length, 1, 'the wrapper keeps the run registered across the backoff');
  assert.equal(control.cancelRuns({ chatId: 'chat-c' }), 1);
  assert.ok(control.isCancelled(await settled));
  assert.ok(Date.now() - t0 < 5000, 'cancel did not wait out the backoff');
  assert.equal(state.externalCalls.length, 1, 'no second attempt');
  assert.deepEqual(control.activeRuns(), []);
});

test('an ordinary failure still falls through to the next provider (cancel handling must not break fallback)', async () => {
  reset([CODEX, OTHER]);
  state.onExternal = async (target) => { if (target === CODEX) throw new Error('boom'); return { text: 'second route answered' }; };
  const r = await agent.runAgent({ message: 'work' });
  assert.equal(r.text, 'second route answered');
  assert.deepEqual(state.externalCalls, [CODEX, OTHER]);
});
