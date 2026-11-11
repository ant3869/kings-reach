// src/ratings.ts - "was this result useful?", one answer per run. Append-only JSONL beside the run ledger, last line wins.
// A separate file (not a field in council-runs.jsonl) because the War Room's Python code owns that ledger and appends to it
// while the core is running; two writers rewriting one file would lose rows.
// No ledger check here: history.ts validates the run id before calling appendRating().

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type RatingValue = 1 | -1 | 0; // 0 = take the rating back

export interface Rating {
  value: 1 | -1;
  at: string;
}

export const ratingsFile = (runsFile: string): string => join(dirname(runsFile), 'ratings.jsonl');

/** Latest rating per run id. A 0 removes it. Corrupt or foreign lines are skipped, never fatal. */
export function loadRatings(runsFile: string): Map<string, Rating> {
  const file = ratingsFile(runsFile);
  const out = new Map<string, Rating>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line) as { id?: unknown; value?: unknown; at?: unknown };
      if (typeof r.id !== 'string') continue;
      if (r.value === 0) out.delete(r.id);
      else if (r.value === 1 || r.value === -1) out.set(r.id, { value: r.value, at: String(r.at ?? '') });
    } catch {
      // partial write: ignore the line
    }
  }
  return out;
}

export function appendRating(runsFile: string, id: string, value: RatingValue, now: Date = new Date()): void {
  appendFileSync(ratingsFile(runsFile), `${JSON.stringify({ id, value, at: now.toISOString() })}\n`, 'utf8');
}
