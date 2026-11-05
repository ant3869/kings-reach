// The "Build will execute plan X" line must be re-renderable on its own (the page refreshes it after a summit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderPlanLine, renderWarRoom } from '../dist/warroom-html.js';

const plan = (run) => ({ run, objective: 'Wrap preflight and gate in the progress heartbeat', question: 'q', confidence: 0.9, steps: 5, owners: ['main'] });

test('the plan line names the plan it was given and links to its review', () => {
  const html = renderPlanLine(plan('9a7edfa0'));
  assert.match(html, /Build will execute plan <b>9a7edfa0<\/b> \(5 steps\)/);
  assert.match(html, /\/history#run=9a7edfa0/);
});

test('with no plan it says so instead of naming a stale one', () => {
  assert.match(renderPlanLine(null), /No plan on file/);
});

test('the page wraps the plan line in a container the client can replace', () => {
  const page = renderWarRoom(plan('cfac8fa0'));
  assert.match(page, /<div id="planbox"><div class="planline">Build will execute plan <b>cfac8fa0<\/b>/);
});

test('plan text from a verdict is escaped, never injected as markup', () => {
  const evil = { ...plan('9a7edfa0'), objective: '<img src=x onerror=alert(1)>' };
  const html = renderPlanLine(evil);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});
