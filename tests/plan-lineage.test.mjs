// tests/plan-lineage.test.mjs - threads of revisions, the plan of record, and the compare/promote routes. Fixture ledgers only (never the real store/).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { STORE_DIR } from '../dist/config.js';
import { threadKey, normalizeQuestion, buildThreads, threadOfPlan, THREAD_BASIS } from '../dist/plan-lineage.js';
import { loadPromotions, appendPromotion, promotionsFile } from '../dist/plan-promotions.js';
import { historyOverview, promotePlan, compareArchived, runDetail, activatePlan } from '../dist/history.js';
import { mountHistory } from '../dist/history-routes.js';
import { renderHistory } from '../dist/history-html.js';

const FIXTURES = join(STORE_DIR, 'test-fixtures-lineage'); // its own folder: files run in parallel and another's cleanup would delete these
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

const Q = 'Should we adopt the new router?';
const S = (id, started, extra = {}) => ({ id, kind: 'summit', question: Q, started, outcome: 'verdict', total_s: 100, total_cost_usd: 1, verdict_confidence: 0.7, plan_steps: 2, ...extra });
const B = (id, started, plan, outcome = 'built') => ({ id, kind: 'build', question: Q, started, outcome, verdict_run: plan, total_s: 50, total_cost_usd: 2, changed_files: ['a.ts'] });
const planJson = (run, extra = {}) => ({ run, question: Q, objective: `Objective ${run}`, verdict: `Verdict ${run}`, confidence: 0.7, success_criteria: ['shared criterion', `only ${run}`],
  plan: [{ owner: 'ops', step: `Do the thing ${run}`, done_when: 'done' }], ...extra });

function fixture({ archive = ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6'], runs } = {}) {
  mkdirSync(FIXTURES, { recursive: true });
  const root = mkdtempSync(join(FIXTURES, 'l-'));
  const p = { runsFile: join(root, 'runs.jsonl'), verdictJson: join(root, 'v.json'), verdictMd: join(root, 'v.md'), archiveDir: join(root, 'verdicts'), councilDir: join(root, 'council') };
  const rows = runs ?? [
    S('a1b2c3d4', '2026-01-01T09:00:00'),
    S('b2c3d4e5', '2026-01-02T09:00:00', { verdict_confidence: 0.85 }),
    S('c3d4e5f6', '2026-01-03T09:00:00', { question: '  SHOULD we adopt   the new router? ' }), // same question after normalizing
    S('d4e5f6a7', '2026-01-04T09:00:00', { question: 'A different question entirely' }),
    S('e5f6a7b8', '2026-01-05T09:00:00', { outcome: 'cancelled' }), // same question, but no verdict: no plan, not in the thread
    B('f6a7b8c9', '2026-01-02T12:00:00', 'b2c3d4e5'),
    B('a7b8c9d0', '2026-01-02T13:00:00', 'b2c3d4e5', 'needs_work'),
  ];
  writeFileSync(p.runsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  mkdirSync(p.archiveDir, { recursive: true });
  for (const id of archive) writeFileSync(join(p.archiveDir, `${id}.json`), JSON.stringify(planJson(id)));
  writeFileSync(p.verdictJson, JSON.stringify(planJson('a1b2c3d4')));
  return { p, root };
}

// --- thread identity --------------------------------------------------------------------------------------------------------------------
test('thread key: stable, case/space-insensitive, 12 hex, and empty for a blank question (which gets no thread)', () => {
  assert.equal(threadKey(Q), threadKey('  SHOULD we adopt   the new router? '));
  assert.match(threadKey(Q), /^[0-9a-f]{12}$/);
  assert.notEqual(threadKey(Q), threadKey('Another question'));
  for (const blank of ['', '   ', null, undefined]) assert.equal(threadKey(blank), '', String(blank));
  assert.equal(normalizeQuestion('  A\n\tB  '), 'a b');
});

test('threads: only VERDICT summits join, oldest first; each carries its builds and the honest basis; the cancelled re-ask and other questions stay out', () => {
  const { p } = fixture();
  const ov = historyOverview(p);
  const r = Object.fromEntries(ov.runs.map((x) => [x.id, x]));
  assert.deepEqual([r.a1b2c3d4.revisions, r.b2c3d4e5.revisions, r.c3d4e5f6.revisions], [3, 3, 3]);
  assert.equal(r.d4e5f6a7.revisions, 1, 'a question asked once is a thread of one');
  assert.equal(r.e5f6a7b8.revisions, 0, 'a cancelled summit has no plan, so no thread');
  const lineage = runDetail('b2c3d4e5', p).lineage;
  assert.deepEqual(lineage.plans.map((x) => x.id), ['a1b2c3d4', 'b2c3d4e5', 'c3d4e5f6']);
  assert.equal(lineage.basis, THREAD_BASIS);
  assert.match(lineage.basis, /inferred/);
  const mid = lineage.plans[1];
  assert.deepEqual([mid.builds, mid.built, mid.archived, mid.confidence, mid.steps], [2, 1, true, 0.85, 2]);
});

test('threads: a build belongs to the thread of the plan it executed; a plan with no verdict has no lineage', () => {
  const { p } = fixture();
  assert.equal(runDetail('f6a7b8c9', p).lineage.plans.length, 3);
  assert.equal(runDetail('e5f6a7b8', p).lineage, null);
  const rows = Object.fromEntries(historyOverview(p).runs.map((x) => [x.id, x]));
  assert.equal(rows.f6a7b8c9.revisions, 3);
  assert.equal(rows.f6a7b8c9.isPlanOfRecord, false, 'a build is never itself the plan of record');
  promotePlan('b2c3d4e5', true, p); // the plan these two builds executed becomes the plan of record...
  const after = Object.fromEntries(historyOverview(p).runs.map((x) => [x.id, x.isPlanOfRecord]));
  assert.deepEqual([after.b2c3d4e5, after.f6a7b8c9, after.a7b8c9d0], [true, false, false], '...but the builds themselves are still not plans');
});

test('threads: summits with a blank or missing question never share a thread (they are not "the same question")', () => {
  const { p } = fixture({ runs: [S('a1b2c3d4', '2026-01-01T09:00:00', { question: '' }), S('b2c3d4e5', '2026-01-02T09:00:00', { question: '   ' }), S('c3d4e5f6', '2026-01-03T09:00:00', { question: undefined })] });
  const ov = historyOverview(p);
  assert.deepEqual(ov.runs.map((r) => r.revisions), [0, 0, 0]);
  assert.equal(promotePlan('a1b2c3d4', true, p).ok, false);
  assert.match(promotePlan('a1b2c3d4', true, p).error, /no question text/);
});

test('threads: a verdict whose archive is gone still counts as a revision, flagged archived:false (it cannot be loaded, compared or promoted)', () => {
  const { p } = fixture({ archive: ['a1b2c3d4', 'b2c3d4e5'] });
  const lineage = runDetail('a1b2c3d4', p).lineage;
  assert.equal(lineage.plans.length, 3);
  assert.deepEqual(lineage.plans.map((x) => x.archived), [true, true, false]);
});

// --- promoting --------------------------------------------------------------------------------------------------------------------------
test('promote: marks the plan of record for the whole thread; promoting another replaces it; taking it back clears it', () => {
  const { p } = fixture();
  const first = promotePlan('b2c3d4e5', true, p);
  assert.deepEqual([first.ok, first.planOfRecord, first.thread], [true, 'b2c3d4e5', threadKey(Q)]);
  assert.equal(runDetail('a1b2c3d4', p).lineage.planOfRecord, 'b2c3d4e5', 'seen from any member of the thread');
  const rows = () => Object.fromEntries(historyOverview(p).runs.map((x) => [x.id, x.isPlanOfRecord]));
  assert.deepEqual([rows().a1b2c3d4, rows().b2c3d4e5, rows().c3d4e5f6], [false, true, false]);
  promotePlan('c3d4e5f6', true, p);
  assert.deepEqual([rows().b2c3d4e5, rows().c3d4e5f6], [false, true], 'exactly one plan of record per thread');
  assert.equal(promotePlan('c3d4e5f6', false, p).planOfRecord, null);
  assert.equal(runDetail('a1b2c3d4', p).lineage.planOfRecord, null);
});

test('promote: only a locked, archived verdict qualifies; a bad id, a non-boolean, a cancelled summit, a build and a missing archive are all refused and write nothing', () => {
  const { p } = fixture({ archive: ['a1b2c3d4', 'b2c3d4e5'] });
  const refused = (id, v) => { const r = promotePlan(id, v, p); assert.equal(r.ok, false, `${id} ${v}`); return r.error; };
  assert.match(refused('../etc', true), /bad run id/);
  assert.match(refused('a1b2c3d4', 'yes'), /value must be/);
  assert.match(refused('a1b2c3d4', 1), /value must be/);
  assert.match(refused('e5f6a7b8', true), /only a locked verdict/);
  assert.match(refused('f6a7b8c9', true), /only a locked verdict/);
  assert.match(refused('c3d4e5f6', true), /no archived verdict/);
  assert.match(refused('00000000', true), /only a locked verdict/);
  assert.equal(existsSync(promotionsFile(p.runsFile)), false, 'nothing was written');
});

test('promote: taking back is refused unless THIS plan is the plan of record (it cannot clear someone else\'s choice)', () => {
  const { p } = fixture();
  assert.match(promotePlan('a1b2c3d4', false, p).error, /not the plan of record/);
  promotePlan('b2c3d4e5', true, p);
  assert.match(promotePlan('a1b2c3d4', false, p).error, /not the plan of record/);
  assert.equal(loadPromotions(p.runsFile).get(threadKey(Q)).plan, 'b2c3d4e5');
});

test('promote: a record pointing at a plan that is no longer in the thread or no longer archived is ignored, not trusted', () => {
  const { p } = fixture();
  appendPromotion(p.runsFile, threadKey(Q), 'd4e5f6a7'); // a real verdict, but of another question
  assert.equal(runDetail('a1b2c3d4', p).lineage.planOfRecord, null);
  appendPromotion(p.runsFile, threadKey(Q), 'b2c3d4e5');
  assert.equal(runDetail('a1b2c3d4', p).lineage.planOfRecord, 'b2c3d4e5');
  rmSync(join(p.archiveDir, 'b2c3d4e5.json'));
  assert.equal(runDetail('a1b2c3d4', p).lineage.planOfRecord, null, 'archive vanished: the choice cannot be honoured');
});

test('promotions file: last line per thread wins; corrupt, foreign and malformed lines are skipped; ids are validated before writing', () => {
  const { p } = fixture();
  const t = threadKey(Q);
  appendPromotion(p.runsFile, t, 'a1b2c3d4', '2026-01-01T00:00:00Z');
  appendFileSync(promotionsFile(p.runsFile), '{not json\n{"thread":"zz","plan":"a1b2c3d4"}\n{"thread":"' + t + '","plan":"../../x"}\n{"other":1}\n');
  appendPromotion(p.runsFile, t, 'b2c3d4e5', '2026-01-02T00:00:00Z');
  assert.deepEqual(loadPromotions(p.runsFile).get(t), { plan: 'b2c3d4e5', at: '2026-01-02T00:00:00Z' });
  assert.equal(loadPromotions(p.runsFile).size, 1, 'the malformed thread id and the path-like plan id were dropped, not stored under a made-up key');
  assert.throws(() => appendPromotion(p.runsFile, 'nope', 'a1b2c3d4'), /bad thread/);
  assert.throws(() => appendPromotion(p.runsFile, t, '../x'), /bad thread/);
  assert.equal(loadPromotions(join(p.archiveDir, 'missing', 'runs.jsonl')).size, 0, 'a missing file is an empty map');
});

test('promote does NOT load the plan: the active plan is unchanged until you load one', () => {
  const { p } = fixture();
  const before = readFileSync(p.verdictJson, 'utf8');
  promotePlan('b2c3d4e5', true, p);
  assert.equal(readFileSync(p.verdictJson, 'utf8'), before);
});

// --- the safety signal ------------------------------------------------------------------------------------------------------------------
test('active plan: says whether it is the plan of record for its question (null when there is no record to disagree with)', () => {
  const { p } = fixture();
  assert.equal(historyOverview(p).active.isPlanOfRecord, null, 'no plan of record yet');
  promotePlan('b2c3d4e5', true, p);
  let a = historyOverview(p).active;
  assert.deepEqual([a.run, a.isPlanOfRecord, a.planOfRecord], ['a1b2c3d4', false, 'b2c3d4e5'], 'Build would run something other than the plan of record');
  activatePlan('b2c3d4e5', p);
  a = historyOverview(p).active;
  assert.deepEqual([a.run, a.isPlanOfRecord], ['b2c3d4e5', true]);
});

// --- compare ----------------------------------------------------------------------------------------------------------------------------
test('compare: the diff plus what each run cost and led to; refuses bad ids, the same plan twice and unarchived plans', () => {
  const { p } = fixture({ archive: ['a1b2c3d4', 'b2c3d4e5'] });
  const r = compareArchived('a1b2c3d4', 'b2c3d4e5', p);
  assert.equal(r.ok, true);
  assert.deepEqual(r.comparison.criteria.kept, ['shared criterion']);
  assert.deepEqual([r.comparison.criteria.onlyA, r.comparison.criteria.onlyB], [['only a1b2c3d4'], ['only b2c3d4e5']]);
  assert.deepEqual([r.runs.a.builds, r.runs.b.builds, r.runs.b.built], [0, 2, 1]);
  assert.equal(r.runs.b.costUsd, 1);
  assert.equal(r.sameThread, true);
  assert.equal(compareArchived('a1b2c3d4', 'a1b2c3d4', p).ok, false);
  assert.match(compareArchived('a1b2c3d4', 'zz', p).error, /bad run id/);
  assert.match(compareArchived('a1b2c3d4', 'c3d4e5f6', p).error, /no archived plan for c3d4e5f6/, 'verdict exists but its archive is gone');
  assert.match(compareArchived('a1b2c3d4', 'f6a7b8c9', p).error, /no archived plan/, 'a build id is not a plan');
});

test('compare: plans from different questions can be compared but are not reported as the same thread', () => {
  const { p } = fixture({ archive: ['a1b2c3d4', 'd4e5f6a7'] });
  assert.equal(compareArchived('a1b2c3d4', 'd4e5f6a7', p).sameThread, false);
});

// --- routes -----------------------------------------------------------------------------------------------------------------------------
function app(p) { const a = new Hono(); mountHistory(a, p); return a; }
const app_ = app; // the test above names a local `app` index; keep both readable
const post = (a, path, body) => a.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('routes: compare, promote and the detail lineage work end to end with the right status codes', async () => {
  const { p } = fixture();
  const a = app(p);
  const cmp = await a.request('/api/history/compare/a1b2c3d4/b2c3d4e5');
  assert.equal(cmp.status, 200);
  assert.equal((await cmp.json()).comparison.criteria.kept[0], 'shared criterion');
  assert.equal((await a.request('/api/history/compare/a1b2c3d4/a1b2c3d4')).status, 400);
  assert.equal((await a.request('/api/history/compare/a1b2c3d4/zz')).status, 400);
  assert.equal((await a.request('/api/history/compare/a1b2c3d4/00000000')).status, 404);

  const ok = await post(a, '/api/history/b2c3d4e5/promote', { value: true });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).planOfRecord, 'b2c3d4e5');
  assert.equal((await (await a.request('/api/history/a1b2c3d4')).json()).lineage.planOfRecord, 'b2c3d4e5');
  assert.equal((await post(a, '/api/history/b2c3d4e5/promote', { value: 'yes' })).status, 400);
  assert.equal((await post(a, '/api/history/not-an-id/promote', { value: true })).status, 400);
  assert.equal((await post(a, '/api/history/e5f6a7b8/promote', { value: true })).status, 404);
  assert.equal((await a.request('/api/history/b2c3d4e5/promote', { method: 'POST', body: 'garbage' })).status, 400, 'no JSON body is a refusal, not a crash');
  assert.equal((await post(a, '/api/history/b2c3d4e5/promote', { value: false })).status, 200);
});

test('routes: "compare" is never mistaken for a run id (the literal route wins over /api/history/:id)', async () => {
  const { p } = fixture();
  const res = await app(p).request('/api/history/compare');
  assert.equal(res.status, 404);
});

test('a build/threads call on an empty or missing ledger does not throw', () => {
  mkdirSync(FIXTURES, { recursive: true });
  const root = mkdtempSync(join(FIXTURES, 'empty-'));
  const p = { runsFile: join(root, 'none.jsonl'), verdictJson: join(root, 'v.json'), verdictMd: join(root, 'v.md'), archiveDir: join(root, 'verdicts'), councilDir: join(root, 'c') };
  const ov = historyOverview(p);
  assert.deepEqual([ov.runs.length, ov.active], [0, null]);
  assert.equal(buildThreads({ runs: [], archived: new Set(), objectives: new Map(), buildsByPlan: new Map(), promotions: new Map() }).size, 0);
  assert.equal(threadOfPlan(new Map(), 'a1b2c3d4'), null);
});

test('page: loads history-plans.js BEFORE history-app.js (the controller calls into it), and both are served; no other file is reachable through that route', async () => {
  const html = renderHistory('');
  const first = html.indexOf('/history/history-plans.js'), second = html.indexOf('/history/history-app.js');
  assert.ok(first > 0 && second > first, 'plans script first');
  const { p } = fixture();
  const a = app_(p);
  for (const name of ['history-plans.js', 'history-app.js']) {
    const res = await a.request(`/history/${name}`);
    assert.equal(res.status, 200, name);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match(await res.text(), /^\/\/ public\/history-/, name);
  }
  for (const bad of ['config.ts', '..%2Fpackage.json', '%2e%2e/package.json', 'history-plans.js.map', 'secret.js']) assert.equal((await a.request(`/history/${bad}`)).status, 404, bad);
});

// The real client file, run in a vm with the page's real esc(): hostile plan text must come out as text, never as live markup.
import vm from 'node:vm';
import { esc } from '../dist/client-md.js';
function loadClient() {
  const ctx = vm.createContext({ esc, badge: (o) => `<b>${esc(o)}</b>`, when: (s) => esc(s), money: (n) => '$' + Number(n).toFixed(2),
    section: (title, html) => `<h2>${esc(title)}</h2>${html}`, api: async () => ({}), $: () => null });
  vm.runInContext(readFileSync(join(import.meta.dirname, '..', 'public', 'history-plans.js'), 'utf8') + '\n;globalThis.out = { lineageSection, promoteButton, recordWarning, compareHtml };', ctx);
  return ctx.out;
}
// Tags and an attribute breakout (the dangerous case for values placed inside data-id="..."). Escaped text may still CONTAIN the words; it must not contain live markup.
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>" onmouseover="alert(3)\'';
const live = (html) => html.includes('<img') || html.includes('<script') || html.includes('" onmouseover=') || html.includes(EVIL);

test('client: hostile text in plans, objectives, dissent, ids and thread basis is escaped everywhere it is shown', () => {
  const c = loadClient();
  const diff = { kept: [EVIL], onlyA: [EVIL], onlyB: [EVIL] };
  const step = { owner: EVIL, step: EVIL, doneWhen: EVIL };
  const html = c.compareHtml({ sameThread: false, runs: { a: { costUsd: 1, totalSeconds: 2, builds: 0, built: 0 }, b: { costUsd: 1, totalSeconds: 2, builds: 0, built: 0 } },
    comparison: { a: EVIL, b: EVIL, objective: { a: EVIL, b: EVIL, same: false }, verdictSame: false, confidence: { a: 0.5, b: 0.6, delta: 0.1 },
      criteria: diff, metrics: diff, dissent: diff, decidedBy: diff,
      steps: { pairs: [{ a: step, b: step, similarity: 0.7, same: false, ownerChanged: true, doneWhenChanged: true }], onlyA: [step], onlyB: [step] } } });
  assert.ok(html.length > 500 && html.includes('&lt;img'), 'rendered, and the text is visible as text');
  assert.equal(live(html), false, html.slice(0, 200));
  const lin = c.lineageSection({ planId: 'a1b2c3d4', plan: {}, active: 'a1b2c3d4', lineage: { basis: EVIL, planOfRecord: null,
    plans: [{ id: EVIL, started: EVIL, archived: true, confidence: 0.5, steps: 1, builds: 0, built: 0 }, { id: 'b2c3d4e5', started: EVIL, archived: false, confidence: null, steps: 0, builds: 1, built: 1 }] } });
  assert.ok(lin.includes('Revisions of this question (2)'));
  assert.equal(live(lin), false);
  assert.equal(live(c.recordWarning({ isPlanOfRecord: false, planOfRecord: EVIL })), false);
  assert.equal(live(c.promoteButton({ plan: {}, planId: EVIL, lineage: { planOfRecord: null } })), false);
});

test('client: a thread of one shows no revisions panel; the promote button needs a plan; the warning only appears when the active plan is NOT the record', () => {
  const c = loadClient();
  assert.equal(c.lineageSection({ planId: 'a1b2c3d4', plan: {}, lineage: { plans: [{ id: 'a1b2c3d4' }] } }), '');
  assert.equal(c.lineageSection({ planId: 'a1b2c3d4', plan: {}, lineage: null }), '');
  assert.equal(c.promoteButton({ plan: null, planId: 'a1b2c3d4', lineage: { planOfRecord: null } }), '');
  assert.equal(c.promoteButton({ plan: {}, planId: 'a1b2c3d4', lineage: null }), '');
  assert.match(c.promoteButton({ plan: {}, planId: 'a1b2c3d4', lineage: { planOfRecord: null } }), /data-value="true"[^>]*aria-pressed="false"/);
  assert.match(c.promoteButton({ plan: {}, planId: 'a1b2c3d4', lineage: { planOfRecord: 'a1b2c3d4' } }), /data-value="false"[^>]*aria-pressed="true"/);
  assert.equal(c.recordWarning(null), '');
  assert.equal(c.recordWarning({ isPlanOfRecord: null }), '');
  assert.equal(c.recordWarning({ isPlanOfRecord: true, planOfRecord: 'a1b2c3d4' }), '');
  assert.match(c.recordWarning({ isPlanOfRecord: false, planOfRecord: 'b2c3d4e5' }), /data-act="activate" data-id="b2c3d4e5"/);
});

test('client: Compare is offered only against OTHER, archived revisions, and only when this plan itself has an archive', () => {
  const c = loadClient();
  const lineage = { basis: 'x', planOfRecord: 'b2c3d4e5', plans: [
    { id: 'a1b2c3d4', started: '', archived: true, confidence: null, steps: 0, builds: 0, built: 0 },
    { id: 'b2c3d4e5', started: '', archived: true, confidence: null, steps: 0, builds: 0, built: 0 },
    { id: 'c3d4e5f6', started: '', archived: false, confidence: null, steps: 0, builds: 0, built: 0 }] };
  const html = c.lineageSection({ planId: 'a1b2c3d4', plan: {}, active: null, lineage });
  assert.equal((html.match(/data-act="compare"/g) || []).length, 1, 'only against the one other archived plan');
  assert.match(html, /data-id="a1b2c3d4" data-other="b2c3d4e5"/);
  assert.match(html, /this plan/);
  assert.match(html, /plan of record/);
  assert.match(html, /not archived/);
  assert.equal((c.lineageSection({ planId: 'a1b2c3d4', plan: null, active: null, lineage }).match(/data-act="compare"/g) || []).length, 0, 'this plan has no archive: nothing to compare from');
});
