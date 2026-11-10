// src/task-cli-shared.ts - what schedule-cli and mission-cli have in common. It lives in its own module because a CLI file runs
// main() the moment it is imported: mission-cli used to import printTaskTable from schedule-cli, so every mission-cli command ALSO ran
// schedule-cli's main on the same arguments (`create` stored two tasks and printed two replies).

import { randomUUID } from 'node:crypto';
import { createScheduledTask, type ScheduledTask } from './db.js';
import { computeNextRun } from './scheduler.js';

export function printTaskTable(tasks: ScheduledTask[]): void {
  if (tasks.length === 0) {
    console.log('No tasks.');
    return;
  }
  console.log('id | status | priority | agent | next_run | schedule | prompt');
  for (const t of tasks) {
    const next = new Date(t.next_run).toLocaleString();
    console.log(
      `${t.id} | ${t.status} | ${t.priority} | ${t.agent_id} | ${next} | ${t.schedule} | ${t.prompt.slice(0, 80)}`,
    );
  }
}

/** The `create` command both CLIs share: check the arguments, store the task, say what was stored. Each CLI words its own reply. */
export function createTaskFromArgs(args: string[], idPrefix: string, usage: () => never) {
  const [prompt, cron, chatId, agentId = 'main', priorityRaw = '3'] = args;
  if (!prompt || !cron || !chatId) usage();
  let nextRun: number;
  try {
    nextRun = computeNextRun(cron);
  } catch {
    console.error(`Invalid cron expression: ${cron}`);
    process.exit(1);
  }
  const priority = Math.min(5, Math.max(1, Number.parseInt(priorityRaw, 10) || 3));
  const id = `${idPrefix}_${randomUUID().slice(0, 8)}`;
  createScheduledTask({ id, chat_id: chatId, prompt, schedule: cron, next_run: nextRun, priority, agent_id: agentId, status: 'active' });
  return { id, agentId, priority, nextRun };
}
