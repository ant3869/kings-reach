// scripts/test-py.mjs - run the War Room's Python tests with the same interpreter the core launches it with.
// `npm run test:py`. Uses WARROOM_PYTHON from .env, else `python`.
//
// Guard: the tests must never touch the real store/. A cancelled council once wrote ledger rows into the user's real
// History because a test forgot to redirect it, and nothing noticed. If the real run history, verdict or build state differ
// after the suite, it fails and says which (a real run finishing during these ~10 s would also trip it: just run it again).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = readEnv(ROOT).WARROOM_PYTHON || 'python';
const GUARDED = ['council-runs.jsonl', 'summit-verdict.json', 'build-state.json'].map((f) => path.join(ROOT, 'store', f));
const fingerprint = () => Object.fromEntries(GUARDED.map((f) => [path.basename(f), existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'absent']));

const before = fingerprint();
const run = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (run.error) console.error(`Could not run ${python}: ${run.error.message} (set WARROOM_PYTHON in .env)`);

const after = fingerprint();
const touched = Object.keys(before).filter((k) => before[k] !== after[k]);
if (touched.length) {
  console.error(`\nFAIL: the Python tests changed the real store/: ${touched.join(', ')}. A test is writing to the live history instead of a temp folder.`);
  process.exit(1);
}
process.exit(run.status ?? 1);
