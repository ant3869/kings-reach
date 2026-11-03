// src/orchestrator.ts - multi-agent delegation (@agent syntax + /delegate).
// Registry comes from agent.yaml via agent-config.ts; execution goes through
// runAgent() in agent.ts. This file only adds routing on top.

import path from 'node:path';
import { runAgent } from './agent.js';
import { effectiveMaxTurns, PROJECT_ROOT, CLAUDECLAW_CONFIG } from './config.js';
import { loadAgentConfigs, type AgentConfig } from './agent-config.js';
import { getSession, setSession, logToHiveMind } from './db.js';

export type { AgentConfig };

export const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,29}$/;
export const MAX_AGENTS = 20;
export { PROJECT_ROOT };
export const AGENT_YAML = CLAUDECLAW_CONFIG
  ? path.join(CLAUDECLAW_CONFIG, 'agent.yaml')
  : path.join(PROJECT_ROOT, 'agent.yaml');

export interface AgentResult {
  text: string;
  sessionId?: string;
  agentId: string;
}

let registry: Map<string, AgentConfig> | null = null;

/** Build the in-memory registry (max 20 agents, main always included). */
export function initOrchestrator(): void {
  registry = new Map<string, AgentConfig>();
  for (const cfg of loadAgentConfigs()) {
    if (registry.size >= MAX_AGENTS) break;
    registry.set(cfg.id, cfg);
  }
}

export function getAgentRegistry(): Map<string, AgentConfig> {
  if (!registry) initOrchestrator();
  return registry as Map<string, AgentConfig>;
}

/** "@comms: draft a reply" or "/delegate comms draft a reply" -> { agentId, prompt }. */
export function parseDelegation(message: string): { agentId: string; prompt: string } | null {
  const at = message.match(/@([a-z][a-z0-9_-]{0,29})\s*:\s*([\s\S]+)/);
  if (at) return { agentId: at[1], prompt: at[2].trim() };
  const slash = message.match(/^\/delegate\s+([a-z][a-z0-9_-]{0,29})\s+([\s\S]+)/);
  if (slash) return { agentId: slash[1], prompt: slash[2].trim() };
  return null;
}

/** Route one prompt to a specialist agent and log it to the hive mind. */
export async function delegateToAgent(
  agentId: string,
  prompt: string,
  chatId: string,
  onTyping?: () => void,
): Promise<AgentResult> {
  const agent = getAgentRegistry().get(agentId);
  if (!agent) {
    const known = [...getAgentRegistry().keys()].join(', ');
    throw new Error(`unknown agent "${agentId}" (known: ${known})`);
  }
  const sessionId = getSession(chatId, agentId) ?? undefined;
  // runAgent resolves cwd (-> the agent's CLAUDE.md) and model from the registry.
  const raw = await runAgent({ message: prompt, agentId, sessionId, onTyping, chatId, maxTurns: effectiveMaxTurns() });
  const text = raw.text ?? '';
  const nextSession = raw.newSessionId ?? sessionId;
  if (nextSession) setSession(chatId, nextSession, agentId);
  logToHiveMind(agentId, 'delegation', prompt.slice(0, 500), { chatId });
  return { text, sessionId: nextSession, agentId };
}
