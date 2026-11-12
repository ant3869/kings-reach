// public/warroom-voice.js - the room's ears and mouths. No dependencies, no framework.
//   Ears:   mic -> AudioWorklet -> 16 kHz int16 utterance -> onUtterance(ArrayBuffer)
//           push-to-talk (hold button / Space) or hands-free (energy VAD, muted while agents talk).
//   Mouths: WAV clips queue and play in order; onLevel(agentId, 0..1) drives the speaking seat.
/* exported WarVoice */
'use strict';

const WarVoice = (() => {
  const RATE = 16000;
  const VAD = { startMs: 140, endMs: 850, preRollMs: 300, minLevel: 0.012, floorMult: 3.2 };
  let ctx = null;
  let mic = null;
  let analyser = null;
  let recording = false;
  let handsFree = false;
  let chunks = [];
  let preRoll = [];
  let noiseFloor = 0.004;
  let loudMs = 0;
  let quietMs = 0;
  const queue = [];
  let current = null;
  let waitingForGesture = false;
  const GESTURES = ['pointerdown', 'keydown'];
  let hooks = { onUtterance() {}, onLevel() {}, onMicState() {}, onSpeaking() {}, onBlocked() {} };

  function audioCtx() {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function downsample(frame, fromRate) {
    const ratio = fromRate / RATE;
    const out = new Float32Array(Math.floor(frame.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(frame.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += frame[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  function rms(frame) {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
    return Math.sqrt(s / frame.length);
  }

  function flush() {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const pcm = new Int16Array(total);
    let o = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) pcm[o++] = Math.max(-32768, Math.min(32767, c[i] * 32768));
    }
    chunks = [];
    if (total > RATE * 0.35) hooks.onUtterance(pcm.buffer);
  }

  function onFrame(raw) {
    const frame = downsample(raw, ctx.sampleRate);
    const ms = (frame.length / RATE) * 1000;
    const level = rms(frame);
    if (recording) {
      chunks.push(frame);
      if (!handsFree) return;
      quietMs = level < Math.max(VAD.minLevel, noiseFloor * VAD.floorMult) ? quietMs + ms : 0;
      if (quietMs > VAD.endMs) stopRecording(true);
      return;
    }
    if (!handsFree || current || queue.length) return; // never listen to our own agents
    preRoll.push(frame);
    while (preRoll.length * ms > VAD.preRollMs) preRoll.shift();
    const threshold = Math.max(VAD.minLevel, noiseFloor * VAD.floorMult);
    if (level > threshold) loudMs += ms;
    else {
      loudMs = 0;
      noiseFloor = noiseFloor * 0.98 + level * 0.02;
    }
    if (loudMs > VAD.startMs) {
      chunks = preRoll.slice();
      preRoll = [];
      startRecording();
    }
  }

  async function ensureMic() {
    if (mic) return true;
    try {
      const c = audioCtx();
      await c.audioWorklet.addModule('/warroom/mic-worklet.js');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const node = new AudioWorkletNode(c, 'mic-tap');
      node.port.onmessage = (e) => onFrame(e.data);
      c.createMediaStreamSource(stream).connect(node);
      mic = { stream, node };
      return true;
    } catch (err) {
      hooks.onMicState('error', String(err && err.message ? err.message : err));
      return false;
    }
  }

  function startRecording() {
    recording = true;
    quietMs = 0;
    hooks.onMicState('recording');
  }

  function stopRecording(send) {
    if (!recording) return;
    recording = false;
    loudMs = 0;
    hooks.onMicState(handsFree ? 'listening' : 'idle');
    if (send) flush();
    else chunks = [];
  }

  // --- mouths ---------------------------------------------------------------------
  function meter() {
    if (!current || !analyser) return;
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128));
    hooks.onLevel(current.agentId, Math.min(1, peak / 70));
    requestAnimationFrame(meter);
  }

  // A browser keeps sound locked until the person has interacted with the page (a click or key press). When a clip arrives while it
  // is still locked, say so once and keep the clip: the next click or key press unlocks the audio and the voices carry on.
  function waitForGesture() {
    if (waitingForGesture) return;
    waitingForGesture = true;
    hooks.onBlocked();
    const go = () => {
      for (const type of GESTURES) document.removeEventListener(type, go, true);
      waitingForGesture = false;
      audioCtx().resume().then(playNext);
    };
    for (const type of GESTURES) document.addEventListener(type, go, true);
  }

  async function playNext() {
    if (current || !queue.length) return;
    const c = audioCtx();
    if (c.state === 'suspended') return waitForGesture();
    const clip = queue.shift();
    let buffer;
    try {
      buffer = await c.decodeAudioData(clip.wav);
    } catch (err) {
      playNext();
      return;
    }
    if (!analyser) {
      analyser = c.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(c.destination);
    }
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(analyser);
    current = { agentId: clip.agentId, src };
    hooks.onSpeaking(clip.agentId, true);
    src.onended = () => {
      hooks.onSpeaking(clip.agentId, false);
      hooks.onLevel(clip.agentId, 0);
      current = null;
      playNext();
    };
    src.start();
    meter();
  }

  return {
    init(h) {
      hooks = Object.assign(hooks, h);
    },
    enqueue(agentId, wav) {
      queue.push({ agentId, wav });
      playNext();
    },
    silence() {
      queue.length = 0;
      if (current) {
        const { src } = current;
        current = null;
        try {
          src.stop();
        } catch (err) {
          /* already stopped */
        }
      }
    },
    busy: () => Boolean(current || queue.length),
    async pressToTalk() {
      if (!(await ensureMic())) return;
      WarVoice.silence(); // barge-in: you talk, they stop
      chunks = [];
      startRecording();
    },
    releaseToTalk() {
      stopRecording(true);
    },
    async setHandsFree(on) {
      if (on && !(await ensureMic())) return false;
      handsFree = on;
      if (!on) stopRecording(false);
      hooks.onMicState(on ? 'listening' : 'idle');
      return true;
    },
    unlock: () => audioCtx(), // browsers need a user gesture before audio can play
  };
})();
