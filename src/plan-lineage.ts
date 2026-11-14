// src/plan-lineage.ts - which plans are revisions of the same question? Pure: ledger facts in, threads out (no I/O, easy to test).
//
// The ledger records no parent link between summits, so a thread is INFERRED: verdict summits whose question text is identical after
// trimming, lower-casing and collapsing whitespace. That is a real signal (the same question put to the council again) but not proof of
// intent, so every thread carries `basis` saying so and the page shows it. Summits that ended without a verdict have no plan and no thread.

import { createHash } from 'node:crypto';
import type { RunRecord } from './history.js';
import type { Promotion } from './plan-promotions.js';

export const THREAD_BASIS = 'identical question text (inferred: the ledger records no parent link)';

export const normalizeQuestion = (q: unknown): string => String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Stable id of a thread. 12 hex of SHA-1 over the normalized question: an id, not a secret. '' for a blank question (it has no thread). */
export const threadKey = (q: unknown): string => {
  const n = normalizeQuestion(q);
  return n ? createHash('sha1').update(n).digest('hex').slice(0, 12) : '';
};

export interface ThreadPlan {
  id: string;
  started: string;
  objective: string | null;
  confidence: number | null;
  steps: number;
  builds: number;
  built: number;
  /** False when the verdict was overwritten before plans were archived: it counts as a revision but cannot be loaded, compared or promoted. */
  archived: boolean;
}

export interface Thread {
  key: string;
  question: string;
  basis: string;
  /** Oldest first, so "revision 2 of 3" reads naturally. */
  plans: ThreadPlan[];
  /** The plan chosen as the plan of record, only if it is still one of this thread's archived plans. */
  planOfRecord: string | null;
}

export interface ThreadInputs {
  runs: RunRecord[];
  /** Run ids that have an archived plan file. */
  archived: ReadonlySet<string>;
  objectives: ReadonlyMap<string, string>;
  buildsByPlan: ReadonlyMap<string, RunRecord[]>;
  promotions: ReadonlyMap<string, Promotion>;
}

export function buildThreads({ runs, archived, objectives, buildsByPlan, promotions }: ThreadInputs): Map<string, Thread> {
  const threads = new Map<string, Thread>();
  for (const r of runs) {
    if (r.kind !== 'summit' || r.outcome !== 'verdict') continue;
    const key = threadKey(r.question);
    if (!key) continue;
    const builds = buildsByPlan.get(r.id) ?? [];
    const thread = threads.get(key) ?? { key, question: String(r.question).slice(0, 300), basis: THREAD_BASIS, plans: [], planOfRecord: null };
    thread.plans.push({
      id: r.id,
      started: String(r.started),
      objective: objectives.get(r.id) ?? null,
      confidence: typeof r.verdict_confidence === 'number' ? r.verdict_confidence : null,
      steps: typeof r.plan_steps === 'number' ? r.plan_steps : 0,
      builds: builds.length,
      built: builds.filter((b) => b.outcome === 'built').length,
      archived: archived.has(r.id),
    });
    threads.set(key, thread);
  }
  for (const t of threads.values()) {
    t.plans.sort((a, b) => a.started.localeCompare(b.started) || a.id.localeCompare(b.id));
    const chosen = promotions.get(t.key)?.plan ?? null;
    t.planOfRecord = chosen && t.plans.some((p) => p.id === chosen && p.archived) ? chosen : null;
  }
  return threads;
}

/** The thread a plan belongs to, or null (not a verdict summit, or a blank question). */
export function threadOfPlan(threads: ReadonlyMap<string, Thread>, planId: string): Thread | null {
  for (const t of threads.values()) if (t.plans.some((p) => p.id === planId)) return t;
  return null;
}
