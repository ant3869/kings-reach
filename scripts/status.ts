// scripts/status.ts - health overview. Run as: npm run status (tsx scripts/status.ts).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

function pidAlive(): string {
  const pidFile = path.join(PROJECT_ROOT, 'store', 'claudeclaw.pid');
  if (!fs.existsSync(pidFile)) return 'not running (no pid file)';
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  try {
    process.kill(pid, 0);
    return `running (pid ${pid})`;
  } catch {
    return `stale pid file (${pid})`;
  }
}

function serviceStatus(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('schtasks', ['/query', '/tn', 'Claudeclaw', '/fo', 'LIST'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      const state = out.match(/Status:\s*(.+)/)?.[1]?.trim() ?? 'unknown';
      return `Task Scheduler: ${state}`;
    }
    const out = execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 10_000 });
    return out.includes('com.claudeclaw') ? 'launchd: loaded' : 'launchd: not loaded';
  } catch {
    return 'service: not registered';
  }
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/agents`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const env = readEnv();
  console.log('=== ClaudeClaw status ===');
  console.log(`platform: ${os.platform()} ${os.release()} | node ${process.version}`);
  console.log(`service: ${pidAlive()} | ${serviceStatus()}`);
  console.log(`telegram: ${env.TELEGRAM_BOT_TOKEN ? 'token set' : 'MISSING TELEGRAM_BOT_TOKEN'}`);
  console.log(`voice: stt=${env.GROQ_API_KEY ? 'groq' : 'off'} tts=${env.KOKORO_URL ? 'kokoro' : 'os'}`);
  console.log(`whatsapp: ${fs.existsSync(path.join(PROJECT_ROOT, 'store', 'wa-auth')) ? 'logged in' : 'not linked'}`);

  try {
    const { initDatabase, getDb } = await import('../src/db.js');
    initDatabase();
    const db = getDb();
    const mem = (db.prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n;
    const tasks = (db.prepare("SELECT COUNT(*) n FROM scheduled_tasks WHERE status = 'active'").get() as { n: number }).n;
    const hive = (db.prepare('SELECT COUNT(*) n FROM hive_mind').get() as { n: number }).n;
    console.log(`db: ${mem} memories, ${tasks} active tasks, ${hive} hive entries`);
  } catch (err) {
    console.log(`db: unavailable (${String(err).slice(0, 120)})`);
  }

  try {
    const { readAgentYaml } = await import('../src/agent-create.js');
    console.log(`agents: main + ${readAgentYaml().length} specialists`);
  } catch {
    console.log('agents: main only (agent registry unreadable)');
  }

  console.log(`dashboard (3141): ${((await portOpen(3141)) ? 'up' : 'down')}`);
  console.log(`war room (7860): ${((await portOpen(7860)) ? 'up' : 'down (ws port, http probe may fail)')}`);
}

main().catch((err) => {
  console.error(`status failed: ${String(err)}`);
  process.exit(1);
});
