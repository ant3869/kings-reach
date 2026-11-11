// tests/setup-wizard.test.mjs - `npm run setup` must never destroy an existing .env. It once overwrote it unconditionally, so
// a second run silently erased every API key. The real wizard runs here in a throwaway copy, with its prompts answered as they appear.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
const made = [];
after(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'kr-wizard-'));
  made.push(root);
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'src'));
  copyFileSync(join(process.cwd(), 'scripts', 'setup.ts'), join(root, 'scripts', 'setup.ts'));
  writeFileSync(join(root, 'src', 'agent-create.ts'), 'export async function createAgent() {}\n'); // the wizard scaffolds agents; not under test
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'node -e 0' } }));
  return root;
}

/** Run the wizard, pressing Enter at every prompt (a question ends in ": " or ") " with no newline). */
function runWizard(root) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [TSX, join('scripts', 'setup.ts')], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] });
    let tail = '', out = '', asked = 0;
    const timer = setTimeout(() => { p.kill(); reject(new Error('wizard hung')); }, 60_000);
    p.stdout.on('data', (d) => { out += d; tail += d; if (/(: |\) )$/.test(tail)) { tail = ''; asked++; p.stdin.write('\n'); } });
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, asked, out }); });
  });
}

test('setup wizard: an existing .env is left exactly as it is, and no questions are asked', async () => {
  const root = sandbox();
  const mine = 'OPENAI_API_KEY=keep-me\nCUSTOM=1\n';
  writeFileSync(join(root, '.env'), mine);
  const r = await runWizard(root);
  assert.equal(r.code, 0);
  assert.equal(readFileSync(join(root, '.env'), 'utf8'), mine, 'a second run must not erase configured keys');
  assert.equal(r.asked, 0, 'asking for keys it will not save would be a trap');
  assert.match(r.out, /\.env already exists/);
});

test('setup wizard: with no .env it still asks and writes one (first run is not broken)', async () => {
  const root = sandbox();
  const r = await runWizard(root);
  assert.equal(r.code, 0);
  assert.ok(r.asked >= 5, `asked ${r.asked} questions`);
  assert.ok(existsSync(join(root, '.env')));
  assert.match(readFileSync(join(root, '.env'), 'utf8'), /DASHBOARD_PORT=3141/);
});
