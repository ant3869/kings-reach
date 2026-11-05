// Plan Library surfaces measured mind-changes, never presenting an old self-report as a measurement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../dist/history.js';

const run = (extra) => ({ id: 'a1b2c3d4', kind: 'summit', question: 'q', started: '2026-01-01T10:00:00', outcome: 'verdict', ...extra });

test('new runs expose measured and claimed mind-changes separately', () => {
  const s = summarize(run({ mind_rule: 2, changed_minds: 1, changed_minds_claimed: 3 }), []);
  assert.equal(s.mindsChanged, 1);
  assert.equal(s.mindsClaimed, 3);
});

test('rule-1 rows (which counted any rewording) are not presented as measurements', () => {
  // Real ledger row 9a7edfa0: two councillors kept the same design, both were scored as changed.
  const s = summarize(run({ changed_minds: 2, changed_minds_claimed: 0, changed_minds_agents: ['research', 'ops'] }), []);
  assert.equal(s.mindsChanged, null);
});

test('legacy runs (self-report only) show nothing rather than a fake measurement', () => {
  const s = summarize(run({ changed_minds: 2 }), []);
  assert.equal(s.mindsChanged, null);
  assert.equal(s.mindsClaimed, null);
});

test('builds and malformed rows never invent the fields', () => {
  assert.equal(summarize(run({ kind: 'build' }), []).mindsChanged, null);
  assert.equal(summarize(run({ changed_minds: 'lots', changed_minds_claimed: 'many' }), []).mindsChanged, null);
});
