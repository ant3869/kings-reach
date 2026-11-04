// src/skill-install.ts - get a skill directory from GitHub or disk into a staging folder. Nothing here activates anything:
// the CLI scans the staged copy and files it in skillpack/quarantine/ for the owner to enable.

import { copyFileSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const MAX_FILES = 60;
const MAX_FILE_BYTES = 200 * 1024;
const TIMEOUT_MS = 30_000;
const TEXT_ONLY = /\.(md|mdc|txt|json|ya?ml)$/i;

export interface GithubSpec {
  repo: string;
  path: string;
  ref: string;
}

/** "github:owner/repo/path/to/skill@ref" (path and ref optional). */
export function parseGithubSpec(spec: string): GithubSpec | null {
  const match = spec.match(/^github:([\w.-]+)\/([\w.-]+)((?:\/[\w.\-]+)*)(?:@([\w./-]+))?$/);
  if (!match) return null;
  if ((match[3] ?? '').split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return { repo: `${match[1]}/${match[2]}`, path: (match[3] ?? '').replace(/^\//, ''), ref: match[4] ?? 'HEAD' };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'User-Agent': 'kings-reach-skill-installer', Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface Fetched {
  repo: string;
  /** Full commit sha the files came from (the install is pinned to it). */
  ref: string;
  path: string;
  license?: string;
  files: number;
  skipped: string[];
}

/** Download one skill directory at an exact commit. `textOnly` leaves scripts and binaries behind. */
export async function fetchGithubSkill(spec: GithubSpec, dest: string, textOnly: boolean): Promise<Fetched> {
  const commit = await getJson<{ sha: string }>(`${API}/repos/${spec.repo}/commits/${spec.ref}`);
  const tree = await getJson<{ tree: Array<{ path: string; type: string; size?: number }>; truncated?: boolean }>(
    `${API}/repos/${spec.repo}/git/trees/${commit.sha}?recursive=1`);
  const prefix = spec.path ? `${spec.path}/` : '';
  const wanted = tree.tree.filter((t) => t.type === 'blob' && (spec.path ? t.path.startsWith(prefix) : true));
  if (!wanted.length) throw new Error(`no files under ${spec.repo}/${spec.path} at ${commit.sha.slice(0, 7)}`);
  if (wanted.length > MAX_FILES * 4) throw new Error(`${spec.path || 'repo root'} has ${wanted.length} files: point at a skill folder, not a whole repo`);
  const skipped: string[] = [];
  const chosen = wanted.filter((t) => {
    const keep = (!textOnly || TEXT_ONLY.test(t.path)) && (t.size ?? 0) <= MAX_FILE_BYTES;
    if (!keep) skipped.push(t.path.slice(prefix.length));
    return keep;
  });
  if (chosen.length > MAX_FILES) throw new Error(`too many files (${chosen.length}); use a narrower path`);
  for (const file of chosen) {
    const res = await fetch(`${RAW}/${spec.repo}/${commit.sha}/${file.path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`${file.path} -> HTTP ${res.status}`);
    const target = resolve(dest, file.path.slice(prefix.length));
    if (!target.startsWith(resolve(dest) + sep)) throw new Error(`refusing path outside the skill folder: ${file.path}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  }
  let license: string | undefined;
  try {
    license = (await getJson<{ license?: { spdx_id?: string } }>(`${API}/repos/${spec.repo}/license`)).license?.spdx_id;
  } catch { /* license is informational */ }
  return { repo: spec.repo, ref: commit.sha, path: spec.path, license, files: chosen.length, skipped };
}

/** Copy a local skill folder, refusing symbolic links (they could point outside the folder). */
export function copySkillDir(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (lstatSync(from).isSymbolicLink()) throw new Error(`refusing symbolic link: ${from}`);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copySkillDir(from, to);
    } else {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}
