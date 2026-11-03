import { callGemini } from './gemini.js';
import {
  getUnconsolidatedMemories,
  saveConsolidation,
  markMemoriesConsolidated,
} from './db.js';
import { logger } from './logger.js';
import { CONSOLIDATION_INTERVAL_MS } from './config.js';

export { CONSOLIDATION_INTERVAL_MS }; // one source: .env CONSOLIDATION_INTERVAL_MIN
export const CONSOLIDATION_BATCH = 20;
export const CONSOLIDATION_MIN = 3;

export const CONSOLIDATION_PROMPT = `Analyze these memories and find patterns. Return JSON:
{
  "summary": "overarching summary of what these memories represent",
  "insight": "one non-obvious pattern or preference you noticed",
  "connections": ["memory X relates to memory Y because..."],
  "contradictions": ["user said A on date1 but said B on date2"]
}`;

export interface ConsolidationResult {
  summary: string;
  insight: string;
  connections: string[];
  contradictions: string[];
}

let timer: NodeJS.Timeout | null = null;
let processing = false;
const activeChats = new Set<string>();

function parseConsolidation(raw: string): ConsolidationResult | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const p = JSON.parse(raw.slice(start, end + 1)) as Partial<ConsolidationResult>;
    return {
      summary: String(p.summary ?? ''),
      insight: String(p.insight ?? ''),
      connections: Array.isArray(p.connections) ? p.connections.map(String) : [],
      contradictions: Array.isArray(p.contradictions) ? p.contradictions.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** Auto-correct contradiction ordering against actual created_at timestamps. */
export function orderContradictions(
  contradictions: string[],
  byId: Map<number, number>,
): string[] {
  // Sparse is better than dense: keep original text, only fix obvious
  // "A then B" mislabels when we can parse [id] markers. No marker → untouched.
  return contradictions.map((c) => {
    const ids = [...c.matchAll(/#?mem(?:ory)?\s*(\d+)/gi)].map((m) => Number(m[1]));
    if (ids.length < 2) return c;
    const [a, b] = [byId.get(ids[0] as number), byId.get(ids[1] as number)];
    if (a === undefined || b === undefined || a <= b) return c;
    return `${c} [timestamp-corrected: #${ids[0]} is actually later than #${ids[1]}]`;
  });
}

export async function runConsolidation(chatId: string): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const memories = getUnconsolidatedMemories(chatId, CONSOLIDATION_BATCH);
    if (memories.length < CONSOLIDATION_MIN) return;

    const byId = new Map(memories.map((m) => [m.id, m.created_at]));
    const block = memories
      .map((m) => `#${m.id} [${new Date(m.created_at).toISOString()}] ${m.summary}`)
      .join('\n');

    const raw = await callGemini(`${CONSOLIDATION_PROMPT}\n\nMemories:\n${block}`);
    const parsed = parseConsolidation(raw);
    if (!parsed || !parsed.summary) return;

    const contradictions = orderContradictions(parsed.contradictions, byId);
    saveConsolidation(
      chatId,
      parsed.summary,
      parsed.insight,
      parsed.connections,
      contradictions,
      memories.map((m) => m.id),
    );
    markMemoriesConsolidated(memories.map((m) => m.id));
  } catch (err) {
    logger.warn({ err, chatId }, 'consolidation failed (non-fatal)');
  } finally {
    processing = false;
  }
}

export function startConsolidationLoop(chatId: string, intervalMs = CONSOLIDATION_INTERVAL_MS): void {
  activeChats.add(chatId);
  if (timer) return;
  timer = setInterval(() => {
    for (const id of activeChats) {
      void runConsolidation(id);
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopConsolidationLoop(chatId?: string): void {
  if (chatId) activeChats.delete(chatId);
  else activeChats.clear();
  if (activeChats.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}
