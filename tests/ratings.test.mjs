// tests/ratings.test.mjs - "was this useful?": append-only ratings beside the run ledger. Fixtures only, never the real store/.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { STORE_DIR } from '../dist/config.js';
import { loadRatings, ratingsFile } from '../dist/ratings.js';
import { setRating, historyOverview, runDetail, computeStats, loadRuns } from '../dist/history.js';
import { mountHistory } from '../dist/history-routes.js';

const FIXTURES = join(STORE_DIR, 'test-fixtures-ratings'); // its own folder: test files run in parallel, and another file's cleanup would delete these
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

function fixture() {
  mkdirSync(FIXTURES, { recursive: true });
  const root = mkdtempSync(join(FIXTURES, 'ratings-'));
  const p = { runsFile: join(root, 'runs.jsonl'), verdictJson: join(root, 'v.json'), verdictMd: join(root, 'v.md'), archiveDir: join(root, 'verdicts'), councilDir: join(root, 'council') };
  const row = (id, kind) => ({ id, kind, question: 'Q', started: '2026-01-01T10:00:00', outcome: kind === 'build' ? 'built' : 'verdict', changed_files: ['a.ts'] });
  writeFileSync(p.runsFile, [row('a1b2c3d4', 'summit'), row('c3d4e5f6', 'build')].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

test('ratings: the latest answer wins, 0 takes it back, and it lands beside the ledger, not in it', () => {
  const p = fixture();
  const before = readFileSync(p.runsFile, 'utf8');
  assert.deepEqual(setRating('a1b2c3d4', 1, p), { ok: true, rating: 1 });
  assert.deepEqual(setRating('a1b2c3d4', -1, p), { ok: true, rating: -1 });
  assert.equal(loadRatings(p.runsFile).get('a1b2c3d4').value, -1);
  assert.deepEqual(setRating('a1b2c3d4', 0, p), { ok: true, rating: null });
  assert.equal(loadRatings(p.runsFile).has('a1b2c3d4'), false);
  assert.equal(readFileSync(p.runsFile, 'utf8'), before, 'the War Room owns council-runs.jsonl; rating must never rewrite it');
  assert.equal(readFileSync(ratingsFile(p.runsFile), 'utf8').trim().split('\n').length, 3, 'append-only: three answers, three lines');
});

test('ratings: only real runs and only 1, -1 or 0 are accepted, and nothing is written when refused', () => {
  const p = fixture();
  for (const id of ['deadbeef', '../x', 'A1B2C3D4', '']) assert.equal(setRating(id, 1, p).ok, false, id);
  for (const v of [2, '1', null, undefined, true, 0.5]) assert.equal(setRating('a1b2c3d4', v, p).ok, false, String(v));
  assert.equal(loadRatings(p.runsFile).size, 0);
  assert.throws(() => readFileSync(ratingsFile(p.runsFile)), /ENOENT/, 'a refused rating must not even create the file');
});

test('ratings: a damaged line is skipped, the rest still count', () => {
  const p = fixture();
  setRating('a1b2c3d4', 1, p);
  writeFileSync(ratingsFile(p.runsFile), readFileSync(ratingsFile(p.runsFile), 'utf8') + '{not json\n{"id":5,"value":1}\n{"id":"c3d4e5f6","value":7}\n');
  assert.deepEqual([...loadRatings(p.runsFile).keys()], ['a1b2c3d4']);
});

test('ratings: they show up in the overview, the run detail and the stats', () => {
  const p = fixture();
  setRating('a1b2c3d4', 1, p);
  setRating('c3d4e5f6', -1, p);
  const o = historyOverview(p);
  assert.deepEqual(Object.fromEntries(o.runs.map((r) => [r.id, r.rating])), { a1b2c3d4: 1, c3d4e5f6: -1 });
  assert.equal(o.stats.rated, 2);
  assert.equal(o.stats.ratedUseful, 1);
  assert.equal(runDetail('c3d4e5f6', p).rating, -1);
  assert.equal(computeStats(loadRuns(p)).rated, 0, 'no ratings passed means none counted');
  assert.equal(computeStats(loadRuns(p), new Map([['zzzzzzzz', { value: 1, at: '' }]])).rated, 0, 'a rating for a run that is not in the ledger is not counted');
});

test('ratings: the route records 1/-1/0, refuses anything else with 400 and an unknown run with 404', async () => {
  const p = fixture();
  const app = new Hono();
  mountHistory(app, p);
  const post = (id, body) => app.request(`/api/history/${id}/rating`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await (await post('a1b2c3d4', '{"value":1}')).json(), { ok: true, rating: 1 });
  assert.deepEqual(await (await post('a1b2c3d4', '{"value":0}')).json(), { ok: true, rating: null });
  assert.equal((await post('a1b2c3d4', '{"value":5}')).status, 400);
  assert.equal((await post('a1b2c3d4', 'not json')).status, 400, 'an unreadable body means no value');
  assert.equal((await post('deadbeef', '{"value":1}')).status, 404);
  assert.equal(loadRatings(p.runsFile).size, 0);
});
