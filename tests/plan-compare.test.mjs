// tests/plan-compare.test.mjs - the plan diff is deterministic, honest about what is a heuristic, and never throws on odd plans. Pure: no files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comparePlans, diffLists, overlap, pairSteps, PAIR_THRESHOLD } from '../dist/plan-compare.js';

const plan = (o = {}) => ({ run: 'a1b2c3d4', objective: 'Ship the card motion', verdict: 'Go.', confidence: 0.7,
  success_criteria: ['Cards animate', 'No layout shift'], success_metrics: ['p95 < 16ms'], dissent: ['Too risky'], decided_by: ['main', 'ops'],
  plan: [{ owner: 'ops', step: 'Add the animation to the card component', done_when: 'Card animates' }], ...o });

test('lists: compared by normalized text (case, spacing, trailing full stop), order kept from the side each line came from', () => {
  const d = diffLists(['Cards animate.', 'No  layout shift', 'Only in A'], ['no layout shift', 'cards animate', 'Only in B']);
  assert.deepEqual(d, { kept: ['Cards animate.', 'No  layout shift'], onlyA: ['Only in A'], onlyB: ['Only in B'] });
});

test('lists: duplicates count once, blanks and non-strings are dropped, and a non-array is an empty list', () => {
  assert.deepEqual(diffLists(['a', 'A', 'a.'], ['a']), { kept: ['a'], onlyA: [], onlyB: [] });
  const c = comparePlans(plan({ success_criteria: 'nope', dissent: [1, null, '  ', 'real'] }), plan({ success_criteria: undefined, dissent: ['real'] }));
  assert.deepEqual(c.criteria, { kept: [], onlyA: [], onlyB: [] });
  assert.deepEqual(c.dissent, { kept: ['real'], onlyA: [], onlyB: [] });
});

test('overlap: identical = 1, disjoint = 0, partial is the Jaccard of words of 3+ letters; two empty texts only match if equal', () => {
  assert.equal(overlap('add the animation', 'add the animation'), 1);
  assert.equal(overlap('add animation', 'remove cache'), 0);
  assert.equal(overlap('alpha beta gamma delta', 'alpha beta gamma epsilon'), 3 / 5);
  assert.equal(overlap('', ''), 1);
  assert.equal(overlap('a', 'b'), 0, 'words under 3 letters carry no signal');
});

test('steps: a reworded step is PAIRED (with its score shown), an unrelated one is added/removed, an identical one is marked same', () => {
  const a = [{ owner: 'ops', step: 'Add the animation to the card component', doneWhen: 'x' }, { owner: 'main', step: 'Write the migration guide', doneWhen: 'y' }];
  const b = [{ owner: 'ops', step: 'Add the card animation to the component and test it', doneWhen: 'x' }, { owner: 'research', step: 'Benchmark the render pipeline thoroughly', doneWhen: 'z' }];
  const s = pairSteps(a, b);
  assert.equal(s.pairs.length, 1);
  assert.equal(s.pairs[0].same, false);
  assert.ok(s.pairs[0].similarity >= PAIR_THRESHOLD && s.pairs[0].similarity < 1);
  assert.equal(s.pairs[0].doneWhenChanged, false);
  assert.deepEqual(s.onlyA.map((x) => x.owner), ['main']);
  assert.deepEqual(s.onlyB.map((x) => x.owner), ['research']);
  assert.equal(pairSteps([a[0]], [a[0]]).pairs[0].same, true);
  const reordered = pairSteps([{ owner: 'o', step: 'alpha beta gamma', doneWhen: '' }], [{ owner: 'o', step: 'gamma beta alpha', doneWhen: '' }]).pairs[0];
  assert.deepEqual([reordered.similarity, reordered.same], [1, false], 'a pure reorder scores 1 but is not the same text: the score is a heuristic, shown as such');
});

test('steps: pairing is one-to-one and picks the BEST match first, so a step is never claimed twice', () => {
  const a = [{ owner: 'o', step: 'alpha beta gamma delta', doneWhen: '' }, { owner: 'o', step: 'alpha beta gamma epsilon zeta', doneWhen: '' }];
  const b = [{ owner: 'o', step: 'alpha beta gamma delta', doneWhen: '' }];
  const s = pairSteps(a, b);
  assert.equal(s.pairs.length, 1);
  assert.equal(s.pairs[0].a.step, 'alpha beta gamma delta', 'the exact match wins over the looser one');
  assert.equal(s.onlyA.length, 1);
  assert.equal(s.onlyB.length, 0);
});

test('steps: a step that moved to a different owner still pairs, and says the owner changed', () => {
  const p = pairSteps([{ owner: 'ops', step: 'Run the full regression suite', doneWhen: 'a' }], [{ owner: 'research', step: 'Run the full regression suite', doneWhen: 'b' }]);
  assert.deepEqual([p.pairs[0].same, p.pairs[0].ownerChanged, p.pairs[0].doneWhenChanged], [true, true, true]);
});

test('steps: the result does not depend on input order of equally good candidates (ties broken by position)', () => {
  const a = [{ owner: 'o', step: 'one two three', doneWhen: '' }, { owner: 'o', step: 'one two three', doneWhen: '' }];
  const b = [{ owner: 'o', step: 'one two three', doneWhen: '' }, { owner: 'o', step: 'one two three', doneWhen: '' }];
  const first = JSON.stringify(pairSteps(a, b)), again = JSON.stringify(pairSteps(a, b));
  assert.equal(first, again);
  assert.deepEqual(pairSteps(a, b).pairs.map((p) => [p.a === a[0], p.b === b[0]]).length, 2);
});

test('compare: confidence delta is B minus A, rounded, and null when either side has none', () => {
  assert.equal(comparePlans(plan({ confidence: 0.55 }), plan({ confidence: 0.8 })).confidence.delta, 0.25);
  assert.equal(comparePlans(plan({ confidence: 0.8 }), plan({ confidence: 0.55 })).confidence.delta, -0.25);
  assert.equal(comparePlans(plan({ confidence: undefined }), plan()).confidence.delta, null);
  assert.equal(comparePlans(plan({ confidence: NaN }), plan()).confidence.a, null);
});

test('compare: identical plans differ in nothing; objective and verdict compare by normalized text', () => {
  const c = comparePlans(plan(), plan({ run: 'b2c3d4e5', objective: '  ship THE card motion. ', verdict: 'go' }));
  assert.equal(c.objective.same, true);
  assert.equal(c.verdictSame, true);
  assert.deepEqual([c.criteria.onlyA, c.criteria.onlyB, c.metrics.onlyA, c.metrics.onlyB, c.dissent.onlyA, c.steps.onlyA, c.steps.onlyB], [[], [], [], [], [], [], []]);
  assert.deepEqual([c.a, c.b], ['a1b2c3d4', 'b2c3d4e5']);
});

test('compare: odd or empty plans never throw (missing fields, wrong types, a step that is not an object)', () => {
  assert.doesNotThrow(() => comparePlans({}, {}));
  assert.doesNotThrow(() => comparePlans(plan({ plan: [null, 3, 'x', {}] }), plan({ plan: 'not a list' })));
  const c = comparePlans({}, {});
  assert.equal(c.objective.same, true);
  assert.deepEqual(c.steps, { pairs: [], onlyA: [], onlyB: [] });
});

test('compare: criteria, metrics and dissent lists are bounded too (60 each), not just steps', () => {
  const lots = Array.from({ length: 500 }, (_, i) => `criterion ${i}`);
  const c = comparePlans(plan({ success_criteria: lots, dissent: lots }), plan({ success_criteria: lots, dissent: lots }));
  assert.equal(c.criteria.kept.length, 60);
  assert.equal(c.dissent.kept.length, 60);
});

test('compare: a huge plan is bounded (60 items per list) so the quadratic pairing cannot hang the page', () => {
  const many = Array.from({ length: 500 }, (_, i) => ({ owner: 'o', step: `step number ${i} alpha beta`, done_when: '' }));
  const t = Date.now();
  const c = comparePlans(plan({ plan: many }), plan({ plan: many }));
  assert.ok(c.steps.pairs.length + c.steps.onlyA.length <= 60);
  assert.ok(Date.now() - t < 2000);
});
