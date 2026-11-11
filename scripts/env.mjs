// scripts/env.mjs - read the project's .env the same way src/env.ts does, without touching process.env.
// Shared by verify.mjs and test-py.mjs so the parsing rules live in one place.

import fs from 'node:fs';
import path from 'node:path';

// Every setting in .env.example ships as this text; copied unchanged it must read as unset (same rule as src/env.ts and warroom/config.py).
export const ENV_PLACEHOLDER = 'YOUR_VALUE_HERE';

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
    const parsed = quoted ? quoted[2] : value.startsWith('#') ? '' : value.replace(/\s#.*$/, '').trim(); // mirrors src/env.ts
    out[line.slice(0, eq).trim()] = parsed === ENV_PLACEHOLDER ? '' : parsed;
  }
  return out;
}
