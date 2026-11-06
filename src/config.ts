import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvFile } from './env.js';

/**
 * Single source of truth for env config.
 * Read once via readEnvFile(), never pollute process.env with secrets.
 */

const ENV = readEnvFile();

function str(key: string, fallback = ''): string {
  const v = ENV[key];
  return v === undefined || v === '' ? fallback : v;
}

function num(key: string, fallback: number): number {
  const raw = str(key, '');
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = str(key, '').toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

// --- paths ---
export const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const STORE_DIR = join(PROJECT_ROOT, 'store');
export const UPLOADS_DIR = join(PROJECT_ROOT, 'workspace', 'uploads');

// --- core ---
export const TELEGRAM_BOT_TOKEN = str('TELEGRAM_BOT_TOKEN', '');
export const ALLOWED_CHAT_ID = str('ALLOWED_CHAT_ID', '');
export const KINGS_REACH_CONFIG = str('KINGS_REACH_CONFIG', '');
export const DEFAULT_AGENT_ID = str('DEFAULT_AGENT_ID', 'main');

// --- voice: stt_groq + tts_kokoro_local (selected) ---
export const STT_PROVIDER = str('STT_PROVIDER', 'groq');
/** 'off' disables spoken replies; anything else runs the cascade xAI -> Kokoro -> OS speech. */
export const TTS_PROVIDER = str('TTS_PROVIDER', 'auto').toLowerCase();
export const GROQ_API_KEY = str('GROQ_API_KEY', '');
export const OPENAI_API_KEY = str('OPENAI_API_KEY', '');
export const OPENROUTER_API_KEY = str('OPENROUTER_API_KEY', '');
export const OPENROUTER_BASE_URL = str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1');
export const OLLAMA_BASE_URL = str('OLLAMA_BASE_URL', 'http://127.0.0.1:11434');
export const NEXUS_LLM_API_KEY = str('NEXUS_LLM_API_KEY', '');
export const NINE_ROUTER_BASE_URL = str('NINE_ROUTER_BASE_URL', 'http://127.0.0.1:20128/v1');
/** Base URL or full .../v1/audio/speech endpoint; voice.ts normalises either. */
export const KOKORO_URL = str('KOKORO_URL', 'http://127.0.0.1:8880');
export const KOKORO_VOICE = str('KOKORO_VOICE', 'af_bella');
export const KOKORO_MODEL = str('KOKORO_MODEL', 'kokoro');
export const XAI_API_KEY = str('XAI_API_KEY', '');
export const XAI_VOICE = str('XAI_VOICE', 'eve');
export const XAI_LANG = str('XAI_LANG', 'en');
export const WHISPER_CPP_BIN = str('WHISPER_CPP_BIN', 'whisper-cpp');
export const WHISPER_CPP_MODEL = str('WHISPER_CPP_MODEL', '');
export const ELEVENLABS_API_KEY = str('ELEVENLABS_API_KEY', '');
export const ELEVENLABS_VOICE_ID = str('ELEVENLABS_VOICE_ID', '');
export const VOICE_REPLY_DEFAULT = bool('VOICE_REPLY_DEFAULT', false);

// --- memory v2 / gemini ---
export const GOOGLE_API_KEY = str('GOOGLE_API_KEY', '');
export const GEMINI_TEXT_MODEL = str('GEMINI_TEXT_MODEL', 'gemini-3-flash-preview');
export const GEMINI_EMBED_MODEL = str('GEMINI_EMBED_MODEL', 'gemini-embedding-001');
export const MEMORY_NUDGE_INTERVAL_TURNS = num('MEMORY_NUDGE_INTERVAL_TURNS', 10);
export const MEMORY_NUDGE_INTERVAL_HOURS = num('MEMORY_NUDGE_INTERVAL_HOURS', 2);
export const CONSOLIDATION_INTERVAL_MIN = num('CONSOLIDATION_INTERVAL_MIN', 30);
export const CONSOLIDATION_INTERVAL_MS = CONSOLIDATION_INTERVAL_MIN * 60 * 1000;

// --- war room / dashboard ---
// War room voice/council settings are read by warroom/config.py (the side that uses them).
export const WARROOM_PORT = num('WARROOM_PORT', 7860);
export const AGENT_BRIDGE_PATH = str('AGENT_BRIDGE_PATH', '');
export const DASHBOARD_PORT = num('DASHBOARD_PORT', 3141);
export const DASHBOARD_TOKEN = str('DASHBOARD_TOKEN', '');
/** Loopback by default. A non-loopback host REQUIRES DASHBOARD_TOKEN (enforced at startup). */
export const DASHBOARD_HOST = str('DASHBOARD_HOST', '127.0.0.1');
/** Absolute path to the war-room venv python. Empty = refuse to spawn (bare `python` hit conda). */
export const WARROOM_PYTHON = str('WARROOM_PYTHON', '');
/** Core supervises the war room: start it on boot when :WARROOM_PORT is free. */
export const WARROOM_AUTOSTART = bool('WARROOM_AUTOSTART', true);

// --- scheduler / whatsapp ---
export const SCHEDULER_ENABLED = bool('SCHEDULER_ENABLED', true);
export const SCHEDULER_POLL_MS = num('SCHEDULER_POLL_MS', 60_000);
export const WHATSAPP_ENABLED = bool('WHATSAPP_ENABLED', true);
export const WHATSAPP_SESSION_PATH = str('WHATSAPP_SESSION_PATH', 'store/wa-session');

// --- multi-agent tokens ---
export const COMMS_TELEGRAM_TOKEN = str('COMMS_TELEGRAM_TOKEN', '');
export const CONTENT_TELEGRAM_TOKEN = str('CONTENT_TELEGRAM_TOKEN', '');
export const OPS_TELEGRAM_TOKEN = str('OPS_TELEGRAM_TOKEN', '');
export const RESEARCH_TELEGRAM_TOKEN = str('RESEARCH_TELEGRAM_TOKEN', '');

// --- agent behavior ---
export const AGENT_TIMEOUT_MS = num('AGENT_TIMEOUT_MS', 900_000);
export const AGENT_MAX_TURNS = num('AGENT_MAX_TURNS', 30);
export const SHOW_COST_FOOTER = str('SHOW_COST_FOOTER', 'compact');
export const STREAM_STRATEGY = str('STREAM_STRATEGY', 'off');
export const MAX_MESSAGE_LENGTH = num('MAX_MESSAGE_LENGTH', 4096);
export const TYPING_REFRESH_MS = num('TYPING_REFRESH_MS', 4000);

// --- security (compat, not selected) ---
export const PIN_HASH = str('PIN_HASH', '');
export const PIN_SALT = str('PIN_SALT', '');
export const IDLE_LOCK_MINUTES = num('IDLE_LOCK_MINUTES', 30);
export const KILL_PHRASE = str('KILL_PHRASE', '');

// --- meeting bot / slack (compat, not selected) ---
export const PIKA_API_KEY = str('PIKA_API_KEY', '');
export const RECALL_API_KEY = str('RECALL_API_KEY', '');
export const SLACK_BOT_TOKEN = str('SLACK_BOT_TOKEN', '');

// --- obsidian ---
export const OBSIDIAN_VAULT_PATH = str('OBSIDIAN_VAULT_PATH', '');

// --- budgets ---
export const DAILY_TOKEN_LIMIT = num('DAILY_TOKEN_LIMIT', 0);
export const DAILY_COST_LIMIT = num('DAILY_COST_LIMIT', 0);
export const HOURLY_TOKEN_LIMIT = num('HOURLY_TOKEN_LIMIT', 0);

// --- system ---
export const LOG_LEVEL = str('LOG_LEVEL', 'info');
export const NODE_ENV = str('NODE_ENV', 'production');

// --- runtime agent overrides (no restart needed) ---
export interface AgentOverrides {
  model?: string;
  timeoutMs?: number;
  maxTurns?: number;
}

const overrides: AgentOverrides = {};

export function setAgentOverrides(next: Partial<AgentOverrides>): void {
  if (next.model !== undefined) overrides.model = next.model;
  if (next.timeoutMs !== undefined) overrides.timeoutMs = next.timeoutMs;
  if (next.maxTurns !== undefined) overrides.maxTurns = next.maxTurns;
}

export function getAgentOverrides(): Readonly<AgentOverrides> {
  return overrides;
}

export function effectiveTimeoutMs(): number {
  return overrides.timeoutMs ?? AGENT_TIMEOUT_MS;
}

export function effectiveMaxTurns(): number {
  return overrides.maxTurns ?? AGENT_MAX_TURNS;
}
