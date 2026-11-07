/**
 * Error classification with retry policies.
 * Errors should never pass silently... unless classified.
 */

export type ErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'context_exhausted'
  | 'timeout'
  | 'subprocess_crash'
  | 'network'
  | 'billing'
  | 'overloaded'
  | 'unknown';

export interface ErrorRecovery {
  shouldRetry: boolean;
  shouldNewChat: boolean;
  shouldSwitchModel: boolean;
  retryAfterMs: number;
  userMessage: string;
}

const PATTERNS: Array<{ category: ErrorCategory; needles: string[] }> = [
  { category: 'auth', needles: ['unauthorized', '401', 'invalid api key', 'forbidden', '403', 'not logged in', 'logged out', 'auth login', '/login'] },
  { category: 'rate_limit', needles: ['rate limit', '429', 'too many requests'] },
  { category: 'context_exhausted', needles: ['context window', 'max tokens', 'context length', 'too long'] },
  { category: 'timeout', needles: ['timeout', 'timed out', 'etimedout', 'deadline exceeded'] },
  { category: 'subprocess_crash', needles: ['subprocess', 'spawn', 'enoent', 'econnreset'] },
  { category: 'network', needles: ['network', 'econnrefused', 'enotfound', 'socket hang up', 'fetch failed'] },
  { category: 'billing', needles: ['billing', 'payment', 'quota exceeded', 'insufficient funds', '402'] },
  { category: 'overloaded', needles: ['overloaded', '503', 'service unavailable', 'try again later'] },
];

const RECOVERY: Record<ErrorCategory, ErrorRecovery> = {
  auth: {
    shouldRetry: false,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 0,
    userMessage: 'Auth failed. Claude: run "claude auth login". API providers: check the key in .env.',
  },
  rate_limit: {
    shouldRetry: true,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 30_000,
    userMessage: 'Rate limited. Retrying shortly.',
  },
  context_exhausted: {
    shouldRetry: true,
    shouldNewChat: true,
    shouldSwitchModel: false,
    retryAfterMs: 0,
    userMessage: 'Context full. Starting a fresh chat.',
  },
  timeout: {
    shouldRetry: true,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 5_000,
    userMessage: 'Timed out. Retrying.',
  },
  subprocess_crash: {
    shouldRetry: true,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 3_000,
    userMessage: 'Subprocess hiccup. Retrying.',
  },
  network: {
    shouldRetry: true,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 5_000,
    userMessage: 'Network wobble. Retrying.',
  },
  billing: {
    shouldRetry: false,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 0,
    userMessage: 'Billing/quota issue. Check your provider dashboard.',
  },
  overloaded: {
    shouldRetry: true,
    shouldNewChat: false,
    shouldSwitchModel: true,
    retryAfterMs: 15_000,
    userMessage: 'Provider overloaded. Retrying, maybe with fallback model.',
  },
  unknown: {
    shouldRetry: true,
    shouldNewChat: false,
    shouldSwitchModel: false,
    retryAfterMs: 5_000,
    userMessage: 'Something odd happened. Retrying once.',
  },
};

export function classifyError(error: Error | string): {
  category: ErrorCategory;
  recovery: ErrorRecovery;
} {
  const text = (typeof error === 'string' ? error : (error?.message ?? String(error))).toLowerCase();
  for (const group of PATTERNS) {
    for (const needle of group.needles) {
      if (text.includes(needle)) {
        return { category: group.category, recovery: RECOVERY[group.category] };
      }
    }
  }
  return { category: 'unknown', recovery: RECOVERY.unknown };
}
