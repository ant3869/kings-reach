// The War Room's voices when the browser is holding sound back (autoplay policy): say so once, keep the clips, and play them
// all, in order, after the next click or key press. A fake audio context stays locked until a "gesture", exactly as Chrome does.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../public/warroom-voice.js', import.meta.url), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 5));

function room({ locked }) {
  const env = { gesture: !locked, played: [], blocked: 0, listeners: {} };
  class FakeContext {
    constructor() { this.state = locked ? 'suspended' : 'running'; this.destination = {}; }
    resume() { if (env.gesture) this.state = 'running'; return Promise.resolve(); }
    decodeAudioData(wav) { return Promise.resolve({ wav }); }
    createAnalyser() { return { fftSize: 0, connect() {}, getByteTimeDomainData() {} }; }
    createBufferSource() {
      const src = { connect() {}, stop() {}, start() { env.played.push(src.buffer.wav); env.now = src; } };
      return src;
    }
  }
  const document = {
    addEventListener: (type, fn) => { env.listeners[type] = fn; },
    removeEventListener: (type) => { delete env.listeners[type]; },
  };
  const context = vm.createContext({ AudioContext: FakeContext, document, requestAnimationFrame() {}, navigator: {}, console });
  vm.runInContext(SRC, context);
  const voice = vm.runInContext('WarVoice', context);
  voice.init({ onBlocked: () => { env.blocked += 1; } });
  return { voice, env };
}

test('voices: a clip that arrives while sound is locked is held, announced once, and not lost', async () => {
  const { voice, env } = room({ locked: true });
  voice.enqueue('main', 'clip-1');
  voice.enqueue('research', 'clip-2');
  await tick();
  assert.equal(env.blocked, 1, 'said once, not once per clip');
  assert.deepEqual(env.played, [], 'nothing plays while locked');
  assert.ok(env.listeners.pointerdown && env.listeners.keydown, 'waiting for a click or a key press');
  assert.equal(voice.busy(), true, 'the clips are still queued');
});

test('voices: the next click unlocks sound and every held clip plays, in order', async () => {
  const { voice, env } = room({ locked: true });
  voice.enqueue('main', 'clip-1');
  voice.enqueue('research', 'clip-2');
  await tick();
  env.gesture = true;
  env.listeners.pointerdown();
  await tick();
  assert.deepEqual(env.played, ['clip-1'], 'the first plays at once');
  assert.deepEqual(Object.keys(env.listeners), [], 'the gesture listeners are removed after use');
  env.now.onended();
  await tick();
  assert.deepEqual(env.played, ['clip-1', 'clip-2'], 'then the second, in the order they arrived');
  assert.equal(env.blocked, 1);
});

test('voices: when sound is already unlocked nothing is announced and clips play straight away', async () => {
  const { voice, env } = room({ locked: false });
  voice.enqueue('main', 'clip-1');
  await tick();
  assert.deepEqual(env.played, ['clip-1']);
  assert.equal(env.blocked, 0);
  assert.deepEqual(Object.keys(env.listeners), []);
});

test('voices: Hush (silence) drops held clips instead of playing them late after a click', async () => {
  const { voice, env } = room({ locked: true });
  voice.enqueue('main', 'clip-1');
  await tick();
  voice.silence();
  env.gesture = true;
  env.listeners.pointerdown();
  await tick();
  assert.deepEqual(env.played, [], 'a hushed room stays hushed');
});
