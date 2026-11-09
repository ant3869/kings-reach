// Claude login detection: a wiped login must be caught once, cheaply, and never retried into the ground.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeAuthCheck, parseAuthStatus, CLAUDE_LOGGED_OUT, RECHECKS, RECHECK_DELAY_MS } from '../dist/claude-auth.js';
import { classifyError } from '../dist/errors.js';
import { onlyAuthFailures } from '../dist/agent.js';

const OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });
const IN = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' });
const clock = () => { let t = 0; const now = () => t; now.advance = (ms) => { t += ms; }; return now; };
const instant = async () => {}; // the re-check delay, without waiting for it
const script = (...answers) => { let i = 0; const probe = async () => answers[Math.min(i++, answers.length - 1)]; probe.calls = () => i; return probe; };

test('auth status: reads loggedIn, treats anything unreadable as unknown', () => {
  assert.equal(parseAuthStatus(OUT), false);
  assert.equal(parseAuthStatus(IN), true);
  assert.equal(parseAuthStatus(''), null);
  assert.equal(parseAuthStatus('error: unknown command'), null);
  assert.equal(parseAuthStatus('{"loggedIn":"yes"}'), null);
});

test('auth check: logged out is reported with the fix, and an unreadable probe fails open', async () => {
  const out = await createClaudeAuthCheck(async () => OUT, clock(), {}, instant)();
  assert.equal(out.loggedIn, false);
  assert.equal(out.detail, CLAUDE_LOGGED_OUT);
  const unknown = await createClaudeAuthCheck(async () => '', clock(), {}, instant)();
  assert.equal(unknown.loggedIn, true); // never block a working setup because the probe hiccuped
});

test('auth check: environment credentials skip the probe entirely', async () => {
  let probes = 0;
  const check = createClaudeAuthCheck(async () => { probes += 1; return OUT; }, clock(), { ANTHROPIC_API_KEY: 'x' });
  assert.equal((await check()).loggedIn, true);
  assert.equal(probes, 0);
});

test('auth check: concurrent callers share one probe, and the result is cached until its TTL', async () => {
  const now = clock();
  let probes = 0;
  const check = createClaudeAuthCheck(async () => { probes += 1; return IN; }, now, {});
  await Promise.all([check(), check(), check(), check()]); // a council fires several agents at once
  assert.equal(probes, 1);
  now.advance(30_000);
  await check();
  assert.equal(probes, 1);
  now.advance(31_000);
  await check();
  assert.equal(probes, 2);
});

test('auth check: a logged-out answer expires fast so a fresh login is noticed', async () => {
  const now = clock();
  let loggedIn = false;
  const check = createClaudeAuthCheck(async () => (loggedIn ? IN : OUT), now, {}, instant);
  assert.equal((await check()).loggedIn, false);
  loggedIn = true;
  now.advance(11_000);
  assert.equal((await check()).loggedIn, true);
});

test('auth check: one logged-out reading is not believed (a token refresh made five agents read it at once)', async () => {
  const probe = script(OUT, IN);
  const logs = [];
  const out = await createClaudeAuthCheck(probe, clock(), {}, instant, (m, f) => logs.push([m, f]))();
  assert.equal(out.loggedIn, true);
  assert.equal(probe.calls(), 2, 'it looked again, and stopped as soon as it saw the login');
  assert.deepEqual(logs, [['claude auth: a logged-out reading did not repeat', { readings: [false, true] }]], 'the flap is on record');
});

test('auth check: a login that is really gone is still reported, after exactly RECHECKS more readings', async () => {
  const probe = script(OUT);
  const waits = [];
  const logs = [];
  const out = await createClaudeAuthCheck(probe, clock(), {}, async (ms) => { waits.push(ms); }, (m, f) => logs.push([m, f]))();
  assert.deepEqual([out.loggedIn, out.detail], [false, CLAUDE_LOGGED_OUT]);
  assert.equal(probe.calls(), 1 + RECHECKS);
  assert.deepEqual(waits, Array(RECHECKS).fill(RECHECK_DELAY_MS), 'it waits between readings, and a short time');
  assert.ok(RECHECKS * RECHECK_DELAY_MS <= 5000, 'a genuinely logged-out user is not made to wait long');
  assert.deepEqual(logs, [['claude auth: still logged out after re-checking', { readings: [false, false, false] }]]);
});

test('auth check: a re-check that cannot be read fails open, and a logged-in answer is never re-checked', async () => {
  const unreadable = script(OUT, '');
  assert.equal((await createClaudeAuthCheck(unreadable, clock(), {}, instant)()).loggedIn, true);
  const fine = script(IN);
  await createClaudeAuthCheck(fine, clock(), {}, instant)();
  assert.equal(fine.calls(), 1, 'the normal case costs exactly one probe');
});

test('auth check: five agents asking during a flap share one re-check sequence', async () => {
  const probe = script(OUT, IN);
  const check = createClaudeAuthCheck(probe, clock(), {}, instant);
  const answers = await Promise.all([check(), check(), check(), check(), check()]);
  assert.deepEqual(answers.map((a) => a.loggedIn), [true, true, true, true, true]);
  assert.equal(probe.calls(), 2);
});

test('errors: "Not logged in" is an auth failure, so it is not retried with backoff', () => {
  const real = 'Error: Claude Code returned an error result: Not logged in · Please run /login';
  assert.equal(classifyError(real).category, 'auth');
  assert.equal(classifyError(real).recovery.shouldRetry, false);
  assert.equal(classifyError(CLAUDE_LOGGED_OUT).category, 'auth');
  assert.equal(classifyError('fetch failed').category, 'network'); // unrelated classes are untouched
});

test('retry gate: only stop retrying when every route that ran failed on credentials', () => {
  const auth = { provider: 'claude', model: 'm', error: CLAUDE_LOGGED_OUT };
  const skipped = { provider: 'chatgpt', model: 'm', error: 'skipped: tools required' };
  const flaky = { provider: 'codex', model: 'm', error: 'Error: fetch failed' };
  assert.equal(onlyAuthFailures([auth, skipped]), true);
  assert.equal(onlyAuthFailures([auth, flaky]), false); // codex might just be having a moment: retry is still worth it
  assert.equal(onlyAuthFailures([skipped]), false);
  assert.equal(onlyAuthFailures([]), false);
});
