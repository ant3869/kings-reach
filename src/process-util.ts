// src/process-util.ts - tiny, dependency-free helpers for ports and pid files.
// The PORT is the lock (exclusive bind); pid files are informational only.

import fs from 'node:fs';
import { createConnection } from 'node:net';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True when something accepts TCP connections on host:port. */
export function isPortOpen(port: number, host = '127.0.0.1', timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port, timeout: timeoutMs });
    const done = (open: boolean): void => {
      sock.destroy();
      resolve(open);
    };
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });
}

/** Poll until the port reaches the wanted state or the deadline passes. */
export async function waitForPort(port: number, wantOpen: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isPortOpen(port, '127.0.0.1', 500)) === wantOpen) return true;
    await sleep(300);
  }
  return false;
}

export function readPid(file: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Node's signal 0 is a real existence check on Windows (OpenProcess), unlike Python's. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function writePid(file: string, pid = process.pid): void {
  fs.writeFileSync(file, String(pid), 'utf8');
}

/** Remove the pid file only if it still names us (a successor may own it). */
export function removePidIfOurs(file: string, pid = process.pid): void {
  if (readPid(file) === pid) fs.rmSync(file, { force: true });
}
