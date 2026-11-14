// src/skills-routes.ts - Skills page routes (/skills and /api/skills/matrix). READ-ONLY: GET only, by contract
// (a test fails if any other method appears here). Mount AFTER the /api/* guard.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { loadAgentConfigs } from './agent-config.js';
import { PROJECT_ROOT } from './config.js';
import { buildSkillMatrix } from './skill-matrix.js';
import { renderSkills } from './skills-html.js';
import { readRegistry, verifySkill } from './skills.js';

export function mountSkills(app: Hono): void {
  app.get('/skills', (c) => c.html(renderSkills(c.req.query('token') ?? '')));
  app.get('/skills/skills-app.js', (c) => {
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    return c.body(readFileSync(join(PROJECT_ROOT, 'public', 'skills-app.js'), 'utf8'));
  });

  app.get('/api/skills/matrix', (c) => {
    const registry = readRegistry();
    const roles = loadAgentConfigs().map((a) => ({ id: a.id, name: a.name, active: a.active !== false }));
    return c.json(buildSkillMatrix(registry, roles, (name) => verifySkill(name, registry)));
  });
}
