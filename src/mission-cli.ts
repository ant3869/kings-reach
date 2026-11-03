// src/mission-cli.ts - Mission Control: schedule-cli plus agent assignment,
// priority, and status/agent filters. Run as: node dist/mission-cli.js <cmd>.

import { randomUUID } from 'node:crypto';
import { getDb, createScheduledTask, setTaskStatus, type ScheduledTask } from './db.js';
import { computeNextRun } from './scheduler.js';
import { printTaskTable } from './schedule-cli.js';

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
    const id = `msn_${randomUUID().slice(0, 8)}`;
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
