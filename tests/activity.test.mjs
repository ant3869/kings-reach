// Live activity narration: tool calls -> human sentences, secret redaction, failed-attempt handoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_ROOT } from '../dist/config.js';
import { codexActivity, describeTool, redact, shortPath, TurnCounter, WorkLog } from '../dist/activity.js';
import { join } from 'node:path';

test('describeTool turns raw tool calls into short sentences', () => {
  const read = describeTool('Read', { file_path: join(PROJECT_ROOT, 'src', 'agent.ts') });
  assert.equal(read.text, 'Reading src/agent.ts');
  assert.equal(read.edit, undefined);
  const edit = describeTool('Edit', { file_path: join(PROJECT_ROOT, 'src', 'agent.ts'), old_string: 'SECRET BODY', new_string: 'x' });
  assert.equal(edit.text, 'Editing src/agent.ts');
  assert.equal(edit.edit, true);
  assert.ok(!JSON.stringify(edit).includes('SECRET BODY'), 'file contents must never travel with the activity line');
  assert.equal(describeTool('WebFetch', { url: 'https://playwright.dev/docs/cli?x=1#top' }).text, 'Fetching playwright.dev/docs/cli');
  assert.equal(describeTool('Grep', { pattern: 'attempts' }).text, 'Searching the code for "attempts"');
  assert.equal(describeTool('mcp__x__lookup', {}).text, 'Using lookup');
  assert.equal(describeTool('Weird', null).text, 'Using Weird');
});

test('secrets are redacted from anything that reaches the browser', () => {
  const key = 'sk-ant-api03-' + 'A'.repeat(40);
  const out = describeTool('Bash', { command: `curl -H "Authorization: Bearer ${'b'.repeat(30)}" https://x && echo ANTHROPIC_API_KEY=${key}` });
  assert.ok(!out.text.includes(key) && !out.text.includes('b'.repeat(30)), out.text);
  assert.ok(out.text.includes('<redacted>'));
  assert.equal(redact('token 1234567890:' + 'Z'.repeat(35)), 'token <redacted>');
  assert.equal(redact('plain text'), 'plain text');
});

test('long commands and paths are clipped', () => {
  assert.ok(describeTool('Bash', { command: 'x'.repeat(500) }).text.length < 110);
  assert.ok(shortPath('C:\\somewhere\\else\\' + 'd\\'.repeat(60) + 'file.ts').length <= 57);
});

test('codex events map to activity; unknown shapes are ignored, not guessed', () => {
  const started = codexActivity({ type: 'item.started', item: { type: 'command_execution', command: 'npm test' } });
  assert.equal(started.text, 'Running: npm test');
  assert.equal(codexActivity({ type: 'item.completed', item: { type: 'command_execution', command: 'npm test' } }), null);
  const edited = codexActivity({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: join(PROJECT_ROOT, 'a.ts') }, { path: 'b.ts' }] } });
  assert.equal(edited.text, 'Edited a.ts (+1 more)');
  assert.equal(edited.edit, true);
  assert.equal(codexActivity({ type: 'turn.completed' }), null);
  assert.equal(codexActivity({ type: 'item.started', item: { type: 'reasoning' } }), null);
});

test('WorkLog hands a dead attempt\'s work to the next route, labelled unverified', () => {
  const log = new WorkLog();
  assert.equal(log.handoff('claude'), '', 'nothing done means nothing to hand over');
  log.addActivity(describeTool('Read', { file_path: join(PROJECT_ROOT, 'package.json') }));
  log.addActivity(describeTool('Read', { file_path: join(PROJECT_ROOT, 'package.json') }));
  log.addActivity(describeTool('Edit', { file_path: join(PROJECT_ROOT, 'src', 'a.ts') }));
  log.addText('Found that the package pins @playwright/cli 0.1.23. Token ghp_' + 'q'.repeat(30));
  const h = log.handoff('claude');
  assert.match(h, /UNVERIFIED/);
  assert.equal(h.split('Reading package.json').length - 1, 1, 'duplicate reads collapse');
  assert.match(h, /pins @playwright\/cli 0\.1\.23/);
  assert.ok(!h.includes('ghp_' + 'q'.repeat(30)), 'a secret in a failed attempt\'s notes must not be forwarded');
  assert.ok(log.edited.has('src/a.ts'));
});

// The Agent SDK streams one `assistant` event per content block, all sharing a message id. A real Ops debate call
// (cap 12) produced 18 such events for 6 messages and the page said "turn 18/12".
test('TurnCounter counts model turns, not content blocks', () => {
  const counter = new TurnCounter();
  const started = [];
  for (let msg = 1; msg <= 6; msg++) {
    for (const _block of ['thinking', 'text', 'tool_use']) started.push(counter.see({ message: { id: 'msg_' + msg } }));
  }
  assert.equal(counter.n, 6);
  assert.equal(started.filter(Boolean).length, 6, 'exactly one event per message starts a turn');
  assert.equal(started.length, 18);
  assert.ok(counter.n <= 12, 'never exceeds the cap the SDK enforces');
});

test('TurnCounter falls back to counting events when there is no message id', () => {
  const counter = new TurnCounter();
  counter.see({}); counter.see(undefined); counter.see({ message: {} }); counter.see({ message: { id: '' } });
  assert.equal(counter.n, 4);
});

test('WorkLog is bounded', () => {
  const log = new WorkLog();
  for (let i = 0; i < 100; i++) { log.addText('note ' + i + ' ' + 'x'.repeat(2000)); log.addActivity(describeTool('Read', { file_path: `f${i}.ts` })); }
  assert.ok(log.handoff('claude').length < 9000);
});
