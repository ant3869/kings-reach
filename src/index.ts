// src/index.ts - King's Reach core: DB -> dashboard (the single-instance lock) -> war room
// supervisor -> scheduler -> Telegram. One graceful shutdown path for every exit.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'node:http';
import {
  ALLOWED_CHAT_ID,
  DASHBOARD_HOST,
  DASHBOARD_PORT,
  PROJECT_ROOT,
  SCHEDULER_ENABLED,
  STORE_DIR,
  TELEGRAM_BOT_TOKEN,
  UPLOADS_DIR,
  WARROOM_AUTOSTART,
} from './config.js';
import { logger } from './logger.js';
import { closeDb, getDb, initDatabase } from './db.js';
import { startConsolidationLoop, stopConsolidationLoop } from './memory-consolidate.js';
import { runDecaySweep } from './memory.js';
import { startDashboard } from './dashboard.js';
import { initScheduler, stopScheduler } from './scheduler.js';
import { createBot, isAllowed, type BotHandle } from './bot.js';
import { startWarroom } from './warroom-supervisor.js';
import { readPid, removePidIfOurs, writePid } from './process-util.js';

const CORE_PID_FILE = join(STORE_DIR, 'kings-reach.pid');

function showBanner(): void {
  const bannerPath = join(PROJECT_ROOT, 'banner.txt');
  logger.info(existsSync(bannerPath) ? readFileSync(bannerPath, 'utf8') : "=== King's Reach ===");
}

function ensureDirs(): void {
  for (const dir of [STORE_DIR, UPLOADS_DIR, join(PROJECT_ROOT, 'workspace'), join(STORE_DIR, 'logs')]) {
    mkdirSync(dir, { recursive: true });
  }
}

let server: Server | null = null;
let bot: BotHandle | null = null;
let stopping = false;
const DAY_MS = 86_400_000;

/** Memory maintenance: consolidate every chat that has memories, decay daily. */
function startMemoryUpkeep(): void {
  const chats = getDb().prepare('SELECT DISTINCT chat_id FROM memories').all() as Array<{ chat_id: string }>;
  for (const id of new Set(['warroom', 'dashboard', ...chats.map((c) => c.chat_id)])) startConsolidationLoop(id);
  const decay = (): void => void runDecaySweep().catch((err) => logger.warn({ err: String(err) }, 'decay sweep failed'));
  decay();
  setInterval(decay, DAY_MS).unref();
  logger.info('memory upkeep running (consolidation + daily decay)');
}

/** Idempotent graceful stop: no new work, close the DB cleanly (WAL checkpoint), drop our pid file. */
function shutdown(reason: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ reason }, 'shutting down');
  stopScheduler();
  stopConsolidationLoop();
  void bot?.bot.stop().catch(() => undefined);
  server?.close();
  try {
    closeDb();
  } catch (err) {
    logger.warn({ err: String(err) }, 'closeDb failed');
  }
  removePidIfOurs(CORE_PID_FILE);
  setTimeout(() => process.exit(0), 300).unref();
}

async function main(): Promise<void> {
  showBanner();
  ensureDirs();

  // Signal handlers FIRST: bot.start() below never resolves while polling.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => shutdown(sig));

  // Lock BEFORE shared state: a twin core dies here without ever opening the DB.
  try {
    server = await startDashboard({ onShutdown: () => shutdown('api/admin/shutdown') });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const holder = readPid(CORE_PID_FILE);
    logger.error(
      code === 'EADDRINUSE'
        ? `:${DASHBOARD_PORT} is taken (core pid file says ${holder ?? 'nothing'}). Another core is running; exiting.`
        : `dashboard failed to start: ${String(err)}`,
    );
    process.exitCode = 1;
    return;
  }
  writePid(CORE_PID_FILE);
  initDatabase();
  logger.info('database ready');
  startMemoryUpkeep();
  logger.info(`dashboard on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}  (health: /api/health)`);

  if (WARROOM_AUTOSTART) {
    void startWarroom().then((r) =>
      r.ok
        ? logger.info(r.already ? `war room already running (pid ${r.pid ?? '?'})` : `war room started (pid ${r.pid})`)
        : logger.warn(`war room not started: ${r.error}`),
    );
  }

  if (!TELEGRAM_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN empty: Telegram + scheduled pushes disabled (dashboard still up).');
    return;
  }
  if (!ALLOWED_CHAT_ID) {
    logger.warn('ALLOWED_CHAT_ID empty: the bot refuses everyone. Send /chatid to it, put the id in .env, restart.');
  }
  bot = createBot();
  const handle = bot;
  if (SCHEDULER_ENABLED) {
    initScheduler(async (chatId, text) => {
      // Scheduled output only goes to allowlisted Telegram chats; anything else just logs.
      if (/^-?\d+$/.test(chatId) && isAllowed(chatId)) await handle.sendMessage(chatId, text);
      else logger.info({ chatId, chars: text.length }, 'scheduled task output (not pushed: chat not on Telegram allowlist)');
    });
    logger.info('scheduler running');
  } else {
    logger.warn('SCHEDULER_ENABLED=false: missions will not run');
  }
  // Resolves only when polling stops. A bad/rotated token must not take the dashboard down.
  await handle.start().catch((err) => logger.error({ err: String(err) }, 'telegram polling stopped; dashboard stays up'));
}

main().catch((err) => {
  logger.error({ err: String(err) }, 'fatal startup error');
  shutdown('fatal');
  process.exitCode = 1;
});
