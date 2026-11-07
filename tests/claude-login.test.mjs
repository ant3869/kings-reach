// The "Sign in to Claude" flow: one browser flow at a time, URL fallback captured, status cache dropped when it ends.
// Child processes are fakes: nothing here opens a browser or touches ~/.claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createClaudeLogin } from '../dist/claude-login.js';
import { signInPrompt, ProviderRoutesError } from '../dist/agent.js';
import { CLAUDE_LOGGED_OUT } from '../dist/claude-auth.js';

function fakeLogin() {
  const spawned = [];
  let finished = 0;
  const spawner = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => proc.emit('exit', null);
    spawned.push(proc);
    return proc;
  };
  const login = createClaudeLogin(spawner, () => { finished += 1; });
  return { login, spawned, finished: () => finished };
}

test('login: starts one flow; clicking again while it is open does not spawn a second browser window', () => {
  const { login, spawned } = fakeLogin();
  assert.equal(login.state().phase, 'idle');
  assert.equal(login.start().phase, 'waiting');
  assert.equal(login.start().phase, 'waiting');
  assert.equal(spawned.length, 1);
});

test('login: captures the sign-in URL from the CLI output as a fallback link', () => {
  const { login, spawned } = fakeLogin();
  login.start();
  spawned[0].stdout.emit('data', Buffer.from('Opening browser to sign in…\nIf it does not open, visit: https://claude.ai/oauth/authorize?code=true&x=1\n'));
  assert.equal(login.state().url, 'https://claude.ai/oauth/authorize?code=true&x=1');
});

test('login: a clean exit means done and the cached login status is dropped', () => {
  const { login, spawned, finished } = fakeLogin();
  login.start();
  spawned[0].emit('exit', 0);
  assert.equal(login.state().phase, 'done');
  assert.equal(finished(), 1);
  assert.equal(login.start().phase, 'waiting'); // a new attempt is allowed afterwards
  assert.equal(spawned.length, 2);
});

test('login: a failed or killed attempt reports why, and error + exit only count once', () => {
  const { login, spawned, finished } = fakeLogin();
  login.start();
  spawned[0].emit('error', new Error('spawn claude ENOENT'));
  spawned[0].emit('exit', 1);
  assert.equal(login.state().phase, 'failed');
  assert.match(login.state().detail, /ENOENT/);
  assert.equal(finished(), 1);
  login.start();
  spawned[1].emit('exit', 1);
  assert.match(login.state().detail, /exit 1/);
});

test('login: a spawn that throws is reported, not crashed on', () => {
  const login = createClaudeLogin(() => { throw new Error('boom'); }, () => {});
  assert.equal(login.start().phase, 'failed');
  assert.match(login.state().detail, /boom/);
});

test('chat surfaces: only an all-credentials failure becomes the sign-in prompt', () => {
  const auth = new ProviderRoutesError('main', [{ provider: 'claude', model: 'm', error: CLAUDE_LOGGED_OUT }]);
  assert.match(signInPrompt(auth), /Sign in to Claude/);
  const mixed = new ProviderRoutesError('main', [
    { provider: 'claude', model: 'm', error: CLAUDE_LOGGED_OUT },
    { provider: 'codex', model: 'x', error: 'Error: fetch failed' },
  ]);
  assert.equal(signInPrompt(mixed), null);
  assert.equal(signInPrompt(new Error('anything else')), null);
});
