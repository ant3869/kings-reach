// src/log-target.ts - where this process's log lines go.
// The core logs to its own stdout (redirected to store/logs/core.log). The agent bridge is a short-lived child of the War Room
// whose stdout is the JSON channel back to Python, which discards every line that is not a reply: the bridge's logs (which
// model each council step picked, which route failed) were thrown away. So the bridge writes to its own file instead.

import { renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export const BRIDGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** The file this process should log to, or undefined for "stdout, as usual". Only the bridge entry point has one. */
export function logFileFor(entryPoint: string | undefined, storeDir: string): string | undefined {
  return /^agent-voice-bridge\.[cm]?[jt]s$/.test(basename(entryPoint ?? '')) ? join(storeDir, 'logs', 'bridge.log') : undefined;
}

/** Keep one previous generation: past the cap the file moves to `<file>.1` (replacing the older one) and a fresh one starts. */
export function rotateIfLarge(file: string, maxBytes = BRIDGE_LOG_MAX_BYTES): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false; // no file yet, or another bridge rotated it first: either way there is nothing to do
  }
}
