// src/history.ts - the Plan Library's data layer: reads the War Room run ledger, verdict archive and
// build artifacts. Read-only except activatePlan(). Paths are injectable so tests use fixtures; user input
// (run ids, file names) is validated and matched against directory listings, never joined blindly.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, STORE_DIR } from './config.js';
import { appendRating, loadRatings, type Rating, type RatingValue } from './ratings.js';

export interface LedgerPaths {
  runsFile: string;
  verdictJson: string;
  verdictMd: string;
  archiveDir: string;
  councilDir: string;
}

export const defaultPaths = (): LedgerPaths => ({
  runsFile: join(STORE_DIR, 'council-runs.jsonl'),
  verdictJson: join(STORE_DIR, 'summit-verdict.json'),
  verdictMd: join(STORE_DIR, 'summit-verdict.md'),
  archiveDir: join(STORE_DIR, 'verdicts'),
  councilDir: join(PROJECT_ROOT, 'workspace', 'council'),
});

/** One line of store/council-runs.jsonl (summit or build). Unlisted metric fields pass through untouched. */
export interface RunRecord {
  id: string;
  kind: 'summit' | 'build';
  question: string;
  started: string;
  outcome: string;
  total_s?: number;
  total_cost_usd?: number;
  verdict_confidence?: number;
  plan_steps?: number;
  changed_files?: string[];
  verdict_run?: string;
  [key: string]: unknown;
}

export interface PlanSummary {
  run: string;
  objective: string;
  question: string;
  confidence: number | null;
  steps: number;
  owners: string[];
}

export const RUN_ID = /^[0-9a-f]{8}$/;
const ARTIFACT_NAME = /^[\w][\w.\-]{0,80}$/;
const ARTIFACT_EXT = /\.(md|txt|json|log|csv)$/i;
const MAX_ARTIFACT_BYTES = 200_000;

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Every run, newest first. Corrupt lines are skipped rather than failing the page. */
export function loadRuns(p = defaultPaths()): RunRecord[] {
  if (!existsSync(p.runsFile)) return [];
  const runs: RunRecord[] = [];
  for (const line of readFileSync(p.runsFile, 'utf8').split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (!RUN_ID.test(String(r.id)) || (r.kind !== 'summit' && r.kind !== 'build')) continue;
      // Builds before the no_changes rule recorded "built" even when nothing changed. Reclassify on read;
      // the ledger file itself is never rewritten.
      if (r.kind === 'build' && r.outcome === 'built' && Array.isArray(r.changed_files) && r.changed_files.length === 0) {
        r.legacy_outcome = r.outcome;
        r.outcome = 'no_changes';
      }
      runs.push(r);
    } catch {
      // partial write or hand edit: ignore the line
    }
  }
  return runs.sort((a, b) => String(b.started).localeCompare(String(a.started)));
}

/** Which plan did each build execute? New builds record verdict_run; older ones are inferred from the
 *  newest locked verdict with the same question that started before the build. */
export function planOf(build: RunRecord, runs: RunRecord[]): string | null {
  if (build.verdict_run && RUN_ID.test(build.verdict_run)) return build.verdict_run;
  const match = runs.find((r) => r.kind === 'summit' && r.outcome === 'verdict'
    && r.question === build.question && r.started <= build.started);
  return match?.id ?? null; // runs are newest-first, so the first hit is the latest eligible summit
}

export function buildsOf(planId: string, runs: RunRecord[]): RunRecord[] {
  return runs.filter((r) => r.kind === 'build' && planOf(r, runs) === planId);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Stopped by you (Cancel) or by the spend limit: neither a success nor a failure of the build, so out of the rate. The spend still counts.
const STOPPED = new Set(['cancelled', 'over_budget']);

export function computeStats(runs: RunRecord[], ratings: Map<string, Rating> = new Map()) {
  const summits = runs.filter((r) => r.kind === 'summit');
  const builds = runs.filter((r) => r.kind === 'build');
  const count = (rs: RunRecord[], outcome: string) => rs.filter((r) => r.outcome === outcome).length;
  const finished = builds.filter((r) => !STOPPED.has(r.outcome));
  const executed = finished.filter((r) => r.outcome !== 'preflight_failed');
  const confidences = summits.filter((r) => typeof r.verdict_confidence === 'number').map((r) => num(r.verdict_confidence));
  const built = count(builds, 'built');
  const rated = runs.filter((r) => ratings.has(r.id));
  return {
    runs: runs.length,
    summits: summits.length,
    verdicts: count(summits, 'verdict'),
    builds: builds.length,
    built,
    needsWork: count(builds, 'needs_work'),
    noChanges: count(builds, 'no_changes'),
    preflightFailed: count(builds, 'preflight_failed'),
    cancelled: count(builds, 'cancelled'),
    overBudget: count(builds, 'over_budget'),
    buildSuccessRate: finished.length ? built / finished.length : null,
    totalCostUsd: Math.round(sum(runs.map((r) => num(r.total_cost_usd))) * 100) / 100,
    totalSeconds: Math.round(sum(runs.map((r) => num(r.total_s)))),
    avgConfidence: confidences.length ? sum(confidences) / confidences.length : null,
    avgBuildCostUsd: executed.length ? sum(executed.map((r) => num(r.total_cost_usd))) / executed.length : null,
    avgBuildSeconds: executed.length ? sum(executed.map((r) => num(r.total_s))) / executed.length : null,
    rated: rated.length,
    ratedUseful: rated.filter((r) => ratings.get(r.id)?.value === 1).length,
  };
}

export function summarize(r: RunRecord, runs: RunRecord[], objectives: Map<string, string> = new Map(), ratings: Map<string, Rating> = new Map()) {
  const planId = r.kind === 'build' ? planOf(r, runs) : r.id;
  return {
    id: r.id,
    kind: r.kind,
    outcome: r.outcome,
    started: r.started,
    // The question is often shared boilerplate across several runs; the plan's objective tells them apart.
    title: (planId && objectives.get(planId)) || String(r.question ?? '').slice(0, 200),
    question: String(r.question ?? '').slice(0, 200),
    totalSeconds: num(r.total_s),
    costUsd: num(r.total_cost_usd),
    confidence: typeof r.verdict_confidence === 'number' ? r.verdict_confidence : null,
    planSteps: num(r.plan_steps),
    // Measured only under rule 2 (v2.14.2). Older rows are either a self-report (pre-2.14) or rule 1, which counted
    // any rewording as a changed mind; showing either as a measurement would be wrong, so they show nothing.
    mindsChanged: r.mind_rule === 2 && typeof r.changed_minds_claimed === 'number' && typeof r.changed_minds === 'number'
      ? r.changed_minds : null,
    mindsClaimed: typeof r.changed_minds_claimed === 'number' ? r.changed_minds_claimed : null,
    changedFiles: Array.isArray(r.changed_files) ? r.changed_files.length : 0,
    criteriaMet: typeof r.criteria_met === 'string' ? r.criteria_met : null,
    plan: planId,
    builds: r.kind === 'summit' ? buildsOf(r.id, runs).length : 0,
    rating: ratings.get(r.id)?.value ?? null,
  };
}

/** The Build stage executes store/summit-verdict.json, which every summit overwrites. Keep each one. */
export function ensureArchive(p = defaultPaths()): void {
  const active = readJson<{ run?: string }>(p.verdictJson);
  if (!active?.run || !RUN_ID.test(active.run)) return;
  const target = join(p.archiveDir, `${active.run}.json`);
  if (existsSync(target)) return;
  mkdirSync(p.archiveDir, { recursive: true });
  copyFileSync(p.verdictJson, target);
  if (existsSync(p.verdictMd)) copyFileSync(p.verdictMd, join(p.archiveDir, `${active.run}.md`));
}

export function readPlan(id: string, p = defaultPaths()): Record<string, unknown> | null {
  if (!RUN_ID.test(id)) return null;
  ensureArchive(p);
  return readJson(join(p.archiveDir, `${id}.json`));
}

export function planSummary(plan: Record<string, unknown> | null): PlanSummary | null {
  if (!plan || typeof plan.run !== 'string') return null;
  const steps = Array.isArray(plan.plan) ? (plan.plan as Array<{ owner?: string }>) : [];
  return {
    run: plan.run,
    objective: String(plan.objective ?? ''),
    question: String(plan.question ?? '').slice(0, 300),
    confidence: typeof plan.confidence === 'number' ? plan.confidence : null,
    steps: steps.length,
    owners: [...new Set(steps.map((s) => String(s.owner)))],
  };
}

/** The plan the next Build will execute. */
export function activePlan(p = defaultPaths()): PlanSummary | null {
  return planSummary(readJson(p.verdictJson));
}

/** Make an archived plan the one Build executes. Overwrites store/summit-verdict.{json,md}. */
export function activatePlan(id: string, p = defaultPaths()): { ok: boolean; error?: string; plan?: PlanSummary } {
  if (!RUN_ID.test(id)) return { ok: false, error: 'bad run id' };
  ensureArchive(p);
  const json = join(p.archiveDir, `${id}.json`);
  if (!existsSync(json)) return { ok: false, error: `no archived verdict for ${id} (only locked verdicts can be loaded)` };
  copyFileSync(json, p.verdictJson);
  const md = join(p.archiveDir, `${id}.md`);
  if (existsSync(md)) copyFileSync(md, p.verdictMd);
  return { ok: true, plan: activePlan(p) ?? undefined };
}

export function listArtifacts(id: string, p = defaultPaths()): Array<{ name: string; bytes: number }> {
  if (!RUN_ID.test(id)) return [];
  const dir = join(p.councilDir, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => ARTIFACT_NAME.test(n) && ARTIFACT_EXT.test(n))
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }))
    .filter((f) => f.bytes <= MAX_ARTIFACT_BYTES);
}

/** Only names present in the directory listing are readable, so there is nothing to traverse. */
export function readArtifact(id: string, name: string, p = defaultPaths()): string | null {
  const hit = listArtifacts(id, p).find((f) => f.name === name);
  return hit ? readFileSync(join(p.councilDir, id, hit.name), 'utf8') : null;
}

export function runDetail(id: string, p = defaultPaths()) {
  if (!RUN_ID.test(id)) return null;
  const runs = loadRuns(p);
  const run = runs.find((r) => r.id === id);
  if (!run) return null;
  const planId = run.kind === 'build' ? planOf(run, runs) : run.id;
  const plan = planId ? readPlan(planId, p) : null;
  const mdFile = planId ? join(p.archiveDir, `${planId}.md`) : '';
  return {
    run,
    planId,
    plan,
    planMarkdown: mdFile && existsSync(mdFile) ? readFileSync(mdFile, 'utf8') : null,
    builds: run.kind === 'summit' ? buildsOf(run.id, runs).map((b) => summarize(b, runs)) : [],
    artifacts: planId ? listArtifacts(planId, p) : [],
    active: activePlan(p)?.run ?? null,
    rating: loadRatings(p.runsFile).get(id)?.value ?? null,
  };
}

/** Record (or take back) your verdict on a run. Only runs in the ledger can be rated. */
export function setRating(id: string, value: unknown, p = defaultPaths()): { ok: boolean; error?: string; rating?: 1 | -1 | null } {
  if (!RUN_ID.test(id) || !loadRuns(p).some((r) => r.id === id)) return { ok: false, error: 'run not found' };
  if (value !== 1 && value !== -1 && value !== 0) return { ok: false, error: 'value must be 1 (useful), -1 (not useful) or 0 (clear)' };
  appendRating(p.runsFile, id, value as RatingValue);
  return { ok: true, rating: loadRatings(p.runsFile).get(id)?.value ?? null };
}

export function historyOverview(p = defaultPaths()) {
  ensureArchive(p);
  const runs = loadRuns(p);
  const archived = existsSync(p.archiveDir)
    ? readdirSync(p.archiveDir).filter((n) => /^[0-9a-f]{8}\.json$/.test(n)).map((n) => n.slice(0, 8)) : [];
  const objectives = new Map<string, string>();
  for (const id of archived) {
    const objective = planSummary(readPlan(id, p))?.objective;
    if (objective) objectives.set(id, objective);
  }
  const ratings = loadRatings(p.runsFile);
  return {
    stats: computeStats(runs, ratings),
    runs: runs.map((r) => summarize(r, runs, objectives, ratings)),
    active: activePlan(p),
    archived,
  };
}
