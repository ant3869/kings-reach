// src/scheduler.ts - cron polling scheduler (60s tick, Mission Control ordering).
// Flat is better than nested: one tick function, one task runner.

import cronParser from 'cron-parser';
import { runAgent } from './agent.js';
import { isCancelled } from './run-control.js';
import { logger } from './logger.js';
import {
  getDueTasks,
  updateTaskRun,
  setTaskStatus,
  logToHiveMind,
  type ScheduledTask,
} from './db.js';

import { SCHEDULER_POLL_MS } from './config.js';

export type Sender = (chatId: string, text: string) => Promise<void>;

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
let senderFn: Sender | null = null;
let defaultAgentId = 'main';

/** Start the 60s poll loop. Safe to call twice (second call is a no-op). */
export function initScheduler(sender: Sender, agentId = 'main'): void {
  senderFn = sender;
  defaultAgentId = agentId;
  if (timer) return;
  timer = setInterval(() => {
    void runDueTasks();
  }, SCHEDULER_POLL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Next occurrence of a cron expression as epoch ms. Throws on bad expressions. */
export function computeNextRun(cronExpression: string): number {
  return cronParser.parseExpression(cronExpression).next().getTime();
}

/** Pick up every due task (status=active, next_run<=now, priority first). */
export async function runDueTasks(): Promise<void> {
  if (ticking || !senderFn) return;
  ticking = true;
  try {
    for (const task of getDueTasks()) {
      await runOneTask(task).catch((err) => {
        logger.error({ taskId: task.id, err: String(err) }, 'scheduled task crashed');
      });
    }
  } finally {
    ticking = false;
  }
}

async function runOneTask(task: ScheduledTask): Promise<void> {
  const send = senderFn as Sender;
  const agentId = task.agent_id || defaultAgentId;
  setTaskStatus(task.id, 'running');
  try {
    await send(task.chat_id, `Running scheduled task: ${task.prompt.slice(0, 200)}`);
    const raw = await runAgent({ message: task.prompt, agentId, chatId: task.chat_id });
    const text = raw.text ?? '(empty response)';
    await send(task.chat_id, text.slice(0, 4000));
    updateTaskRun(task.id, computeNextRun(task.schedule), text.slice(0, 2000));
    setTaskStatus(task.id, 'active');
    logToHiveMind(agentId, 'scheduled_task', task.prompt.slice(0, 300), { taskId: task.id });
  } catch (err) {
    if (isCancelled(err)) {
      // Stopped on purpose: leave the task scheduled for its next run rather than marking it failed.
      updateTaskRun(task.id, computeNextRun(task.schedule), 'cancelled');
      setTaskStatus(task.id, 'active');
      await send(task.chat_id, 'Scheduled task stopped.').catch(() => {});
      return;
    }
    setTaskStatus(task.id, 'failed');
    logToHiveMind(agentId, 'scheduler_error', String(err).slice(0, 300), { taskId: task.id });
    await send(task.chat_id, `Scheduled task failed: ${String(err).slice(0, 500)}`).catch(() => {});
  }
}
