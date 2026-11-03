// src/provider-config.ts - non-secret model/provider routing, persisted in store/provider-routing.json.
// Credentials stay in .env or the provider CLI. This file only answers: who should do which job, in what order?

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GEMINI_TEXT_MODEL, STORE_DIR } from './config.js';

export const PROVIDER_IDS = ['claude', 'codex', 'meta', '9router', 'gemini', 'openai', 'openrouter', 'ollama'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type ToolNeed = 'required' | 'preferred' | 'none';

export interface RouteTarget {
  provider: ProviderId;
  model: string;
}
export interface ProviderRouting {
  version: 1;
  agents: Record<string, RouteTarget[]>;
}
export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  auth: string;
  tools: boolean;
  structured: boolean;
  local: boolean;
  note: string;
  examples: string[];
}

export const PROVIDERS: ProviderDefinition[] = [
  { id: 'claude', name: 'Claude Agent SDK', auth: 'Claude subscription / ANTHROPIC_API_KEY', tools: true, structured: true,
    local: false, note: 'Excellent tool use and long-context synthesis. Best for Main, Ops and code-changing work.', examples: ['claude-sonnet-4-6', 'claude-opus-4-6'] },
  { id: 'codex', name: 'Codex CLI', auth: 'Codex subscription login', tools: true, structured: true,
    local: false, note: 'Strong coding, shell and repository work. Ideal fallback for Ops and execution-heavy roles.', examples: ['default', 'gpt-5-codex'] },
  { id: 'meta', name: 'Meta Muse / Llama via 9Router', auth: 'local 9Router credential', tools: false, structured: true,
    local: true, note: 'Independent Meta training and long-context reasoning. Great debate/research voice; advisory until King's Reach adds a 9Router tool loop.', examples: ['meta/muse-spark-1.3', 'meta/muse-spark-1.2', 'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast'] },
  { id: '9router', name: '9Router model network', auth: 'local 9Router credential', tools: false, structured: true,
    local: true, note: 'Live local gateway to many labs and tiers. Catalog is discovered at runtime; advisory models are safe in plan/debate/content stages.', examples: ['cx/gpt-5.6-terra', 'openrouter/deepseek/deepseek-v4-flash-0731:free', 'gc/gemini-2.5-pro'] },
  { id: 'gemini', name: 'Google Gemini API', auth: 'GOOGLE_API_KEY', tools: false, structured: true,
    local: false, note: 'Fast, broad-context advisory reasoning. Good for Research, Comms, Content and debate; no local tools here.', examples: [GEMINI_TEXT_MODEL, 'gemini-2.5-pro'] },
  { id: 'openai', name: 'OpenAI API', auth: 'OPENAI_API_KEY', tools: false, structured: true,
    local: false, note: 'Useful independent perspective. Mini models tolerate copy/review roles; use stronger models for adjudication.', examples: ['gpt-4.1-mini', 'gpt-5-mini', 'gpt-5.4'] },
  { id: 'openrouter', name: 'OpenRouter / Meta / others', auth: 'OPENROUTER_API_KEY', tools: false, structured: true,
    local: false, note: 'Cross-lab diversity: Meta, Mistral, Qwen and more. Best for advisory debate unless the chosen endpoint guarantees tools.', examples: ['meta-llama/llama-4-maverick', 'qwen/qwen3-235b-a22b', 'mistralai/mistral-large'] },
  { id: 'ollama', name: 'Ollama local', auth: 'local service', tools: false, structured: true,
    local: true, note: 'Free and private. Small local models suit summaries, critique and drafting—not final high-risk execution.', examples: ['qwen3:8b', 'llama3.3:70b', 'mistral-small3.1'] },
];

export const ROLE_GUIDANCE: Record<string, { tier: string; strengths: string; tolerate: string }> = {
  main: { tier: 'Frontier / high reasoning', strengths: 'Planning, adjudication, synthesis, structured output; tools preferred.', tolerate: 'Use a mid-tier model only for simple routing or short summaries.' },
  ops: { tier: 'Frontier coding + tools', strengths: 'Reliable shell/filesystem use, debugging, verification and precise edits.', tolerate: 'Do not use a tool-less model for Build; smaller models may review logs only.' },
  research: { tier: 'Strong reasoning / broad context', strengths: 'Evidence, source comparison, skepticism and long documents.', tolerate: 'Flash/mini models work for extraction; use stronger models for ambiguous conclusions.' },
  comms: { tier: 'Mid-tier usually sufficient', strengths: 'Audience judgment, tone, stakeholder risk and concise communication.', tolerate: 'Cheap/local models are usually fine; upgrade for legal or reputation-sensitive work.' },
  content: { tier: 'Mid-tier creative', strengths: 'Clarity, voice, naming, UX copy and divergent ideas.', tolerate: 'Cheap/local models are welcome for ideation; stronger models for final brand-critical copy.' },
};

const FILE = join(STORE_DIR, 'provider-routing.json');
const STATE_DIR = join(STORE_DIR, 'provider-state');
export interface ProviderObservedState { ok: boolean; at: string; detail: string; model: string; }

function safeFailure(error: unknown): string {
  const text = String(error);
  if (/out of extra usage|insufficient_quota|credit_balance_exhausted|no credits/i.test(text)) return 'quota / credits exhausted';
  if (/unauthorized|authentication|invalid.*key|login/i.test(text)) return 'authentication failed';
  if (/model.*not supported|model_not_found/i.test(text)) return 'model unsupported';
  return text.replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').slice(0, 240);
}
export function loadProviderState(): Partial<Record<ProviderId, ProviderObservedState>> {
  const out: Partial<Record<ProviderId, ProviderObservedState>> = {};
  for (const id of PROVIDER_IDS) {
    try { out[id] = JSON.parse(readFileSync(join(STATE_DIR, `${id}.json`), 'utf8')) as ProviderObservedState; }
    catch { /* no observation for this provider yet */ }
  }
  return out;
}
export function recordProviderOutcome(provider: ProviderId, model: string, ok: boolean, detail = ''): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const state = { ok, model, at: new Date().toISOString(), detail: ok ? 'last call succeeded' : safeFailure(detail) };
    writeFileSync(join(STATE_DIR, `${provider}.json`), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch { /* provider telemetry must never break an answer */ }
}
const DEFAULTS: ProviderRouting = {
  version: 1,
  agents: {
    main: [{ provider: 'claude', model: 'claude-sonnet-4-6' }, { provider: 'codex', model: 'default' }, { provider: 'meta', model: 'meta/muse-spark-1.3' }, { provider: 'gemini', model: GEMINI_TEXT_MODEL }],
    ops: [{ provider: 'claude', model: 'claude-sonnet-4-6' }, { provider: 'codex', model: 'default' }],
    research: [{ provider: 'gemini', model: GEMINI_TEXT_MODEL }, { provider: 'claude', model: 'claude-sonnet-4-6' }, { provider: 'codex', model: 'default' }, { provider: 'meta', model: 'meta/muse-spark-1.3' }],
    comms: [{ provider: 'meta', model: 'meta/muse-spark-1.3' }, { provider: 'claude', model: 'claude-sonnet-4-6' }, { provider: 'gemini', model: GEMINI_TEXT_MODEL }, { provider: 'openai', model: 'gpt-4.1-mini' }],
    content: [{ provider: 'meta', model: 'meta/muse-spark-1.3' }, { provider: 'gemini', model: GEMINI_TEXT_MODEL }, { provider: 'claude', model: 'claude-sonnet-4-6' }, { provider: 'openai', model: 'gpt-4.1-mini' }],
  },
};

function validTarget(v: unknown): v is RouteTarget {
  const x = v as Partial<RouteTarget>;
  return PROVIDER_IDS.includes(x.provider as ProviderId) && typeof x.model === 'string' && x.model.length > 0 && x.model.length <= 120;
}
export function defaultProviderRouting(): ProviderRouting {
  return JSON.parse(JSON.stringify(DEFAULTS)) as ProviderRouting;
}
export function loadProviderRouting(): ProviderRouting {
  try {
    if (!existsSync(FILE)) return defaultProviderRouting();
    const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Partial<ProviderRouting>;
    const agents: Record<string, RouteTarget[]> = {};
    for (const [id, routes] of Object.entries(raw.agents ?? {})) {
      if (/^[a-z][a-z0-9_-]{0,29}$/.test(id) && Array.isArray(routes)) agents[id] = routes.filter(validTarget).slice(0, 6);
    }
    return { version: 1, agents: { ...DEFAULTS.agents, ...agents } };
  } catch {
    return defaultProviderRouting();
  }
}
export function saveProviderRouting(value: unknown): ProviderRouting {
  const incoming = value as Partial<ProviderRouting>;
  if (!incoming.agents || typeof incoming.agents !== 'object') throw new Error('agents must be an object');
  const agents: Record<string, RouteTarget[]> = {};
  for (const [id, routes] of Object.entries(incoming.agents)) {
    if (!/^[a-z][a-z0-9_-]{0,29}$/.test(id) || !Array.isArray(routes)) throw new Error(`invalid agent route: ${id}`);
    const clean = routes.filter(validTarget).slice(0, 6);
    if (!clean.length) throw new Error(`${id} needs at least one valid provider/model`);
    agents[id] = clean;
  }
  const out = { version: 1 as const, agents };
  writeFileSync(FILE, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  return out;
}
export function routesFor(agentId = 'main'): RouteTarget[] {
  const cfg = loadProviderRouting();
  return cfg.agents[agentId] ?? cfg.agents.main ?? DEFAULTS.agents.main!;
}
export function providerHasTools(id: ProviderId): boolean {
  return PROVIDERS.find((p) => p.id === id)?.tools ?? false;
}
