// public/card-director.js is a browser file (UMD, no DOM); load it in a bare vm context exactly as a page would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { PROJECT_ROOT } from '../dist/config.js';

const sandbox = {};
vm.runInNewContext(readFileSync(join(PROJECT_ROOT, 'public', 'card-director.js'), 'utf8'), sandbox);
const { create, resolve, load } = sandbox.CardDirector;

const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'public', 'card-states', 'manifest.json'), 'utf8'));
const seeded = (seed = 7) => () => (seed = (seed * 16807) % 2147483647) / 2147483647; // deterministic rng

test('resolve: speaking > building > live pose > researching/thinking > idle', () => {
  const now = 1000;
  const live = { state: 'offense', until: now + 5000 };
  const expired = { state: 'offense', until: now - 1 };
  assert.equal(resolve({ speaking: true, building: true, thinking: true, pose: live }, now, ''), 'speaking');
  assert.equal(resolve({ building: true, thinking: true, pose: live }, now, ''), 'building');
  assert.equal(resolve({ thinking: true, pose: live }, now, ''), 'offense');
  assert.equal(resolve({ thinking: true, pose: expired }, now, ''), 'thinking');
  assert.equal(resolve({ thinking: true, pose: null }, now, 'investigate'), 'researching');
  assert.equal(resolve({ thinking: false, pose: expired }, now, 'investigate'), 'idle');
  assert.equal(resolve(undefined, now, ''), 'idle');
});

test('pick: never repeats a seat\'s previous art while alternatives exist', () => {
  const d = create(manifest, { rng: seeded() });
  let prev = '';
  for (let i = 0; i < 200; i++) {
    const src = d.pick('speaking', 'ops');
    assert.notEqual(src, prev);
    prev = src;
  }
});

test('pick: every pool entry resolves to the seat\'s own role and a webp under card-states', () => {
  const d = create(manifest, { rng: seeded(3) });
  for (const state of Object.keys(manifest.pools)) {
    for (let i = 0; i < 40; i++) {
      const src = d.pick(state, 'comms');
      assert.match(src, /^\/warroom\/card-states\/(sets|composed)\/[\w/-]+-comms\.webp$/, `${state}: ${src}`);
    }
  }
});

test('pick: weights are honoured (set_2 idle is picked more often than a composed close-up)', () => {
  const d = create(manifest, { rng: seeded(11) });
  const counts = {};
  for (let i = 0; i < 4000; i++) {
    // fresh seat id each time so the no-repeat rule cannot flatten the distribution
    const src = d.pick('idle', 'seat' + i).replace(/seat\d+/, 'ROLE');
    const key = src.includes('set_2') ? 'set_2' : src.includes('set_1') ? 'set_1' : 'composed';
    counts[key] = (counts[key] || 0) + 1;
  }
  assert.ok(counts.set_2 > counts.set_1 && counts.set_1 > counts.composed / 2, JSON.stringify(counts));
});

test('rotation: transient poses hold; long states rotate within their configured range', () => {
  const d = create(manifest, { rng: seeded(5) });
  for (const hold of ['offense', 'defense', 'confused', 'defeated']) assert.equal(d.rotateDelayMs(hold), null);
  for (const state of ['idle', 'thinking', 'speaking', 'building']) {
    const [lo, hi] = manifest.rotateSeconds[state];
    for (let i = 0; i < 50; i++) {
      const ms = d.rotateDelayMs(state);
      assert.ok(ms >= lo * 1000 && ms <= hi * 1000, `${state} ${ms}`);
    }
  }
  assert.ok(d.poseMs('defeated') > d.poseMs('offense'));
});

test('without a manifest the original four-state art is used, and new poses borrow the nearest look', async () => {
  const d = create(null);
  assert.equal(d.pick('thinking', 'ops'), '/warroom/card-states/individual/thinking-ops.png');
  assert.equal(d.pick('defeated', 'main'), '/warroom/card-states/individual/idle-main.png');
  assert.equal(d.pick('offense', 'main'), '/warroom/card-states/individual/speaking-main.png');
  assert.equal(d.rotateDelayMs('idle'), null);
  const failed = await load(async () => { throw new Error('offline'); });
  assert.equal(failed.pick('idle', 'main'), '/warroom/card-states/individual/idle-main.png');
  const notFound = await load(async () => ({ ok: false, status: 404 }));
  assert.equal(notFound.pick('building', 'ops'), '/warroom/card-states/individual/building-ops.png');
});
