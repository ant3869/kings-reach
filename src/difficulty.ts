// src/difficulty.ts - "how smart does this step need to be?" Pure and dependency-free so it is trivial to test and tune.
// Each PROVIDER has its own ladder: an ordered list of models from the weakest the user allows (low) to the strongest
// (high), with everything sensible in between. A step gets a continuous difficulty LEVEL from 0 (trivial) to 1 (hardest)
// and lands on the matching rung, so a medium-hard task gets a medium model, not just one of the two ends. A step never
// changes provider; it only moves along the ladder of the provider its role already uses.
// The level comes from, in order of trust:
//   1. an explicit request (`difficulty`),  2. the pipeline stage it belongs to,  3. a cheap text heuristic.
// The model call itself is never made here; this only decides which model each of the role's routes should try.

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
 * `level` (0..1) is the difficulty; `tier` is only its coarse label for logs and `light`.
 * `light`: the step needs no tool servers, so the run can skip loading them (the slow part of a first response).
 */
export interface Assessment { tier: Tier; level: number; score: number; reasons: string[]; light: boolean }

/** Council and build stages have a known job, so their difficulty is known, not guessed. */
export const STAGE_LEVEL: Record<string, number> = {
  recall: 0, record: 0, preflight: 0, gate: 0,
  investigate: 0.55, debate: 0.55, execute: 0.5, review: 0.5,
  plan: 1, verdict: 1,
};

/** A text score at or above this is as hard as a request gets (level 1). */
const LEVEL_SPAN = 60;
const tierOf = (level: number): Tier => (level >= 0.75 ? 'high' : level >= 1 / 3 ? 'mid' : 'low');
const TIER_LEVEL: Record<Tier, number> = { high: 1, mid: 0.5, low: 0 };

const HARD = /\b(architect\w*|design|refactor\w*|root[- ]cause|debug\w*|security|vulnerab\w*|trade-?offs?|migrat\w*|optimi[sz]\w*|algorithm\w*|prove|strateg\w*|analy[sz]\w*|compare|investigat\w*|diagnos\w*|concurren\w*|race condition|performance|audit|rewrite|why)\b/gi;
const WORK = /\b(write|add|fix|build|create|implement\w*|update|change|modify|test\w*|bug|error|fail\w*|function|endpoint|script|query|config\w*)\b/gi;
const EASY = /\b(summari[sz]e|translate|rename|reformat|format|reword|proofread|list|status|remind\w*|thanks?|ok(?:ay)?|hello|hi)\b/gi;
const CODE = /```|^\s+at .+:\d+|[\w./\\-]+\.(?:ts|tsx|js|mjs|py|json|ya?ml|md|css|html)\b/m;
const NEEDS_TOOLS = /\b(github|issues?|pull requests?|prs?|repos?|repository|commits?|branch\w*|files?|folders?|search\w*|fetch\w*|browse\w*|download\w*|urls?|website|https?)\b|https?:|[\w./\\-]+\.(?:ts|tsx|js|mjs|py|json|ya?ml|md|css|html)\b/i;
const STEP_LINE = /^\s*(?:\d+[.)]|[-*])\s/gm;

const unique = (text: string, pattern: RegExp): number => new Set((text.match(pattern) ?? []).map((m) => m.toLowerCase())).size;

/** The user's own words: dashboard/Telegram prepend a memory block ending in "[user]", which would inflate the length score. */
export function userText(message: string): string {
  const at = message.lastIndexOf('\n[user]\n');
  return at >= 0 ? message.slice(at + 8) : message;
}

export function assessDifficulty(message: string, hint: { stage?: string; difficulty?: Tier } = {}): Assessment {
  if (hint.difficulty) return { tier: hint.difficulty, level: TIER_LEVEL[hint.difficulty], score: -1, reasons: ['requested'], light: false };
  const stageLevel = hint.stage ? STAGE_LEVEL[hint.stage.toLowerCase()] : undefined;
  if (stageLevel !== undefined) return { tier: tierOf(stageLevel), level: stageLevel, score: -1, reasons: [`stage: ${hint.stage}`], light: stageLevel === 0 };

  const text = userText(message).trim();
  if (text.length <= 2 || /^(?:ok(?:ay)?|k|yes|no|thanks?|thank you|thx|got it|sure|hi|hello|hey|bye)[.!]?$/i.test(text)) {
    return { tier: 'low', level: 0, score: 0, reasons: ['trivial message'], light: true };
  }
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, why: string): void => { if (points) { score += points; reasons.push(`${points > 0 ? '+' : ''}${points} ${why}`); } };
  add(Math.min(30, Math.round(text.length / 40)), 'length');
  add(Math.min(32, unique(text, HARD) * 8), 'hard-task wording');
  add(Math.min(15, unique(text, WORK) * 5), 'concrete work');
  if (CODE.test(text)) add(10, 'code or file reference');
  add(Math.min(16, ((text.match(STEP_LINE) ?? []).length + (text.match(/\bthen\b/gi) ?? []).length) * 4), 'multiple steps');
  add(-Math.min(20, unique(text, EASY) * 10), 'simple-task wording');
  score = Math.max(0, Math.min(100, score));
  const level = Math.min(1, score / LEVEL_SPAN);
  const tier = tierOf(level);
  // Easy AND clearly not about repos/files/the web: safe to run without tool servers. Anything that smells of tools keeps them.
  return { tier, level, score, reasons, light: tier === 'low' && !NEEDS_TOOLS.test(text) };
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
