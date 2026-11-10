// src/mission-cli.ts - Mission Control: schedule-cli plus agent assignment,
// priority, and status/agent filters. Run as: node dist/mission-cli.js <cmd>.

import { getDb, setTaskStatus, type ScheduledTask } from './db.js';
import { createTaskFromArgs, printTaskTable } from './task-cli-shared.js';

function usage(): never {
  console.log('Usage: mission-cli <create|list|delete|pause|resume> ...');
  console.log('  create "<prompt>" "<cron>" <chat_id> [agent_id] [priority 1-5]');
  console.log('  list [--status=active] [--agent=comms]');
  console.log('  delete|pause|resume <id>');
  process.exit(1);
}

function filteredList(status?: string, agent?: string): ScheduledTask[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (agent) {
    clauses.push('agent_id = ?');
    params.push(agent);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT * FROM scheduled_tasks ${where} ORDER BY priority ASC, next_run ASC`)
    .all(...params) as ScheduledTask[];
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'create') {
    const { id, agentId, priority, nextRun } = createTaskFromArgs(rest, 'msn', usage);
    console.log(`Mission ${id} -> ${agentId} (p${priority}), next ${new Date(nextRun).toLocaleString()}`);
  } else if (cmd === 'list') {
    const status = rest.find((a) => a.startsWith('--status='))?.slice(9);
    const agent = rest.find((a) => a.startsWith('--agent='))?.slice(8);
    printTaskTable(filteredList(status, agent));
  } else if (cmd === 'delete' && rest[0]) {
    getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(rest[0]);
    console.log(`Deleted ${rest[0]}`);
  } else if (cmd === 'pause' && rest[0]) {
    setTaskStatus(rest[0], 'paused');
    console.log(`Paused ${rest[0]}`);
  } else if (cmd === 'resume' && rest[0]) {
    setTaskStatus(rest[0], 'active');
    console.log(`Resumed ${rest[0]}`);
  } else {
    usage();
  }
}

main().catch((err) => {
  console.error(`mission-cli failed: ${String(err)}`);
  process.exit(1);
});
