// src/routing-advice.ts - what the run ledger says about which route (provider + model) does the work for each role. Pure: records in, advice out.
// ADVISORY ONLY. It measures whether a route COMPLETED its work, never whether the answer was good, and it changes nothing. Rules it keeps:
//  - Failures are classified. A route that was logged out, out of credit or unreachable is an environment problem, not a model-quality one,
//    and "skipped: tools required" is a capability gate that never ran at all. Only the rest count against a route's reliability.
//  - Cancelled runs are left out entirely (the user stopped them; their errors may be artifacts of stopping).
//  - A route needs MIN_ATTEMPTS real attempts before any advice about it is given. Below that it is listed, labelled "insufficient".
//  - A missing cost is not a zero cost, and a missing outcome is not a success.

export const MIN_ATTEMPTS = 5;
export const SOLID_ATTEMPTS = 20;
export const LEADER_MARGIN = 0.2;
export const UNRELIABLE_BELOW = 0.5;
export const ENVIRONMENT_MIN = 3;

export type Confidence = 'insufficient' | 'limited' | 'reasonable';
export type FailureKind = 'auth' | 'quota' | 'transport' | 'turn-limit' | 'other';
/** Failures that say nothing about the model. The one place this is decided: reliability and the environment warning both read it. */
const ENVIRONMENTAL: ReadonlySet<FailureKind> = new Set(['auth', 'quota', 'transport']);
const KINDS = ['auth', 'quota', 'transport', 'turn-limit', 'other'] as const;
const tally = (s: RouteStats, environmental: boolean): number => KINDS.filter((k) => ENVIRONMENTAL.has(k) === environmental).reduce((n, k) => n + s.failures[k], 0);

export interface RouteStats {
  provider: string; model: string;
  attempts: number; succeeded: number; skipped: number; salvaged: number;
  failures: Record<FailureKind, number>;
  /** succeeded / (succeeded + failures that are not environmental). null when there is nothing to divide. */
  reliability: number | null;
  runs: number; verdictRuns: number; builds: number; built: number; thumbsUp: number; thumbsDown: number;
  seconds: { samples: number; avg: number | null };
  cost: { samples: number; avgUsd: number | null; recordedZero: number };
  confidence: Confidence;
  skipReasons: string[];
}
export interface Advice { kind: 'observed-leader' | 'unreliable' | 'environment' | 'inert'; level: 'suggestion' | 'heads-up'; route: string; text: string }
export interface RoleAdvice { role: string; routes: RouteStats[]; advice: Advice[] }
export interface RoutingAdvice {
  coverage: { rows: number; summits: number; cancelledLeftOut: number; usable: number; roleRuns: number; roleRunsWithoutAttempts: number; ratings: number; builds: number };
  roles: RoleAdvice[];
  limits: string[];
}

type Rec = Record<string, unknown>;
const obj = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const label = (provider: string, model: string): string => `${provider} \u00B7 ${model}`;

export function classify(error: string): 'skipped' | FailureKind {
  if (/^skipped:/i.test(error)) return 'skipped';
  if (/not logged in|logged out|no usable credentials|sign in to claude/i.test(error)) return 'auth';
  if (/out of (extra )?usage|rate.?limit|quota|insufficient (credit|funds)|credit balance/i.test(error)) return 'quota';
  if (/maximum number of turns/i.test(error)) return 'turn-limit';
  if (/rmcp|transport channel|econn|enotfound|etimedout|timed? ?out|network|overloaded|(api error|status|http)\D{0,3}5\d\d\b/i.test(error)) return 'transport';
  return 'other';
}

export const MIN_NOTE = `A route needs ${MIN_ATTEMPTS} real attempts before any advice is given about it, and ${SOLID_ATTEMPTS} before the numbers are called reasonable.`;
export const ROUTING_LIMITS = [
  'This measures whether a route finished its work, not whether the answer was good. A fast, reliable route can still give weak answers.',
  'Sign-in, credit and connection failures are not counted against a model. Every other error is, including ones this page could not classify.',
  'Cancelled runs are left out. Cost and time are only attributed to a route when it was the only route a role tried in that run; otherwise they cannot be split.',
  'A cost of $0 is shown as "recorded as $0": it may be free, flat-rate or simply untracked. It is never treated as proof a route is free.',
  'Run outcomes and ratings are per run, not per route, so they show what happened when a route took part. They are context, not proof that the route caused it.',
  MIN_NOTE,
];

const blank = (provider: string, model: string): RouteStats => ({
  provider, model, attempts: 0, succeeded: 0, skipped: 0, salvaged: 0,
  failures: { auth: 0, quota: 0, transport: 0, 'turn-limit': 0, other: 0 }, reliability: null,
  runs: 0, verdictRuns: 0, builds: 0, built: 0, thumbsUp: 0, thumbsDown: 0,
  seconds: { samples: 0, avg: null }, cost: { samples: 0, avgUsd: null, recordedZero: 0 }, confidence: 'insufficient', skipReasons: [],
});

export function buildRoutingAdvice(records: unknown[], ratings: ReadonlyMap<string, { value: number }> = new Map()): RoutingAdvice {
  const rows = records.map(obj).filter((r): r is Rec => r !== null);
  const summits = rows.filter((r) => r.kind === 'summit');
  const buildsByVerdict = new Map<string, Rec[]>();
  for (const b of rows.filter((r) => r.kind === 'build')) {
    const v = str(b.verdict_run);
    if (v) buildsByVerdict.set(v, [...(buildsByVerdict.get(v) ?? []), b]);
  }
  const usable = summits.filter((r) => r.outcome !== 'cancelled');
  const table = new Map<string, Map<string, RouteStats>>();
  const secs = new Map<string, number[]>(), costs = new Map<string, number[]>(), counted = new Set<string>();
  let roleRuns = 0, roleRunsWithoutAttempts = 0;

  for (const run of usable) {
    const runId = str(run.id);
    for (const [role, raw] of Object.entries(obj(run.agents) ?? {})) {
      const agent = obj(raw);
      if (!agent) continue;
      roleRuns++;
      const attempts = (Array.isArray(agent.attempts) ? agent.attempts : []).map(obj).filter((a): a is Rec => a !== null && str(a.model) !== '');
      if (!attempts.length) { roleRunsWithoutAttempts++; continue; }
      const byRoute = (table.get(role) ?? table.set(role, new Map()).get(role)!);
      const keys = new Set(attempts.map((a) => `${str(a.provider)}\u0000${str(a.model)}`));
      for (const a of attempts) {
        const key = `${str(a.provider)}\u0000${str(a.model)}`;
        const s = byRoute.get(key) ?? byRoute.set(key, blank(str(a.provider), str(a.model))).get(key)!;
        const err = str(a.error);
        const kind = err ? classify(err) : null;
        if (kind === 'skipped') { s.skipped++; const why = err.replace(/^skipped:\s*/i, '').slice(0, 60); if (!s.skipReasons.includes(why)) s.skipReasons.push(why); continue; }
        s.attempts++;
        if (!err) s.succeeded++;
        else if (a.salvaged) s.salvaged++;
        else if (kind) s.failures[kind]++;
        const seen = `${role}|${key}|${runId}`;
        if (counted.has(seen)) continue;
        counted.add(seen);
        s.runs++;
        if (!err) {
          if (run.outcome === 'verdict') {
            s.verdictRuns++;
            for (const b of buildsByVerdict.get(runId) ?? []) { s.builds++; if (b.outcome === 'built') s.built++; }
          }
          const r = ratings.get(runId);
          if (r?.value === 1) s.thumbsUp++; else if (r?.value === -1) s.thumbsDown++;
        }
      }
      if (keys.size === 1) { // one route did the whole role: only then can its time and cost be told apart from another route's
        const key = `${role}|${[...keys][0]}`;
        const t = num(agent.seconds), c = num(agent.cost_usd);
        if (t !== null) secs.set(key, [...(secs.get(key) ?? []), t]);
        if (c !== null) costs.set(key, [...(costs.get(key) ?? []), c]);
      }
    }
  }

  const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const roles: RoleAdvice[] = [...table.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([role, byRoute]) => {
    const routes = [...byRoute.entries()].map(([key, s]) => {
      const t = secs.get(`${role}|${key}`) ?? [], c = costs.get(`${role}|${key}`) ?? [];
      const against = tally(s, false);
      s.reliability = s.succeeded + against > 0 ? s.succeeded / (s.succeeded + against) : null;
      s.seconds = { samples: t.length, avg: avg(t) };
      s.cost = { samples: c.length, avgUsd: avg(c), recordedZero: c.filter((x) => x === 0).length };
      s.confidence = s.attempts >= SOLID_ATTEMPTS ? 'reasonable' : s.attempts >= MIN_ATTEMPTS ? 'limited' : 'insufficient';
      return s;
    }).sort((a, b) => b.attempts - a.attempts || a.model.localeCompare(b.model));
    return { role, routes, advice: adviseRole(role, routes) };
  });

  return {
    coverage: { rows: rows.length, summits: summits.length, cancelledLeftOut: summits.length - usable.length, usable: usable.length, roleRuns, roleRunsWithoutAttempts, ratings: ratings.size, builds: [...buildsByVerdict.values()].reduce((n, b) => n + b.length, 0) },
    roles, limits: [...ROUTING_LIMITS],
  };
}

function adviseRole(role: string, routes: RouteStats[]): Advice[] {
  const out: Advice[] = [];
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  const enough = routes.filter((r) => r.confidence !== 'insufficient');
  for (const r of routes) {
    const name = label(r.provider, r.model);
    const env = tally(r, true);
    if (env >= ENVIRONMENT_MIN) out.push({ kind: 'environment', level: 'heads-up', route: name, text: `${name} hit ${env} sign-in, credit or connection failures for ${role}. That is not a verdict on the model: fix access before judging it.` });
    if (r.attempts === 0 && r.skipped >= ENVIRONMENT_MIN) out.push({ kind: 'inert', level: 'heads-up', route: name, text: `${name} was skipped ${r.skipped} times for ${role} (${r.skipReasons.join('; ') || 'no reason given'}) and never ran. In this role's list it adds nothing.` });
    if (r.confidence !== 'insufficient' && r.reliability !== null && r.reliability < UNRELIABLE_BELOW) {
      out.push({ kind: 'unreliable', level: 'suggestion', route: name, text: `${name} finished ${pct(r.reliability)} of its ${r.attempts} attempts for ${role} (${r.confidence} evidence). Consider placing it later in the list.` });
    }
  }
  const ranked = enough.filter((r) => r.reliability !== null).sort((a, b) => b.reliability! - a.reliability!);
  if (ranked.length >= 2 && ranked[0]!.reliability! - ranked[1]!.reliability! >= LEADER_MARGIN) {
    const [a, b] = [ranked[0]!, ranked[1]!];
    out.push({ kind: 'observed-leader', level: 'suggestion', route: label(a.provider, a.model),
      text: `For ${role}, ${label(a.provider, a.model)} finished ${pct(a.reliability!)} of ${a.attempts} attempts against ${pct(b.reliability!)} of ${b.attempts} for ${label(b.provider, b.model)}. If you care about completion, try it first. This says nothing about answer quality.` });
  }
  return out;
}
