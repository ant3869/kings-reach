// scripts/setup.ts - onboarding wizard. Run as: npm run setup (tsx scripts/setup.ts).
// Collects only the keys for enabled features, writes .env, scaffolds agents,
// installs the background service (Windows: Task Scheduler via .ps1).

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string): string => `\x1b[33m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;

function ask(rl: readline.Interface, q: string, secret = false): Promise<string> {
  return new Promise((resolve) => {
    if (!secret) {
      rl.question(q, (a) => resolve(a.trim()));
      return;
    }
    // Best-effort secret prompt: no echo is terminal-specific, so warn instead.
    rl.question(`${q}(input will be visible) `, (a) => resolve(a.trim()));
  });
}

function checkBin(bin: string, args: string[] = ['--version']): boolean {
  try {
    execFileSync(bin, args, { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log(green('=== Kings Reach setup (Windows) ==='));

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 20) {
    console.log(red(`Node >= 20 required, found ${process.version}. Aborting.`));
    process.exit(1);
  }
  console.log(green(`Node ${process.version} ok`));
  if (!checkBin('claude')) {
    console.log(yellow('`claude` CLI not found or not authenticated. Install it, then re-run setup.'));
  }
  if (!checkBin('python', ['--version'])) {
    console.log(yellow('Python not found. War Room needs Python 3.9+.'));
  }

  console.log('Building...');
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, shell: true, stdio: 'inherit' });
  if (build.status !== 0) console.log(yellow('Build failed. Continuing so .env can still be written.'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const env: Record<string, string> = {};

  env.TELEGRAM_BOT_TOKEN = await ask(rl, 'Telegram bot token (from @BotFather): ', true);
  env.ALLOWED_CHAT_ID = await ask(rl, 'Allowed Telegram chat ID (send /chatid to your bot): ');
  env.GROQ_API_KEY = await ask(rl, 'Groq API key for voice STT (blank to skip): ', true);
  env.KOKORO_URL = (await ask(rl, 'Kokoro TTS URL [http://127.0.0.1:8880]: ')) || 'http://127.0.0.1:8880';
  env.GOOGLE_API_KEY = await ask(rl, 'Google API key for memory v2 + War Room (blank to skip): ', true);
  const wa = await ask(rl, 'Enable WhatsApp bridge? [y/N]: ');
  env.WHATSAPP_ENABLED = wa.toLowerCase().startsWith('y') ? 'true' : 'false';
  env.DASHBOARD_PORT = (await ask(rl, 'Dashboard port [3141]: ')) || '3141';
  env.WARROOM_PORT = (await ask(rl, 'War Room port [7860]: ')) || '7860';
  env.AGENT_TIMEOUT_MS = '900000';
  env.AGENT_MAX_TURNS = '30';

  const lines = Object.entries(env)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(path.join(PROJECT_ROOT, '.env'), `${lines.join('\n')}\n`, 'utf8');
  console.log(green('.env written.'));

  // Multi-agent scaffold from template (idempotent: createAgent skips existing).
  const { createAgent } = await import('../src/agent-create.js');
  const specialists: Array<[string, string, string]> = [
    ['comms', 'Comms', 'email, Slack, LinkedIn, all communications'],
    ['content', 'Content', 'writing, editing, publishing, brand voice'],
    ['ops', 'Ops', 'system admin, deployments, infrastructure, backups'],
    ['research', 'Research', 'deep dives, competitive analysis, market research'],
  ];
  for (const [id, name, desc] of specialists) {
    try {
      await createAgent(id, name, desc);
      console.log(green(`agent ${id} ready`));
    } catch (err) {
      console.log(yellow(`agent ${id}: ${String(err).slice(0, 120)}`));
    }
  }

  if (fs.existsSync(path.join(PROJECT_ROOT, 'warroom', 'requirements.txt'))) {
    console.log('Installing War Room Python deps...');
    const pip = spawnSync('python', ['-m', 'pip', 'install', '-r', 'warroom/requirements.txt'], {
      cwd: PROJECT_ROOT,
      shell: true,
      stdio: 'inherit',
    });
    if (pip.status !== 0) console.log(yellow('pip install failed. Run it manually later.'));
  }

  rl.close();
  console.log(green('Next steps:'));
  console.log('  1. Register the background task:  powershell -File scripts\\agent-service.ps1 -Install');
  console.log('  2. Check health:                   npm run status');
  console.log('  3. Start the War Room separately:  npm run warroom  (then open http://localhost:7860)');
}

main().catch((err) => {
  console.error(red(`setup failed: ${String(err)}`));
  process.exit(1);
});
