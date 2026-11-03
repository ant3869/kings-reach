// src/agent-create.ts - agent creation wizard (template copy + agent.yaml update).
// Simple is better than complex: one function does the whole scaffold.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { AGENT_ID_RE, MAX_AGENTS, PROJECT_ROOT, AGENT_YAML, initOrchestrator } from './orchestrator.js';

export const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'agents', '_template');
export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export interface AgentYamlEntry {
  id: string;
  name: string;
  description?: string;
  cwd?: string;
  model?: string;
  telegramToken?: string;
}

export function readAgentYaml(): AgentYamlEntry[] {
  if (!fs.existsSync(AGENT_YAML)) return [];
  const doc = yaml.load(fs.readFileSync(AGENT_YAML, 'utf8')) as { agents?: AgentYamlEntry[] };
  return Array.isArray(doc?.agents) ? doc.agents : [];
}

function writeAgentYaml(entries: AgentYamlEntry[]): void {
  fs.mkdirSync(path.dirname(AGENT_YAML), { recursive: true });
  fs.writeFileSync(AGENT_YAML, yaml.dump({ agents: entries }), 'utf8');
}

function fillPlaceholders(text: string, id: string, name: string, description: string): string {
  return text
    .replaceAll('[AGENT_ID]', id)
    .replaceAll('[AGENT_NAME]', name)
    .replaceAll('[AGENT_DESCRIPTION]', description);
}

/** Scaffold agents/{id}/ from the template and register it in agent.yaml. */
export async function createAgent(
  id: string,
  name: string,
  description: string,
  telegramToken?: string,
  model = DEFAULT_MODEL,
): Promise<void> {
  if (!AGENT_ID_RE.test(id)) {
    throw new Error(`bad agent id "${id}": must match ${String(AGENT_ID_RE)}`);
  }
  const entries = readAgentYaml();
  if (entries.length >= MAX_AGENTS) throw new Error(`agent limit (${MAX_AGENTS}) reached`);
  if (entries.some((e) => e.id === id) || id === 'main') {
    throw new Error(`agent "${id}" already exists`);
  }
  if (!fs.existsSync(path.join(TEMPLATE_DIR, 'CLAUDE.md'))) {
    throw new Error(`template missing: ${TEMPLATE_DIR} (run setup first)`);
  }

  const dir = path.join(PROJECT_ROOT, 'agents', id);
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true });

  for (const file of ['CLAUDE.md', 'config.yml']) {
    const src = path.join(TEMPLATE_DIR, file);
    if (!fs.existsSync(src)) continue;
    const filled = fillPlaceholders(fs.readFileSync(src, 'utf8'), id, name, description);
    fs.writeFileSync(path.join(dir, file), filled, 'utf8');
  }

  const entry: AgentYamlEntry = { id, name, description, model };
  if (telegramToken) entry.telegramToken = telegramToken;
  entries.push(entry);
  writeAgentYaml(entries);

  initOrchestrator(); // rebuild registry so the new agent is routable now
}

/** Non-throwing count helper for CLIs and dashboards. */
export function agentCount(): number {
  return readAgentYaml().length + 1; // +1 for built-in main
}
