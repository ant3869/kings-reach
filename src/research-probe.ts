// src/research-probe.ts - can this machine actually research? Without internet or a browser the council is guessing
// from memory, so the War Room checks before it deliberates and tells the agents (and you) the truth.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from './config.js';

export const PLAYWRIGHT_CLI = join(PROJECT_ROOT, 'tools', 'browser', 'node_modules', '.bin', process.platform === 'win32' ? 'playwright-cli.cmd' : 'playwright-cli');
export const AGENT_REACH_EXE = join(PROJECT_ROOT, 'tools', 'agent-reach', 'venv', process.platform === 'win32' ? 'Scripts/agent-reach.exe' : 'bin/agent-reach');

const HOSTS = ['https://example.com', 'https://api.github.com'];
const TIMEOUT_MS = 4000;
const CACHE_MS = 60_000;

function browserCandidates(): string[] {
  const env = process.env;
  const programFiles = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean) as string[];
  return [
    env['RESEARCH_CHROME_PATH'], env['CHROME_PATH'],
    ...programFiles.flatMap((base) => [join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean) as string[];
}

export interface ResearchStatus {
  ok: boolean;
  internet: boolean;
  /** playwright-cli installed AND a Chrome/Edge to drive. */
  browser: boolean;
  /** agent-reach CLI installed. */
  reach: boolean;
  summary: string;
  /** Text for the agents' prompts: states exactly what they can and cannot do this run. */
  note: string;
  checkedAt: string;
}

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  exists?: (path: string) => boolean;
  hosts?: string[];
}

let cache: { at: number; value: ResearchStatus } | null = null;

export async function probeResearch(deps: ProbeDeps = {}, force = false): Promise<ResearchStatus> {
  if (!force && !deps.fetchImpl && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const doFetch = deps.fetchImpl ?? fetch;
  const exists = deps.exists ?? existsSync;
  const hosts = deps.hosts ?? HOSTS;

  const reachable = await Promise.all(hosts.map(async (url) => {
    try { await doFetch(url, { method: 'GET', signal: AbortSignal.timeout(TIMEOUT_MS) }); return true; } catch { return false; }
  }));
  const internet = reachable.some(Boolean);
  const browser = exists(PLAYWRIGHT_CLI) && browserCandidates().some((p) => exists(p));
  const reach = exists(AGENT_REACH_EXE);

  const tools = [browser && 'browser (playwright-cli)', reach && 'agent-reach (web/GitHub/YouTube read+search)', 'the built-in WebSearch/WebFetch tools'].filter(Boolean).join(', ');
  const ok = internet && (browser || reach);
  const summary = !internet
    ? 'NO internet: research is limited to local files and memory'
    : ok ? `internet ok; ${[browser && 'browser', reach && 'agent-reach'].filter(Boolean).join(' + ')} ready`
      : 'internet ok but no browser or agent-reach installed (only built-in web tools)';
  const note = !internet
    ? 'Research capability: this machine has NO internet access right now. You cannot verify anything on the web. Say so plainly, label every external claim "unverified (no web access)", and keep confidence low for anything you cannot check locally.'
    : `Research capability: internet is reachable. Prefer primary sources. Tools you can use: ${tools}. Cite URLs for every external claim.`;
  const value: ResearchStatus = { ok, internet, browser, reach, summary, note, checkedAt: new Date().toISOString() };
  if (!deps.fetchImpl) cache = { at: Date.now(), value };
  return value;
}
