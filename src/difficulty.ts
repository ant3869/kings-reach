// src/difficulty.ts - "how smart does this step need to be?" Pure and dependency-free so it is trivial to test and tune.
// Each PROVIDER has its own ladder: an ordered list of models from the weakest the user allows (low) to the strongest
// (high), with everything sensible in between. A step gets a continuous difficulty LEVEL from 0 (trivial) to 1 (hardest)
// and lands on the matching rung, so a medium-hard task gets a medium model, not just one of the two ends. A step never
// changes provider; it only moves along the ladder of the provider its role already uses.
// The level comes from, in order of trust:
//   1. an explicit request (`difficulty`),  2. the pipeline stage it belongs to,  3. a cheap text heuristic.
// The model call itself is never made here; this only decides which model each of the role's routes should try.

import { hasAttachments, withoutAttachments } from './attach-format.js';
import { MODEL } from './difficulty-model.js';
import type { RouteTarget } from './provider-config.js';

export const TIERS = ['high', 'mid', 'low'] as const;
export type Tier = (typeof TIERS)[number];

/** Settings: per provider, model ids ordered weakest -> strongest; and which roles let the ladders choose for them. */
export interface TierConfig {
  enabled: boolean;
  /** Roles whose model the ladders may pick. Omitted = every role. */
  roles?: string[];
  providers: Record<string, string[]>;
}

/**
 * `level` (0..1) is the difficulty; `tier` is only its coarse label for logs and `light`. `score` is the expected number of
 * model turns plus tool calls for free-form text (-1 when an explicit request or the stage decided).
 * `light`: the step needs no tool servers, so the run can skip loading them (the slow part of a first response).
 */
export interface Assessment { tier: Tier; level: number; score: number; reasons: string[]; light: boolean }

/**
 * Council and build stages have a known job, so their difficulty is known, not guessed. The chair's two steps (plan, verdict)
 * are synthesis: the plan is told to skim a file or two and the verdict to decide from what the specialists already found, so
 * they start at mid like the investigation they depend on. Always giving the chair the top model cost about half of a council
 * (an Opus verdict, $1.02 of $2.03) on a plain "which file does X" question that Sonnet answered as well.
 */
export const STAGE_LEVEL: Record<string, number> = {
  recall: 0, record: 0, preflight: 0, gate: 0,
  investigate: 0.55, debate: 0.55, execute: 0.5, review: 0.5,
  plan: 0.5, verdict: 0.5,
};
/** Stages whose level the QUESTION can raise: a genuinely hard question deserves the strongest chair. */
const CHAIR_STAGES = new Set(['plan', 'verdict']);

/** The council's own question, from the `[Council question]` block every chair prompt starts with. */
export function councilQuestion(message: string): string | undefined {
  return /\[Council question\]\n([\s\S]*?)(?:\n\n\[|$)/.exec(message)?.[1]?.trim() || undefined;
}

const tierOf = (level: number): Tier => (level >= 0.75 ? 'high' : level >= 1 / 3 ? 'mid' : 'low');
const TIER_LEVEL: Record<Tier, number> = { high: 1, mid: 0.5, low: 0 };

const CODE = /```|^\s+at .+:\d+|[\w./\\-]+\.(?:ts|tsx|js|mjs|py|json|ya?ml|md|css|html)\b/m;
const NEEDS_TOOLS = /\b(github|issues?|pull requests?|prs?|repos?|repository|commits?|branch\w*|files?|folders?|search\w*|fetch\w*|browse\w*|download\w*|urls?|website|https?)\b|https?:|[\w./\\-]+\.(?:ts|tsx|js|mjs|py|json|ya?ml|md|css|html)\b/i;

/** The user's own words: dashboard/Telegram prepend a memory block ending in "[user]", which would inflate the length score. */
export function userText(message: string): string {
  const at = message.lastIndexOf('\n[user]\n');
  return withoutAttachments(at >= 0 ? message.slice(at + 8) : message);
}

/**
 * Raw measurements of a prompt. The model weights them; the calibration tool fits those weights from real runs.
 * To try a new candidate feature, add it here and to MODEL.weights, then run the calibration tool: it keeps the feature only
 * if it improves accuracy on prompts the fit has not seen. (A hard-task word list and a step counter were tried on 162 real
 * prompts and added nothing beyond length, so they were removed.)
 */
export interface Features { logChars: number; code: number }

export function features(text: string): Features {
  return { logChars: Math.log1p(text.length), code: CODE.test(text) ? 1 : 0 };
}

const FEATURE_LABEL: Record<keyof Features, string> = { logChars: 'length', code: 'code or file reference' };

/** Predicted ln(1 + turns + tool calls) for a prompt's features. */
export const predictEffort = (f: Features): number =>
  MODEL.intercept + (Object.keys(MODEL.weights) as (keyof Features)[]).reduce((sum, k) => sum + MODEL.weights[k] * f[k], 0);

/** Piecewise-linear lookup through the calibration anchors, clamped to 0..1 outside them. */
export function levelOf(effort: number, anchors: [number, number][] = MODEL.anchors): number {
  const [first, last] = [anchors[0], anchors[anchors.length - 1]];
  if (effort <= first[0]) return first[1];
  if (effort >= last[0]) return last[1];
  const i = anchors.findIndex(([x]) => x >= effort);
  const [x0, y0] = anchors[i - 1];
  const [x1, y1] = anchors[i];
  return x1 === x0 ? y1 : y0 + ((effort - x0) / (x1 - x0)) * (y1 - y0);
}

export function assessDifficulty(message: string, hint: { stage?: string; difficulty?: Tier } = {}): Assessment {
  if (hint.difficulty) return { tier: hint.difficulty, level: TIER_LEVEL[hint.difficulty], score: -1, reasons: ['requested'], light: false };
  const stageLevel = hint.stage ? STAGE_LEVEL[hint.stage.toLowerCase()] : undefined;
  if (stageLevel !== undefined) {
    const question = CHAIR_STAGES.has(hint.stage!.toLowerCase()) ? councilQuestion(message) : undefined;
    const asked = question ? assessDifficulty(question).level : 0;
    const level = Math.max(stageLevel, asked);
    const reasons = [`stage: ${hint.stage}`, ...(asked > stageLevel ? [`hard question: level ${asked.toFixed(2)}`] : [])];
    return { tier: tierOf(level), level, score: -1, reasons, light: stageLevel === 0 };
  }

  const text = userText(message).trim();
  if (text.length <= 2 || /^(?:ok(?:ay)?|k|yes|no|thanks?|thank you|thx|got it|sure|hi|hello|hey|bye)[.!]?$/i.test(text)) {
    return { tier: 'low', level: 0, score: 0, reasons: ['trivial message'], light: true };
  }
  const f = features(text);
  const effort = predictEffort(f);
  const level = levelOf(effort);
  const tier = tierOf(level);
  const reasons = [`expected ~${Math.max(0, Math.round(Math.expm1(effort)))} model turns and tool calls`];
  for (const k of Object.keys(MODEL.weights) as (keyof Features)[]) {
    const part = MODEL.weights[k] * f[k];
    if (Math.abs(part) >= 0.15) reasons.push(`${part > 0 ? '+' : ''}${part.toFixed(2)} ${FEATURE_LABEL[k]}`);
  }
  // Easy AND clearly not about repos/files/the web: safe to run without tool servers. Anything that smells of tools keeps them.
  return { tier, level, score: Math.max(0, Math.round(Math.expm1(effort))), reasons, light: tier === 'low' && !NEEDS_TOOLS.test(text) && !hasAttachments(message) };
}

export const tierApplies = (cfg: TierConfig | null | undefined, agentId: string): cfg is TierConfig =>
  Boolean(cfg?.enabled) && (!cfg?.roles || cfg.roles.includes(agentId));

/** Which rung of an n-rung ladder a difficulty level lands on: 0 is the bottom, 1 the top, anything between is proportional. */
export function ladderIndex(rungs: number, level: number): number {
  return Math.round(Math.min(1, Math.max(0, level)) * (rungs - 1));
}

/**
 * Re-model each of the role's routes from its own provider's ladder. The provider and the route order never change; the
 * role's configured model stays right behind the picked one as that provider's fallback. Providers without a ladder
 * are left exactly as configured.
 */
export function applyTiers(routes: RouteTarget[], level: number, cfg: TierConfig): RouteTarget[] {
  const out: RouteTarget[] = [];
  const add = (t: RouteTarget): void => { if (!out.some((o) => o.provider === t.provider && o.model === t.model)) out.push(t); };
  for (const route of routes) {
    const ladder = cfg.providers[route.provider];
    const pick = ladder?.length ? ladder[ladderIndex(ladder.length, level)] : undefined;
    if (pick) add({ provider: route.provider, model: pick });
    add(route);
  }
  return out;
}
