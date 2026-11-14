// src/plan-promotions.ts - "which plan is the plan of record for this question?" Append-only JSONL beside the run ledger, last line per thread wins.
// Same shape and reason as ratings.ts: the War Room's Python code owns council-runs.jsonl and appends to it while the core runs, so this state lives in a file
// of its own. Promoting is a durable choice; "loading" a plan is not (the next summit overwrites store/summit-verdict.json).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface Promotion {
  /** The plan of record, or null when the choice was taken back. */
  plan: string | null;
  at: string;
}

const THREAD = /^[0-9a-f]{12}$/;
const PLAN = /^[0-9a-f]{8}$/;

export const promotionsFile = (runsFile: string): string => join(dirname(runsFile), 'plan-promotions.jsonl');

/** Latest choice per thread. Corrupt, foreign or malformed lines are skipped, never fatal. */
export function loadPromotions(runsFile: string): Map<string, Promotion> {
  const file = promotionsFile(runsFile);
  const out = new Map<string, Promotion>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line) as { thread?: unknown; plan?: unknown; at?: unknown };
      if (typeof r.thread !== 'string' || !THREAD.test(r.thread)) continue;
      if (r.plan !== null && !(typeof r.plan === 'string' && PLAN.test(r.plan))) continue;
      out.set(r.thread, { plan: r.plan, at: typeof r.at === 'string' ? r.at : '' });
    } catch {
      // a partial write or a hand edit: ignore the line
    }
  }
  return out;
}

/** The caller (history.ts) has already checked that the plan is a real, archived verdict in this thread. */
export function appendPromotion(runsFile: string, thread: string, plan: string | null, at = new Date().toISOString()): void {
  if (!THREAD.test(thread) || (plan !== null && !PLAN.test(plan))) throw new Error('bad thread or plan id');
  appendFileSync(promotionsFile(runsFile), JSON.stringify({ thread, plan, at }) + '\n', 'utf8');
}
