// scripts/env.mjs - read the project's .env the same way src/env.ts does, without touching process.env.
// Shared by verify.mjs and test-py.mjs so the parsing rules live in one place.

import fs from 'node:fs';
import path from 'node:path';

export function readEnv(root) {
  const out = {};
  const file = path.join(root, '.env');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq <= 0) continue;
    const value = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*?)\1/.exec(value);
    out[line.slice(0, eq).trim()] = quoted ? quoted[2] : value.startsWith('#') ? '' : value.replace(/\s#.*$/, '').trim(); // mirrors src/env.ts
  }
  return out;
}
