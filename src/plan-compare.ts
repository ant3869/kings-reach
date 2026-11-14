// src/plan-compare.ts - what changed between two saved plans? Pure and deterministic: two plan objects in, a structured diff out.
//
// Only what the saved plan actually contains is compared (objective, verdict, confidence, success criteria and metrics, dissent, who decided, steps).
// Lists are compared by normalized text, so "Ship it." and "ship it" are the same line. Steps are rewritten between revisions far more often than
// they are copied, so they are PAIRED by word overlap: a pair above the threshold is "reworded", below it the step is simply added or removed.
// The overlap score is shown, never hidden, because it is a heuristic and the reader should be able to judge it.

export interface PlanStep { step?: unknown; owner?: unknown; done_when?: unknown }
export interface PlanLike {
  run?: unknown; objective?: unknown; verdict?: unknown; confidence?: unknown;
  success_criteria?: unknown; success_metrics?: unknown; dissent?: unknown; decided_by?: unknown; plan?: unknown;
}

export interface ListDiff { kept: string[]; onlyA: string[]; onlyB: string[] }
export interface StepRef { owner: string; step: string; doneWhen: string }
export interface StepPair { a: StepRef; b: StepRef; similarity: number; same: boolean; ownerChanged: boolean; doneWhenChanged: boolean }
export interface PlanComparison {
  a: string;
  b: string;
  objective: { a: string; b: string; same: boolean };
  verdictSame: boolean;
  confidence: { a: number | null; b: number | null; delta: number | null };
  criteria: ListDiff;
  metrics: ListDiff;
  dissent: ListDiff;
  decidedBy: ListDiff;
  steps: { pairs: StepPair[]; onlyA: StepRef[]; onlyB: StepRef[] };
}

/** Two steps whose word overlap is at least this are treated as the same step, reworded. */
export const PAIR_THRESHOLD = 0.5;
const MAX_ITEMS = 60; // pairing is quadratic; a real plan has a handful of steps

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const norm = (s: string): string => s.toLowerCase().replace(/[\s]+/g, ' ').replace(/[.\s]+$/, '').trim();
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, MAX_ITEMS) : []);
const words = (s: string): Set<string> => new Set(norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

export function overlap(a: string, b: string): number {
  const x = words(a), y = words(b);
  if (!x.size && !y.size) return norm(a) === norm(b) ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/** Order is kept from the side each line came from. Duplicates inside one list count once. */
export function diffLists(a: string[], b: string[]): ListDiff {
  const inA = new Map<string, string>(), inB = new Map<string, string>();
  for (const s of a) if (!inA.has(norm(s))) inA.set(norm(s), s);
  for (const s of b) if (!inB.has(norm(s))) inB.set(norm(s), s);
  return {
    kept: [...inA].filter(([k]) => inB.has(k)).map(([, v]) => v),
    onlyA: [...inA].filter(([k]) => !inB.has(k)).map(([, v]) => v),
    onlyB: [...inB].filter(([k]) => !inA.has(k)).map(([, v]) => v),
  };
}

const stepsOf = (p: PlanLike): StepRef[] => (Array.isArray(p.plan) ? (p.plan as PlanStep[]) : []).slice(0, MAX_ITEMS)
  .map((s) => ({ owner: text(s?.owner), step: text(s?.step), doneWhen: text(s?.done_when) }));

export function pairSteps(as: StepRef[], bs: StepRef[]): PlanComparison['steps'] {
  const scored: Array<{ i: number; j: number; sim: number }> = [];
  as.forEach((a, i) => bs.forEach((b, j) => {
    const sim = overlap(a.step, b.step);
    if (sim >= PAIR_THRESHOLD) scored.push({ i, j, sim });
  }));
  // best matches first; ties broken by position so the result never depends on iteration order
  scored.sort((p, q) => q.sim - p.sim || p.i - q.i || p.j - q.j);
  const usedA = new Set<number>(), usedB = new Set<number>(), pairs: Array<StepPair & { i: number }> = [];
  for (const { i, j, sim } of scored) {
    if (usedA.has(i) || usedB.has(j)) continue;
    usedA.add(i); usedB.add(j);
    const a = as[i]!, b = bs[j]!;
    pairs.push({ i, a, b, similarity: Math.round(sim * 100) / 100, same: norm(a.step) === norm(b.step),
      ownerChanged: a.owner !== b.owner, doneWhenChanged: norm(a.doneWhen) !== norm(b.doneWhen) });
  }
  pairs.sort((p, q) => p.i - q.i);
  return { pairs: pairs.map(({ i: _i, ...rest }) => rest), onlyA: as.filter((_, i) => !usedA.has(i)), onlyB: bs.filter((_, j) => !usedB.has(j)) };
}

const conf = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function comparePlans(a: PlanLike, b: PlanLike): PlanComparison {
  const ca = conf(a.confidence), cb = conf(b.confidence);
  return {
    a: text(a.run), b: text(b.run),
    objective: { a: text(a.objective), b: text(b.objective), same: norm(text(a.objective)) === norm(text(b.objective)) },
    verdictSame: norm(text(a.verdict)) === norm(text(b.verdict)),
    confidence: { a: ca, b: cb, delta: ca !== null && cb !== null ? Math.round((cb - ca) * 100) / 100 : null },
    criteria: diffLists(list(a.success_criteria), list(b.success_criteria)),
    metrics: diffLists(list(a.success_metrics), list(b.success_metrics)),
    dissent: diffLists(list(a.dissent), list(b.dissent)),
    decidedBy: diffLists(list(a.decided_by), list(b.decided_by)),
    steps: pairSteps(stepsOf(a), stepsOf(b)),
  };
}
