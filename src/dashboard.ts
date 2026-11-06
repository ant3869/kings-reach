// src/dashboard.ts - Hono web server (REST + SSE) on DASHBOARD_HOST:DASHBOARD_PORT.
// Every /api route sits behind apiGuard (host allowlist + same-origin writes + token).

import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { DASHBOARD_HOST, DASHBOARD_PORT, DASHBOARD_TOKEN, PROJECT_ROOT } from './config.js';
import { getDb, getRecentHiveMind, createScheduledTask } from './db.js';
import { computeNextRun } from './scheduler.js';
import { getAgentRegistry } from './orchestrator.js';
import { renderDashboard } from './dashboard-html.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPlanLine, renderWarRoom, WARROOM_STATIC } from './warroom-html.js';
import { renderProviderSettings } from './provider-html.js';
import { mountHistory } from './history-routes.js';
import { defaultProviderRouting, loadProviderRouting, PROVIDERS, ROLE_GUIDANCE, saveProviderRouting } from './provider-config.js';
import { get9RouterCatalog, getProviderHealth } from './provider-runner.js';
import { buildModelChoices, invalidRoutes, readiness } from './provider-models.js';
import { apiGuard } from './http-guard.js';
import { collectHealth } from './health.js';
import { logger } from './logger.js';
import { startWarroom, stopWarroom, warroomStatus } from './warroom-supervisor.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
export const DASHBOARD_LOOPBACK = LOOPBACK_HOSTS.has(DASHBOARD_HOST);

export interface DashboardOptions {
  /** Graceful shutdown hook (closes DB, removes pid file). Used by the war-room Build reboot. */
  onShutdown?: () => void;
}

export function buildDashboardApp(opts: DashboardOptions = {}): Hono {
  const app = new Hono();

  app.get('/warroom', (c) => c.html(renderWarRoom()));
  // The page asks for this after a summit locks a verdict, so "Build will execute plan X" never names an old plan.
  app.get('/warroom/planline', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.html(renderPlanLine());
  });
  // Allowlisted static client files only (no path joins from user input).
  for (const name of WARROOM_STATIC) {
    app.get(`/warroom/${name}`, (c) => {
      const image = name.endsWith('.png') || name.endsWith('.webp');
      const type = name.endsWith('.webp') ? 'image/webp' : name.endsWith('.png') ? 'image/png'
        : name.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8';
      c.header('Content-Type', type);
      c.header('Cache-Control', image ? 'public, max-age=86400' : 'no-cache');
      const path = join(PROJECT_ROOT, 'public', name);
      return image ? c.body(readFileSync(path) as unknown as string) : c.body(readFileSync(path, 'utf8'));
    });
  }
  app.get('/', (c) => c.html(renderDashboard({ token: c.req.query('token') })));
  app.get('/providers', (c) => c.html(renderProviderSettings(c.req.query('token') ?? '')));

  app.use('/api/*', apiGuard({ token: DASHBOARD_TOKEN, loopbackOnly: DASHBOARD_LOOPBACK }));

  mountHistory(app);

  app.get('/api/health', async (c) => c.json(await collectHealth()));
  app.get('/api/providers', async (c) => {
    const models = await get9RouterCatalog();
    const catalog = { '9router': models, chatgpt: models.filter((m) => /^cx\//.test(m.id)),
      meta: models.filter((m) => /^(meta\/|cf\/@cf\/meta\/)/.test(m.id)) };
    const health = await getProviderHealth(models);
    return c.json({ config: loadProviderRouting(), providers: PROVIDERS, guidance: ROLE_GUIDANCE,
      health, catalog, choices: buildModelChoices(models, health) });
  });
  app.get('/api/providers/defaults', (c) => c.json({ config: defaultProviderRouting() }));
  app.put('/api/providers/config', async (c) => {
    try {
      const body = await c.req.json();
      // Only real, available (provider, model) pairs may be saved: the page offers dropdowns, this is the backstop.
      const models = await get9RouterCatalog();
      const health = await getProviderHealth(models);
      const problems = invalidRoutes(body, buildModelChoices(models, health), readiness(health));
      if (problems.length) return c.json({ error: `Not saved. ${problems.join('; ')}` }, 400);
      return c.json(saveProviderRouting(body));
    } catch (err) { return c.json({ error: String(err) }, 400); }
  });

  app.get('/api/memories', (c) => {
    const chatId = c.req.query('chatId') ?? '';
    const base = 'SELECT id, summary, importance, pinned, created_at FROM memories';
    const rows = chatId
      ? getDb().prepare(`${base} WHERE chat_id = ? ORDER BY created_at DESC LIMIT 50`).all(chatId)
      : getDb().prepare(`${base} ORDER BY created_at DESC LIMIT 50`).all();
    return c.json(rows);
  });

  app.get('/api/agents', (c) =>
    c.json([...getAgentRegistry().values()].map((a) => ({ id: a.id, name: a.name, model: a.model }))),
  );

  app.get('/api/tasks', (c) =>
    c.json(getDb().prepare('SELECT * FROM scheduled_tasks ORDER BY priority ASC, next_run ASC').all()),
  );

  app.get('/api/hive-mind', (c) => c.json(getRecentHiveMind(50)));

  app.get('/api/tokens', (c) => {
    const day = getDb()
      .prepare('SELECT COALESCE(SUM(input_tokens),0) t_in, COALESCE(SUM(output_tokens),0) t_out FROM token_usage WHERE created_at > ?')
      .get(Date.now() - 86_400_000);
    return c.json({ daily: day });
  });

  app.post('/api/chat', async (c) => {
    const body = (await c.req.json()) as { message?: string; agentId?: string; chatId?: string };
    if (!body.message?.trim()) return c.json({ error: 'message required' }, 400);
    const chatId = body.chatId?.trim() || 'dashboard';
    const { parseDelegation, delegateToAgent } = await import('./orchestrator.js');
    const { runAgent } = await import('./agent.js');
    const { getSession, setSession } = await import('./db.js');
    const { buildMemoryContext, saveConversationTurn } = await import('./memory.js');
    // buildMemoryContext already emits its own [Memory context] header.
    const memCtx = await buildMemoryContext(chatId, body.message).catch(() => '');
    const withMemory = memCtx ? `${memCtx}\n\n[user]\n${body.message}` : body.message;
    const remember = (text: string, sessionId: string | undefined, agentId: string): void => {
      saveConversationTurn(chatId, body.message as string, text, sessionId, agentId).catch((err) =>
        logger.warn({ err }, 'dashboard saveConversationTurn failed'),
      );
    };
    try {
      const routed = parseDelegation(body.message);
      if (routed) {
        const r = await delegateToAgent(routed.agentId, routed.prompt, chatId);
        if (r.text) remember(r.text, r.sessionId, r.agentId);
        return c.json({ text: r.text, agentId: r.agentId });
      }
      const agentId = body.agentId?.trim() || 'main';
      const sessionId = getSession(chatId, agentId) ?? undefined;
      const r = await runAgent({ message: withMemory, sessionId, agentId, chatId });
      const nextSession = r.newSessionId ?? sessionId;
      if (nextSession) setSession(chatId, nextSession, agentId);
      if (r.text) remember(r.text, nextSession, agentId);
      return c.json({ text: r.text ?? r.error ?? '(no reply)', agentId });
    } catch (err) {
      return c.json({ error: String(err).slice(0, 500) }, 500);
    }
  });

  app.post('/api/tasks', async (c) => {
    const body = (await c.req.json()) as { prompt?: string; schedule?: string; chatId?: string; agentId?: string; priority?: number };
    if (!body.prompt || !body.schedule || !body.chatId) return c.json({ error: 'prompt, schedule, chatId required' }, 400);
    let nextRun: number;
    try {
      nextRun = computeNextRun(body.schedule);
    } catch {
      return c.json({ error: `invalid cron expression: ${body.schedule}` }, 400);
    }
    const id = `dash_${Date.now().toString(36)}`;
    createScheduledTask({
      id,
      chat_id: body.chatId,
      prompt: body.prompt,
      schedule: body.schedule,
      next_run: nextRun,
      priority: body.priority ?? 3,
      agent_id: body.agentId ?? 'main',
      status: 'active',
    });
    return c.json({ id });
  });

  app.delete('/api/tasks/:id', (c) => {
    getDb().prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/api/agents', async (c) => {
    const { createAgent } = await import('./agent-create.js');
    const body = (await c.req.json()) as { id?: string; name?: string; description?: string };
    if (!body.id || !body.name || !body.description) return c.json({ error: 'id, name, description required' }, 400);
    await createAgent(body.id, body.name, body.description);
    return c.json({ ok: true, id: body.id });
  });

  app.post('/api/warroom/start', async (c) => {
    const r = await startWarroom();
    return c.json(r, r.ok ? 200 : 500);
  });

  app.post('/api/warroom/stop', async (c) => {
    const r = await stopWarroom();
    return c.json(r, r.ok ? 200 : 500);
  });

  app.get('/api/warroom/status', async (c) => c.json(await warroomStatus()));

  // Graceful stop (DB closed, pid file cleared). Windows has no SIGTERM between processes,
  // so the war-room Build reboot calls this instead of `taskkill /F` mid-write.
  app.post('/api/admin/shutdown', (c) => {
    if (!opts.onShutdown) return c.json({ error: 'shutdown not wired' }, 501);
    setTimeout(opts.onShutdown, 100);
    return c.json({ ok: true, pid: process.pid });
  });

  return app;
}

/**
 * Bind the dashboard. Resolves once listening; rejects on EADDRINUSE, which makes
 * :DASHBOARD_PORT the single-instance lock for the whole core.
 */
export function startDashboard(opts: DashboardOptions = {}): Promise<Server> {
  if (!DASHBOARD_LOOPBACK && !DASHBOARD_TOKEN) {
    return Promise.reject(new Error(`DASHBOARD_HOST=${DASHBOARD_HOST} is not loopback; set DASHBOARD_TOKEN first`));
  }
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: buildDashboardApp(opts).fetch, port: DASHBOARD_PORT, hostname: DASHBOARD_HOST }) as Server;
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
