import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, KINGS_REACH_CONFIG } from './config.js';
import { logger } from './logger.js';

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  model?: string;
  telegramToken?: string;
  cwd: string;
  claudeMdPath: string;
  /** undefined = legacy (every configured MCP server); [] = none; otherwise exactly these server names. */
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
  const raw = (KINGS_REACH_CONFIG || '').trim();
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

const ALLOWLIST_ITEM = /^[^\s\[\]{}:,#'"][^\[\]{}:,#'"]*$/;

function allowlistItem(raw: string): string | null {
  const t = raw.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  return ALLOWLIST_ITEM.test(t) ? t : null;
}

/**
 * Reads `mcp_allowlist` (inline `[a, b]` or a block list) from one agent block.
 * Absent -> undefined (legacy all servers). Present but not a list of plain names -> throws, so the caller can fail closed.
 */
export function parseMcpAllowlist(block: string): string[] | undefined {
  const lines = block.split(/\r\n|\r|\n/); // the agent split can leave a lone \r at a block end
  const at = lines.findIndex((l) => /^\s*mcp_allowlist\s*:/.test(l));
  if (at < 0) return undefined;
  const rest = (lines[at] ?? '').replace(/^\s*mcp_allowlist\s*:/, '').replace(/\s+#.*$/, '').trim();
  const names: string[] = [];
  const take = (raw: string): void => {
    const name = allowlistItem(raw);
    if (name === null) throw new Error(`invalid mcp_allowlist entry "${raw.trim()}"`);
    names.push(name);
  };
  if (rest) {
    if (!rest.startsWith('[') || !rest.endsWith(']')) throw new Error('mcp_allowlist must be a list of strings');
    const inner = rest.slice(1, -1).trim();
    if (inner) inner.split(',').forEach(take);
    return names;
  }
  const indent = (lines[at] ?? '').match(/^\s*/)?.[0].length ?? 0;
  for (const line of lines.slice(at + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^(\s*)-\s+(.*)$/);
    if (!m || (m[1] ?? '').length <= indent) break;
    take(m[2] ?? '');
  }
  if (names.length === 0) throw new Error('mcp_allowlist must be a list of strings (use [] for none)');
  return names;
}

/** Minimal YAML subset parser for agent.yaml (avoids hard dep at import time). */
export function parseAgentYaml(text: string): AgentConfig[] {
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
    let mcpAllowlist: string[] | undefined;
    try {
      mcpAllowlist = parseMcpAllowlist(block);
    } catch (err) {
      mcpAllowlist = []; // an unreadable allowlist must not widen access
      logger.warn({ agentId: id, err: String(err) }, 'bad mcp_allowlist in agent.yaml; agent gets no MCP servers');
    }
    out.push({
      id,
      name: get('name') || id,
      description: get('description') || `${id} agent`,
      model: get('model') || DEFAULT_MODEL,
      cwd: resolveAgentDir(id),
      claudeMdPath: resolveAgentClaudeMd(id),
      ...(mcpAllowlist !== undefined ? { mcpAllowlist } : {}),
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
