// Memory upkeep: decay must step once per tier (not once per sweep) and embeddings must score correctly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decayStep } from '../dist/memory.js';
import {
  cosineSimilarity,
  embeddingToBuffer,
  storedToEmbedding,
} from '../dist/embeddings.js';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const row = (importance, ageDays, decayedAgoDays = null) => ({
  importance,
  last_accessed: NOW - ageDays * DAY,
  decayed_at: decayedAgoDays === null ? null : NOW - decayedAgoDays * DAY,
});

test('decay: fresh memories are untouched', () => {
  assert.deepEqual(decayStep(row(0.9, 10), NOW), { action: 'keep' });
  assert.deepEqual(decayStep(row(0.5, 13), NOW), { action: 'keep' });
});

test('decay: first step fires once the tier has passed', () => {
  const s = decayStep(row(0.9, 61), NOW);
  assert.equal(s.action, 'decay');
  assert.ok(Math.abs(s.importance - 0.8) < 1e-9);
});

test('decay: a repeat sweep right after a step does nothing (no compounding on restarts)', () => {
  assert.deepEqual(decayStep(row(0.8, 61, 0), NOW), { action: 'keep' });
  assert.deepEqual(decayStep(row(0.8, 61, 1), NOW), { action: 'keep' });
});

test('decay: next step fires only after another full tier', () => {
  assert.equal(decayStep(row(0.7, 95, 31), NOW).action, 'decay');
});

test('decay: floor memory is deleted only when stale beyond two tiers', () => {
  assert.equal(decayStep(row(0.2, 20), NOW).action, 'decay'); // 0.1 next, not stale enough to delete
  assert.deepEqual(decayStep(row(0.2, 29), NOW), { action: 'delete' });
});

test('embeddings: Float32Array round trip survives an unaligned Buffer view', () => {
  const v = [0.25, -0.5, 1, 0];
  const padded = Buffer.concat([Buffer.from([7]), embeddingToBuffer(v)]);
  const view = padded.subarray(1); // byteOffset 1: would throw if we aliased it as Float32Array
  assert.deepEqual([...storedToEmbedding(view)], v);
  assert.deepEqual([...storedToEmbedding(embeddingToBuffer(v).toString('hex'))], v); // a hex string, as older rows stored it
  assert.equal(storedToEmbedding(null), null);
});

test('embeddings: cosine works on typed arrays and rejects mismatched sizes', () => {
  const a = new Float32Array([1, 0, 0]);
  assert.ok(Math.abs(cosineSimilarity(a, [1, 0, 0]) - 1) < 1e-6);
  assert.equal(cosineSimilarity(a, [0, 1, 0]), 0);
  assert.equal(cosineSimilarity(a, [1, 0]), 0);
});
