// src/schedule-cli.ts - manage scheduled tasks. Run as: node dist/schedule-cli.js <cmd>.

import { randomUUID } from 'node:crypto';
import { getDb, createScheduledTask, setTaskStatus, type ScheduledTask } from './db.js';
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

export function listAllTasks(): ScheduledTask[] {
  return getDb()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY status, priority ASC, next_run ASC')
    .all() as ScheduledTask[];
}

function usage(): never {
  console.log('Usage: schedule-cli <create|list|delete|pause|resume> ...');
  console.log('  create "<prompt>" "<cron>" <chat_id> [agent_id] [priority]');
  console.log('  list | delete <id> | pause <id> | resume <id>');
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'create') {
    const [prompt, cron, chatId, agentId = 'main', priorityRaw = '3'] = rest;
    if (!prompt || !cron || !chatId) usage();
    let nextRun: number;
    try {
      nextRun = computeNextRun(cron);
    } catch {
      console.error(`Invalid cron expression: ${cron}`);
      process.exit(1);
    }
    const priority = Math.min(5, Math.max(1, Number.parseInt(priorityRaw, 10) || 3));
    const id = `tsch_${randomUUID().slice(0, 8)}`;
    createScheduledTask({
      id,
      chat_id: chatId,
      prompt,
      schedule: cron,
      next_run: nextRun,
      priority,
      agent_id: agentId,
      status: 'active',
    });
    console.log(`Created ${id}, next run ${new Date(nextRun).toLocaleString()}`);
  } else if (cmd === 'list') {
    printTaskTable(listAllTasks());
  } else if (cmd === 'delete' && rest[0]) {
    getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(rest[0]);
    console.log(`Deleted ${rest[0]}`);
  } else if (cmd === 'pause' && rest[0]) {
    setTaskStatus(rest[0], 'paused');
    console.log(`Paused ${rest[0]}`);
  } else if (cmd === 'resume' && rest[0]) {
    const row = getDb().prepare('SELECT schedule FROM scheduled_tasks WHERE id = ?').get(rest[0]) as
      | { schedule: string }
      | undefined;
    if (!row) {
      console.error(`Unknown task ${rest[0]}`);
      process.exit(1);
    }
    getDb()
      .prepare('UPDATE scheduled_tasks SET status = ?, next_run = ? WHERE id = ?')
      .run('active', computeNextRun(row.schedule), rest[0]);
    console.log(`Resumed ${rest[0]}`);
  } else {
    usage();
  }
}

main().catch((err) => {
  console.error(`schedule-cli failed: ${String(err)}`);
  process.exit(1);
});
