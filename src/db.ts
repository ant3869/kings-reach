import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit is better than implicit: resolve paths from this file, never cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');
export const STORE_DIR = path.join(PROJECT_ROOT, 'store');
export const DB_PATH =
  process.env.KINGS_REACH_DB ?? path.join(STORE_DIR, 'claudeclaw.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  db = new Database(DB_PATH);
  // Flat is better than nested: WAL first, then schema.
  db.pragma('journal_mode = WAL');
  return db;
}

/** Read-only handle for callers that cannot write (sandboxed agents recalling memory). No schema work, no WAL pragma. */
export function openReadOnly(): Database.Database {
  closeDb();
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function ensureColumn(
  handle: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = handle.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  session_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, agent_id)
);

-- Full_v2 memories: task requires salience DEFAULT 1.0, last_accessed,
-- embedding (BLOB, hex helpers live in embeddings.ts).
-- Spec compat columns (source, session_id, connections, accessed_at) included.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  source TEXT,
  session_id TEXT,
  raw_text TEXT,
  summary TEXT NOT NULL,
  entities TEXT NOT NULL DEFAULT '[]',
  topics TEXT NOT NULL DEFAULT '[]',
  connections TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  salience REAL NOT NULL DEFAULT 1.0,
  pinned INTEGER NOT NULL DEFAULT 0,
  superseded_by INTEGER,
  consolidated INTEGER NOT NULL DEFAULT 0,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_chat ON memories(chat_id, consolidated);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(chat_id, importance);
CREATE INDEX IF NOT EXISTS idx_memories_accessed ON memories(chat_id, last_accessed);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(summary, raw_text, content=memories, content_rowid=id);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, raw_text) VALUES (new.id, new.summary, new.raw_text);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text) VALUES ('delete', old.id, old.summary, old.raw_text);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF summary, raw_text ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, raw_text) VALUES ('delete', old.id, old.summary, old.raw_text);
  INSERT INTO memories_fts(rowid, summary, raw_text) VALUES (new.id, new.summary, new.raw_text);
END;

CREATE TABLE IF NOT EXISTS consolidations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  insight TEXT,
  connections TEXT,
  contradictions TEXT,
  source_memory_ids TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consolidations_chat ON consolidations(chat_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_chat ON conversation_log(chat_id, created_at);

CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  next_run INTEGER NOT NULL,
  last_run INTEGER,
  last_result TEXT,
  priority INTEGER NOT NULL DEFAULT 3,
  agent_id TEXT NOT NULL DEFAULT 'main',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','paused','running','completed','failed')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_tasks(status, priority, next_run);

CREATE TABLE IF NOT EXISTS mission_tasks (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mission_status ON mission_tasks(status, priority);

CREATE TABLE IF NOT EXISTS hive_mind (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hive_agent ON hive_mind(agent_id, created_at);

CREATE TABLE IF NOT EXISTS inter_agent_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  details TEXT,
  chat_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS warroom_transcript (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  speaker TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  body_enc TEXT NOT NULL,
  iv TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  body_enc TEXT NOT NULL,
  iv TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_message_map (
  wa_id TEXT PRIMARY KEY,
  tg_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skill_health (
  skill TEXT PRIMARY KEY,
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  last_ok INTEGER,
  last_fail INTEGER
);
CREATE TABLE IF NOT EXISTS session_summaries (
  chat_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, agent_id)
);
`;

export function initDatabase(): Database.Database {
  const handle = getDb();
  handle.exec(SCHEMA);
  // Inline migrations for DBs created before new columns existed.
  ensureColumn(handle, 'memories', 'source', 'TEXT');
  ensureColumn(handle, 'memories', 'session_id', 'TEXT');
  ensureColumn(handle, 'memories', 'connections', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(handle, 'memories', 'salience', 'REAL NOT NULL DEFAULT 1.0');
  ensureColumn(handle, 'memories', 'last_accessed', 'INTEGER');
  ensureColumn(handle, 'memories', 'accessed_at', 'INTEGER');
  ensureColumn(handle, 'memories', 'decayed_at', 'INTEGER'); // last decay step; NULL = never decayed
  // Backfill timestamps where migration added NULLs.
  handle
    .prepare(
      `UPDATE memories SET last_accessed = COALESCE(last_accessed, accessed_at, created_at),
        accessed_at = COALESCE(accessed_at, last_accessed, created_at)
        WHERE last_accessed IS NULL OR accessed_at IS NULL`,
    )
    .run();
  return handle;
}

// --- Sessions (composite key: chat_id + agent_id) ---
export function getSession(chatId: string, agentId = 'main'): string | null {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE chat_id = ? AND agent_id = ?')
    .get(chatId, agentId) as { session_id: string } | undefined;
  return row?.session_id ?? null;
}

export function setSession(chatId: string, sessionId: string, agentId = 'main'): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (chat_id, agent_id, session_id, updated_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, agent_id)
       DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`,
    )
    .run(chatId, agentId, sessionId, Date.now());
}

// --- Memories ---
export interface StructuredMemory {
  chat_id: string;
  agent_id?: string;
  source?: string;
  session_id?: string;
  raw_text: string;
  summary: string;
  entities?: string[];
  topics?: string[];
  importance: number;
  salience?: number;
  embedding?: Buffer | null;
}

export function saveStructuredMemoryAtomic(m: StructuredMemory): number {
  const now = Date.now();
  const run = getDb().transaction(() => {
    const info = getDb()
      .prepare(
        `INSERT INTO memories
          (chat_id, agent_id, source, session_id, raw_text, summary, entities, topics,
           importance, salience, pinned, consolidated, embedding, created_at, last_accessed, accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        m.chat_id,
        m.agent_id ?? 'main',
        m.source ?? null,
        m.session_id ?? null,
        m.raw_text,
        m.summary,
        JSON.stringify(m.entities ?? []),
        JSON.stringify(m.topics ?? []),
        m.importance,
        m.salience ?? 1.0,
        m.embedding ?? null,
        now,
        now,
        now,
      );
    return Number(info.lastInsertRowid);
  });
  return run();
}

export interface MemoryRow {
  id: number;
  chat_id: string;
  agent_id: string;
  summary: string;
  raw_text: string;
  entities: string;
  topics: string;
  importance: number;
  salience: number;
  pinned: number;
  superseded_by: number | null;
  consolidated: number;
  embedding: Buffer | null;
  created_at: number;
  last_accessed: number;
  accessed_at: number;
}

export function getMemoryById(id: number): MemoryRow | null {
  const row = getDb().prepare('SELECT * FROM memories WHERE id = ?').get(id) as
    | MemoryRow
    | undefined;
  return row ?? null;
}

export function touchMemory(id: number): void {
  const now = Date.now();
  // NOTE: never touch summary/raw_text here — FTS triggers stay content-only.
  getDb()
    .prepare('UPDATE memories SET last_accessed = ?, accessed_at = ? WHERE id = ?')
    .run(now, now, id);
}

export function pinMemory(id: number, pinned = true): void {
  getDb().prepare('UPDATE memories SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
}

export function supersedeMemory(oldId: number, newId: number): void {
  getDb().prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(newId, oldId);
}

export function markMemoriesConsolidated(ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  getDb().prepare(`UPDATE memories SET consolidated = 1 WHERE id IN (${placeholders})`).run(...ids);
}

export function getUnconsolidatedMemories(chatId: string, limit = 20): MemoryRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM memories WHERE chat_id = ? AND consolidated = 0 AND pinned = 0
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as MemoryRow[];
}

// --- Consolidations ---
export function saveConsolidation(
  chatId: string,
  summary: string,
  insight: string,
  connections: string[],
  contradictions: string[],
  sourceIds: number[],
): number {
  const info = getDb()
    .prepare(
      `INSERT INTO consolidations (chat_id, summary, insight, connections, contradictions, source_memory_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      chatId,
      summary,
      insight,
      JSON.stringify(connections),
      JSON.stringify(contradictions),
      JSON.stringify(sourceIds),
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

export function getRecentConsolidations(chatId: string, limit = 3): Array<{
  summary: string;
  insight: string | null;
  created_at: number;
}> {
  return getDb()
    .prepare(
      'SELECT summary, insight, created_at FROM consolidations WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(chatId, limit) as Array<{ summary: string; insight: string | null; created_at: number }>;
}

// --- Conversation log + tokens ---
export function logConversation(chatId: string, role: string, content: string, agentId = 'main'): void {
  getDb()
    .prepare(
      'INSERT INTO conversation_log (chat_id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(chatId, agentId, role, content, Date.now());
}

export function getRecentConversation(chatId: string, limit = 10): Array<{ role: string; content: string }> {
  return getDb()
    .prepare(
      'SELECT role, content FROM conversation_log WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(chatId, limit) as Array<{ role: string; content: string }>;
}

export function logTokenUsage(
  chatId: string,
  agentId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost?: number,
): void {
  getDb()
    .prepare(
      `INSERT INTO token_usage (chat_id, agent_id, model, input_tokens, output_tokens, estimated_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chatId, agentId, model, inputTokens, outputTokens, cost ?? null, Date.now());
}

// --- Scheduler (Mission Control) ---
export interface ScheduledTask {
  id: string;
  chat_id: string;
  prompt: string;
  schedule: string;
  next_run: number;
  last_run: number | null;
  last_result: string | null;
  priority: number;
  agent_id: string;
  status: string;
  created_at: number;
}

export function createScheduledTask(t: Omit<ScheduledTask, 'last_run' | 'last_result' | 'created_at'> & {
  last_run?: number | null;
  last_result?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO scheduled_tasks (id, chat_id, prompt, schedule, next_run, last_run, last_result, priority, agent_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id, t.chat_id, t.prompt, t.schedule, t.next_run,
      t.last_run ?? null, t.last_result ?? null,
      t.priority, t.agent_id, t.status, Date.now(),
    );
}

export function getDueTasks(now = Date.now()): ScheduledTask[] {
  return getDb()
    .prepare(
      `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run <= ?
       ORDER BY priority ASC, next_run ASC`,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskRun(id: string, nextRun: number, lastResult?: string): void {
  getDb()
    .prepare('UPDATE scheduled_tasks SET last_run = ?, next_run = ?, last_result = ? WHERE id = ?')
    .run(Date.now(), nextRun, lastResult ?? null, id);
}

export function setTaskStatus(id: string, status: ScheduledTask['status']): void {
  getDb().prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(status, id);
}

// --- Hive mind (multi-agent) ---
export function logToHiveMind(agentId: string, actionType: string, summary: string, metadata?: unknown): void {
  getDb()
    .prepare(
      'INSERT INTO hive_mind (agent_id, action_type, summary, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(agentId, actionType, summary, metadata === undefined ? null : JSON.stringify(metadata), Date.now());
}

export function getRecentHiveMind(limit = 5): Array<{
  agent_id: string;
  action_type: string;
  summary: string;
  created_at: number;
}> {
  return getDb()
    .prepare('SELECT agent_id, action_type, summary, created_at FROM hive_mind ORDER BY created_at DESC LIMIT ?')
    .all(limit) as Array<{ agent_id: string; action_type: string; summary: string; created_at: number }>;
}


