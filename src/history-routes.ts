// src/history-routes.ts - Plan Library routes. Mount AFTER the /api/* guard so every API call is protected
// (host allowlist, same-origin writes, token). The page itself carries no data; it fetches through the API.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { PROJECT_ROOT } from './config.js';
import { activatePlan, historyOverview, readArtifact, runDetail } from './history.js';
import { renderHistory } from './history-html.js';

export function mountHistory(app: Hono): void {
  app.get('/history', (c) => c.html(renderHistory(c.req.query('token') ?? '')));
  app.get('/history/history-app.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.body(readFileSync(join(PROJECT_ROOT, 'public', 'history-app.js'), 'utf8'));
  });

  app.get('/api/history', (c) => c.json(historyOverview()));

  app.get('/api/history/:id', (c) => {
    const detail = runDetail(c.req.param('id'));
    return detail ? c.json(detail) : c.json({ error: 'run not found' }, 404);
  });

  app.get('/api/history/:id/artifact/:name', (c) => {
    const text = readArtifact(c.req.param('id'), c.req.param('name'));
    return text === null ? c.json({ error: 'artifact not found' }, 404) : c.json({ text });
  });

  app.post('/api/history/:id/activate', (c) => {
    const r = activatePlan(c.req.param('id'));
    return c.json(r, r.ok ? 200 : 404);
  });
}
