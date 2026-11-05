// tests/warroom-render.test.mjs
// Proves the salvage label appears only when attempts[].salvaged is true,
// matching the logic in history-app.js agentsTable() and warroom-app.js provider handler.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors history-app.js agentsTable(): generates the salvage span for one agent row.
// If this logic changes in the browser file, update here too.
function agentSalvageLabel(agentData) {
  const wasSalvaged = (agentData.attempts || []).some((x) => x.salvaged);
  return wasSalvaged ? ' <span class="tag" title="a turn-capped attempt was recovered and answered before fallback">salvaged</span>' : '';
}

// Mirrors warroom-app.js provider handler: does this provider message set pendingSalvaged?
function isSalvagedProviderMsg(msg) {
  return (msg.attempts || []).some((a) => a.salvaged);
}

test('history agent row: salvage label present when attempts contains salvaged:true', () => {
  const agent = { attempts: [{ provider: 'claude', model: 'claude-sonnet-4-6', salvaged: true }] };
  const html = agentSalvageLabel(agent);
  assert.ok(html.includes('salvaged'), `expected label, got: ${html}`);
  assert.ok(html.includes('<span'), 'expected a span element');
});

test('history agent row: no salvage label for ordinary successful event', () => {
  const agent = { attempts: [{ provider: 'claude', model: 'claude-sonnet-4-6' }] };
  assert.equal(agentSalvageLabel(agent), '');
});

test('history agent row: no salvage label when all attempts have errors but none were salvaged', () => {
  const agent = {
    attempts: [{ provider: 'claude', model: 'claude-sonnet-4-6', error: 'timeout' }],
    failures: [{ provider: 'claude', model: 'claude-sonnet-4-6', error: 'timeout' }],
  };
  assert.equal(agentSalvageLabel(agent), '');
});

test('history agent row: salvage label present even when mixed with prior errors', () => {
  const agent = {
    attempts: [
      { provider: 'codex', model: 'codex-mini', error: 'failed' },
      { provider: 'claude', model: 'claude-sonnet-4-6', salvaged: true },
    ],
  };
  assert.ok(agentSalvageLabel(agent).includes('salvaged'));
});

test('history agent row: no label when attempts array is absent', () => {
  assert.equal(agentSalvageLabel({}), '');
});

test('warroom provider msg: flagged when attempts contains salvaged:true', () => {
  const msg = { type: 'provider', agent_id: 'research', attempts: [{ provider: 'claude', salvaged: true }] };
  assert.ok(isSalvagedProviderMsg(msg));
});

test('warroom provider msg: not flagged for ordinary reply', () => {
  const msg = { type: 'provider', agent_id: 'main', attempts: [{ provider: 'claude', model: 'claude-sonnet-4-6' }] };
  assert.ok(!isSalvagedProviderMsg(msg));
});

test('warroom provider msg: not flagged when attempts is absent', () => {
  const msg = { type: 'provider', agent_id: 'main' };
  assert.ok(!isSalvagedProviderMsg(msg));
});
