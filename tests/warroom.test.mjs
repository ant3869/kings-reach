// tests/warroom.test.mjs - runs the Python war room unit tests with the configured WARROOM_PYTHON,
// so `npm test` is the one command for both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { WARROOM_PYTHON } from '../dist/config.js';

test('war room python unit tests', { skip: !WARROOM_PYTHON && 'WARROOM_PYTHON not set' }, () => {
  const r = spawnSync(WARROOM_PYTHON, ['-m', 'unittest', '-v', 'tests/test_warroom.py', 'tests/test_live.py', 'tests/test_execute.py', 'tests/test_summit.py'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-3000));
});
