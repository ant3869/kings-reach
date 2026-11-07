// src/claude-login.ts - starts `claude auth login` for the user, so "you are logged out" comes with a button instead
// of a terminal chore. The CLI opens the browser itself; we only supervise it (one flow at a time, 5 minute cap),
// sniff the sign-in URL as a fallback link, and drop the cached login status when it ends.

import { spawn, type ChildProcess } from 'node:child_process';
import { claudeAuth } from './claude-auth.js';

export interface LoginState {
  phase: 'idle' | 'waiting' | 'done' | 'failed';
  /** The sign-in page, in case the browser did not open on its own. */
  url?: string;
  detail?: string;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const URL_PATTERN = /https:\/\/[^\s"'<>\u001b]+/;

const spawnLogin = (): ChildProcess =>
  spawn('claude', ['auth', 'login'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

export function createClaudeLogin(spawner: () => ChildProcess = spawnLogin, onFinished: () => void = () => claudeAuth.invalidate()) {
  let state: LoginState = { phase: 'idle' };
  let running: ChildProcess | null = null;

  const finish = (proc: ChildProcess, next: LoginState): void => {
    if (running !== proc) return; // 'error' and 'exit' can both fire; only the first counts
    running = null;
    state = next;
    onFinished();
  };

  return {
    state: (): LoginState => state,
    /** Idempotent: while a flow is open, clicking again just returns it (no second browser window). */
    start(): LoginState {
      if (running) return state;
      let proc: ChildProcess;
      try {
        proc = spawner();
      } catch (err) {
        state = { phase: 'failed', detail: String(err).slice(0, 200) };
        return state;
      }
      running = proc;
      state = { phase: 'waiting' };
      const timer = setTimeout(() => proc.kill(), LOGIN_TIMEOUT_MS);
      timer.unref();
      const sniff = (chunk: Buffer | string): void => {
        const url = String(chunk).match(URL_PATTERN)?.[0];
        if (url && !state.url) state = { ...state, url };
      };
      proc.stdout?.on('data', sniff);
      proc.stderr?.on('data', sniff);
      proc.once('error', (err) => { clearTimeout(timer); finish(proc, { phase: 'failed', detail: String(err).slice(0, 200) }); });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        finish(proc, code === 0 ? { phase: 'done' } : { phase: 'failed', detail: `sign-in ended without finishing (exit ${code ?? 'killed'})` });
      });
      return state;
    },
  };
}

export const claudeLogin = createClaudeLogin();
