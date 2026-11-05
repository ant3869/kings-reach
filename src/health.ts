// src/health.ts - one JSON snapshot that answers "is the right code running, once?"

import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_CHAT_ID, DASHBOARD_HOST, DASHBOARD_PORT, DASHBOARD_TOKEN, PROJECT_ROOT } from './config.js';
import { DB_PATH, getDb } from './db.js';
import { getAgentRegistry } from './orchestrator.js';
import { DASHBOARD_CLIENT_VERSION } from './dashboard-html.js';
import { WARROOM_CLIENT_VERSION } from './warroom-html.js';
import { warroomStatus } from './warroom-supervisor.js';
import { probeResearch } from './research-probe.js';
import { readRegistry, skillsFor } from './skills.js';
import { loadAgentConfigs } from './agent-config.js';

const STARTED_AT = Date.now();
const COUNTED_TABLES = ['memories', 'scheduled_tasks', 'hive_mind', 'sessions', 'token_usage'] as const;

function appVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
const APP_VERSION = appVersion();

function count(table: string): number | null {
  try {
    return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return null; // table missing -> visible as null, never a crash
  }
}

function fileBytes(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function skillsHealth(): Record<string, unknown> {
  const registry = readRegistry();
  const perAgent: Record<string, unknown> = {};
  let rejected = 0;
  for (const agent of loadAgentConfigs()) {
    const r = skillsFor(agent.id, registry);
    rejected += r.rejected.length;
    perAgent[agent.id] = { required: r.required, available: r.available, rejected: r.rejected };
  }
  const states = Object.values(registry.skills).map((s) => s.state);
  return { active: states.filter((s) => s === 'active').length, quarantined: states.filter((s) => s === 'quarantined').length, rejected, perAgent };
}

export async function collectHealth(): Promise<Record<string, unknown>> {
  return {
    ok: true,
    version: APP_VERSION,
    node: process.version,
    pid: process.pid,
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    // Page VERSIONS, not connection counts. It was called `clients`, and "warroom: 28" was misread as 28 open tabs.
    clientVersions: { dashboard: DASHBOARD_CLIENT_VERSION, warroom: WARROOM_CLIENT_VERSION },
    dashboard: { host: DASHBOARD_HOST, port: DASHBOARD_PORT },
    warroom: await warroomStatus(),
    agents: getAgentRegistry().size,
    skills: skillsHealth(),
    research: await probeResearch(),
    db: {
      counts: Object.fromEntries(COUNTED_TABLES.map((t) => [t, count(t)])),
      bytes: fileBytes(DB_PATH),
      walBytes: fileBytes(`${DB_PATH}-wal`),
    },
    security: { dashboardToken: Boolean(DASHBOARD_TOKEN), telegramAllowlist: Boolean(ALLOWED_CHAT_ID) },
  };
}
