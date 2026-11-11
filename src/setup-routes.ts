// src/setup-routes.ts - the first-run checklist and the provider re-check. Mount AFTER the /api/* guard (host allowlist,
// same-origin writes, token), like the Plan Library routes. Dependencies are injectable so tests never call a provider.

import type { Hono } from 'hono';
import { collectChecklist, recheckProvider } from './setup-checklist.js';

export interface SetupDeps { collect: typeof collectChecklist; recheck: typeof recheckProvider }

export function mountSetup(app: Hono, deps: SetupDeps = { collect: collectChecklist, recheck: recheckProvider }): void {
  app.get('/api/setup', async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(await deps.collect());
  });

  // POST on purpose: it spends a few tokens, so it must never happen from a prefetch or a stray link.
  app.post('/api/providers/:id/check', async (c) => {
    const r = await deps.recheck(c.req.param('id'));
    return r ? c.json(r) : c.json({ error: 'this provider cannot be re-checked with one call' }, 404);
  });
}
