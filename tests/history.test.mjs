// tests/history.test.mjs - Plan Library data layer against fixture ledgers (never touches the real store/).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STORE_DIR } from '../dist/config.js';
import {
  loadRuns, planOf, computeStats, ensureArchive, activatePlan, activePlan, readArtifact, listArtifacts,
  runDetail, historyOverview, readPlan,
} from '../dist/history.js';
import { renderHistory } from '../dist/history-html.js';
import { renderWarRoom } from '../dist/warroom-html.js';

const Q = 'Plan the card motion';
const summit = (id, started, extra = {}) => ({ id, kind: 'summit', question: Q, started, outcome: 'verdict',
  total_s: 100, total_cost_usd: 1, verdict_confidence: 0.8, plan_steps: 2, ...extra });
const build = (id, started, extra = {}) => ({ id, kind: 'build', question: Q, started, outcome: 'built',
  total_s: 200, total_cost_usd: 2, changed_files: ['a.ts'], ...extra });

// Fixtures live under the project's gitignored store/ (never the system temp dir, which is on C:).
const FIXTURES = join(STORE_DIR, 'test-fixtures');
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

function fixture() {
  mkdirSync(FIXTURES, { recursive: true });
  const root = mkdtempSync(join(FIXTURES, 'history-'));
  const p = { runsFile: join(root, 'runs.jsonl'), verdictJson: join(root, 'summit-verdict.json'),
    verdictMd: join(root, 'summit-verdict.md'), archiveDir: join(root, 'verdicts'), councilDir: join(root, 'council') };
  const runs = [
    summit('a1b2c3d4', '2026-01-01T10:00:00'),
    summit('b2c3d4e5', '2026-01-01T09:00:00', { outcome: 'no_verdict', verdict_confidence: undefined }),
    build('c3d4e5f6', '2026-01-01T11:00:00', { verdict_run: 'a1b2c3d4' }),
    build('d4e5f6a7', '2026-01-01T12:00:00', { changed_files: [], criteria_met: '18/7' }), // legacy: no verdict_run, "built" with nothing changed
  ];
  writeFileSync(p.runsFile, runs.map((r) => JSON.stringify(r)).join('\n') + '\n{not json\n');
  writeFileSync(p.verdictJson, JSON.stringify({ run: 'a1b2c3d4', question: Q, objective: 'Ship motion', confidence: 0.8,
    plan: [{ owner: 'ops', step: 's1', done_when: 'd1' }, { owner: 'main', step: 's2', done_when: 'd2' }] }));
  writeFileSync(p.verdictMd, '# Summit verdict (a1b2c3d4)');
  mkdirSync(join(p.councilDir, 'a1b2c3d4'), { recursive: true });
  writeFileSync(join(p.councilDir, 'a1b2c3d4', 'ops-report.md'), '# report');
  writeFileSync(join(p.councilDir, 'a1b2c3d4', '.env'), 'SECRET=1');
  writeFileSync(join(p.councilDir, 'a1b2c3d4', 'huge.md'), 'x'.repeat(300_000));
  writeFileSync(join(root, 'secret.md'), 'top secret');
  return { p, root };
}

test('history: loads newest-first, skips corrupt lines, reclassifies legacy no-op builds', () => {
  const { p } = fixture();
  const runs = loadRuns(p);
  assert.deepEqual(runs.map((r) => r.id), ['d4e5f6a7', 'c3d4e5f6', 'a1b2c3d4', 'b2c3d4e5']);
  const legacy = runs.find((r) => r.id === 'd4e5f6a7');
  assert.equal(legacy.outcome, 'no_changes'); // was "built" with zero changed files
  assert.equal(legacy.legacy_outcome, 'built');
  assert.equal(JSON.parse(readFileSync(p.runsFile, 'utf8').split('\n')[3]).outcome, 'built'); // ledger itself untouched
});

test('history: builds link to their plan (recorded, or inferred for old builds)', () => {
  const { p } = fixture();
  const runs = loadRuns(p);
  assert.equal(planOf(runs.find((r) => r.id === 'c3d4e5f6'), runs), 'a1b2c3d4');
  assert.equal(planOf(runs.find((r) => r.id === 'd4e5f6a7'), runs), 'a1b2c3d4'); // newest verdict with same question
  assert.equal(planOf({ ...build('e5f6a7b8', '2026-01-01T08:00:00') }, runs), null); // no summit before it
});

test('history: stats count what actually happened', () => {
  const { p } = fixture();
  const s = computeStats(loadRuns(p));
  assert.equal(s.runs, 4);
  assert.equal(s.summits, 2);
  assert.equal(s.verdicts, 1);
  assert.equal(s.builds, 2);
  assert.equal(s.built, 1);
  assert.equal(s.noChanges, 1);
  assert.equal(s.buildSuccessRate, 0.5);
  assert.equal(s.totalCostUsd, 6);
  assert.equal(s.avgConfidence, 0.8);
});

test('history: the active verdict is archived once, and a past plan can be re-activated', () => {
  const { p } = fixture();
  assert.equal(existsSync(p.archiveDir), false);
  ensureArchive(p);
  ensureArchive(p); // idempotent
  assert.equal(readPlan('a1b2c3d4', p).objective, 'Ship motion');
  // a later summit overwrites the active verdict...
  writeFileSync(p.verdictJson, JSON.stringify({ run: 'f6a7b8c9', objective: 'Something else', plan: [] }));
  ensureArchive(p);
  assert.equal(activePlan(p).run, 'f6a7b8c9');
  // ...but the earlier plan is still loadable
  const r = activatePlan('a1b2c3d4', p);
  assert.equal(r.ok, true);
  assert.equal(activePlan(p).run, 'a1b2c3d4');
  assert.equal(activePlan(p).steps, 2);
  assert.deepEqual(activePlan(p).owners, ['ops', 'main']);
  assert.equal(readFileSync(p.verdictMd, 'utf8'), '# Summit verdict (a1b2c3d4)');
});

test('history: activation refuses unknown and malformed ids', () => {
  const { p } = fixture();
  assert.equal(activatePlan('deadbeef', p).ok, false);
  for (const bad of ['../x', 'A1B2C3D4', 'a1b2c3d', 'a1b2c3d4/..', '']) assert.equal(activatePlan(bad, p).ok, false, bad);
  assert.equal(activePlan(p).run, 'a1b2c3d4'); // untouched
});

test('history: artifacts are allowlisted by directory listing, so nothing can be traversed', () => {
  const { p } = fixture();
  assert.deepEqual(listArtifacts('a1b2c3d4', p).map((f) => f.name), ['ops-report.md']); // no .env, no 300KB file
  assert.equal(readArtifact('a1b2c3d4', 'ops-report.md', p), '# report');
  for (const name of ['../../secret.md', '..\\..\\secret.md', '.env', 'huge.md', 'missing.md']) {
    assert.equal(readArtifact('a1b2c3d4', name, p), null, name);
  }
  assert.equal(readArtifact('../x', 'ops-report.md', p), null);
});

test('history: run detail joins plan, follow-through builds and deliverables', () => {
  const { p } = fixture();
  const d = runDetail('a1b2c3d4', p);
  assert.equal(d.plan.objective, 'Ship motion');
  assert.deepEqual(d.builds.map((b) => b.id).sort(), ['c3d4e5f6', 'd4e5f6a7']);
  assert.equal(d.artifacts.length, 1);
  const b = runDetail('c3d4e5f6', p);
  assert.equal(b.planId, 'a1b2c3d4');
  assert.equal(b.plan.objective, 'Ship motion');
  assert.equal(runDetail('nonexistent', p), null);
  assert.equal(historyOverview(p).active.run, 'a1b2c3d4');
});

test('history: list titles come from the plan objective, so runs sharing a question stay distinguishable', () => {
  const { p } = fixture();
  const rows = Object.fromEntries(historyOverview(p).runs.map((r) => [r.id, r]));
  assert.equal(rows.a1b2c3d4.title, 'Ship motion');
  assert.equal(rows.c3d4e5f6.title, 'Ship motion'); // a build is titled by the plan it executed
  assert.equal(rows.b2c3d4e5.title, Q); // no archived plan: falls back to the question
  assert.equal(rows.a1b2c3d4.builds, 2);
});

test('history page: renders without data, escapes the token, and the war room shows the active plan', () => {
  const html = renderHistory('</script><b>');
  assert.ok(!html.includes('</script><b>'));
  assert.ok(html.includes('Plan Library') && html.includes('/history/history-app.js'));
  const room = renderWarRoom({ run: 'a1b2c3d4', objective: '<img src=x>', question: '', confidence: 0.8, steps: 3, owners: ['ops'] });
  assert.ok(room.includes('a1b2c3d4') && room.includes('/history#run=a1b2c3d4') && !room.includes('<img src=x>'));
  assert.ok(renderWarRoom(null).includes('No plan on file'));
});
