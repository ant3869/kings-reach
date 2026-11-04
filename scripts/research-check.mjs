// scripts/research-check.mjs - prove the research tools really work, end to end, without spending a cent on a model.
//   node scripts/research-check.mjs
// Drives the same entry points the agents use (the PATH wrappers under tools/), against example.com.

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const work = join(ROOT, 'store', 'browser-work');
mkdirSync(work, { recursive: true });
const env = { ...process.env, TEMP: join(ROOT, 'store', 'tmp'), TMP: join(ROOT, 'store', 'tmp') };
mkdirSync(env.TEMP, { recursive: true });

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`); };
const run = (command, args, cwd = ROOT) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, shell: win && command.endsWith('.cmd') });

const reach = run(win ? join(ROOT, 'tools', 'bin', 'agent-reach.cmd') : join(ROOT, 'tools', 'bin', 'agent-reach'), ['read', 'https://example.com']);
let body = {};
try { body = JSON.parse(reach.stdout); } catch { /* reported below */ }
check('agent-reach read example.com', body.ok === true && /Example Domain/.test(JSON.stringify(body.items ?? [])), body.ok ? `via ${body.backend}` : (reach.stdout || reach.stderr).slice(0, 160));

const refused = run(win ? join(ROOT, 'tools', 'bin', 'agent-reach.cmd') : join(ROOT, 'tools', 'bin', 'agent-reach'), ['login', 'github']);
check('agent-reach refuses owner-only commands', /OWNER_ONLY/.test(refused.stdout));

const pw = join(ROOT, 'tools', 'browser', 'node_modules', '.bin', win ? 'playwright-cli.cmd' : 'playwright-cli');
const session = `check${process.pid}`;
const opened = run(pw, [`-s=${session}`, 'open', 'https://example.com'], work);
check('playwright-cli opens a page headless', opened.status === 0 && /Page Title: Example Domain/.test(opened.stdout), (opened.stdout + opened.stderr).replace(/\s+/g, ' ').slice(0, 160));
const title = run(pw, [`-s=${session}`, 'eval', 'document.title'], work);
check('playwright-cli evaluates in the page', /Example Domain/.test(title.stdout), title.stdout.replace(/\s+/g, ' ').slice(0, 120));
run(pw, [`-s=${session}`, 'close'], work);
rmSync(join(work, '.playwright-cli'), { recursive: true, force: true });

console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASS'}`);
process.exitCode = failed ? 1 : 0;
