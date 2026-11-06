// src/provider-models.ts - which (provider, model) pairs are actually valid right now.
// The Settings page used free-text model boxes, so "claude + cx/gpt-5.6-Sol" (a ChatGPT-style name under the Claude
// route) saved fine and then failed on every call. This module turns what we can really verify (the live 9Router
// catalog, the provider health checks, installed Ollama models) into dropdown choices, and rejects anything else on save.

import { GEMINI_TEXT_MODEL } from './config.js';
import { PROVIDERS } from './provider-config.js';
import type { ProviderHealth, RouterModel } from './provider-runner.js';

export interface ModelChoice { id: string; note?: string }
export type ModelChoices = Record<string, ModelChoice[]>;

const META = /^(meta\/|cf\/@cf\/meta\/)/;
const CLAUDE_VIA_ROUTER = /^cc\//; // the 9Router "Claude Code" lane: same ids the Claude SDK accepts, minus the prefix

function describe(m: RouterModel): ModelChoice {
  const c = m.capabilities ?? {};
  const note = [c.reasoning ? 'reasoning' : '', c.contextWindow ? `${Math.round(c.contextWindow / 1000)}k ctx` : ''].filter(Boolean).join(' · ');
  return note ? { id: m.id, note } : { id: m.id };
}

function unique(list: ModelChoice[]): ModelChoice[] {
  const seen = new Set<string>();
  return list.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

const examples = (id: string): ModelChoice[] => (PROVIDERS.find((p) => p.id === id)?.examples ?? []).map((m) => ({ id: m }));

export function buildModelChoices(models: RouterModel[], health: ProviderHealth[]): ModelChoices {
  const ollamaInstalled = health.find((h) => h.id === 'ollama')?.models ?? [];
  return {
    claude: unique([...examples('claude'), ...models.filter((m) => CLAUDE_VIA_ROUTER.test(m.id)).map((m) => ({ ...describe(m), id: m.id.replace(CLAUDE_VIA_ROUTER, '') }))]),
    codex: examples('codex'),
    chatgpt: models.filter((m) => /^cx\//.test(m.id)).map(describe),
    meta: models.filter((m) => META.test(m.id)).map(describe),
    '9router': models.map(describe),
    gemini: unique([{ id: GEMINI_TEXT_MODEL }, ...examples('gemini')]),
    openai: examples('openai'),
    openrouter: examples('openrouter'),
    ollama: ollamaInstalled.map((id) => ({ id })),
  };
}

/** provider id -> "its credentials/service are present" (NOT "its last call worked": a bad model must not lock a provider out). */
export function readiness(health: ProviderHealth[]): Record<string, boolean> {
  return Object.fromEntries(health.map((h) => [h.id, h.configured ?? h.available]));
}

/** Human-readable reasons a routing body must not be saved. Empty means every route is a real, available pair. */
export function invalidRoutes(value: unknown, choices: ModelChoices, ready: Record<string, boolean>): string[] {
  const agents = (value as { agents?: Record<string, unknown> } | null)?.agents ?? {};
  const problems: string[] = [];
  for (const [agent, routes] of Object.entries(agents)) {
    for (const r of Array.isArray(routes) ? routes : []) {
      const { provider = '', model = '' } = (r ?? {}) as { provider?: string; model?: string };
      if (ready[provider] !== true) problems.push(`${agent}: provider "${provider}" is not available right now`);
      else if (!(choices[provider] ?? []).some((m) => m.id === model)) problems.push(`${agent}: "${model}" is not a ${provider} model`);
    }
  }
  return problems;
}
