import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Read a .env file without polluting process.env.
 * Simple is better than complex. Explicit is better than implicit.
 */

function projectRoot(): string {
  // fileURLToPath handles %20 correctly, unlike new URL().pathname.
  const here = fileURLToPath(import.meta.url);
  return dirname(dirname(here));
}

/** The value every setting in `.env.example` ships with. Copying that file unchanged must leave every setting unset, not set to this text. */
export const ENV_PLACEHOLDER = 'YOUR_VALUE_HERE';

/** `"quoted # kept"` -> inner text; `bare  # comment` -> `bare`; `   # comment` -> ''; the example placeholder -> ''. Exported for tests. */
export function parseEnvValue(raw: string): string {
  const v = unquoteEnvValue(raw);
  return v === ENV_PLACEHOLDER ? '' : v;
}

function unquoteEnvValue(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('#')) return '';
  const quote = v[0];
  if (quote === '"' || quote === "'") {
    const end = v.indexOf(quote, 1);
    if (end > 0) return v.slice(1, end);
  }
  const comment = v.search(/\s#/);
  return (comment >= 0 ? v.slice(0, comment) : v).trim();
}

export function readEnvFile(keys?: string[]): Record<string, string> {
  try {
    const envPath = join(projectRoot(), '.env');
    if (!existsSync(envPath)) {
      return {};
    }
    const text = readFileSync(envPath, 'utf8');
    const out: Record<string, string> = {};
    const wanted = keys ? new Set(keys) : null;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const k = trimmed.slice(0, eq).trim();
      if (!k || (wanted && !wanted.has(k))) {
        continue;
      }
      const v = parseEnvValue(trimmed.slice(eq + 1));
      out[k] = v;
    }
    return out;
  } catch {
    // Never throw. Flat is better than nested, and quiet is better than crashy.
    return {};
  }
}
