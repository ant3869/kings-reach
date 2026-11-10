// schedule-cli and mission-cli share one `create` path (createTaskFromArgs). These run the real built CLIs against a throwaway database,
// so they pin what a user sees (ids, replies, clamping, errors) whether the code behind it is one copy or two.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const dir = mkdtempSync(join(tmpdir(), 'kr-task-cli-'));
const env = { ...process.env, KINGS_REACH_DB: join(dir, 'tasks.db') };
// The CLIs expect the core to have made the tables already, so make them the way the core does (in a child: db.ts reads the env at import).
const dbUrl = pathToFileURL(join(dist, 'db.js')).href;
const init = spawnSync(process.execPath, ['--input-type=module', '-e', `import { initDatabase, closeDb } from '${dbUrl}'; initDatabase(); closeDb();`], { env, encoding: 'utf8' });
assert.equal(init.status, 0, init.stderr);
const cli = (name, ...args) => {
  const r = spawnSync(process.execPath, [join(dist, `${name}-cli.js`), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('schedule-cli create: tsch_ id, default agent and priority, plain reply', () => {
  const r = cli('schedule', 'create', 'water the plants', '0 9 * * *', '123');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Created tsch_[0-9a-f]{8}, next run /);
  assert.match(cli('schedule', 'list').out, /tsch_[0-9a-f]{8} \| active \| 3 \| main \|.*\| 0 9 \* \* \* \| water the plants/);
});

test('mission-cli create: msn_ id, the chosen agent, and the reply names agent and priority', () => {
  const r = cli('mission', 'create', 'draft the post', '0 8 * * 1', '123', 'comms', '2');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Mission msn_[0-9a-f]{8} -> comms \(p2\), next /);
  assert.match(cli('mission', 'list', '--agent=comms').out, /msn_[0-9a-f]{8} \| active \| 2 \| comms \|/);
});

test('one mission-cli command is one command: create stores exactly one task, and the schedule CLI does not also run', () => {
  const before = cli('mission', 'list').out.split('\n').filter((l) => /^(msn|tsch)_/.test(l)).length;
  cli('mission', 'create', 'only once', '0 6 * * *', '123');
  const rows = cli('mission', 'list').out.split('\n').filter((l) => /^(msn|tsch)_/.test(l));
  assert.equal(rows.length - before, 1, `expected one new task, got:\n${rows.join('\n')}`);
  assert.equal(rows.filter((l) => l.includes('only once')).length, 1);
  assert.ok(!rows.some((l) => l.startsWith('tsch_') && l.includes('only once')), 'mission-cli must not create a schedule-cli task');
});

test('priority is clamped to 1-5 and falls back to 3 when it is not a number', () => {
  const ask = (p) => cli('mission', 'create', `p-${p}`, '0 7 * * *', '123', 'ops', p).out.match(/\(p(\d)\)/)[1];
  assert.deepEqual(['0', '9', 'abc', '4'].map(ask), ['3', '5', '3', '4']);
});

test('a bad cron expression and missing arguments both fail with exit 1 and say why', () => {
  for (const name of ['schedule', 'mission']) {
    const bad = cli(name, 'create', 'x', 'not a cron', '123');
    assert.equal(bad.code, 1);
    assert.match(bad.err, /Invalid cron expression: not a cron/);
    const missing = cli(name, 'create', 'only a prompt');
    assert.equal(missing.code, 1);
    assert.match(missing.out, new RegExp(`Usage: ${name}-cli`));
  }
});
