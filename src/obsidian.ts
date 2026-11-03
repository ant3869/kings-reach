import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { OBSIDIAN_VAULT_PATH } from './config.js';
import { logger } from './logger.js';

/** Search the Obsidian vault for notes relevant to the query. */

function listMarkdownFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listMarkdownFiles(full, out, depth + 1);
    } else if (extname(name).toLowerCase() === '.md') {
      out.push(full);
      if (out.length >= 200) return out;
    }
  }
  return out;
}

function scoreFile(content: string, terms: string[]): number {
  const lower = content.toLowerCase().slice(0, 8000);
  let score = 0;
  for (const t of terms) {
    if (!t) continue;
    const needle = t.toLowerCase();
    let idx = lower.indexOf(needle);
    let hits = 0;
    while (idx !== -1 && hits < 5) {
      score += needle.length > 4 ? 2 : 1;
      hits += 1;
      idx = lower.indexOf(needle, idx + needle.length);
    }
  }
  return score;
}

export async function buildObsidianContext(query: string, vaultPath?: string): Promise<string> {
  const vault = (vaultPath || OBSIDIAN_VAULT_PATH || '').trim();
  if (!vault || !existsSync(vault)) {
    return '';
  }
  const terms = (query || '')
    .split(/[^a-zA-Z0-9]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .slice(0, 8);
  if (terms.length === 0) {
    return '';
  }
  try {
    const files = listMarkdownFiles(vault);
    const scored: Array<{ file: string; score: number; snippet: string }> = [];
    for (const file of files) {
      let content = '';
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const score = scoreFile(content, terms);
      if (score > 0) {
        scored.push({ file, score, snippet: content.slice(0, 1200) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 3);
    if (top.length === 0) {
      return '';
    }
    const lines = top.map((t) => `- ${t.file}: ${t.snippet.replace(/\s+/g, ' ').slice(0, 400)}`);
    return `[Obsidian context]\n${lines.join('\n')}`;
  } catch (err) {
    logger.warn({ err: String(err) }, 'obsidian context failed');
    return '';
  }
}
