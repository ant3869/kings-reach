// Difficulty tiers: the classifier, the per-provider ladders, `light` runs, and the strict settings validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTiers, assessDifficulty, ladderIndex, tierApplies, userText } from '../dist/difficulty.js';
import { cleanTierConfig } from '../dist/provider-config.js';
import { invalidTiers } from '../dist/provider-models.js';

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

test('light: only quick steps with no sign of needing tools may skip loading MCP servers', () => {
  assert.equal(assessDifficulty('hi').light, true);
  assert.equal(assessDifficulty('Summarize this paragraph for me').light, true);
  assert.equal(assessDifficulty('list my open github issues').tier, 'low');
  assert.equal(assessDifficulty('list my open github issues').light, false); // low, but it clearly needs a tool server
  assert.equal(assessDifficulty('summarize src/db.ts').light, false);
  assert.equal(assessDifficulty('hi', { stage: 'recall' }).light, true);
  assert.equal(assessDifficulty('hi', { stage: 'plan' }).light, false);
  assert.equal(assessDifficulty('hi', { difficulty: 'low' }).light, false); // an explicit request never silently drops tools
  assert.equal(assessDifficulty(HARD).light, false);
});

const LADDER = ['haiku-4', 'sonnet-4-6', 'opus-4-6', 'sonnet-5', 'opus-5-5'];
const CFG = { enabled: true, providers: { claude: LADDER, openai: ['gpt-mini', 'gpt-big'] } };
const names = (routes) => routes.map((r) => `${r.provider}:${r.model}`);

test('level: a difficulty is continuous, from trivial (0) to the hardest (1), and stages have fixed levels', () => {
  assert.equal(assessDifficulty('hi').level, 0);
  assert.equal(assessDifficulty('hi', { stage: 'plan' }).level, 1);
  assert.equal(assessDifficulty('hi', { stage: 'execute' }).level, 0.5);
  assert.equal(assessDifficulty('hi', { difficulty: 'mid' }).level, 0.5);
  const hard = assessDifficulty(HARD), easy = assessDifficulty('Add a unit test for parseDate in src/utils.ts');
  assert.ok(hard.level > easy.level && easy.level > 0 && hard.level <= 1);
  assert.equal(assessDifficulty(HARD).tier, 'high'); // the coarse label still follows the level
});

test('ladderIndex: the level lands proportionally on the rungs, clamped to the ends', () => {
  assert.deepEqual([0, 0.25, 0.5, 0.75, 1].map((l) => ladderIndex(5, l)), [0, 1, 2, 3, 4]);
  assert.equal(ladderIndex(5, 0.4), 2);
  assert.equal(ladderIndex(5, -3), 0);
  assert.equal(ladderIndex(5, 9), 4);
  assert.equal(ladderIndex(1, 0.9), 0);
  assert.deepEqual([0.2, 0.4, 0.6, 0.8].map((l) => ladderIndex(2, l)), [0, 0, 1, 1]); // two rungs is the binary case
});

test('ladders: an in-between task gets an in-between model, not just one of the two ends', () => {
  const role = [{ provider: 'claude', model: 'own-model' }];
  assert.equal(applyTiers(role, 0, CFG)[0].model, 'haiku-4');
  assert.equal(applyTiers(role, 0.25, CFG)[0].model, 'sonnet-4-6');
  assert.equal(applyTiers(role, 0.5, CFG)[0].model, 'opus-4-6');
  assert.equal(applyTiers(role, 0.75, CFG)[0].model, 'sonnet-5');
  assert.equal(applyTiers(role, 1, CFG)[0].model, 'opus-5-5');
  assert.deepEqual(names(applyTiers(role, 1, CFG)), ['claude:opus-5-5', 'claude:own-model']); // the role's own model stays as the fallback
});

test('ladders: a role moves along ITS OWN provider only, others keep their order and their own model', () => {
  const mixed = [{ provider: 'claude', model: 'sonnet-4-6' }, { provider: 'codex', model: 'default' }];
  assert.deepEqual(names(applyTiers(mixed, 1, CFG)), ['claude:opus-5-5', 'claude:sonnet-4-6', 'codex:default']);
  assert.deepEqual(names(applyTiers(mixed, 0.25, CFG)), ['claude:sonnet-4-6', 'codex:default']); // the pick equals the role's model: no duplicate
  const openaiRole = [{ provider: 'openai', model: 'gpt-mid' }];
  for (const level of [0, 0.3, 0.6, 1]) assert.ok(!names(applyTiers(openaiRole, level, CFG)).some((n) => n.includes('opus')));
  assert.deepEqual(names(applyTiers(openaiRole, 1, CFG)), ['openai:gpt-big', 'openai:gpt-mid']);
  const noLadder = [{ provider: 'gemini', model: 'g' }];
  assert.deepEqual(applyTiers(noLadder, 1, CFG), noLadder);
  assert.equal(mixed.length, 2); // input untouched
});

test('tierApplies: needs enabled, and respects the role list when there is one', () => {
  assert.equal(tierApplies(null, 'main'), false);
  assert.equal(tierApplies({ ...CFG, enabled: false }, 'main'), false);
  assert.equal(tierApplies(CFG, 'anything'), true);
  assert.equal(tierApplies({ ...CFG, roles: ['ops'] }, 'main'), false);
  assert.equal(tierApplies({ ...CFG, roles: ['ops'] }, 'ops'), true);
});

const CHOICES = { claude: [{ id: 'opus' }, { id: 'sonnet' }, { id: 'haiku' }], openai: [{ id: 'gpt-big' }, { id: 'gpt-mini' }], codex: [{ id: 'default' }] };
const READY = { claude: true, openai: true, codex: false };

test('save check: every model on an enabled ladder must be real and available; a disabled setup always saves', () => {
  assert.deepEqual(invalidTiers({ agents: {} }, CHOICES, READY), []); // no tiers key: nothing to check
  assert.deepEqual(invalidTiers({ tiers: { enabled: true, providers: { claude: ['haiku', 'sonnet', 'opus'], openai: ['gpt-mini', 'gpt-big'] } } }, CHOICES, READY), []);
  assert.deepEqual(invalidTiers({ tiers: { enabled: false, providers: { nope: ['x'] } } }, CHOICES, READY), []);
  const bad = invalidTiers({ tiers: { enabled: true, providers: { claude: ['sonnet', 'gpt-9'], codex: ['default'], openai: 'x' } } }, CHOICES, READY);
  assert.equal(bad.length, 3);
  assert.match(bad[0], /tiers\.claude.*"gpt-9" is not a claude model/);
  assert.match(bad[1], /tiers\.codex.*not available/);
  assert.match(bad[2], /tiers\.openai.*list of models/);
  assert.deepEqual(invalidTiers({ tiers: 'on' }, CHOICES, READY), ['tiers must be an object']);
});

test('settings: only well-formed ladders survive cleaning; order is kept and nothing is invented', () => {
  assert.equal(cleanTierConfig(undefined), undefined);
  assert.equal(cleanTierConfig({ enabled: true }), undefined); // no providers object
  const ok = cleanTierConfig({
    enabled: true, roles: ['main', 'Bad Role!', 5], extra: 'ignored',
    providers: { claude: ['haiku', 'sonnet', 'sonnet', '', 7, 'opus'], nope: ['x'], openai: [], gemini: 'str', codex: ['default'] },
  });
  assert.deepEqual(ok, { enabled: true, roles: ['main'], providers: { claude: ['haiku', 'sonnet', 'opus'], codex: ['default'] } });
  assert.equal(cleanTierConfig({ enabled: 'yes', providers: {} }).enabled, false); // only a real true enables it
  assert.equal(cleanTierConfig({ enabled: true, providers: { claude: Array.from({ length: 30 }, (_, n) => `m${n}`) } }).providers.claude.length, 12);
});
