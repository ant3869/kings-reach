// src/warroom-supervisor.ts - the ONE place that starts/stops the war room server.
// Single-flight start, explicit python (never bare `python`), logs to store/logs.
// server.py binds :WARROOM_PORT with SO_EXCLUSIVEADDRUSE, so a twin cannot listen
// even if two starts race; this module just avoids pointless spawns.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, STORE_DIR, WARROOM_PORT, WARROOM_PYTHON } from './config.js';
import { isPidAlive, isPortOpen, readPid, sleep, waitForPort } from './process-util.js';

export const WARROOM_PID_FILE = path.join(STORE_DIR, 'warroom.pid');
export const WARROOM_LOG_FILE = path.join(STORE_DIR, 'logs', 'warroom.log');

export interface WarroomResult {
  ok: boolean;
  already?: boolean;
  pid?: number | null;
  error?: string;
}

export interface WarroomStatus {
  running: boolean;
  pid: number | null;
  port: number;
  log: string;
}

let inflight: Promise<WarroomResult> | null = null;

function livePid(): number | null {
  const pid = readPid(WARROOM_PID_FILE);
  return pid && isPidAlive(pid) ? pid : null;
}

export async function warroomStatus(): Promise<WarroomStatus> {
  const running = await isPortOpen(WARROOM_PORT);
  return { running, pid: running ? livePid() : null, port: WARROOM_PORT, log: 'store/logs/warroom.log' };
}

/** Start the war room unless something already listens. Concurrent callers share one attempt. */
export function startWarroom(): Promise<WarroomResult> {
  inflight ??= doStart().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doStart(): Promise<WarroomResult> {
  if (await isPortOpen(WARROOM_PORT)) return { ok: true, already: true, pid: livePid() };
  if (!WARROOM_PYTHON) {
    return { ok: false, error: 'WARROOM_PYTHON is not set in .env (refusing to guess; bare `python` resolves to conda)' };
  }
  if (!fs.existsSync(WARROOM_PYTHON)) return { ok: false, error: `WARROOM_PYTHON not found: ${WARROOM_PYTHON}` };

  fs.mkdirSync(path.dirname(WARROOM_LOG_FILE), { recursive: true });
  const out = fs.openSync(WARROOM_LOG_FILE, 'a');
  const child = spawn(WARROOM_PYTHON, ['-u', path.join(PROJECT_ROOT, 'warroom', 'server.py')], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', out, out],
    detached: true, // survives core restarts; the port is the lock, not parentage
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);

  // A venv python.exe is a launcher shim that spawns the real interpreter, so child.pid is
  // NOT the server. The server writes its own pid file right after binding: trust that.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await waitForPort(WARROOM_PORT, true, 500)) {
      await sleep(300);
      return { ok: true, pid: livePid() ?? child.pid ?? null };
    }
    if (child.exitCode !== null) {
      return { ok: false, error: `war room exited with code ${child.exitCode}; see store/logs/warroom.log` };
    }
  }
  return { ok: false, error: `war room did not open :${WARROOM_PORT} within 20s; see store/logs/warroom.log` };
}

/** Stop the server that holds the port (by its own pid file, which it writes after binding). */
export async function stopWarroom(): Promise<WarroomResult> {
  if (!(await isPortOpen(WARROOM_PORT))) return { ok: true, already: true };
  const pid = livePid();
  if (!pid) return { ok: false, error: `:${WARROOM_PORT} is held by a process with no live pid file; stop it by hand` };
  process.kill(pid);
  const closed = await waitForPort(WARROOM_PORT, false, 8_000);
  return closed ? { ok: true, pid } : { ok: false, pid, error: `pid ${pid} killed but :${WARROOM_PORT} still open` };
}
