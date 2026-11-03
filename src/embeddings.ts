import { getDb } from './db.js';
import { EMBEDDING_DIMS } from './gemini.js';

// One obvious way to do it: Float32 <-> Buffer <-> hex string.
export const DUPLICATE_THRESHOLD = 0.85;
export const SIMILARITY_THRESHOLD = 0.3;

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function embeddingToBuffer(embedding: number[]): Buffer {
  const arr = new Float32Array(embedding);
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

export function bufferToEmbedding(buffer: Buffer): number[] {
  const copy = Buffer.from(buffer);
  const arr = new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
  return Array.from(arr);
}

/** Hex encoding satisfies the "embedding hex" requirement without JSON bloat. */
export function embeddingToHex(embedding: number[]): string {
  return embeddingToBuffer(embedding).toString('hex');
}

export function hexToEmbedding(hex: string): number[] {
  return bufferToEmbedding(Buffer.from(hex, 'hex'));
}

/** Accept whatever the DB hands back: Buffer, Uint8Array, or hex string. */
export function storedToEmbedding(value: Buffer | Uint8Array | string | null): number[] | null {
  if (!value) return null;
  if (typeof value === 'string') {
    if (value.length === 0) return null;
    try {
      return hexToEmbedding(value);
    } catch {
      return null;
    }
  }
  return bufferToEmbedding(Buffer.from(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength));
}

export interface SimilarMemory {
  id: number;
  content: string;
  similarity: number;
}

export async function findSimilarMemories(
  chatId: string,
  queryEmbedding: number[],
  limit = 5,
  threshold: number = SIMILARITY_THRESHOLD,
): Promise<SimilarMemory[]> {
  if (queryEmbedding.length !== EMBEDDING_DIMS && queryEmbedding.length === 0) return [];
  const rows = getDb()
    .prepare(
      `SELECT id, summary, raw_text, embedding FROM memories
       WHERE chat_id = ? AND embedding IS NOT NULL AND superseded_by IS NULL`,
    )
    .all(chatId) as Array<{
    id: number;
    summary: string;
    raw_text: string | null;
    embedding: Buffer | null;
  }>;

  const scored: SimilarMemory[] = [];
  for (const row of rows) {
    const vec = storedToEmbedding(row.embedding);
    if (!vec) continue;
    const sim = cosineSimilarity(queryEmbedding, vec);
    if (sim >= threshold) {
      scored.push({ id: row.id, content: row.summary || row.raw_text || '', similarity: sim });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}
