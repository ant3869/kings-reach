// src/routing-routes.ts - Route advice page routes (/routing and /api/routing/advice). READ-ONLY: GET only, by contract
// (a test fails if any other method appears here). Advice never changes a route: acting on it is the operator's call, on the Settings page.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { PROJECT_ROOT } from './config.js';
import { defaultPaths, loadRuns } from './history.js';
import { loadRatings } from './ratings.js';
import { buildRoutingAdvice } from './routing-advice.js';
import { renderRouting } from './routing-html.js';

export function mountRouting(app: Hono): void {
  app.get('/routing', (c) => c.html(renderRouting(c.req.query('token') ?? '')));
  app.get('/routing/routing-app.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.body(readFileSync(join(PROJECT_ROOT, 'public', 'routing-app.js'), 'utf8'));
  });
  app.get('/api/routing/advice', (c) => {
    const paths = defaultPaths();
    return c.json(buildRoutingAdvice(loadRuns(paths), loadRatings(paths.runsFile)));
  });
}
