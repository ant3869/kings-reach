// src/difficulty.ts - "how smart does this step need to be?" Pure and dependency-free so it is trivial to test and tune.
// Three tiers (high / mid / low) map to three configured models. A step's tier comes from, in order of trust:
//   1. an explicit request (`difficulty`),  2. the pipeline stage it belongs to,  3. a cheap text heuristic.
// The model call itself is never made here; this only picks which of the configured models to try first.

import type { RouteTarget } from './provider-config.js';

export const TIERS = ['high', 'mid', 'low'] as const;
export type Tier = (typeof TIERS)[number];

/** Settings: which model serves each tier, and which roles let the tiers choose for them. */
export interface TierConfig {
  enabled: boolean;
  /** Roles whose model the tiers may pick. Omitted = every role. */
  roles?: string[];
  high: RouteTarget;
  mid: RouteTarget;
  low: RouteTarget;
}

export interface Assessment { tier: Tier; score: number; reasons: string[] }

/** Council and build stages have a known job, so their difficulty is known, not guessed. */
export const STAGE_TIER: Record<string, Tier> = {
  recall: 'low', record: 'low', preflight: 'low', gate: 'low',
  investigate: 'mid', debate: 'mid', execute: 'mid', review: 'mid',
  plan: 'high', verdict: 'high',
};

const HIGH_AT = 45;
const MID_AT = 20;

const HARD = /\b(architect\w*|design|refactor\w*|root[- ]cause|debug\w*|security|vulnerab\w*|trade-?offs?|migrat\w*|optimi[sz]\w*|algorithm\w*|prove|strateg\w*|analy[sz]\w*|compare|investigat\w*|diagnos\w*|concurren\w*|race condition|performance|audit|rewrite|why)\b/gi;
const WORK = /\b(write|add|fix|build|create|implement\w*|update|change|modify|test\w*|bug|error|fail\w*|function|endpoint|script|query|config\w*)\b/gi;
const EASY = /\b(summari[sz]e|translate|rename|reformat|format|reword|proofread|list|status|remind\w*|thanks?|ok(?:ay)?|hello|hi)\b/gi;
const CODE = /```|^\s+at .+:\d+|[\w./\\-]+\.(?:ts|tsx|js|mjs|py|json|ya?ml|md|css|html)\b/m;
const STEP_LINE = /^\s*(?:\d+[.)]|[-*])\s/gm;

const unique = (text: string, pattern: RegExp): number => new Set((text.match(pattern) ?? []).map((m) => m.toLowerCase())).size;

/** The user's own words: dashboard/Telegram prepend a memory block ending in "[user]", which would inflate the length score. */
export function userText(message: string): string {
  const at = message.lastIndexOf('\n[user]\n');
  return at >= 0 ? message.slice(at + 8) : message;
}

export function assessDifficulty(message: string, hint: { stage?: string; difficulty?: Tier } = {}): Assessment {
  if (hint.difficulty) return { tier: hint.difficulty, score: -1, reasons: ['requested'] };
  const stageTier = hint.stage ? STAGE_TIER[hint.stage.toLowerCase()] : undefined;
  if (stageTier) return { tier: stageTier, score: -1, reasons: [`stage: ${hint.stage}`] };

  const text = userText(message).trim();
  if (text.length <= 2 || /^(?:ok(?:ay)?|k|yes|no|thanks?|thank you|thx|got it|sure|hi|hello|hey|bye)[.!]?$/i.test(text)) {
    return { tier: 'low', score: 0, reasons: ['trivial message'] };
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
  return { tier: score >= HIGH_AT ? 'high' : score >= MID_AT ? 'mid' : 'low', score, reasons };
}

export const tierApplies = (cfg: TierConfig | null | undefined, agentId: string): cfg is TierConfig =>
  Boolean(cfg?.enabled) && (!cfg?.roles || cfg.roles.includes(agentId));

/** The tier's model goes first; the role's own routes stay behind it as the fallback chain (no duplicate of the pick). */
export function applyTier(routes: RouteTarget[], tier: Tier, cfg: TierConfig): RouteTarget[] {
  const pick = cfg[tier];
  return [pick, ...routes.filter((r) => !(r.provider === pick.provider && r.model === pick.model))];
}
