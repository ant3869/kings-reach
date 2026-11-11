// src/schedule-cli.ts - manage scheduled tasks. Run as: node dist/schedule-cli.js <cmd>.

import { getDb, deleteScheduledTask, setTaskStatus, type ScheduledTask } from './db.js';
import { computeNextRun } from './scheduler.js';
import { createTaskFromArgs, printTaskTable } from './task-cli-shared.js';

function listAllTasks(): ScheduledTask[] {
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
    const { id, nextRun } = createTaskFromArgs(rest, 'tsch', usage);
    console.log(`Created ${id}, next run ${new Date(nextRun).toLocaleString()}`);
  } else if (cmd === 'list') {
    printTaskTable(listAllTasks());
  } else if (cmd === 'delete' && rest[0]) {
    deleteScheduledTask(rest[0]);
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
