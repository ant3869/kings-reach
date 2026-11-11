// tests/history-export.test.mjs - the Markdown export of a run: complete, safe to share, and well-formed. Fixtures only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { STORE_DIR } from '../dist/config.js';
import { exportMarkdown, fence, demoteHeadings } from '../dist/history-export.js';
import { setRating } from '../dist/history.js';
import { mountHistory } from '../dist/history-routes.js';

const FIXTURES = join(STORE_DIR, 'test-fixtures-export'); // its own folder: files run in parallel and another's cleanup would delete these
after(() => rmSync(FIXTURES, { recursive: true, force: true }));

const SECRET = ['sk-ant', 'api03', 'FAKE'.repeat(6)].join('-'); // built at run time so no secret scanner mistakes this file for a leak
function fixture(artifacts = {}) {
  mkdirSync(FIXTURES, { recursive: true });
  const root = mkdtempSync(join(FIXTURES, 'x-'));
  const p = { runsFile: join(root, 'runs.jsonl'), verdictJson: join(root, 'v.json'), verdictMd: join(root, 'v.md'), archiveDir: join(root, 'verdicts'), councilDir: join(root, 'council') };
  const runs = [
    { id: 'a1b2c3d4', kind: 'summit', question: 'Plan the | motion', started: '2026-01-01T10:00:00', outcome: 'verdict', total_s: 100, total_cost_usd: 1.5,
      verdict_confidence: 0.8, plan_steps: 1, specialists: ['ops', 'research'], memory_lines_used: 3, stages: { plan: 10, debate: 20 },
      agents: { main: { cost_usd: 0.5, turns: 4, seconds: 30, calls: 1, models: ['m|1'] } }, evidence: ['seen it'] },
    { id: 'c3d4e5f6', kind: 'build', question: 'Plan the | motion', started: '2026-01-01T11:00:00', outcome: 'needs_work', verdict_run: 'a1b2c3d4', total_s: 50, total_cost_usd: 0.4,
      changed_files: ['src/a.ts', 'src/b.ts'], checks_ok: false, approved: false, gate_output: 'error TS1: ```nope```', failure_summary: 'Checks failed.' },
    { id: 'e5f6a7b8', kind: 'summit', question: 'No plan here', started: '2026-01-01T09:00:00', outcome: 'no_verdict' },
  ];
  writeFileSync(p.runsFile, runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(p.verdictJson, JSON.stringify({ run: 'a1b2c3d4', question: 'Plan the motion', objective: 'Ship motion', confidence: 0.8, verdict: 'Do it.',
    success_criteria: ['it moves'], plan: [{ owner: 'ops', step: 'write it', done_when: 'it compiles' }] }));
  writeFileSync(p.verdictMd, '# Summit verdict (a1b2c3d4)\n\n## Takes\n```sh\n# not a heading\n```\n## Plan\n1. write it');
  mkdirSync(join(p.councilDir, 'a1b2c3d4'), { recursive: true });
  for (const [name, text] of Object.entries(artifacts)) writeFileSync(join(p.councilDir, 'a1b2c3d4', name), text);
  return p;
}

test('export: a council run carries its question, plan, builds, timings and spend, with a single top title', () => {
  const p = fixture({ 'notes.md': 'hello deliverable' });
  const e = exportMarkdown('a1b2c3d4', p, {});
  assert.equal(e.filename, 'kings-reach-council-a1b2c3d4.md');
  const md = e.markdown;
  assert.equal(md.replace(/```[\s\S]*?```/g, '').match(/^# /gm).length, 1, 'one top-level title, so it can be pasted under another document');
  for (const want of ['Plan the | motion', 'm\\|1', '| Verdict confidence | 0.8 |', 'ops, research', '## Builds that executed this plan', 'c3d4e5f6', 'needs_work', '## Stage timings', '| main | $0.50 |', 'hello deliverable', '## Deliverable: notes.md', '"evidence"']) {
    assert.ok(md.includes(want), `missing: ${want}`);
  }
  assert.ok(md.includes('## Summit verdict (a1b2c3d4)') && md.includes('### Takes'), 'the saved verdict is included, one heading level down');
  assert.ok(md.includes('\n# not a heading\n'), 'a # line inside a code fence is not a heading and must not be touched');
});

test('export: a build lists changed files, check output and the plan it executed; a failure reason is shown', () => {
  const md = exportMarkdown('c3d4e5f6', fixture(), {}).markdown;
  for (const want of ['# King\'s Reach report: build c3d4e5f6', '| Automated checks | failed |', '## Changed files (2)', '- src/a.ts', '### Why it did not complete', 'Checks failed.', 'The plan this build executed (run a1b2c3d4)', '1. write it']) {
    assert.ok(md.includes(want), `missing: ${want}`);
  }
  assert.ok(md.includes('````\nerror TS1: ```nope```\n````'), 'check output containing ``` must get a longer fence so it cannot break the document');
});

test('export: secrets are redacted before the file leaves, and it says so', () => {
  const p = fixture({ 'leak.md': `token ${SECRET} and MYPASS=hunter2hunter2` });
  const e = exportMarkdown('a1b2c3d4', p, { WAR_PASSWORD: 'hunter2hunter2' });
  assert.ok(!e.markdown.includes(SECRET) && !e.markdown.includes('hunter2hunter2'));
  assert.ok(e.redactions.includes('anthropic-key') && e.redactions.includes('WAR_PASSWORD'));
  assert.match(e.markdown, /secret-looking value type\(s\) were redacted/);
});

test('export: a run with no plan says so, a huge deliverable is cut honestly, and bad ids give nothing', () => {
  const none = exportMarkdown('e5f6a7b8', fixture(), {}).markdown;
  assert.ok(none.includes('No plan was locked for this run (outcome: no_verdict).'));
  const big = exportMarkdown('a1b2c3d4', fixture({ 'big.md': 'x'.repeat(25_000) }), {}).markdown;
  assert.ok(big.includes('Cut at 20,000 of 25,000 characters') && big.includes('workspace/council/a1b2c3d4/big.md'));
  const p = fixture();
  for (const bad of ['deadbeef', '../x', 'A1B2C3D4', '']) assert.equal(exportMarkdown(bad, p, {}), null, bad);
});

test('export: your rating is part of the record, and fence()/demoteHeadings() hold up', () => {
  const p = fixture();
  setRating('a1b2c3d4', -1, p);
  assert.ok(exportMarkdown('a1b2c3d4', p, {}).markdown.includes('| Your rating | not useful |'));
  assert.equal(fence('a ```` b'), '`````\na ```` b\n`````');
  assert.equal(demoteHeadings('# a\n~~~\n# b\n~~~\n## c\n````\n```\n# d\n```\n````\n# e'), '## a\n~~~\n# b\n~~~\n### c\n````\n```\n# d\n```\n````\n## e');
});

test('export route: serves the file as a download for a real run, 404 for an unknown one', async () => {
  const p = fixture();
  const app = new Hono();
  mountHistory(app, p);
  const ok = await app.request('/api/history/c3d4e5f6/export.md');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /text\/markdown/);
  assert.equal(ok.headers.get('content-disposition'), 'attachment; filename="kings-reach-build-c3d4e5f6.md"');
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(await ok.text(), /King's Reach report: build c3d4e5f6/);
  assert.equal((await app.request('/api/history/deadbeef/export.md')).status, 404);
});
