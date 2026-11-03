import { callGemini, getEmbedding } from './gemini.js';
import { findSimilarMemories, embeddingToBuffer, DUPLICATE_THRESHOLD } from './embeddings.js';
import { saveStructuredMemoryAtomic, touchMemory, supersedeMemory, getMemoryById } from './db.js';
import { logger } from './logger.js';

export const MIN_MESSAGE_CHARS = 15;
export const MAX_MESSAGE_CHARS = 2000;
export const IMPORTANCE_THRESHOLD = 0.5;

export const EXTRACTION_PROMPT = `Extract key facts from this conversation turn. Return JSON:
{
  "skip": false,
  "summary": "one sentence summary of what was discussed or decided",
  "entities": ["person names", "project names", "tools mentioned"],
  "topics": ["high level topics"],
  "importance": 0.7,
  "salience": 3
}
If the message is trivial (greetings, acknowledgments, simple yes/no), set skip=true.
Importance scale: 0.0 = trivial, 0.5 = routine, 0.7 = notable, 1.0 = critical decision or preference.
Salience scale: 0 = background noise, 1 = low, 2 = moderate, 3 = notable, 4 = high, 5 = critical.`;

export interface ExtractionResult {
  skip: boolean;
  summary: string;
  entities: string[];
  topics: string[];
  importance: number;
  salience: number;
}

export function shouldSkipInput(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < MIN_MESSAGE_CHARS || trimmed.startsWith('/');
}

export function parseExtraction(raw: string): ExtractionResult | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<ExtractionResult>;
    return {
      skip: parsed.skip ?? false,
      summary: String(parsed.summary ?? '').slice(0, 1000),
      entities: Array.isArray(parsed.entities) ? parsed.entities.map(String).slice(0, 20) : [],
      topics: Array.isArray(parsed.topics) ? parsed.topics.map(String).slice(0, 20) : [],
      importance: Number(parsed.importance ?? 0),
      salience: Number(parsed.salience ?? 1),
    };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget ingestion: extract, filter, embed, dedupe, save.
 * Callers must not await this on the hot path — log and swallow errors.
 */
export async function ingestConversationTurn(
  chatId: string,
  role: 'user' | 'assistant',
  text: string,
  sessionId?: string,
  agentId = 'main',
): Promise<void> {
  try {
    if (role === 'user' && shouldSkipInput(text)) return;
    const truncated = text.slice(0, MAX_MESSAGE_CHARS);
    const raw = await callGemini(
      `${EXTRACTION_PROMPT}\n\nRole: ${role}\nTurn:\n${truncated}`,
    );
    const extracted = parseExtraction(raw);
    if (!extracted || extracted.skip) return;
    if (!(extracted.importance >= IMPORTANCE_THRESHOLD)) return;
    if (!extracted.summary) return;

    const embedding = await getEmbedding(extracted.summary);
    const dupes = await findSimilarMemories(chatId, embedding, 1, DUPLICATE_THRESHOLD);
    const dupe = dupes[0];
    if (dupe && dupe.similarity > DUPLICATE_THRESHOLD) {
      const existing = getMemoryById(dupe.id);
      if (existing && isContradiction(existing.summary, extracted.summary)) {
        const newId = saveStructuredMemoryAtomic({
          chat_id: chatId,
          agent_id: agentId,
          session_id: sessionId,
          raw_text: truncated,
          summary: extracted.summary,
          entities: extracted.entities,
          topics: extracted.topics,
          importance: extracted.importance,
          salience: extracted.salience,
          embedding: embeddingToBuffer(embedding),
        });
        supersedeMemory(dupe.id, newId);
      } else {
        touchMemory(dupe.id);
      }
      return;
    }

    saveStructuredMemoryAtomic({
      chat_id: chatId,
      agent_id: agentId,
      session_id: sessionId,
      raw_text: truncated,
      summary: extracted.summary,
      entities: extracted.entities,
      topics: extracted.topics,
      importance: extracted.importance,
      salience: extracted.salience,
      embedding: embeddingToBuffer(embedding),
    });
  } catch (err) {
    logger.warn({ err, chatId, role }, 'memory ingest failed (non-fatal)');
  }
}

/** Cheap contradiction heuristic; Gemini consolidation does the deep check. */
export function isContradiction(oldSummary: string, newSummary: string): boolean {
  const flip = /\b(no longer|not anymore|changed (my )?mind|instead|switched|prefer .* now|don't like anymore)\b/i;
  return flip.test(newSummary) && oldSummary.length > 0;
}
