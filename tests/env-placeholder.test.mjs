// Copying .env.example to .env is the documented first step (README, "Configure"). Every value in that file is a placeholder, so
// copying it unchanged must leave every setting UNSET. Before this was fixed the placeholder text was read as a real value: the
// War Room crashed on start (int('YOUR_VALUE_HERE')) and OPENROUTER_BASE_URL etc. were overridden with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ENV_PLACEHOLDER, parseEnvValue } from '../dist/env.js';
import { ENV_PLACEHOLDER as SCRIPT_PLACEHOLDER, readEnv } from '../scripts/env.mjs';

const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const settings = [...example.matchAll(/^\s*([A-Z][A-Z0-9_]{2,})\s*=(.*)$/gm)].map((m) => ({ key: m[1], raw: m[2] }));

test('the example placeholder reads as unset, bare or quoted or with a trailing comment', () => {
  assert.equal(parseEnvValue(ENV_PLACEHOLDER), '');
  assert.equal(parseEnvValue(`  ${ENV_PLACEHOLDER}  `), '');
  assert.equal(parseEnvValue(`"${ENV_PLACEHOLDER}"`), '');
  assert.equal(parseEnvValue(`'${ENV_PLACEHOLDER}'`), '');
  assert.equal(parseEnvValue(`${ENV_PLACEHOLDER}   # fill me in`), '');
});

test('a real value is never mistaken for the placeholder', () => {
  assert.equal(parseEnvValue('7860'), '7860');
  assert.equal(parseEnvValue('sk-live-abc'), 'sk-live-abc');
  assert.equal(parseEnvValue('YOUR_VALUE_HERE_2'), 'YOUR_VALUE_HERE_2');
  assert.equal(parseEnvValue('my YOUR_VALUE_HERE'), 'my YOUR_VALUE_HERE');
  assert.equal(parseEnvValue('your_value_here'), 'your_value_here', 'only the exact placeholder is special');
});

test('every setting in .env.example reads as unset (copying it unchanged is harmless)', () => {
  assert.ok(settings.length >= 30, `parsed the example (${settings.length} settings)`);
  const live = settings.filter((s) => parseEnvValue(s.raw) !== '').map((s) => `${s.key}=${s.raw.trim()}`);
  assert.deepEqual(live, [], 'these would be read as real values; ship them as the placeholder, or comment the line out');
});

test('the three Node readers agree on the placeholder, and scripts/env.mjs reads a copied example as unset', () => {
  assert.equal(SCRIPT_PLACEHOLDER, ENV_PLACEHOLDER, 'scripts/env.mjs cannot import dist/ (it runs before a build), so it keeps its own copy: they must match');
  const dir = mkdtempSync(join(tmpdir(), 'kr-env-'));
  copyFileSync(new URL('../.env.example', import.meta.url), join(dir, '.env'));
  const loaded = readEnv(dir);
  assert.ok(Object.keys(loaded).length >= 30);
  assert.deepEqual(Object.entries(loaded).filter(([, v]) => v !== ''), [], 'npm run test:py would try to launch WARROOM_PYTHON=YOUR_VALUE_HERE');
});
