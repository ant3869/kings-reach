// src/claude-auth.ts - is Claude Code actually logged in right now?
// A wiped login used to surface only as "Not logged in" deep inside every stage: each route attempt, salvage call and
// retry re-ran the failing Claude call before falling back. One cheap, cached status probe lets the router skip a
// logged-out Claude instantly and lets Settings say why. It fails OPEN: if the probe itself cannot answer, we assume
// the login is fine and let the real call decide, so this check can never take down a working setup.
//
// A "logged out" reading is checked again before it is believed. On 2026-11-09 five agents of one council read "logged
// out" within the same second that Claude rewrote its credentials file, while `claude auth status` said "logged in" every
// time it was run by hand; believing that one reading sent Main and Ops to fallbacks and left Content with no route at all.

import { execFile } from 'node:child_process';
import { logger } from './logger.js';

export interface ClaudeAuth { loggedIn: boolean; detail: string }

export const CLAUDE_LOGGED_OUT =
  'Claude is logged out. Press "Sign in to Claude" on the dashboard (or run "claude auth login"), then retry.';

export type ClaudeAuthCheck = (() => Promise<ClaudeAuth>) & { /** Forget the cached answer (call after a login attempt ends). */ invalidate(): void };

const LOGGED_IN_TTL_MS = 60_000;
const LOGGED_OUT_TTL_MS = 10_000; // short, so a fresh login is picked up almost immediately
const ENV_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;
export const RECHECKS = 2; // extra readings before "logged out" is believed
export const RECHECK_DELAY_MS = 1500;

/** `claude auth status` prints JSON like {"loggedIn":false,...} (exit 1 when logged out). null = unreadable. */
export function parseAuthStatus(stdout: string): boolean | null {
  try {
    const value = JSON.parse(stdout) as { loggedIn?: unknown };
    return typeof value.loggedIn === 'boolean' ? value.loggedIn : null;
  } catch {
    return null;
  }
}

/** Resolves with whatever the CLI printed, even on a non-zero exit; '' when it could not run at all. */
function runStatusCommand(): Promise<string> {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status'], { timeout: 10_000, windowsHide: true }, (_err, stdout) => resolve(String(stdout ?? '')));
  });
}

export function createClaudeAuthCheck(
  probe: () => Promise<string> = runStatusCommand,
  now: () => number = Date.now,
  env: NodeJS.ProcessEnv = process.env,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message: string, fields: Record<string, unknown>) => void = () => undefined,
): ClaudeAuthCheck {
  let cached: { at: number; ttl: number; value: ClaudeAuth } | null = null;
  let inflight: Promise<ClaudeAuth> | null = null; // a council fires several agents at once: share one probe

  const measure = async (): Promise<ClaudeAuth> => {
    if (ENV_CREDENTIALS.some((name) => env[name])) return { loggedIn: true, detail: 'credentials supplied by environment' };
    let loggedIn = parseAuthStatus(await probe());
    const readings: Array<boolean | null> = [loggedIn];
    for (let i = 0; loggedIn === false && i < RECHECKS; i++) {
      await sleep(RECHECK_DELAY_MS);
      loggedIn = parseAuthStatus(await probe());
      readings.push(loggedIn);
    }
    if (readings.length > 1) log(loggedIn === false ? 'claude auth: still logged out after re-checking' : 'claude auth: a logged-out reading did not repeat', { readings });
    if (loggedIn === null) return { loggedIn: true, detail: 'login status unavailable; assuming signed in' };
    return loggedIn ? { loggedIn: true, detail: 'signed in' } : { loggedIn: false, detail: CLAUDE_LOGGED_OUT };
  };

  const check = async (): Promise<ClaudeAuth> => {
    if (cached && now() - cached.at < cached.ttl) return cached.value;
    inflight ??= measure()
      .then((value) => {
        cached = { at: now(), ttl: value.loggedIn ? LOGGED_IN_TTL_MS : LOGGED_OUT_TTL_MS, value };
        return value;
      })
      .finally(() => { inflight = null; });
    return inflight;
  };
  return Object.assign(check, { invalidate: () => { cached = null; } });
}

export const claudeAuth = createClaudeAuthCheck(undefined, undefined, undefined, undefined, (message, fields) => logger.warn(fields, message));
