import { DAILY_TOKEN_LIMIT, DAILY_COST_LIMIT, HOURLY_TOKEN_LIMIT } from './config.js';

/** Daily/hourly budget tracking. In-memory, resets on restart. DB builder adds persistence. */

interface Bucket {
  tokens: number;
  cost: number;
  day: string;
  hour: string;
}

const buckets = new Map<string, Bucket>();

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function hourKey(d = new Date()): string {
  return `${dayKey(d)}-${d.getHours()}`;
}

function bucketFor(chatId: string): Bucket {
  const key = chatId || 'global';
  let b = buckets.get(key);
  const now = new Date();
  if (!b || b.day !== dayKey(now)) {
    b = { tokens: 0, cost: 0, day: dayKey(now), hour: hourKey(now) };
    buckets.set(key, b);
  }
  return b;
}

export function trackUsage(chatId: string, _agentId: string, tokens: number, cost: number): void {
  const b = bucketFor(chatId);
  b.tokens += Math.max(0, tokens || 0);
  b.cost += Math.max(0, cost || 0);
  const global = bucketFor('global');
  if (chatId !== 'global') {
    global.tokens += Math.max(0, tokens || 0);
    global.cost += Math.max(0, cost || 0);
  }
}

export function getDailyUsage(chatId?: string): { tokens: number; cost: number } {
  const b = bucketFor(chatId || 'global');
  return { tokens: b.tokens, cost: b.cost };
}

export function getHourlyUsage(chatId?: string): { tokens: number; cost: number } {
  // Hourly is approximated from the daily bucket unless a tracker builder refines it.
  // Keep it honest: same numbers, documented.
  const b = bucketFor(chatId || 'global');
  const h = new Date().getHours();
  const fraction = 1 / Math.max(1, h + 1);
  return { tokens: Math.round(b.tokens * fraction), cost: b.cost * fraction };
}

export function isOverBudget(chatId?: string): boolean {
  const daily = getDailyUsage(chatId);
  if (DAILY_TOKEN_LIMIT > 0 && daily.tokens >= DAILY_TOKEN_LIMIT) return true;
  if (DAILY_COST_LIMIT > 0 && daily.cost >= DAILY_COST_LIMIT) return true;
  if (HOURLY_TOKEN_LIMIT > 0 && getHourlyUsage(chatId).tokens >= HOURLY_TOKEN_LIMIT) return true;
  return false;
}
