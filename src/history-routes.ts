// src/history-routes.ts - Plan Library routes. Mount AFTER the /api/* guard so every API call is protected
// (host allowlist, same-origin writes, token). The page itself carries no data; it fetches through the API.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { PROJECT_ROOT } from './config.js';
import { activatePlan, compareArchived, defaultPaths, historyOverview, promotePlan, readArtifact, runDetail, setRating, type LedgerPaths } from './history.js';
import { exportMarkdown } from './history-export.js';
import { renderHistory } from './history-html.js';

/** `paths` is injectable so tests can run every route against a fixture ledger instead of the real store. */
export function mountHistory(app: Hono, paths: LedgerPaths = defaultPaths()): void {
  app.get('/history', (c) => c.html(renderHistory(c.req.query('token') ?? '')));
  // A fixed list, never a path taken from the request: the page's two scripts are the only files this route can serve.
  for (const name of ['history-plans.js', 'history-app.js']) {
    app.get(`/history/${name}`, (c) => {
      c.header('Content-Type', 'text/javascript; charset=utf-8');
      c.header('Cache-Control', 'no-cache');
      return c.body(readFileSync(join(PROJECT_ROOT, 'public', name), 'utf8'));
    });
  }

  app.get('/api/history', (c) => c.json(historyOverview(paths)));

  // Registered before /api/history/:id/... so the literal segment "compare" is never read as a run id.
  app.get('/api/history/compare/:a/:b', (c) => {
    const r = compareArchived(c.req.param('a'), c.req.param('b'), paths);
    return c.json(r, r.ok ? 200 : r.error.startsWith('bad') || r.error.startsWith('pick') ? 400 : 404);
  });

  app.get('/api/history/:id', (c) => {
    const detail = runDetail(c.req.param('id'), paths);
    return detail ? c.json(detail) : c.json({ error: 'run not found' }, 404);
  });

  app.get('/api/history/:id/artifact/:name', (c) => {
    const text = readArtifact(c.req.param('id'), c.req.param('name'), paths);
    return text === null ? c.json({ error: 'artifact not found' }, 404) : c.json({ text });
  });

  // The whole run as one Markdown file, for handing to another agent. Fetched with the token header, so it is a download, not a link.
  app.get('/api/history/:id/export.md', (c) => {
    const report = exportMarkdown(c.req.param('id'), paths);
    if (!report) return c.json({ error: 'run not found' }, 404);
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${report.filename}"`);
    c.header('Cache-Control', 'no-store');
    return c.body(report.markdown);
  });

  app.post('/api/history/:id/rating', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    const r = setRating(c.req.param('id'), body.value, paths);
    return c.json(r, r.ok ? 200 : r.error === 'run not found' ? 404 : 400);
  });

  app.post('/api/history/:id/promote', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
    const r = promotePlan(c.req.param('id'), body.value, paths);
    return c.json(r, r.ok ? 200 : r.error?.startsWith('bad') || r.error?.startsWith('value') ? 400 : 404);
  });

  app.post('/api/history/:id/activate', (c) => {
    const r = activatePlan(c.req.param('id'), paths);
    return c.json(r, r.ok ? 200 : 404);
  });
}
