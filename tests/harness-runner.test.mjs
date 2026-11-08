// Harness providers (OpenClaw / Hermes / Code Puppy): output parsing, how the prompt and model are handed over,
// failure reporting, and the cached health probe. Fixtures are the real shapes the CLIs printed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildInvocation, harnessHealth, hermesModelArgs, isHarness, launch, afterPromptEcho, parseCodePuppy, parseHermes, parseOpenClaw,
  resetHarnessHealth, runHarness, stripTerminal,
} from '../dist/harness-runner.js';
import { invalidRoutes, buildModelChoices } from '../dist/provider-models.js';
import { PROVIDER_IDS, providerHasTools } from '../dist/provider-config.js';

const OPENCLAW_OK = JSON.stringify({
  runId: 'r1', status: 'ok', summary: 'completed',
  result: { payloads: [{ text: 'PONG', mediaUrl: null }], meta: { durationMs: 4054, finalAssistantVisibleText: 'PONG',
    agentMeta: { sessionId: 's-1', provider: 'openai', model: 'gpt-5.6-terra', usage: { input: 629, output: 6, cacheRead: 37632 } } } },
}, null, 2);
const PUPPY_OUT = '\u001b]11;#050505\u0007\u001b]10;#e6e6e6\u0007Computer Use is off by default. Run `/computer-use enable` to opt in.\nExecuting prompt: say pong\nCurrent version: 0.0.945\nLatest version: 0.0.967\nA new version of code puppy is available: 0.0.967\nPlease consider updating!\n\u2b06 Update available: 0.0.945 -> 0.0.967\n\nPONG\n';

test('ids: the three harnesses are real providers with tools', () => {
  for (const id of ['openclaw', 'hermes', 'codepuppy']) {
    assert.ok(isHarness(id) && PROVIDER_IDS.includes(id));
    assert.equal(providerHasTools(id), true);
  }
  assert.equal(isHarness('codex'), false);
});

test('openclaw: reads the visible answer, session, model and tokens; ignores noise around the JSON', () => {
  const r = parseOpenClaw(`(node) DeprecationWarning: something\n${OPENCLAW_OK}\n`);
  assert.deepEqual(r, { text: 'PONG', sessionId: 's-1', model: 'gpt-5.6-terra', inputTokens: 629, outputTokens: 6 });
});

test('openclaw: a failed run, a missing answer and non-JSON all throw with a reason', () => {
  assert.throws(() => parseOpenClaw(JSON.stringify({ status: 'error', error: { message: 'gateway closed' } })), /gateway closed/);
  assert.throws(() => parseOpenClaw(JSON.stringify({ status: 'ok', result: { payloads: [] } })), /without an answer/);
  assert.throws(() => parseOpenClaw('boom'), /no JSON/);
  // falls back to payload text when the visible-text field is absent
  assert.equal(parseOpenClaw(JSON.stringify({ status: 'ok', result: { payloads: [{ text: 'a' }, { text: 'b' }] } })).text, 'a\n\nb');
});

test('hermes: stdout is the answer, stderr carries the session id, missing credentials are an error', () => {
  assert.deepEqual(parseHermes('PONG\n', 'session_id: local-abc123\n'), { text: 'PONG', sessionId: 'local-abc123' });
  assert.throws(() => parseHermes("No usable credentials found for provider 'meta-ai'.", ''), /auth failed/);
  assert.throws(() => parseHermes('  \n', ''), /without an answer/);
});

test('code-puppy: banner, version nagging and terminal codes are stripped, the answer stays', () => {
  assert.equal(parseCodePuppy(PUPPY_OUT).text, 'PONG');
  assert.equal(parseCodePuppy('Line one\n\nLine two\nCurrent version: 1').text, 'Line one\n\nLine two');
  assert.throws(() => parseCodePuppy('Executing prompt: x\nCurrent version: 1'), /without an answer/);
  assert.equal(stripTerminal('\u001b[31mred\u001b[0m'), 'red');
});

test('code-puppy: the echoed prompt (even word-wrapped) is cut away; an answer that quotes the prompt is kept whole', () => {
  const sent = '[Task]\nReply with exactly the single word PONG and nothing else.';
  const wrapped = 'Executing prompt: [Task]\nReply with exactly the single word PONG and nothing\nelse.\n\nPONG\n';
  assert.equal(parseCodePuppy(wrapped, sent).text, 'PONG');
  const quoting = `Executing prompt: ${sent}\n\nYou asked: Reply with exactly the single word PONG and nothing else. Done.`;
  assert.match(parseCodePuppy(quoting, sent).text, /^You asked: Reply with exactly/);
  assert.equal(afterPromptEcho('no banner here PONG', sent), 'no banner here PONG'); // no marker: untouched
  assert.equal(parseCodePuppy('Executing prompt: x\nanswer', 'something else entirely').text, 'answer');
});

test('hermes model: provider:model splits into both flags, default adds none', () => {
  assert.deepEqual(hermesModelArgs('default'), []);
  assert.deepEqual(hermesModelArgs('openrouter:meta-llama/llama-4-maverick'), ['--provider', 'openrouter', '-m', 'meta-llama/llama-4-maverick']);
  assert.deepEqual(hermesModelArgs('plain-model'), ['-m', 'plain-model']);
});

test('invocation: the prompt travels by file (OpenClaw), stdin (Hermes) or argument (Code Puppy, short only)', () => {
  const oc = buildInvocation('openclaw', { prompt: 'hi', model: 'openai/x' }, 'C:\\t\\p.txt');
  assert.deepEqual(oc.args, ['agent', '--json', '--agent', 'main', '--message-file', 'C:\\t\\p.txt', '--model', 'openai/x']);
  assert.equal(buildInvocation('openclaw', { prompt: 'hi', model: 'default' }, 'f').args.includes('--model'), false);
  const hm = buildInvocation('hermes', { prompt: 'say "hi" $(x)', model: 'default' }, 'f');
  assert.equal(hm.input, 'say "hi" $(x)'); // verbatim on stdin: nothing is shell-interpreted
  assert.ok(hm.args.includes('--oneshot') && hm.args.includes('-Q') && !hm.args.includes('say "hi" $(x)'));
  assert.deepEqual(buildInvocation('codepuppy', { prompt: 'short', model: 'gpt-5' }, 'f').args, ['-p', 'short', '-m', 'gpt-5']);
  const long = buildInvocation('codepuppy', { prompt: 'x'.repeat(7000), model: 'default' }, 'C:\\t\\p.txt').args[1];
  assert.match(long, /C:\\t\\p\.txt/);
  assert.ok(long.length < 300, 'a long prompt must not ride on the command line');
  // newlines are fine inside one quoted argument, so a normal multi-line prompt stays direct
  assert.deepEqual(buildInvocation('codepuppy', { prompt: '[Task]\ntwo\nlines', model: 'default' }, 'F.txt').args, ['-p', '[Task]\ntwo\nlines']);
});

test('launch: on Windows OpenClaw goes through its .cmd shim (the bare name is an unrelated installer); others run directly', () => {
  assert.deepEqual(launch('openclaw', ['agent', '--json'], 'win32', 'cmd.exe'), { exe: 'cmd.exe', args: ['/d', '/s', '/c', 'openclaw.cmd', 'agent', '--json'] });
  assert.deepEqual(launch('openclaw', ['agent'], 'linux'), { exe: 'openclaw', args: ['agent'] });
  assert.deepEqual(launch('hermes', ['chat'], 'win32', 'cmd.exe'), { exe: 'hermes', args: ['chat'] });
  assert.deepEqual(launch('codepuppy', ['-p', 'x'], 'win32', 'cmd.exe'), { exe: 'code-puppy', args: ['-p', 'x'] });
});

test('model ids: shell metacharacters are refused before anything is spawned', () => {
  for (const bad of ['gpt-5 & calc', 'x|y', 'a;b', '$(whoami)', 'a"b', 'a\nb', 'x'.repeat(130)]) {
    for (const id of ['openclaw', 'hermes', 'codepuppy']) assert.throws(() => buildInvocation(id, { prompt: 'p', model: bad }, 'f'), /unsafe model id/);
  }
  assert.doesNotThrow(() => buildInvocation('hermes', { prompt: 'p', model: 'openrouter:meta-llama/llama-4-maverick' }, 'f'));
  assert.doesNotThrow(() => buildInvocation('openclaw', { prompt: 'p', model: 'openai/gpt-5.6-terra' }, 'f'));
});

test('runHarness: writes then removes the prompt file, passes read-only as a constraint, and parses the reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-h-'));
  let seen;
  const run = async (exe, args, input) => {
    const file = args[args.indexOf('--message-file') + 1];
    seen = { exe, file, written: readFileSync(file, 'utf8'), input };
    return { code: 0, stdout: OPENCLAW_OK, stderr: '' };
  };
  const reply = await runHarness('openclaw', { prompt: 'do it', model: 'default', readOnly: true }, run, dir);
  assert.equal(reply.text, 'PONG');
  assert.match(seen.exe, /openclaw|cmd/i);
  assert.match(seen.written, /read-only task/);
  assert.match(seen.written, /do it$/);
  assert.equal(existsSync(seen.file), false, 'temp prompt must not be left behind');
});

test('runHarness: a nonzero exit reports the tail of the output and still cleans up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-h-'));
  const run = async () => ({ code: 3, stdout: '', stderr: 'line1\nline2\nreal reason here' });
  await assert.rejects(runHarness('hermes', { prompt: 'x', model: 'default' }, run, dir), /hermes exited 3: .*real reason here/);
});

test('health: missing CLIs are reported unavailable with a fix, installed ones with a version, and the answer is cached', async () => {
  resetHarnessHealth();
  let calls = 0;
  const run = async (exe, args) => {
    calls += 1;
    if (process.platform === 'win32' && exe !== 'hermes' && exe !== 'code-puppy') assert.ok(args.includes('openclaw.cmd'), 'openclaw is probed through its shim');
    if (exe === 'hermes') throw new Error('spawn hermes ENOENT');
    if (exe === 'code-puppy') return { code: 1, stdout: '', stderr: '' };
    return { code: 0, stdout: 'OpenClaw 2026.11.1 (4ffdd20)\n', stderr: '' };
  };
  let t = 0;
  const first = await harnessHealth(run, () => t);
  assert.deepEqual(first.map((h) => [h.id, h.available]), [['openclaw', true], ['hermes', false], ['codepuppy', false]]);
  assert.match(first[0].detail, /2026\.11\.1/);
  assert.match(first[1].detail, /not installed/);
  await harnessHealth(run, () => (t = 30_000));
  assert.equal(calls, 3);
  // Stale (61 s): the old answer comes back immediately and a refresh runs behind it.
  assert.deepEqual((await harnessHealth(run, () => (t = 61_000))).map((h) => h.available), [true, false, false]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 6);
  resetHarnessHealth();
});

test('health: a stale answer is served without waiting for a slow probe, and callers during a probe share it', async () => {
  resetHarnessHealth();
  let calls = 0, release;
  const slow = new Promise((resolve) => { release = resolve; });
  let gate = Promise.resolve();
  const run = async () => { calls += 1; await gate; return { code: 0, stdout: 'OpenClaw 1.0.0\n', stderr: '' }; };
  // Cold: three simultaneous first callers run ONE probe (3 harnesses = 3 commands), not three.
  await Promise.all([harnessHealth(run, () => 0), harnessHealth(run, () => 0), harnessHealth(run, () => 0)]);
  assert.equal(calls, 3);
  // Now the refresh is slow. Stale callers must not wait for it, and must not start more than one.
  gate = slow;
  const started = Date.now();
  const answers = await Promise.all([harnessHealth(run, () => 90_000), harnessHealth(run, () => 90_000)]);
  assert.ok(Date.now() - started < 1000, 'stale answer returned without waiting on the slow refresh');
  assert.ok(answers.every((a) => a.length === 3 && a[0].available));
  assert.equal(calls, 6, 'exactly one refresh (3 commands) started for both callers');
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  resetHarnessHealth();
});

test('settings: harness routes are valid choices, and only while the harness is installed', () => {
  const choices = buildModelChoices([], []);
  assert.ok(choices.hermes.some((m) => m.id === 'openrouter:meta-llama/llama-4-maverick'));
  const body = { agents: { ops: [{ provider: 'codepuppy', model: 'default' }, { provider: 'hermes', model: 'default' }] } };
  assert.deepEqual(invalidRoutes(body, choices, { codepuppy: true, hermes: true }), []);
  assert.match(invalidRoutes(body, choices, { codepuppy: true, hermes: false })[0], /hermes.*not available/);
});
