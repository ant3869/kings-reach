// Bridge logging: only the agent bridge gets its own log file, the file is capped, and a real bridge process writes to it
// (not to the stdout that carries its reply back to Python).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BRIDGE_LOG_MAX_BYTES, logFileFor, rotateIfLarge } from '../dist/log-target.js';

test('logFileFor: only the agent bridge entry point has its own file', () => {
  const store = join('x', 'store');
  assert.equal(logFileFor(join('a', 'dist', 'agent-voice-bridge.js'), store), join(store, 'logs', 'bridge.log'));
  assert.equal(logFileFor('C:\\proj\\src\\agent-voice-bridge.ts', store), join(store, 'logs', 'bridge.log'));
  for (const other of [join('dist', 'index.js'), join('dist', 'mission-cli.js'), 'agent-voice-bridge.js.map', 'my-agent-voice-bridge.js', '', undefined]) {
    assert.equal(logFileFor(other, store), undefined, `${other} keeps logging to stdout`);
  }
});

test('no logger call in src uses a key pino already owns (level, time, msg, pid, hostname): it would shadow the real one', () => {
  // A `level:` field once sat beside pino's severity in the difficulty-tier line, so every JSON reader saw the difficulty
  // (0.17) where the severity (30) belonged.
  const offenders = [];
  for (const file of readdirSync('src').filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(join('src', file), 'utf8');
    for (const call of text.matchAll(/logger\.(?:trace|debug|info|warn|error|fatal)\(\{([^}]*)\}/g)) {
      for (const key of call[1].matchAll(/(?:^|[,{\s])(level|time|msg|pid|hostname):/g)) offenders.push(`${file}: ${key[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('rotateIfLarge: under the cap nothing moves; over it the file becomes .1 (replacing the older one)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kr-log-'));
  try {
    const file = join(dir, 'bridge.log');
    assert.equal(rotateIfLarge(file, 10), false, 'no file is not an error');
    writeFileSync(file, '0123456789');
    assert.equal(rotateIfLarge(file, 10), false, 'exactly at the cap stays');
    writeFileSync(file, '0123456789!');
    writeFileSync(`${file}.1`, 'older generation');
    assert.equal(rotateIfLarge(file, 10), true);
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(`${file}.1`, 'utf8'), '0123456789!');
    assert.ok(BRIDGE_LOG_MAX_BYTES >= 1024 * 1024, 'a council writes a few KB; the cap is generous');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a real bridge process keeps its stdout to the reply alone (its log lines go to the file, not into the reply channel)', () => {
  // `op: record` with nothing to record exercises the real entry point and logger without any model call.
  // (That a decision line really lands in store/logs/bridge.log was checked live with one cheap recall-stage call.)
  const r = spawnSync(process.execPath, [resolve('dist', 'agent-voice-bridge.js'), '-'], {
    input: JSON.stringify({ op: 'record', chatId: 'log-target-test' }), encoding: 'utf8', timeout: 60_000,
  });
  const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `stdout carries only the reply, got: ${r.stdout.slice(0, 300)}`);
  assert.equal(JSON.parse(lines[0]).ok, true);
});
