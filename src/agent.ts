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
import { describeTool, redact, TurnCounter, WorkLog, type ActivitySink } from './activity.js';

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
  /** Live narration of what the agent is doing (tool calls, turns, route changes). Optional and best-effort. */
  onActivity?: ActivitySink;
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
  attempts?: Attempt[];
  /** Set when the SDK reported a failed result (max turns, execution error, ...). */
  error?: string;
  /** On failure: what the attempt had already gathered, formatted for the next route's prompt. */
  handoff?: string;
}

const TURN_CAP = /maximum number of turns/i;

/**
 * The real SDK THROWS at the turn cap ("Claude Code returned an error result: Reached maximum number of turns (6)")
 * instead of only yielding an error result, so salvage was never reached (found on a real run, 2.14.3). Returns the
 * message when `err` is that cap, else null so every other failure still propagates.
 */
export function turnCapMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err);
  return TURN_CAP.test(msg) ? msg : null;
}
const WRAP_UP = 'You have run out of tool budget. Do NOT call any more tools. Using ONLY what you have already gathered ' +
  'in this session, give your final answer now in the required format. Anything you did not get to verify must be ' +
  'labelled unverified, and your confidence must reflect that.';

/** One route tried. `costUsd` is money a FAILED attempt still burned (e.g. a Claude run that hit its turn cap). */
export interface Attempt { provider: ProviderId; model: string; error?: string; costUsd?: number; salvaged?: boolean }

/** Total spend across attempts that produced no answer. */
export const wastedCost = (attempts: Attempt[]): number => attempts.reduce((sum, a) => sum + (a.costUsd ?? 0), 0);

const REPORTED_COST = Symbol('reportedCostUsd');

/** Tags a thrown error with money its route already reported, so the route loop can still count it. Only a finite, non-negative cost is kept. */
export function attachReportedCost(err: unknown, costUsd: number | undefined): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0) {
    (error as unknown as Record<symbol, number>)[REPORTED_COST] = costUsd;
  }
  return error;
}

export function reportedCost(err: unknown): number | undefined {
  return err instanceof Error ? (err as unknown as Record<symbol, number | undefined>)[REPORTED_COST] : undefined;
}

export class ProviderRoutesError extends Error {
  constructor(public readonly agentId: string, public readonly attempts: Attempt[], public readonly handoff?: string) {
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
    const log = new WorkLog();
    const turns = new TurnCounter();

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

    try {
    for await (const event of q as AsyncIterable<Record<string, unknown>>) {
      const type = event['type'] as string | undefined;
      if (type === 'system' && event['subtype'] === 'init') {
        const sid = event['session_id'] ?? event['sessionId'];
        if (typeof sid === 'string' && sid) {
          newSessionId = sid;
        }
      } else if (type === 'assistant') {
        if (turns.see(event as { message?: { id?: unknown } })) {
          opts.onActivity?.({ kind: 'turn', text: `turn ${turns.n}/${maxTurns}`, turn: turns.n, maxTurns });
        }
        const blocks = ((event['message'] as { content?: unknown[] } | undefined)?.content ?? []) as Array<Record<string, unknown>>;
        for (const b of blocks) {
          if (b['type'] === 'tool_use') {
            const act = describeTool(String(b['name'] ?? ''), b['input']);
            log.addActivity(act);
            opts.onActivity?.(act);
          } else if (b['type'] === 'text' && typeof b['text'] === 'string') log.addText(b['text']);
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
    } catch (err) {
      const cap = turnCapMessage(err);
      if (!cap) throw attachReportedCost(err, costUsd);
      error = error ?? cap; // keep the session id and cost gathered so far: runAgent() can now resume and salvage
    }

    if (opts.chatId && (inputTokens || outputTokens)) {
      try {
        logTokenUsage(opts.chatId, opts.agentId ?? 'main', model ?? 'unknown', inputTokens ?? 0, outputTokens ?? 0, costUsd);
      } catch (err) {
        logger.warn({ err }, 'token usage logging failed (non-fatal)');
      }
    }
    return { text, newSessionId, inputTokens, outputTokens, model, structured, costUsd, numTurns, durationMs, error, provider: 'claude',
      handoff: error ? log.handoff('claude') : undefined };
  } finally {
    if (typingTimer) {
      clearInterval(typingTimer);
    }
  }
}

/**
 * A Claude run that hit its turn cap has already paid for its research. Resume the same session and make it answer
 * from what it gathered instead of discarding the work. Returns null when that does not work (its cost is then
 * added to `failed` so the ledger still counts it).
 */
async function salvage(opts: AgentOptions, model: string, failed: AgentResult): Promise<AgentResult | null> {
  if (!failed.newSessionId || !TURN_CAP.test(failed.error ?? '')) return null;
  opts.onActivity?.({ kind: 'route', state: 'salvage', provider: 'claude', model,
    text: 'Out of turns: asking Claude to answer from what it already gathered' });
  let wrap: AgentResult;
  try {
    wrap = await runClaudeAgent({ ...opts, model, sessionId: failed.newSessionId, message: WRAP_UP, maxTurns: 4 });
  } catch (err) {
    const thrown = reportedCost(err);
    if (thrown !== undefined) failed.costUsd = (failed.costUsd ?? 0) + thrown;
    return null;
  }
  failed.costUsd = (failed.costUsd ?? 0) + (wrap.costUsd ?? 0);
  if (wrap.error || (!wrap.text && wrap.structured === undefined)) return null;
  wrap.costUsd = failed.costUsd;
  wrap.numTurns = (wrap.numTurns ?? 0) + (failed.numTurns ?? 0);
  wrap.durationMs = (wrap.durationMs ?? 0) + (failed.durationMs ?? 0);
  return wrap;
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
  const attempts: Attempt[] = [];
  let handoff = '';
  const routes = routesFor(agentId);
  for (const target of routes) {
    if (opts.toolNeed === 'required' && !providerHasTools(target.provider)) {
      attempts.push({ ...target, error: 'skipped: tools required' });
      continue;
    }
    const started = Date.now();
    let spent: number | undefined;
    // Work an earlier route finished before dying rides along, so the next route does not start from zero.
    const message = handoff ? `${handoff}\n\n${opts.message}` : opts.message;
    opts.onActivity?.({ kind: 'route', state: 'try', provider: target.provider, model: target.model,
      text: `Asking ${target.provider} (${target.model})${handoff ? ' with the earlier attempt\'s notes' : ''}` });
    try {
      let result = target.provider === 'claude'
        ? await runClaudeAgent({ ...opts, message, model: target.model })
        : await runExternalProvider(target, { ...externalOpts, message });
      let salvaged = false;
      if (result.error && target.provider === 'claude') {
        const rescued = await salvage({ ...opts, message }, target.model, result);
        if (rescued) { result = rescued; salvaged = true; }
      }
      if (result.error || (!result.text && result.structured === undefined)) {
        spent = result.costUsd;
        handoff = result.handoff ?? handoff;
        throw new Error(result.error ?? 'empty result');
      }
      attempts.push({ ...target, ...(salvaged ? { salvaged: true } : {}) });
      const ownCost = result.costUsd;
      const wasted = wastedCost(attempts);
      if (wasted) result.costUsd = (result.costUsd ?? 0) + wasted; // earlier failed routes were paid for too
      recordProviderOutcome(target.provider, target.model, true);
      if (result.durationMs === undefined) result.durationMs = Date.now() - started;
      result.attempts = attempts;
      result.provider = target.provider;
      if (target.provider !== 'claude' && opts.chatId && (result.inputTokens || result.outputTokens)) {
        try {
          logTokenUsage(opts.chatId, agentId, result.model ?? target.model,
            result.inputTokens ?? 0, result.outputTokens ?? 0, ownCost); // failed Claude routes log their own cost already
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
      const burned = spent ?? reportedCost(err);
      attempts.push({ ...target, error: reason, ...(burned ? { costUsd: burned } : {}) });
      recordProviderOutcome(target.provider, target.model, false, reason);
      opts.onActivity?.({ kind: 'route', state: 'failed', provider: target.provider, model: target.model,
        text: `${target.provider} could not finish: ${redact(reason).replace(/\s+/g, ' ').slice(-110)}` });
      logger.warn({ agentId, provider: target.provider, model: target.model, err: reason }, 'provider route failed; trying fallback');
    }
  }
  throw new ProviderRoutesError(agentId, attempts, handoff || undefined);
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
