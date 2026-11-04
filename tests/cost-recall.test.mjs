// Failed-attempt cost accounting + read-only memory recall (found in the v2.13 summit post-mortem).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT } from '../dist/config.js';
import { wastedCost } from '../dist/agent.js';

test('wastedCost counts what failed attempts burned, ignoring attempts with no cost', () => {
  assert.equal(wastedCost([]), 0);
  assert.equal(wastedCost([{ provider: 'chatgpt', model: 'x', error: 'skipped: tools required' }]), 0);
  const total = wastedCost([
    { provider: 'claude', model: 'm', error: 'max turns', costUsd: 0.65 },
    { provider: 'gemini', model: 'g', error: 'skipped' },
    { provider: 'claude', model: 'm', error: 'max turns', costUsd: 0.59 },
    { provider: 'codex', model: 'c' },
  ]);
  assert.ok(Math.abs(total - 1.24) < 1e-9, `got ${total}`);
});

test('openReadOnly: recall can read a database it cannot write, and writes are refused', () => {
  const dir = join(PROJECT_ROOT, 'store', 'tmp', `ro-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const script = `
    import { initDatabase, closeDb, openReadOnly, getRecentHiveMind, logToHiveMind } from ${JSON.stringify('file:///' + PROJECT_ROOT.replace(/\\/g, '/') + '/dist/db.js')};
    initDatabase(); logToHiveMind('ops', 'probe', 'hello from the hive'); closeDb();
    const h = openReadOnly();
    const rows = getRecentHiveMind(5);
    let refused = false;
    try { h.prepare("INSERT INTO hive_mind (agent_id, action_type, summary, created_at) VALUES ('x','y','z',0)").run(); } catch (e) { refused = /readonly/i.test(String(e)); }
    console.log(JSON.stringify({ read: rows.map((r) => r.summary), refused }));
  `;
  try {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, CLAUDECLAW_DB: join(dir, 'test.db') },
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual(out.read, ['hello from the hive']);
    assert.equal(out.refused, true, 'a read-only handle must refuse writes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
