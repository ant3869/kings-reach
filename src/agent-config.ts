import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, CLAUDECLAW_CONFIG } from './config.js';

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  model?: string;
  telegramToken?: string;
  cwd: string;
  claudeMdPath: string;
  mcpAllowlist?: string[];
  active?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const FALLBACK_ROOT = dirname(HERE);
const ROOT = PROJECT_ROOT || FALLBACK_ROOT;

const ID_RE = /^[a-z][a-z0-9_-]{0,29}$/;
const MAX_AGENTS = 20;
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function externalRoot(): string | null {
  const raw = (CLAUDECLAW_CONFIG || '').trim();
  if (!raw) return null;
  if (raw.startsWith('~')) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return join(home, raw.slice(1));
  }
  return raw;
}

function mainConfig(): AgentConfig {
  return {
    id: 'main',
    name: 'Main',
    description: 'Primary assistant',
    model: DEFAULT_MODEL,
    cwd: ROOT,
    claudeMdPath: join(ROOT, 'CLAUDE.md'),
    active: true,
  };
}

/** Minimal YAML subset parser for agent.yaml (avoids hard dep at import time). */
function parseAgentYaml(text: string): AgentConfig[] {
  const out: AgentConfig[] = [];
  const blocks = text.split(/^\s*-\s+id\s*:/m);
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i] ?? '';
    const id = (block.split('\n')[0] ?? '').trim().replace(/^["']|["']$/g, '');
    if (!id || !ID_RE.test(id)) continue;
    const get = (key: string): string => {
      const m = block.match(new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'\\n#]+)["']?`, 'm'));
      return (m?.[1] ?? '').trim();
    };
    out.push({
      id,
      name: get('name') || id,
      description: get('description') || `${id} agent`,
      model: get('model') || DEFAULT_MODEL,
      cwd: resolveAgentDir(id),
      claudeMdPath: resolveAgentClaudeMd(id),
      active: true,
    });
  }
  return out;
}

function loadFromYaml(): AgentConfig[] {
  const candidates = [
    join(ROOT, 'agent.yaml'),
    join(ROOT, 'agents.yaml'),
    ...(externalRoot() ? [join(externalRoot() as string, 'agent.yaml')] : []),
  ];
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue;
      const parsed = parseAgentYaml(readFileSync(p, 'utf8'));
      if (parsed.length) return parsed.slice(0, MAX_AGENTS);
    } catch {
      continue;
    }
  }
  return [];
}

export function loadAgentConfigs(): AgentConfig[] {
  const fromYaml = loadFromYaml();
  if (fromYaml.length > 0) {
    const seen = new Set(fromYaml.map((a) => a.id));
    if (!seen.has('main')) {
      return [mainConfig(), ...fromYaml].slice(0, MAX_AGENTS);
    }
    return fromYaml;
  }
  // Single-agent fallback: just main.
  return [mainConfig()];
}

export function getAgentConfig(agentId: string): AgentConfig | undefined {
  return loadAgentConfigs().find((a) => a.id === agentId);
}

export function getDefaultAgent(): AgentConfig {
  return getAgentConfig('main') ?? mainConfig();
}

export function resolveAgentDir(agentId: string): string {
  if (!agentId || agentId === 'main') return ROOT;
  return join(ROOT, 'agents', agentId);
}

export function resolveAgentClaudeMd(agentId: string): string {
  if (!agentId || agentId === 'main') return join(ROOT, 'CLAUDE.md');
  const perAgent = join(ROOT, 'agents', agentId, 'CLAUDE.md');
  if (existsSync(perAgent)) return perAgent;
  const template = join(ROOT, 'agents', '_template', 'CLAUDE.md');
  if (existsSync(template)) return template;
  return join(ROOT, 'CLAUDE.md');
}
