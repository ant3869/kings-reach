// src/activity.ts - what an agent is doing RIGHT NOW, in words a human can follow.
// Raw tool calls become short, redacted sentences ("Editing src/agent.ts"). The War Room shows them live,
// the narrator speaks from them, and a failed attempt hands its work log to the next route.
// Anything that leaves the machine's process (the browser) goes through redact() first.

import { isAbsolute, relative, sep } from 'node:path';
import { PROJECT_ROOT } from './config.js';

export interface Activity {
  kind: 'tool' | 'turn' | 'route';
  text: string;
  tool?: string;
  /** File / URL / query the tool touched, already shortened. */
  target?: string;
  /** True when the tool changes a file. */
  edit?: boolean;
  turn?: number;
  maxTurns?: number;
  provider?: string;
  model?: string;
  state?: 'try' | 'failed' | 'salvage';
}
export type ActivitySink = (a: Activity) => void;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SECRETS: Array<[RegExp, string]> = [
  [/\b(?:sk|xai|ghp|gho|ghu|ghs|github_pat)[-_][A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/AIza[0-9A-Za-z_-]{30,}/g, '<redacted>'],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, '<redacted>'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1<redacted>'],
  [/([A-Za-z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z_]*\s*[=:]\s*)\S+/gi, '$1<redacted>'],
];

export function redact(text: string): string {
  return SECRETS.reduce((s, [re, to]) => s.replace(re, to), text);
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Repo-relative with forward slashes when inside the project; otherwise the tail of the path. */
export function shortPath(p: string): string {
  if (!p) return '';
  const inside = isAbsolute(p) && p.toLowerCase().startsWith(PROJECT_ROOT.toLowerCase());
  const rel = (inside ? relative(PROJECT_ROOT, p) : p).split(sep).join('/');
  return rel.length > 56 ? `…${rel.slice(-55)}` : rel;
}

function host(url: string): string {
  try { const u = new URL(url); return clip(`${u.host}${u.pathname === '/' ? '' : u.pathname}`, 60); } catch { return clip(url, 60); }
}

/** One tool call -> one human sentence. Unknown tools degrade to their name, never to raw input. */
export function describeTool(name: string, input: unknown): Activity {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '');
  const base = { kind: 'tool' as const, tool: name };
  if (EDIT_TOOLS.has(name)) {
    const target = shortPath(str('file_path') || str('notebook_path'));
    return { ...base, text: `Editing ${target || 'a file'}`, target, edit: true };
  }
  switch (name) {
    case 'Read': { const target = shortPath(str('file_path')); return { ...base, text: `Reading ${target || 'a file'}`, target }; }
    case 'Grep': { const target = clip(redact(str('pattern')), 50); return { ...base, text: `Searching the code for "${target}"`, target }; }
    case 'Glob': { const target = clip(str('pattern'), 50); return { ...base, text: `Listing files matching ${target}`, target }; }
    case 'Bash': case 'PowerShell': {
      const target = clip(redact(str('command')).replace(/\s+/g, ' ').trim(), 90);
      return { ...base, text: `Running: ${target}`, target };
    }
    case 'WebFetch': { const target = host(str('url')); return { ...base, text: `Fetching ${target}`, target }; }
    case 'WebSearch': { const target = clip(redact(str('query')), 70); return { ...base, text: `Searching the web: "${target}"`, target }; }
    case 'Skill': { const target = str('skill') || str('name'); return { ...base, text: `Loading the ${target} skill`, target }; }
    case 'Task': case 'Agent': return { ...base, text: 'Delegating a sub-task' };
    case 'ToolSearch': return { ...base, text: 'Looking up available tools' };
    case 'StructuredOutput': return { ...base, text: 'Writing up the answer' };
    default: {
      const tail = name.startsWith('mcp__') ? name.split('__').slice(-1)[0] ?? name : name;
      return { ...base, text: `Using ${tail}` };
    }
  }
}

/** Codex `exec --json` events -> activity. Best effort: unknown shapes are ignored, never guessed at. */
export function codexActivity(event: Record<string, unknown>): Activity | null {
  const item = event['item'] as Record<string, unknown> | undefined;
  const phase = event['type'];
  if (!item || (phase !== 'item.started' && phase !== 'item.completed')) return null;
  const base = { kind: 'tool' as const };
  switch (item['type']) {
    case 'command_execution': {
      if (phase !== 'item.started') return null;
      const target = clip(redact(String(item['command'] ?? '')).replace(/\s+/g, ' ').trim(), 90);
      return { ...base, tool: 'Shell', text: `Running: ${target}`, target };
    }
    case 'file_change': {
      if (phase !== 'item.completed') return null;
      const changes = Array.isArray(item['changes']) ? (item['changes'] as Array<Record<string, unknown>>) : [];
      const first = shortPath(String(changes[0]?.['path'] ?? ''));
      const more = changes.length > 1 ? ` (+${changes.length - 1} more)` : '';
      return { ...base, tool: 'Edit', text: `Edited ${first || 'a file'}${more}`, target: first, edit: true };
    }
    case 'web_search': {
      if (phase !== 'item.started') return null;
      const target = clip(redact(String(item['query'] ?? '')), 70);
      return { ...base, tool: 'WebSearch', text: `Searching the web: "${target}"`, target };
    }
    case 'mcp_tool_call': {
      if (phase !== 'item.started') return null;
      return { ...base, tool: 'mcp', text: `Using ${String(item['tool'] ?? 'a tool')}` };
    }
    default: return null;
  }
}

/**
 * Running record of one attempt. If the attempt dies (turn cap, crash) the next route gets this, so the
 * work already paid for is not thrown away.
 */
export class WorkLog {
  private notes: string[] = [];
  private visited: string[] = [];
  readonly edited = new Set<string>();

  addText(text: string): void {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t) this.notes = [...this.notes, clip(t, 500)].slice(-6);
  }

  addActivity(a: Activity): void {
    if (a.kind !== 'tool' || !a.target) return;
    if (a.edit) this.edited.add(a.target);
    else if (!this.visited.includes(a.text)) this.visited = [...this.visited, a.text].slice(-30);
  }

  /** Prompt prefix for the next route; empty when the failed attempt did nothing worth passing on. */
  handoff(from: string): string {
    if (!this.notes.length && !this.visited.length) return '';
    const parts = ['[Handoff] A previous attempt by ' + from + ' ran out of budget before answering. Its notes are UNVERIFIED: ' +
      're-check anything load-bearing, but do not redo work needlessly.'];
    if (this.visited.length) parts.push('It had looked at:\n' + this.visited.map((v) => `- ${v}`).join('\n'));
    if (this.notes.length) parts.push('Its working notes, oldest first:\n' + this.notes.map((n) => `- ${redact(n)}`).join('\n'));
    return parts.join('\n\n');
  }
}
