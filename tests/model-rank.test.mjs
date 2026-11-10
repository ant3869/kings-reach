// Model ordering from names alone: generation first, then size. The ladders in Settings are built from this.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelRank, rankModels } from '../dist/model-rank.js';

test('claude: generation first, then family, so sonnet 4-6 < opus 4-6 < sonnet 5 < opus 5-5', () => {
  const shuffled = ['claude-opus-5-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-6', 'claude-haiku-4-5'];
  assert.deepEqual(rankModels(shuffled), ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-opus-5-5']);
  assert.ok(modelRank('claude-3-5-sonnet-20241022') < modelRank('claude-sonnet-4-6')); // old naming, date suffix ignored
});

test('openai and gemini: version beats size, size orders within a version', () => {
  assert.deepEqual(rankModels(['gpt-5-mini', 'gpt-4.1-mini', 'gpt-5.4', 'gpt-5']), ['gpt-4.1-mini', 'gpt-5-mini', 'gpt-5', 'gpt-5.4']);
  assert.deepEqual(rankModels(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']), ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']);
  assert.ok(modelRank('cx/gpt-5.6-terra') > modelRank('cx/gpt-5.4-mini'));
});

test('names that cannot be ranked are left out, and parameter counts are not read as versions', () => {
  assert.equal(modelRank('default'), null);
  assert.deepEqual(rankModels(['default', 'gpt-5', 'default']), ['gpt-5']);
  assert.equal(modelRank('qwen/qwen3-235b-a22b'), 3000); // "3", not "3.235"
  assert.equal(modelRank('gpt-4-proton'), 4000); // "pro" inside a longer word is not the size word
  assert.equal(modelRank('gpt-5-pro'), 5001);
});

test('image, speech and embedding models are never ranked, so they cannot land on a chat ladder', () => {
  for (const id of ['meta/muse-image-1.0', 'meta/muse-voice-transcribe-1.0', 'text-embedding-3-large', 'whisper-large-v3', 'gpt-4o-audio-preview', 'tts-1']) {
    assert.equal(modelRank(id), null, id);
  }
  assert.deepEqual(rankModels(['meta/muse-spark-1.3', 'meta/muse-image-1.0']), ['meta/muse-spark-1.3']);
  assert.notEqual(modelRank('claude-imagine-5'), null); // only whole words count
});

test('equal ranks keep a stable alphabetical order and duplicates collapse', () => {
  assert.deepEqual(rankModels(['m-2b', 'a-2b', 'm-2b']), ['a-2b', 'm-2b']);
});
