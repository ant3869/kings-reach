// src/skill-scan.ts - vet a skill directory before it may be loaded, and fingerprint it afterwards.
// A skill is text an autonomous, permission-bypassing agent will obey, so it is treated like code from a stranger:
// structure is validated, hidden characters and known injection/exfil idioms are rejected, scripts are flagged.

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import yaml from 'js-yaml';

export interface Finding {
  level: 'error' | 'warn';
  file: string;
  message: string;
}

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_FILES = 60;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 600 * 1024;
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.mdc']);
const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.ps1', '.bat', '.cmd']);

// Invisible or direction-changing characters let instructions hide from a human reviewer.
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|rules|prompts?)/i, 'prompt-injection phrase: "ignore previous instructions"'],
  [/disregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|system)\s+(?:instructions|rules|prompt)/i, 'prompt-injection phrase: "disregard instructions"'],
  [/(?:curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|python\d?|node)\b/i, 'pipes a download straight into an interpreter'],
  [/\b(?:Invoke-Expression|iex)\s*[(\s$]/, 'PowerShell Invoke-Expression'],
  [/base64\s+(?:-d|--decode)[^\n|]*\|\s*(?:sh|bash)/i, 'decodes base64 into a shell'],
  [/\brm\s+-rf\s+(?:\/|~|\$HOME)(?:\s|$)/, 'recursive delete of root or home'],
  [/Remove-Item[^\n]*-Recurse[^\n]*(?:[A-Z]:\\(?:\s|$|\*)|\$env:USERPROFILE)/i, 'recursive delete of a drive or profile root'],
];
const WARN_PATTERNS: Array<[RegExp, string]> = [
  [/(?:(?<!\w)\.env\b|id_rsa|\.ssh[\\/]|credentials\.json|\.aws[\\/])/i, 'mentions credential files'], // (?<!\w): not process.env
  [/curl[^\n]*(?:-d|--data(?:-binary)?)\s+@/i, 'uploads a local file with curl'],
  [/<!--[\s\S]{40,}?-->/, 'long HTML comment (text the reader does not see)'],
  [/\beval\s*\(/, 'uses eval()'],
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out.sort();
}

export function parseFrontmatter(markdown: string): Record<string, unknown> | null {
  const match = markdown.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  try {
    const parsed = yaml.load(match[1] ?? '');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Line-ending-insensitive fingerprint of every file (a git checkout may rewrite CRLF/LF). */
export function hashSkillDir(dir: string): string {
  const hash = createHash('sha256');
  for (const file of listFiles(dir)) {
    hash.update(relative(dir, file).split('\\').join('/') + '\0');
    hash.update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n') + '\0');
  }
  return hash.digest('hex');
}

export function scanSkillDir(dir: string, expectedName: string): Finding[] {
  const findings: Finding[] = [];
  const add = (level: Finding['level'], file: string, message: string): void => { findings.push({ level, file, message }); };

  let files: string[] = [];
  try {
    files = listFiles(dir);
  } catch {
    return [{ level: 'error', file: '.', message: 'skill directory is unreadable' }];
  }
  if (files.length > MAX_FILES) add('error', '.', `too many files (${files.length} > ${MAX_FILES})`);
  let total = 0;

  for (const file of files) {
    const rel = relative(dir, file).split('\\').join('/');
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) { add('error', rel, 'symbolic links are not allowed'); continue; }
    total += stat.size;
    if (stat.size > MAX_FILE_BYTES) add('error', rel, `file too large (${stat.size} bytes)`);
    const ext = extname(file).toLowerCase();
    if (SCRIPT_EXT.has(ext)) add('warn', rel, `executable content (${ext}): the owner must read it before enabling`);
    else if (!TEXT_EXT.has(ext)) { add('error', rel, `file type ${ext || '(none)'} is not allowed in a skill`); continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    const text = readFileSync(file, 'utf8');
    if (HIDDEN_CHARS.test(text)) add('error', rel, 'contains invisible or direction-changing characters');
    for (const [pattern, message] of ERROR_PATTERNS) if (pattern.test(text)) add('error', rel, message);
    for (const [pattern, message] of WARN_PATTERNS) if (pattern.test(text)) add('warn', rel, message);
  }
  if (total > MAX_TOTAL_BYTES) add('error', '.', `skill is too large (${total} bytes)`);

  let skillMd = '';
  try { skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8'); } catch { add('error', 'SKILL.md', 'missing'); return findings; }
  const meta = parseFrontmatter(skillMd);
  if (!meta) { add('error', 'SKILL.md', 'frontmatter is missing or is not valid YAML'); return findings; }
  if (meta['name'] !== expectedName) add('error', 'SKILL.md', `frontmatter name "${String(meta['name'])}" must equal "${expectedName}"`);
  if (!NAME_RE.test(expectedName)) add('error', 'SKILL.md', 'name must be lowercase letters, digits and hyphens');
  const description = typeof meta['description'] === 'string' ? meta['description'].trim() : '';
  if (!description) add('error', 'SKILL.md', 'description is required (it is how the model decides to use the skill)');
  else if (description.length > 1024) add('error', 'SKILL.md', 'description is longer than 1024 characters');
  return findings;
}

export const hasErrors = (findings: Finding[]): boolean => findings.some((f) => f.level === 'error');
