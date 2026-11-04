// tools/bin/agent-reach-guard.mjs - the only way agents reach the agent-reach CLI.
//  1. HOME/USERPROFILE point inside store/ so its config, browser profile and sessions never touch the real user profile
//     (the CLI treats HOME as its isolation boundary). The agent's own HOME is untouched: Claude Code needs it.
//  2. Owner-only subcommands are refused. They install software, open login windows, copy browser logins, change
//     keys or uninstall, which an autonomous agent must never do. Reading and searching are what agents are for.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXE = join(ROOT, 'tools', 'agent-reach', 'venv', process.platform === 'win32' ? 'Scripts/agent-reach.exe' : 'bin/agent-reach');
const HOME = join(ROOT, 'store', 'agent-reach-home');
const OWNER_ONLY = new Set(['setup', 'add', 'remove', 'login', 'logout', 'browser', 'update', 'configure', 'uninstall', 'skill']);

const refuse = (code, message) => {
  console.log(JSON.stringify({ schema_version: 1, ok: false, error: { code, message, hint: 'Report this to the owner in your findings instead of working around it.' } }));
  process.exit(3);
};

const sub = process.argv[2];
if (!sub) refuse('BAD_INPUT', 'usage: agent-reach read <url> | agent-reach <channel> <action> ... | agent-reach channels | agent-reach doctor');
if (OWNER_ONLY.has(sub)) refuse('OWNER_ONLY', `"agent-reach ${sub}" changes the machine and is reserved for the owner.`);
if (!existsSync(EXE)) refuse('NEED_SETUP', 'agent-reach is not installed. The owner runs: node scripts/setup-research-tools.mjs');

mkdirSync(HOME, { recursive: true });
const child = spawn(EXE, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, HOME, USERPROFILE: HOME, PYTHONUTF8: '1', AGENT_REACH_LANG: 'en' },
});
child.on('exit', (code) => process.exit(code ?? 1));
