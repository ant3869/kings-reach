// TTS smoke test: reads .env at runtime, synthesizes via xAI, saves MP3. No secrets in code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const envRaw = fs.readFileSync(path.join(root, '.env'), 'utf8');
for (const line of envRaw.split('\n')) {
  const m = line.trim().match(/^([A-Za-z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const { synthesizeXai } = await import('../dist/voice.js');
const text = process.argv[2] || 'Hello ant! Mission Control is online. Your five agents are ready.';
const audio = await synthesizeXai(text);
const out = path.join(root, 'workspace', 'hello.mp3');
fs.writeFileSync(out, audio);
console.log('saved ' + out + ' bytes=' + audio.length);
