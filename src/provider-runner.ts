// src/provider-runner.ts - execute one non-Claude route. Provider selection/fallback stays in agent.ts.
// Full local tools: Codex CLI. Advisory calls: ChatGPT/Meta/9Router/Gemini/OpenAI/OpenRouter/Ollama.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  GEMINI_TEXT_MODEL, GOOGLE_API_KEY, NEXUS_LLM_API_KEY, NINE_ROUTER_BASE_URL, OLLAMA_BASE_URL,
  OPENAI_API_KEY, OPENROUTER_API_KEY, OPENROUTER_BASE_URL, STORE_DIR,
} from './config.js';
import type { AgentOptions, AgentResult } from './agent.js';
import { codexActivity } from './activity.js';
import { claudeAuth } from './claude-auth.js';
import { harnessHealth, isHarness, runHarness } from './harness-runner.js';
import { loadProviderState, type ProviderId, type RouteTarget } from './provider-config.js';

interface CommandResult { code: number | null; stdout: string; stderr: string; }
const TIMEOUT_MS = 15 * 60_000;

function command(exe: string, args: string[], input = '', timeoutMs = TIMEOUT_MS, onLine?: (line: string) => void): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: process.cwd(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${exe} timed out`)); }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      const chunk = b.toString();
      stdout += chunk;
      if (!onLine) return;
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function normalizeSchema(value: unknown, mode: 'gemini' | 'openai'): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeSchema(v, mode));
  if (!value || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>, out: Record<string, unknown> = {};
  const geminiUnsupported = new Set(['$schema', 'additionalProperties', 'patternProperties', 'minLength', 'maxLength']);
  for (const [key, val] of Object.entries(src)) {
    if (mode === 'gemini' && geminiUnsupported.has(key)) continue;
    out[key] = normalizeSchema(val, mode);
  }
  // OpenAI strict structured outputs require closed objects and every property listed as required.
  if (mode === 'openai' && out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Record<string, unknown>);
  }
  return out;
}

function parseStructured(text: string, schema?: Record<string, unknown>): unknown {
  if (!schema) return undefined;
  try { return JSON.parse(text); } catch { /* fenced fallback */ }
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* report below */ }
  }
  throw new Error('provider did not return valid structured JSON');
}

function fullPrompt(opts: AgentOptions): string {
  const format = opts.schema ? '\nReturn ONLY JSON matching the supplied schema. No markdown fence.' : '';
  return `${opts.systemPrompt ? `[System]\n${opts.systemPrompt}\n\n` : ''}[Task]\n${opts.message}${format}`;
}

async function runCodex(target: RouteTarget, opts: AgentOptions): Promise<AgentResult> {
  const tmp = join(STORE_DIR, 'provider-tmp');
  mkdirSync(tmp, { recursive: true });
  const id = randomUUID();
  const output = join(tmp, `${id}.out`), schemaFile = join(tmp, `${id}.schema.json`);
  if (opts.schema) writeFileSync(schemaFile, JSON.stringify(normalizeSchema(opts.schema, 'openai')), 'utf8');
  const args = ['exec', '--json', '--skip-git-repo-check', '-C', opts.cwd ?? process.cwd(), '--sandbox', opts.readOnly ? 'read-only' : 'workspace-write',
    '--color', 'never'];
  // `default` respects the model attached to the user's Codex subscription/config. Public model names
  // are not universally valid for ChatGPT-authenticated Codex accounts.
  if (target.model !== 'default') args.push('-m', target.model);
  args.push('-o', output);
  if (opts.schema) args.push('--output-schema', schemaFile);
  args.push('-');
  try {
    // `.cmd` is resolved by cmd.exe on Windows; no shell on other platforms.
    const exe = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'codex';
    const realArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'codex.cmd', ...args] : args;
    const r = await command(exe, realArgs, fullPrompt(opts), TIMEOUT_MS, (line) => {
      if (!opts.onActivity) return;
      try {
        const act = codexActivity(JSON.parse(line) as Record<string, unknown>);
        if (act) opts.onActivity(act);
      } catch { /* non-JSON diagnostic line */ }
    });
    const text = (() => { try { return readFileSync(output, 'utf8').trim(); } catch { return r.stdout.trim(); } })();
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `Codex exited ${r.code}`).slice(-1000));
    let inputTokens = 0, outputTokens = 0;
    for (const line of r.stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const usage = event['usage'] as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = Math.max(inputTokens, Number(usage['input_tokens'] ?? usage['prompt_tokens'] ?? 0));
          outputTokens = Math.max(outputTokens, Number(usage['output_tokens'] ?? usage['completion_tokens'] ?? 0));
        }
      } catch { /* non-JSON diagnostic line */ }
    }
    return { text, model: target.model, structured: parseStructured(text, opts.schema), provider: 'codex',
      inputTokens: inputTokens || undefined, outputTokens: outputTokens || undefined };
  } finally {
    rmSync(output, { force: true });
    rmSync(schemaFile, { force: true });
  }
}

async function post(url: string, init: RequestInit, timeoutMs = 180_000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 700)}`);
    return JSON.parse(body);
  } finally { clearTimeout(timer); }
}

async function runGemini(target: RouteTarget, opts: AgentOptions): Promise<AgentResult> {
  if (!GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY is not configured');
  const generationConfig: Record<string, unknown> = { temperature: 0.2 };
  if (opts.schema) Object.assign(generationConfig, { responseMimeType: 'application/json', responseSchema: normalizeSchema(opts.schema, 'gemini') });
  const body: Record<string, unknown> = { contents: [{ parts: [{ text: opts.message }] }], generationConfig };
  if (opts.systemPrompt) body.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
  const data = await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(target.model)}:generateContent?key=${GOOGLE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (data.error) throw new Error(data.error.message ?? 'Gemini error');
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('').trim();
  const usage = data.usageMetadata ?? {};
  return { text, model: target.model, structured: parseStructured(text, opts.schema), provider: 'gemini',
    inputTokens: Number(usage.promptTokenCount ?? 0) || undefined,
    outputTokens: Number(usage.candidatesTokenCount ?? 0) || undefined };
}

async function runOpenAICompatible(target: RouteTarget, opts: AgentOptions, openrouter = false): Promise<AgentResult> {
  const key = openrouter ? OPENROUTER_API_KEY : OPENAI_API_KEY;
  if (!key) throw new Error(`${openrouter ? 'OPENROUTER' : 'OPENAI'}_API_KEY is not configured`);
  const base = openrouter ? OPENROUTER_BASE_URL : 'https://api.openai.com/v1';
  const body: Record<string, unknown> = { model: target.model, messages: [
    ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []), { role: 'user', content: opts.message },
  ] };
  if (opts.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'kings_reach_result', strict: true, schema: normalizeSchema(opts.schema, 'openai') } };
  const data = await post(`${base.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
    ...(openrouter ? { 'HTTP-Referer': 'http://localhost/kings-reach', 'X-Title': 'Kings Reach' } : {}),
  }, body: JSON.stringify(body) });
  const text = data.choices?.[0]?.message?.content ?? '';
  return { text, model: target.model, structured: parseStructured(text, opts.schema), provider: target.provider,
    inputTokens: Number(data.usage?.prompt_tokens ?? 0) || undefined,
    outputTokens: Number(data.usage?.completion_tokens ?? 0) || undefined };
}

function nineRouterKey(): string {
  if (NEXUS_LLM_API_KEY) return NEXUS_LLM_API_KEY;
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
    const toml = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    const section = toml.split('[model_providers.9router.http_headers]')[1]?.split(/^\[/m)[0] ?? '';
    const match = section.match(/^Authorization\s*=\s*["']Bearer\s+([^"']+)["']/m);
    return match?.[1] ?? '';
  } catch { return ''; }
}

async function run9Router(target: RouteTarget, opts: AgentOptions): Promise<AgentResult> {
  const key = nineRouterKey();
  if (!key) throw new Error('NEXUS_LLM_API_KEY / Codex 9Router credential is not configured');
  const body: Record<string, unknown> = { model: target.model, stream: false, temperature: 0.2, messages: [
    ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
    { role: 'user', content: opts.schema ? `${opts.message}\n\nReturn only JSON matching this schema:\n${JSON.stringify(opts.schema)}` : opts.message },
  ] };
  if (opts.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'kings_reach_result', strict: true,
    schema: normalizeSchema(opts.schema, 'openai') } };
  const data = await post(`${NINE_ROUTER_BASE_URL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${key}`,
  }, body: JSON.stringify(body) }, 10 * 60_000);
  const raw = data.choices?.[0]?.message?.content ?? '';
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return { text, model: target.model, structured: parseStructured(text, opts.schema), provider: target.provider,
    inputTokens: Number(data.usage?.prompt_tokens ?? 0) || undefined,
    outputTokens: Number(data.usage?.completion_tokens ?? 0) || undefined };
}

async function runOllama(target: RouteTarget, opts: AgentOptions): Promise<AgentResult> {
  const data = await post(`${OLLAMA_BASE_URL.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: target.model, stream: false, messages: [
      ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []), { role: 'user', content: opts.message },
    ], ...(opts.schema ? { format: opts.schema } : {}) }) }, 10 * 60_000);
  const text = data.message?.content ?? '';
  return { text, model: target.model, structured: parseStructured(text, opts.schema), provider: 'ollama',
    inputTokens: Number(data.prompt_eval_count ?? 0) || undefined,
    outputTokens: Number(data.eval_count ?? 0) || undefined };
}

async function runHarnessRoute(target: RouteTarget, opts: AgentOptions): Promise<AgentResult> {
  if (!isHarness(target.provider)) throw new Error(`not a harness: ${target.provider}`);
  const started = Date.now();
  const reply = await runHarness(target.provider, { prompt: fullPrompt(opts), model: target.model, readOnly: opts.readOnly },
    (exe, args, input, timeoutMs) => command(exe, args, input, timeoutMs), join(STORE_DIR, 'provider-tmp'));
  return { text: reply.text, model: reply.model ?? target.model, provider: target.provider, newSessionId: reply.sessionId,
    inputTokens: reply.inputTokens, outputTokens: reply.outputTokens, durationMs: Date.now() - started,
    structured: parseStructured(reply.text, opts.schema) };
}

export async function runExternalProvider(target: RouteTarget, opts: AgentOptions): Promise<AgentResult> {
  if (isHarness(target.provider)) return runHarnessRoute(target, opts);
  if (target.provider === 'codex') return runCodex(target, opts);
  if (target.provider === 'meta' || target.provider === '9router' || target.provider === 'chatgpt') return run9Router(target, opts);
  if (target.provider === 'gemini') return runGemini(target, opts);
  if (target.provider === 'openai') return runOpenAICompatible(target, opts);
  if (target.provider === 'openrouter') return runOpenAICompatible(target, opts, true);
  if (target.provider === 'ollama') return runOllama(target, opts);
  throw new Error(`unsupported external provider: ${target.provider}`);
}

export interface RouterModel { id: string; capabilities?: { tools?: boolean; reasoning?: boolean; contextWindow?: number }; }
/** `available` includes the last real call's outcome; `configured` is only "credentials/service present" (a bad model once must not lock a provider out of the picker). */
export interface ProviderHealth { id: ProviderId; available: boolean; detail: string; models?: string[]; configured?: boolean; }
export async function get9RouterCatalog(): Promise<RouterModel[]> {
  try {
    const data = await post(`${NINE_ROUTER_BASE_URL.replace(/\/$/, '')}/models`, { method: 'GET' }, 5_000);
    return Array.isArray(data.data) ? data.data.map((m: RouterModel) => ({ id: m.id, capabilities: m.capabilities })) : [];
  } catch { return []; }
}
export async function getProviderHealth(catalog?: RouterModel[]): Promise<ProviderHealth[]> {
  const codex = await command(process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'codex',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'codex.cmd', 'login', 'status'] : ['login', 'status'], '', 10_000)
    .then((r) => ({ id: 'codex' as const, available: r.code === 0, detail: (r.stdout || r.stderr).trim().slice(-300) }))
    .catch((e) => ({ id: 'codex' as const, available: false, detail: String(e).slice(-300) }));
  let ollama: ProviderHealth = { id: 'ollama', available: false, detail: 'service unavailable' };
  try {
    const data = await post(`${OLLAMA_BASE_URL.replace(/\/$/, '')}/api/tags`, { method: 'GET' }, 3_000);
    const models = (data.models ?? []).map((m: { name: string }) => m.name);
    ollama = { id: 'ollama', available: models.length > 0, detail: models.length ? `${models.length} local model(s)` : 'running, no models installed', models };
  } catch { /* expected when Ollama is off */ }
  const claude = await claudeAuth();
  const harnesses = await harnessHealth((exe, args, input, timeoutMs) => command(exe, args, input, timeoutMs));
  const routerModels = catalog ?? await get9RouterCatalog();
  const routerReady = Boolean(nineRouterKey()) && routerModels.length > 0;
  const metaCount = routerModels.filter((m) => /^(meta\/|cf\/@cf\/meta\/)/.test(m.id)).length;
  const chatgptCount = routerModels.filter((m) => /^cx\//.test(m.id)).length;
  const base: ProviderHealth[] = [
    // Installed counts as configured (routes stay saveable while logged out); only `available` tracks the login.
    { id: 'claude', available: claude.loggedIn, configured: true,
      detail: claude.loggedIn ? 'SDK/CLI installed; quota is checked per call' : claude.detail }, codex,
    { id: 'chatgpt', available: routerReady && chatgptCount > 0,
      detail: routerReady ? `${chatgptCount} ChatGPT/Codex models through 9Router` : '9Router/credential unavailable' },
    { id: 'meta', available: routerReady && metaCount > 0, detail: routerReady ? `${metaCount} Meta models through 9Router` : '9Router/credential unavailable' },
    { id: '9router', available: routerReady, detail: routerReady ? `${routerModels.length} models discovered` : 'gateway/credential unavailable' },
    { id: 'gemini', available: Boolean(GOOGLE_API_KEY), detail: GOOGLE_API_KEY ? `configured (${GEMINI_TEXT_MODEL})` : 'GOOGLE_API_KEY missing' },
    { id: 'openai', available: Boolean(OPENAI_API_KEY), detail: OPENAI_API_KEY ? 'OPENAI_API_KEY configured' : 'OPENAI_API_KEY missing' },
    { id: 'openrouter', available: Boolean(OPENROUTER_API_KEY), detail: OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY configured' : 'OPENROUTER_API_KEY missing' },
    ollama,
    ...harnesses,
  ];
  const observed = loadProviderState();
  return base.map((raw) => {
    const item: ProviderHealth = { ...raw, configured: raw.configured ?? raw.available };
    const last = observed[item.id];
    if (!last) return item;
    // A verified login outranks an old "authentication failed" note: do not keep showing it after re-login.
    if (item.id === 'claude' && claude.loggedIn && /auth/i.test(last.detail)) return item;
    const ageMs = Date.now() - Date.parse(last.at);
    const stickyFailure = /quota|credit|auth|api[_ ]?key/i.test(last.detail);
    if (!last.ok && !stickyFailure && ageMs > 30 * 60_000) {
      return { ...item, detail: `${item.detail}; previous failure cooldown expired (${last.model})` };
    }
    return { ...item, available: item.available && last.ok,
      detail: `${item.detail}; ${last.detail} (${last.model}, ${last.at.replace('T', ' ').slice(0, 19)})` };
  });
}
