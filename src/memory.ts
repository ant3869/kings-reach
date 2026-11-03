import { getEmbedding, callGemini } from './gemini.js';
import { findSimilarMemories } from './embeddings.js';
import {
  getDb,
  getRecentConsolidations,
  getRecentHiveMind,
  getRecentConversation,
  logConversation,
  touchMemory,
} from './db.js';
import { ingestConversationTurn } from './memory-ingest.js';
import { logger } from './logger.js';
import { MEMORY_NUDGE_INTERVAL_HOURS, MEMORY_NUDGE_INTERVAL_TURNS } from './config.js';

export const MEMORY_TOP_K = 5;
export const MEMORY_SIM_THRESHOLD = 0.3;
export const NUDGE_TURNS = MEMORY_NUDGE_INTERVAL_TURNS;
export const NUDGE_HOURS = MEMORY_NUDGE_INTERVAL_HOURS;

const lastNudge = new Map<string, { turns: number; at: number }>();

/**
 * 5-layer retrieval:
 *  1. embedding similarity (0.3 min)  2. FTS5 keyword
 *  3. recent high-importance          4. hive mind (cross-agent)
 *  5. conversation history
 */
export async function buildMemoryContext(chatId: string, userMessage: string): Promise<string> {
  const lines: string[] = [];
  const seen = new Set<number>();
  const touchIds: number[] = [];

  const push = (id: number | null, text: string, importance?: number) => {
    if (!text) return;
    const suffix = importance !== undefined ? ` (importance: ${importance})` : '';
    const key = id ?? -lines.length - 1;
    if (id !== null) {
      if (seen.has(id)) return;
      seen.add(id);
      touchIds.push(id);
    }
    lines.push(`- ${text}${suffix}`);
  };

  // Layer 1 — embedding similarity.
  try {
    const queryEmbedding = await getEmbedding(userMessage.slice(0, 2000));
    const similar = await findSimilarMemories(chatId, queryEmbedding, MEMORY_TOP_K, MEMORY_SIM_THRESHOLD);
    for (const m of similar) push(m.id, m.content);
  } catch (err) {
    logger.warn({ err, chatId }, 'memory layer 1 (embedding) failed');
  }

  const handle = getDb();
  // Layer 2 — FTS5 keyword search.
  try {
    const keywords = userMessage.replace(/["*:()]/g, ' ').split(/\s+/).filter((w) => w.length > 2).slice(0, 8).join(' OR ');
    if (keywords) {
      const fts = handle
        .prepare(
          `SELECT m.id, m.summary, m.importance FROM memories_fts f
           JOIN memories m ON m.id = f.rowid
           WHERE memories_fts MATCH ? AND m.chat_id = ? AND m.superseded_by IS NULL LIMIT 5`,
        )
        .all(keywords, chatId) as Array<{ id: number; summary: string; importance: number }>;
      for (const r of fts) push(r.id, r.summary, r.importance);
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'memory layer 2 (fts) failed');
  }

  // Layer 3 — recent high-importance.
  try {
    const rows = handle
      .prepare(
        `SELECT id, summary, importance FROM memories
         WHERE chat_id = ? AND importance >= 0.7 AND pinned = 0 AND superseded_by IS NULL
         ORDER BY last_accessed DESC LIMIT 5`,
      )
      .all(chatId) as Array<{ id: number; summary: string; importance: number }>;
    for (const r of rows) push(r.id, r.summary, r.importance);
  } catch (err) {
    logger.warn({ err, chatId }, 'memory layer 3 (recency) failed');
  }

  // Layer 4 — consolidation insights + hive mind.
  try {
    for (const c of getRecentConsolidations(chatId, 3)) {
      push(null, `Insight: ${c.summary}${c.insight ? ` — ${c.insight}` : ''}`);
    }
    for (const h of getRecentHiveMind(5)) {
      push(null, `[${h.agent_id}] ${h.summary}`);
    }
  } catch (err) {
    logger.warn({ err, chatId }, 'memory layer 4 (hive) failed');
  }

  // Layer 5 — conversation history.
  try {
    const history = getRecentConversation(chatId, 6).reverse();
    for (const t of history) push(null, `${t.role}: ${t.content.slice(0, 500)}`);
  } catch (err) {
    logger.warn({ err, chatId }, 'memory layer 5 (history) failed');
  }

  for (const id of touchIds) {
    try {
      touchMemory(id);
    } catch {
      // Touch failures never block responses.
    }
  }

  if (lines.length === 0) return '';
  return `[Memory context]\n${lines.join('\n')}`;
}

/** Save both sides of a turn + log to conversation history. Fire-and-forget ingest. */
export async function saveConversationTurn(
  chatId: string,
  userMsg: string,
  assistantMsg: string,
  sessionId?: string,
  agentId = 'main',
): Promise<void> {
  logConversation(chatId, 'user', userMsg, agentId);
  logConversation(chatId, 'assistant', assistantMsg, agentId);
  // Readability counts: explicit void, explicit catch — never an unhandled rejection.
  void ingestConversationTurn(chatId, 'user', userMsg, sessionId, agentId).catch((err) =>
    logger.warn({ err }, 'user ingest failed'),
  );
  void ingestConversationTurn(chatId, 'assistant', assistantMsg, sessionId, agentId).catch((err) =>
    logger.warn({ err }, 'assistant ingest failed'),
  );
}

/** Post-response relevance feedback: reward useful memories, decay the noise. */
export async function evaluateMemoryRelevance(
  chatId: string,
  response: string,
  injectedMemories: string[],
): Promise<void> {
  if (injectedMemories.length === 0) return;
  try {
    const raw = await callGemini(
      `Rate each memory 0-1 for how useful it was for this response. Return JSON {"scores":[0.9,0.1]}.\n\nMemories:\n${injectedMemories.slice(0, 8).join('\n')}\n\nResponse:\n${response.slice(0, 2000)}`,
    );
    const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) as {
      scores?: number[];
    };
    const scores = parsed.scores ?? [];
    const handle = getDb();
    scores.slice(0, 8).forEach((score, i) => {
      const summary = injectedMemories[i];
      if (!summary || typeof score !== 'number') return;
      const row = handle
        .prepare('SELECT id, importance FROM memories WHERE chat_id = ? AND summary = ? LIMIT 1')
        .get(chatId, summary) as { id: number; importance: number } | undefined;
      if (!row) return;
      const next = Math.max(0, Math.min(1, row.importance + (score - 0.5) * 0.1));
      handle.prepare('UPDATE memories SET importance = ? WHERE id = ?').run(next, row.id);
    });
  } catch (err) {
    logger.warn({ err, chatId }, 'relevance feedback failed (non-fatal)');
  }
}

export function shouldNudgeMemory(chatId: string): boolean {
  const entry = lastNudge.get(chatId);
  const now = Date.now();
  if (!entry) {
    lastNudge.set(chatId, { turns: 1, at: now });
    return false;
  }
  entry.turns += 1;
  const hoursSince = (now - entry.at) / 3_600_000;
  if (entry.turns >= NUDGE_TURNS || hoursSince >= NUDGE_HOURS) {
    lastNudge.set(chatId, { turns: 0, at: now });
    return true;
  }
  return false;
}

/** Importance-weighted, multi-tier decay. Pinned memories are exempt. */
export async function runDecaySweep(): Promise<void> {
  const handle = getDb();
  const now = Date.now();
  const day = 86_400_000;
  const rows = handle
    .prepare(
      `SELECT id, importance, last_accessed FROM memories
       WHERE pinned = 0 AND superseded_by IS NULL`,
    )
    .all() as Array<{ id: number; importance: number; last_accessed: number }>;
  const stmt = handle.prepare(
    'UPDATE memories SET importance = ?, last_accessed = ?, accessed_at = ? WHERE id = ?',
  );
  const del = handle.prepare('DELETE FROM memories WHERE id = ?');
  const tx = handle.transaction(() => {
    for (const r of rows) {
      const ageDays = (now - r.last_accessed) / day;
      // High-importance decays slower: flat tiers beat clever curves.
      const tier = r.importance >= 0.8 ? 60 : r.importance >= 0.6 ? 30 : 14;
      if (ageDays < tier) continue;
      const next = r.importance - 0.1;
      if (next <= 0.15 && ageDays > tier * 2) del.run(r.id);
      else stmt.run(Math.max(0.05, next), r.last_accessed, r.last_accessed, r.id);
    }
  });
  tx();
}
