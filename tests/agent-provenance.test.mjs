// tests/agent-provenance.test.mjs
// Bounded provenance patch: capped-Claude handoff must survive a salvage failure and flow through ProviderRoutesError.
// Step 1 contract: salvage returning null leaves result intact so runAgent captures costUsd + handoff before fallback.
// Step 2 contract: ProviderRoutesError carries the accumulated handoff; the voice bridge serialises it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('ProviderRoutesError carries the final accumulated handoff when all routes fail', async () => {
  const { ProviderRoutesError } = await import('../dist/agent.js');
  const handoff = 'Earlier research: found X (unverified), Y confirmed';
  const attempts = [
    { provider: 'claude', model: 'claude-sonnet-4-6', error: 'turn cap', costUsd: 0.05 },
    { provider: 'codex', model: 'codex-mini', error: 'network timeout', costUsd: 0.01 },
  ];
  const err = new ProviderRoutesError('main', attempts, handoff);
  assert.equal(err.handoff, handoff);
  assert.equal(err.agentId, 'main');
  assert.equal(err.attempts.length, 2);
  assert.ok(err instanceof Error);
});

test('ProviderRoutesError.handoff is undefined when no route left any notes', async () => {
  const { ProviderRoutesError } = await import('../dist/agent.js');
  const err = new ProviderRoutesError('research', [{ provider: 'codex', model: 'codex-mini', error: 'failed' }]);
  assert.equal(err.handoff, undefined);
});

test('wastedCost sums costUsd from all failed attempts including the capped Claude run', async () => {
  const { wastedCost } = await import('../dist/agent.js');
  // The capped Claude run costs money even when salvage fails; it must be counted in the next route's ledger.
  const attempts = [
    { provider: 'claude', model: 'claude-sonnet-4-6', error: 'max turns', costUsd: 0.08 },
    { provider: 'gemini', model: 'gemini-2.0-flash', error: 'api error', costUsd: 0.00 },
    { provider: 'codex', model: 'codex-mini', error: 'timeout' }, // no cost recorded
  ];
  assert.ok(Math.abs(wastedCost(attempts) - 0.08) < 0.0001);
});

test('bridge failed reply includes handoff when ProviderRoutesError carries one', async () => {
  // Mirrors the ask() catch block: { ok, text, attempts, costUsd, handoff: err.handoff ?? null }.
  const { ProviderRoutesError, wastedCost } = await import('../dist/agent.js');
  const attempts = [{ provider: 'claude', model: 'claude-sonnet-4-6', error: 'turn cap', costUsd: 0.03 }];
  const err = new ProviderRoutesError('main', attempts, 'found: DB schema has no index on user_id');
  const reply = {
    ok: false,
    text: `all provider routes failed for ${err.agentId}`,
    attempts: err.attempts,
    costUsd: wastedCost(err.attempts),
    handoff: err.handoff ?? null,
  };
  assert.equal(reply.ok, false);
  assert.equal(reply.handoff, 'found: DB schema has no index on user_id');
  assert.ok(Math.abs(reply.costUsd - 0.03) < 0.0001);
});

test('bridge failed reply handoff is null when no handoff accumulated', async () => {
  const { ProviderRoutesError, wastedCost } = await import('../dist/agent.js');
  const err = new ProviderRoutesError('ops', [], undefined);
  const reply = { ok: false, handoff: err.handoff ?? null, costUsd: wastedCost(err.attempts) };
  assert.equal(reply.handoff, null);
  assert.equal(reply.costUsd, 0);
});
