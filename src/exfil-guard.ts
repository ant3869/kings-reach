// src/exfil-guard.ts - redact secrets from anything leaving the machine (Telegram replies,
// scheduled-task pushes). Two nets: exact values of secret-looking .env keys, plus
// well-known credential shapes (catches keys that never lived in our .env).

import { readEnvFile } from './env.js';

const SECRET_KEY_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASS|HASH|SALT|COOKIE/i;
const MIN_SECRET_LEN = 8;

const CREDENTIAL_SHAPES: Array<[string, RegExp]> = [
  ['telegram-bot-token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['xai-key', /\bxai-[A-Za-z0-9]{20,}/g],
  ['groq-key', /\bgsk_[A-Za-z0-9]{20,}/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}/g],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
];

/** Secret values from .env, longest first so overlapping values redact fully. */
function loadSecretValues(env: Record<string, string>): Array<[string, string]> {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_KEY_NAME.test(k) && v.length >= MIN_SECRET_LEN)
    .sort((a, b) => b[1].length - a[1].length);
}

let cached: Array<[string, string]> | null = null;

export interface RedactResult {
  text: string;
  redactions: string[];
}

export function redactSecrets(input: string, env?: Record<string, string>): RedactResult {
  const secrets = env ? loadSecretValues(env) : (cached ??= loadSecretValues(readEnvFile()));
  const redactions: string[] = [];
  let text = input;
  for (const [name, value] of secrets) {
    if (text.includes(value)) {
      text = text.split(value).join(`[redacted:${name}]`);
      redactions.push(name);
    }
  }
  for (const [name, shape] of CREDENTIAL_SHAPES) {
    const next = text.replace(shape, `[redacted:${name}]`);
    if (next !== text) redactions.push(name);
    text = next;
  }
  return { text, redactions };
}
