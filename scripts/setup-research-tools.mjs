// scripts/setup-research-tools.mjs - reproducible install of the research tooling the War Room agents use.
//   node scripts/setup-research-tools.mjs
//
//   tools/browser        npm: @playwright/cli (pinned in tools/browser/package.json)
//   tools/agent-reach    python venv + Agent-Reach, built from an exact GitHub commit with the project's own constraints
//
// NOT from PyPI: the PyPI package named "agent-reach" is an unrelated project (0.1.0). The real one lives on GitHub.
// Caches and temp files stay inside store/ so nothing is written outside the project drive.
// Idempotent: re-running upgrades nothing unless a pin below changed.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_REACH_REPO = 'Panniantong/Agent-Reach';
const AGENT_REACH_COMMIT = '7a38047acf26a729cbb27851e3cb81639da86b29'; // v1.6.1
const win = process.platform === 'win32';

const store = (...p) => join(ROOT, 'store', ...p);
for (const d of ['tmp', 'npm-cache', 'pip-cache']) mkdirSync(store(d), { recursive: true });
const env = { ...process.env, npm_config_cache: store('npm-cache'), PIP_CACHE_DIR: store('pip-cache'), TEMP: store('tmp'), TMP: store('tmp'), TMPDIR: store('tmp') };

function run(label, command, args, cwd = ROOT) {
  console.log(`\n== ${label}`);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: win && command.endsWith('.cmd') }); // Node refuses to spawn .cmd files without a shell on Windows
  if (result.status !== 0) { console.error(`FAILED: ${label}`); process.exit(result.status ?? 1); }
}

// cwd, not `--prefix tools/browser` from the root: that form made npm save the ROOT project into tools/browser's
// package.json ("kings-reach": "file:../.."), which linked the repo into its own node_modules as an endless loop.
run('browser tools: npm install', win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], join(ROOT, 'tools', 'browser'));


const venv = join(ROOT, 'tools', 'agent-reach', 'venv');
const py = join(venv, win ? 'Scripts/python.exe' : 'bin/python');
if (!existsSync(py)) run('agent-reach: create venv', win ? 'python' : 'python3', ['-m', 'venv', venv]);
const constraints = join(ROOT, 'tools', 'agent-reach', 'constraints.txt');
if (!existsSync(constraints)) { console.error(`missing ${constraints}`); process.exit(1); }
run('agent-reach: pip install (pinned commit)', py, ['-m', 'pip', 'install', '--disable-pip-version-check', '-c', constraints,
  `https://github.com/${AGENT_REACH_REPO}/archive/${AGENT_REACH_COMMIT}.zip`]);

mkdirSync(store('agent-reach-home'), { recursive: true });
writeFileSync(store('research-tools.json'), JSON.stringify({ agentReach: AGENT_REACH_COMMIT, at: new Date().toISOString() }) + '\n');
console.log('\nresearch tools ready. Verify: node dist/skill-cli.js doctor');
