// src/http-guard.ts - one middleware for every /api route. Three locks:
//  1. Host allowlist  -> blocks DNS-rebinding (evil.com resolving to 127.0.0.1).
//  2. Same-origin writes -> blocks drive-by CSRF (any tab POSTing /api/chat = agent with tools).
//  3. Optional token  -> DASHBOARD_TOKEN via `x-kings-reach-token` header or `?token=`.

import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface GuardOptions {
  token: string;
  /** When true (default bind), only loopback Host headers are accepted. */
  loopbackOnly: boolean;
}

function hostname(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1).toLowerCase();
  return hostHeader.split(':')[0].toLowerCase();
}

export function tokenMatches(given: string | undefined, need: string): boolean {
  if (!need) return true;
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(need);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Pure decision function (unit-testable). Returns a reason string when the request must be refused. */
export function refusalReason(
  req: { method: string; host: string; origin?: string; fetchSite?: string; token?: string },
  opts: GuardOptions,
): string | null {
  if (opts.loopbackOnly && !LOOPBACK.has(hostname(req.host))) return 'host not allowed';
  if (!SAFE_METHODS.has(req.method)) {
    if (req.fetchSite && req.fetchSite !== 'same-origin' && req.fetchSite !== 'none') return 'cross-site request';
    if (req.origin && req.origin !== 'null') {
      let originHost = '';
      try {
        originHost = new URL(req.origin).host.toLowerCase();
      } catch {
        return 'bad origin';
      }
      if (originHost !== req.host.toLowerCase()) return 'cross-origin request';
    }
  }
  if (!tokenMatches(req.token, opts.token)) return 'unauthorized';
  return null;
}

export function apiGuard(opts: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    const reason = refusalReason(
      {
        method: c.req.method,
        host: c.req.header('host') ?? '',
        origin: c.req.header('origin'),
        fetchSite: c.req.header('sec-fetch-site'),
        token: c.req.header('x-kings-reach-token') ?? c.req.query('token'),
      },
      opts,
    );
    if (reason) return c.json({ error: reason }, reason === 'unauthorized' ? 401 : 403);
    await next();
  };
}
