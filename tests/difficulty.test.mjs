// Difficulty tiers: the classifier, the tier->routes rule, and the strict settings validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTier, assessDifficulty, tierApplies, userText } from '../dist/difficulty.js';
import { cleanTierConfig } from '../dist/provider-config.js';

const HARD = 'Design a migration strategy for our database that avoids a race condition under concurrent writes, compare the trade-offs of two approaches, and analyze the performance impact. Then investigate why the audit log is slow, diagnose the root cause and fix the failing tests in src/db.ts';

test('classifier: greetings and simple chores are low, concrete work is mid, hard analysis is high', () => {
  assert.equal(assessDifficulty('hi').tier, 'low');
  assert.equal(assessDifficulty('thanks!').tier, 'low');
  assert.equal(assessDifficulty('Summarize this paragraph for me').tier, 'low');
  assert.equal(assessDifficulty('Add a unit test for the parseDate function in src/utils.ts').tier, 'mid');
  const hard = assessDifficulty(HARD);
  assert.equal(hard.tier, 'high');
  assert.ok(hard.reasons.length >= 3, 'every decision explains itself');
});

test('classifier: the memory block the chat surfaces prepend does not inflate the score', () => {
  const memory = `[Memory context]\n${'we discussed the architecture and security design at length. '.repeat(40)}\n\n[user]\nhi`;
  assert.equal(userText(memory), 'hi');
  assert.equal(assessDifficulty(memory).tier, 'low');
});

test('classifier: an explicit request beats a stage, and a known stage beats the text', () => {
  assert.equal(assessDifficulty('hi', { difficulty: 'high' }).tier, 'high');
  assert.equal(assessDifficulty(HARD, { stage: 'record' }).tier, 'low');
  assert.equal(assessDifficulty('hi', { stage: 'verdict' }).tier, 'high');
  assert.equal(assessDifficulty('hi', { stage: 'debate' }).tier, 'mid');
  assert.equal(assessDifficulty('hi', { stage: 'not-a-stage' }).tier, 'low'); // unknown stage: fall back to the text
});

const CFG = { enabled: true, high: { provider: 'claude', model: 'opus' }, mid: { provider: 'claude', model: 'sonnet' }, low: { provider: 'claude', model: 'haiku' } };

test('applyTier: the tier model goes first, the role routes follow, and the pick is never duplicated', () => {
  const routes = [{ provider: 'claude', model: 'sonnet' }, { provider: 'codex', model: 'default' }];
  assert.deepEqual(applyTier(routes, 'high', CFG).map((r) => r.model), ['opus', 'sonnet', 'default']);
  assert.deepEqual(applyTier(routes, 'mid', CFG).map((r) => r.model), ['sonnet', 'default']);
  assert.equal(routes.length, 2); // input untouched
});

test('tierApplies: needs enabled, and respects the role list when there is one', () => {
  assert.equal(tierApplies(null, 'main'), false);
  assert.equal(tierApplies({ ...CFG, enabled: false }, 'main'), false);
  assert.equal(tierApplies(CFG, 'anything'), true);
  assert.equal(tierApplies({ ...CFG, roles: ['ops'] }, 'main'), false);
  assert.equal(tierApplies({ ...CFG, roles: ['ops'] }, 'ops'), true);
});

test('settings: a half-filled or invalid tier setup is dropped, never half-applied', () => {
  assert.equal(cleanTierConfig(undefined), undefined);
  assert.equal(cleanTierConfig({ enabled: true, high: CFG.high, mid: CFG.mid }), undefined); // no low model
  assert.equal(cleanTierConfig({ enabled: true, high: CFG.high, mid: CFG.mid, low: { provider: 'nope', model: 'x' } }), undefined);
  const ok = cleanTierConfig({ ...CFG, roles: ['main', 'Bad Role!', 5], extra: 'ignored', high: { ...CFG.high, junk: 1 } });
  assert.deepEqual(ok, { enabled: true, roles: ['main'], high: CFG.high, mid: CFG.mid, low: CFG.low });
  assert.equal(cleanTierConfig({ ...CFG, enabled: 'yes' }).enabled, false); // only a real true enables it
});
