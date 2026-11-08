// src/run-control.ts - which agent runs are in flight, and the one way to stop them.
//
// Every run registers here (runAgent / runAgentWithRetry), gets an AbortSignal, and passes it down to whatever does the
// work: the Claude SDK (abortController), provider CLIs and harnesses (their whole process tree is killed), and HTTP
// calls (fetch). A cancelled run throws RunCancelled, which the fallback loop and the retry wrapper treat as final:
// "stop" must never mean "try the next provider" or "retry".

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export class RunCancelled extends Error {
  constructor(message = 'Run cancelled') {
    super(message);
    this.name = 'RunCancelled';
  }
}

export const isCancelled = (err: unknown): boolean => err instanceof RunCancelled || (err as { name?: string } | null)?.name === 'RunCancelled';

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunCancelled();
}

/**
 * Kill a process AND everything it started. On Windows a plain `child.kill()` ends only that one process: provider CLIs run
 * as `cmd.exe /c tool.cmd`, so killing the wrapper leaves the real worker (and any tool it launched) running unobserved.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    // Synchronous on purpose: taskkill finds the children by walking down from a live parent. If anything else kills the parent
    // first (the SDK does, on abort) the children are orphaned and can no longer be found. Rare, and about 100 ms.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
    return;
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** The SDK's SpawnOptions, restated so this file does not depend on the SDK's types. */
interface SdkSpawn { command: string; args: string[]; cwd?: string; env: Record<string, string | undefined>; signal: AbortSignal }

/**
 * Spawns the Claude CLI the way the SDK does, except that an abort ends the CLI's whole process tree. The SDK's own abort
 * kills only the CLI, so a shell command the agent had started (a build, a long test run) kept running with nobody listening.
 */
export function spawnClaudeCli({ command, args, cwd, env, signal }: SdkSpawn): ChildProcess {
  // No `signal` option on spawn(): Node would kill just the one process; killTree below does the whole tree.
  const child = spawn(command, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const stop = (): void => { if (child.exitCode === null) killTree(child.pid); };
  // The SDK also calls kill() itself when it shuts the query down. Route that through killTree too, so the tree dies first
  // whichever of the two reaches the process first.
  const nativeKill = child.kill.bind(child);
  child.kill = (sig?: NodeJS.Signals | number): boolean => { stop(); return nativeKill(sig); };
  if (signal.aborted) stop();
  else {
    signal.addEventListener('abort', stop, { once: true });
    child.once('exit', () => signal.removeEventListener('abort', stop));
  }
  return child;
}

export interface RunInfo { id: string; agentId: string; chatId?: string; stage?: string; startedAt: number }
interface Entry extends RunInfo { controller: AbortController }

const runs = new Map<string, Entry>();

export interface ActiveRun { id: string; signal: AbortSignal; finish: () => void }

/** Register a run. `parent` is an optional outside signal (a caller that wants to cancel it itself). Always call `finish()`. */
export function startRun(info: { agentId: string; chatId?: string; stage?: string }, parent?: AbortSignal): ActiveRun {
  const id = randomUUID().slice(0, 8);
  const controller = new AbortController();
  runs.set(id, { ...info, id, startedAt: Date.now(), controller });
  const onParent = (): void => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', onParent, { once: true });
  return {
    id,
    signal: controller.signal,
    finish: () => { runs.delete(id); parent?.removeEventListener('abort', onParent); },
  };
}

export function activeRuns(): RunInfo[] {
  return [...runs.values()].map(({ controller: _controller, ...info }) => info).sort((a, b) => a.startedAt - b.startedAt);
}

/** Cancel by run id, by chat, or everything. No criteria cancels nothing: a stray request must never stop the whole system. */
export function cancelRuns(filter: { id?: string; chatId?: string; all?: boolean }): number {
  const targets = [...runs.values()].filter((r) =>
    filter.all === true || (filter.id !== undefined && r.id === filter.id) || (filter.chatId !== undefined && r.chatId === filter.chatId));
  for (const run of targets) run.controller.abort();
  return targets.length;
}
