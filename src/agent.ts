// src/agent.ts - the ONE way to run an agent (Telegram, dashboard, orchestrator, war room).
// Resolves the agent's config (cwd -> its CLAUDE.md via settingSources, model), keeps Claude
// Code's own system prompt (tool skills!) and only APPENDS runtime context.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT_ROOT, effectiveMaxTurns } from './config.js';
import { getAgentConfig } from './agent-config.js';
import { logTokenUsage } from './db.js';
import { classifyError } from './errors.js';
import { logger } from './logger.js';
import { providerHasTools, recordProviderOutcome, routesFor, type ProviderId, type ToolNeed } from './provider-config.js';
import { runExternalProvider } from './provider-runner.js';
import { agentEnv, claudeSkillOptions, skillContext } from './skills.js';

/** Deliberation stages may read and research, never mutate. */
export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export interface AgentOptions {
  message: string;
  sessionId?: string;
  agentId?: string;
  /** Overrides the agent's own directory. */
  cwd?: string;
  /** Appended to Claude Code's system prompt (never replaces it). */
  systemPrompt?: string;
  onTyping?: () => void;
  maxTurns?: number;
  readOnly?: boolean;
  /** Capability gate for fallback routing. Tool-less APIs are skipped when required. */
  toolNeed?: ToolNeed;
  /** Internal route override; public callers normally use provider-routing.json. */
  model?: string;
  /** JSON schema: the SDK validates and returns `structured`. */
  schema?: Record<string, unknown>;
  /** When set, usage + cost are recorded in token_usage for this chat. */
  chatId?: string;
}

export interface AgentResult {
  text: string | null;
  newSessionId?: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  structured?: unknown;
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  provider?: ProviderId;
  attempts?: Array<{ provider: ProviderId; model: string; error?: string }>;
  /** Set when the SDK reported a failed result (max turns, execution error, ...). */
  error?: string;
}

export class ProviderRoutesError extends Error {
  constructor(public readonly agentId: string, public readonly attempts: NonNullable<AgentResult['attempts']>) {
    super(`all provider routes failed for ${agentId}`);
    this.name = 'ProviderRoutesError';
  }
}

interface McpServers {
  [name: string]: unknown;
}

function readJsonIfExists(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Merge project + user settings.json, filtered by the agent allowlist. */
export function loadMcpServers(agentAllowlist?: string[]): McpServers {
  const project = readJsonIfExists(join(PROJECT_ROOT, '.claude', 'settings.json'));
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const user = home ? readJsonIfExists(join(home, '.claude', 'settings.json')) : {};
  const merged: McpServers = {
    ...((user['mcpServers'] as McpServers) ?? {}),
    ...((project['mcpServers'] as McpServers) ?? {}),
  };
  if (!agentAllowlist || agentAllowlist.length === 0) {
    return merged;
  }
  const allowed = new Set(agentAllowlist);
  const out: McpServers = {};
  for (const [name, cfg] of Object.entries(merged)) {
    if (allowed.has(name)) {
      out[name] = cfg;
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runClaudeAgent(opts: AgentOptions): Promise<AgentResult> {
  const agent = opts.agentId ? getAgentConfig(opts.agentId) : undefined;
  const cwd = opts.cwd ?? agent?.cwd ?? PROJECT_ROOT;
  const maxTurns = opts.maxTurns ?? effectiveMaxTurns();
  let typingTimer: NodeJS.Timeout | undefined;

  if (opts.onTyping) {
    const cb = opts.onTyping;
    cb();
    typingTimer = setInterval(cb, 4000);
  }

  try {
    const mcpServers = loadMcpServers(agent?.mcpAllowlist);
    const skillText = await skillContext(opts.agentId ?? 'main');
    const appended = [opts.systemPrompt, skillText].filter(Boolean).join('\n\n');
    let text: string | null = null;
    let newSessionId: string | undefined = opts.sessionId;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let model: string | undefined = opts.model ?? agent?.model;
    let structured: unknown;
    let costUsd: number | undefined;
    let numTurns: number | undefined;
    let durationMs: number | undefined;
    let error: string | undefined;

    const q = query({
      prompt: opts.message,
      options: {
        cwd,
        resume: opts.sessionId,
        settingSources: ['project', 'user'],
        permissionMode: 'bypassPermissions',
        maxTurns,
        mcpServers: mcpServers as never,
        env: agentEnv(),
        ...claudeSkillOptions(opts.agentId ?? 'main'),
        systemPrompt: { type: 'preset', preset: 'claude_code', ...(appended ? { append: appended } : {}) },
        ...(model ? { model } : {}),
        ...(opts.readOnly ? { disallowedTools: WRITE_TOOLS } : {}),
        ...(opts.schema ? { outputFormat: { type: 'json_schema', schema: opts.schema } } : {}),
      } as never,
    });

    for await (const event of q as AsyncIterable<Record<string, unknown>>) {
      const type = event['type'] as string | undefined;
      if (type === 'system' && event['subtype'] === 'init') {
        const sid = event['session_id'] ?? event['sessionId'];
        if (typeof sid === 'string' && sid) {
          newSessionId = sid;
        }
      } else if (type === 'result') {
        const result = event['result'];
        if (typeof result === 'string') {
          text = result;
        } else if (result && typeof result === 'object') {
          const r = result as Record<string, unknown>;
          text = typeof r['result'] === 'string' ? (r['result'] as string) : JSON.stringify(r);
        }
        const usage = event['usage'] as Record<string, unknown> | undefined;
        if (usage) {
          if (typeof usage['input_tokens'] === 'number') inputTokens = usage['input_tokens'] as number;
          if (typeof usage['output_tokens'] === 'number') outputTokens = usage['output_tokens'] as number;
          if (typeof usage['model'] === 'string') model = usage['model'] as string;
        }
        if (typeof event['model'] === 'string') model = event['model'] as string;
        structured = event['structured_output'];
        if (typeof event['total_cost_usd'] === 'number') costUsd = event['total_cost_usd'] as number;
        if (typeof event['num_turns'] === 'number') numTurns = event['num_turns'] as number;
        if (typeof event['duration_ms'] === 'number') durationMs = event['duration_ms'] as number;
        if (event['is_error'] === true || event['subtype'] !== 'success') {
          const errors = Array.isArray(event['errors']) ? (event['errors'] as unknown[]).join('; ') : '';
          error = `${String(event['subtype'])}${errors ? `: ${errors}` : ''}`;
        }
      }
    }

    if (opts.chatId && (inputTokens || outputTokens)) {
      try {
        logTokenUsage(opts.chatId, opts.agentId ?? 'main', model ?? 'unknown', inputTokens ?? 0, outputTokens ?? 0, costUsd);
      } catch (err) {
        logger.warn({ err }, 'token usage logging failed (non-fatal)');
      }
    }
    return { text, newSessionId, inputTokens, outputTokens, model, structured, costUsd, numTurns, durationMs, error, provider: 'claude' };
  } finally {
    if (typingTimer) {
      clearInterval(typingTimer);
    }
  }
}

/** One capability-aware entry point for every surface. Tries each configured route in order. */
export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const agentId = opts.agentId ?? 'main';
  const agent = getAgentConfig(agentId);
  let rolePrompt = '';
  try { if (agent?.claudeMdPath) rolePrompt = readFileSync(agent.claudeMdPath, 'utf8'); } catch { /* optional */ }
  const externalOpts: AgentOptions = {
    ...opts,
    cwd: opts.cwd ?? agent?.cwd ?? PROJECT_ROOT,
    // Tool-less providers cannot load a skill on demand, so their required skills are included in the prompt.
    systemPrompt: [rolePrompt, opts.systemPrompt, await skillContext(agentId, true)].filter(Boolean).join('\n\n'),
  };
  const attempts: NonNullable<AgentResult['attempts']> = [];
  const routes = routesFor(agentId);
  for (const target of routes) {
    if (opts.toolNeed === 'required' && !providerHasTools(target.provider)) {
      attempts.push({ ...target, error: 'skipped: tools required' });
      continue;
    }
    const started = Date.now();
    try {
      const result = target.provider === 'claude'
        ? await runClaudeAgent({ ...opts, model: target.model })
        : await runExternalProvider(target, externalOpts);
      if (result.error || (!result.text && result.structured === undefined)) {
        throw new Error(result.error ?? 'empty result');
      }
      attempts.push({ ...target });
      recordProviderOutcome(target.provider, target.model, true);
      if (result.durationMs === undefined) result.durationMs = Date.now() - started;
      result.attempts = attempts;
      result.provider = target.provider;
      if (target.provider !== 'claude' && opts.chatId && (result.inputTokens || result.outputTokens)) {
        try {
          logTokenUsage(opts.chatId, agentId, result.model ?? target.model,
            result.inputTokens ?? 0, result.outputTokens ?? 0, result.costUsd);
        } catch (err) {
          logger.warn({ err }, 'external provider token usage logging failed (non-fatal)');
        }
      }
      if (target.provider !== 'claude' && opts.chatId) {
        // APIs/CLIs do not all expose token counts; still record the selected model/provider in logs.
        logger.info({ chatId: opts.chatId, agentId, provider: target.provider, model: target.model }, 'provider fallback answered');
      }
      return result;
    } catch (err) {
      // Provider CLIs often prepend hook/MCP noise; the actionable API/schema error is at the end.
      const reason = String(err).slice(-1500);
      attempts.push({ ...target, error: reason });
      recordProviderOutcome(target.provider, target.model, false, reason);
      logger.warn({ agentId, provider: target.provider, model: target.model, err: reason }, 'provider route failed; trying fallback');
    }
  }
  throw new ProviderRoutesError(agentId, attempts);
}

export async function runAgentWithRetry(opts: AgentOptions, maxRetries = 2): Promise<AgentResult> {
  let attempt = 0;
  let lastError: unknown = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await runAgent(opts);
    } catch (err) {
      lastError = err;
      const { category, recovery } = classifyError(err as Error);
      logger.warn({ category, attempt, err: String(err) }, 'agent call failed');
      if (!recovery.shouldRetry || attempt >= maxRetries) {
        throw err;
      }
      const backoff = recovery.retryAfterMs || 2000 * 2 ** attempt;
      await sleep(Math.min(backoff, 30_000));
      attempt += 1;
      if (recovery.shouldNewChat) {
        opts = { ...opts, sessionId: undefined };
      }
    }
  }
  throw lastError;
}
