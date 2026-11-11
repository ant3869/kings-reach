// src/setup-checklist.ts - "is King's Reach set up, and if not, what do I do next?" Every line is a real check, never a guess.
// buildChecklist() is pure (facts in, checklist out) so it is easy to test; collectChecklist() gathers the facts.
// Re-checking a provider makes ONE tiny paid call, so it only ever runs when the user presses the button.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_CHAT_ID, PROJECT_ROOT, TELEGRAM_BOT_TOKEN } from './config.js';
import { loadRuns } from './history.js';
import { loadProviderRouting, loadProviderState, recordProviderOutcome, type ProviderId, type RouteTarget } from './provider-config.js';
import { getProviderHealth, runExternalProvider, type ProviderHealth } from './provider-runner.js';
import { warroomStatus } from './warroom-supervisor.js';

export interface ChecklistItem { id: string; title: string; state: 'ok' | 'todo'; required: boolean; detail: string; fix: string | null }
export interface ProviderProblem { id: ProviderId; detail: string; fix: string; recheck: boolean }
export interface Checklist { items: ChecklistItem[]; problems: ProviderProblem[]; ready: boolean }
export interface Facts { envFile: boolean; providers: ProviderHealth[]; warroomRunning: boolean; runs: number; telegramToken: boolean; telegramChat: boolean }

/** Providers whose only requirement is an API key, so one small call tells you whether the key and the account work. */
export const RECHECKABLE: readonly ProviderId[] = ['openai', 'openrouter', 'gemini'];
// Taken from the provider's own error message (OpenAI: "Add credits ... at <this page>"); no guessing for the others.
const BILLING: Partial<Record<ProviderId, string>> = { openai: 'https://platform.openai.com/settings/organization/billing/' };

function adviceFor(p: ProviderHealth): string {
  if (/quota|credit/i.test(p.detail)) {
    return `Out of credit. Add credit${BILLING[p.id] ? ` at ${BILLING[p.id]}` : ' on that provider\'s billing page'}, then press Re-check.`;
  }
  if (/authentication failed/i.test(p.detail)) return 'The key was rejected. Put a valid key in .env, restart King\'s Reach, then press Re-check.';
  return RECHECKABLE.includes(p.id) ? 'Fix what the detail says, then press Re-check.' : 'Fix what the detail says; it clears the next time this route answers.';
}

export function buildChecklist(f: Facts): Checklist {
  const by = (id: ProviderId) => f.providers.find((p) => p.id === id);
  const claude = by('claude');
  const fallbacks = f.providers.filter((p) => p.id !== 'claude' && p.available);
  const item = (id: string, title: string, ok: boolean, detail: string, fix: string, required = true): ChecklistItem =>
    ({ id, title, state: ok ? 'ok' : 'todo', required, detail, fix: ok ? null : fix });

  const items = [
    item('env', 'Settings file exists', f.envFile, f.envFile ? '.env found' : 'No .env file yet',
      'Copy .env.example to .env (or run npm run setup), fill in what you use, then restart.'),
    item('claude', 'Signed in to Claude', Boolean(claude?.available), claude?.detail ?? 'Claude status unknown',
      'Use the Sign in to Claude button at the top of this page. Until then, chat and the council run on fallback models.'),
    item('fallback', 'A fallback model is ready', fallbacks.length > 0,
      fallbacks.length ? `${fallbacks.length} ready (${fallbacks.slice(0, 3).map((p) => p.id).join(', ')}${fallbacks.length > 3 ? ', ...' : ''})` : 'No other route is available',
      'Set OPENAI_API_KEY, GOOGLE_API_KEY or OPENROUTER_API_KEY in .env, or sign in to Codex, so work continues when Claude hits its limit.'),
    item('warroom', 'War Room is running', f.warroomRunning, f.warroomRunning ? 'Listening' : 'Not running',
      'Press Start under System readiness. First time: pip install -r warroom/requirements.txt.'),
    item('firstrun', 'Ran your first council', f.runs > 0, f.runs ? `${f.runs} run${f.runs === 1 ? '' : 's'} so far` : 'Nothing run yet',
      'Open the War Room and convene the council on a small question to see the whole flow.'),
    item('telegram', 'Chat from your phone (Telegram)', f.telegramToken && f.telegramChat,
      f.telegramToken && f.telegramChat ? 'Bot token and chat ID set' : f.telegramToken ? 'Bot token set, ALLOWED_CHAT_ID missing' : f.telegramChat ? 'ALLOWED_CHAT_ID set, bot token missing' : 'Not set up',
      `Set ${[!f.telegramToken && 'TELEGRAM_BOT_TOKEN', !f.telegramChat && 'ALLOWED_CHAT_ID'].filter(Boolean).join(' and ')} in .env, then restart.`, false),
  ];
  // A provider that is set up but not answering is not a setup step; it is something to look at (and, for API keys, re-test).
  const problems = f.providers.filter((p) => p.id !== 'claude' && p.configured && !p.available)
    .map((p) => ({ id: p.id, detail: p.detail, fix: adviceFor(p), recheck: RECHECKABLE.includes(p.id) }));
  return { items, problems, ready: items.every((i) => !i.required || i.state === 'ok') };
}

export async function collectChecklist(): Promise<Checklist> {
  return buildChecklist({
    envFile: existsSync(join(PROJECT_ROOT, '.env')),
    providers: await getProviderHealth(),
    warroomRunning: (await warroomStatus()).running,
    runs: loadRuns().length,
    telegramToken: Boolean(TELEGRAM_BOT_TOKEN),
    telegramChat: Boolean(ALLOWED_CHAT_ID),
  });
}

export interface RecheckDeps {
  run: typeof runExternalProvider;
  targets: () => RouteTarget[];
  record: typeof recordProviderOutcome;
  observed: typeof loadProviderState;
}
const REAL: RecheckDeps = {
  run: runExternalProvider,
  targets: () => Object.values(loadProviderRouting().agents).flat(),
  record: recordProviderOutcome,
  observed: loadProviderState,
};

/** One tiny call to a provider you already route to; records the result so Settings stops showing a stale failure. null = not re-checkable. */
export async function recheckProvider(id: string, deps: RecheckDeps = REAL): Promise<{ ok: boolean; detail: string } | null> {
  if (!RECHECKABLE.includes(id as ProviderId)) return null;
  const provider = id as ProviderId;
  const model = deps.targets().find((t) => t.provider === provider)?.model;
  if (!model) return { ok: false, detail: 'No route uses this provider yet. Add one in Settings first, so the check tests what you actually use.' };
  try {
    const r = await deps.run({ provider, model }, { message: 'Reply with the single word OK.' });
    if (r.error || !r.text) throw new Error(r.error ?? 'empty reply');
    deps.record(provider, model, true);
    return { ok: true, detail: `Answered (${model}).` };
  } catch (err) {
    deps.record(provider, model, false, String(err));
    return { ok: false, detail: deps.observed()[provider]?.detail ?? 'The call failed.' };
  }
}
