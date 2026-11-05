// Guards for the War Room reconnect behaviour and the health field that was misread as "28 open tabs" (summit 241424d9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../dist/config.js';

const app = readFileSync(join(PROJECT_ROOT, 'public', 'warroom-app.js'), 'utf8');
const between = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from)));

test('the reconnect backoff is not reset by a bare handshake, only by a pong', () => {
  assert.ok(!/retryMs\s*=\s*2000/.test(between('ws.onopen', 'ws.onmessage')), 'onopen must not reset the backoff');
  assert.match(between('if (m.pong)', 'return;'), /retryMs\s*=\s*2000/);
});

test('a fresh socket starts its silence clock, so a mute server cannot keep a tab open forever', () => {
  assert.match(between('function connect()', 'ws.onopen'), /lastPong\s*=\s*Date\.now\(\)/);
});

test('health reports page versions as clientVersions, never as a "clients" count', async () => {
  const src = readFileSync(join(PROJECT_ROOT, 'src', 'health.ts'), 'utf8');
  assert.match(src, /clientVersions:/);
  assert.ok(!/\bclients:/.test(src));
});
