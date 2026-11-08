// src/voice.ts - STT cascade (Groq Whisper -> whisper-cpp) and
// TTS cascade (Kokoro local -> OS speech). Build pick: stt_groq + tts_kokoro_local.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  GROQ_API_KEY,
  KOKORO_MODEL,
  KOKORO_URL,
  KOKORO_VOICE,
  TTS_PROVIDER,
  WHISPER_CPP_BIN,
  WHISPER_CPP_MODEL,
  XAI_API_KEY,
  XAI_LANG,
  XAI_VOICE,
} from './config.js';

const execFileAsync = promisify(execFile);

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const KOKORO_SPEECH_PATH = '/v1/audio/speech';
const XAI_TTS_URL = 'https://api.x.ai/v1/tts';

export interface VoiceCapabilities {
  stt: 'groq' | 'whisper-cpp' | null;
  tts: 'xai' | 'kokoro' | 'os' | 'off';
}


/** Groq rejects .oga (Telegram voice notes) - same bytes as .ogg, just rename. */
function withSendableExtension(filePath: string): { sendPath: string; cleanup: () => void } {
  if (!filePath.toLowerCase().endsWith('.oga')) return { sendPath: filePath, cleanup: () => {} };
  const sendPath = `${filePath.slice(0, -4)}.ogg`;
  fs.copyFileSync(filePath, sendPath);
  return { sendPath, cleanup: () => fs.rmSync(sendPath, { force: true }) };
}

/** Primary STT: Groq Whisper large-v3. */
export async function transcribeAudioGroq(filePath: string): Promise<string> {
  const key = GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY is not set');
  const { sendPath, cleanup } = withSendableExtension(filePath);
  try {
    const form = new FormData();
    form.set('model', 'whisper-large-v3');
    form.set('file', new Blob([fs.readFileSync(sendPath)]), path.basename(sendPath));
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) throw new Error(`groq stt ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  } finally {
    cleanup();
  }
}

/** Fallback STT: local whisper-cpp binary (expects -m model -f file --output-txt). */
export async function transcribeAudioLocal(filePath: string): Promise<string> {
  const bin = WHISPER_CPP_BIN;
  const model = WHISPER_CPP_MODEL;
  const args = model ? ['-m', model, '-f', filePath, '--output-txt'] : ['-f', filePath];
  const { stdout } = await execFileAsync(bin, args, { timeout: 120_000 });
  return stdout.trim();
}

/** STT cascade: Groq first, whisper-cpp if Groq is missing or fails. */
export async function transcribeAudio(filePath: string): Promise<string> {
  if (GROQ_API_KEY) {
    try {
      return await transcribeAudioGroq(filePath);
    } catch (err) {
      console.error(`[voice] groq stt failed, trying whisper-cpp: ${String(err)}`);
    }
  }
  return transcribeAudioLocal(filePath);
}

/** xAI Grok TTS: POST https://api.x.ai/v1/tts, same key as Grok. Returns mp3 bytes. */
export async function synthesizeXai(text: string): Promise<Buffer> {
  const key = XAI_API_KEY;
  if (!key) throw new Error('XAI_API_KEY is not set');
  const res = await fetch(XAI_TTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: text.slice(0, 4000),
      voice_id: XAI_VOICE,
      language: XAI_LANG,
    }),
  });
  if (!res.ok) throw new Error(`xai tts ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Primary TTS: any OpenAI-compatible server (Kokoro). Returns mp3 bytes. */
export async function synthesizeKokoro(text: string): Promise<Buffer> {
  // .env may hold the base URL or the full endpoint; never double the path.
  const base = KOKORO_URL.replace(/\/+$/, '').replace(/\/v1\/audio\/speech$/, '');
  const res = await fetch(`${base}${KOKORO_SPEECH_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: KOKORO_MODEL,
      input: text.slice(0, 4000),
      voice: KOKORO_VOICE,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`kokoro tts ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * PowerShell single-quoted literal: no $() or backtick expansion. JSON.stringify produced a
 * double-quoted string, so agent text like $(Remove-Item ...) EXECUTED. Exported for tests.
 */
export function psLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "''")}'`;
}

/** Last-resort TTS: OS speech (PowerShell SAPI on Windows, say on macOS). */
export async function synthesizeOs(text: string): Promise<Buffer | null> {
  const wav = path.join(os.tmpdir(), `kings-reach-say-${Date.now()}.wav`);
  try {
    if (process.platform === 'win32') {
      const script =
        `Add-Type -AssemblyName System.Speech; ` +
        `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
        `$s.SetOutputToWaveFile(${psLiteral(wav)}); ` +
        `$s.Speak(${psLiteral(text.slice(0, 2000))}); $s.Dispose()`;
      await execFileAsync('powershell', ['-NoProfile', '-Command', script], { timeout: 60_000 });
    } else {
      await execFileAsync('say', ['-o', wav, text.slice(0, 2000)], { timeout: 60_000 });
    }
    return fs.readFileSync(wav);
  } catch (err) {
    console.error(`[voice] os tts failed: ${String(err)}`);
    return null;
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

/** TTS cascade: xAI Grok first (same key), Kokoro local second, OS speech fallback. Never throws. */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  if (TTS_PROVIDER === 'off') return null;
  if (XAI_API_KEY) {
    try {
      return await synthesizeXai(text);
    } catch (err) {
      console.error(`[voice] xai tts failed, trying kokoro: ${String(err)}`);
    }
  }
  try {
    return await synthesizeKokoro(text);
  } catch (err) {
    console.error(`[voice] kokoro tts failed, trying os speech: ${String(err)}`);
  }
  return synthesizeOs(text);
}
