// scripts/test-py.mjs - run the War Room's Python tests with the same interpreter the core launches it with.
// `npm run test:py`. Uses WARROOM_PYTHON from .env, else `python`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from './env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = readEnv(ROOT).WARROOM_PYTHON || 'python';
const run = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'tests', '-p', 'test_*.py'], { cwd: ROOT, stdio: 'inherit', windowsHide: true });
if (run.error) console.error(`Could not run ${python}: ${run.error.message} (set WARROOM_PYTHON in .env)`);
process.exit(run.status ?? 1);
