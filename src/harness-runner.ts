// src/harness-runner.ts - run a whole agent harness (OpenClaw, Hermes, Code Puppy) as a provider route.
// Unlike the API providers these are full agents with their own tools, so they can take real work, not just advice.
// Everything that knows a CLI's quirks (flags, how the prompt is handed over, where the answer sits in the output)
// lives here as pure functions; the process runner is injected, which keeps this testable and avoids an import cycle.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const HARNESS_IDS = ['openclaw', 'hermes', 'codepuppy'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export const isHarness = (id: string): id is HarnessId => (HARNESS_IDS as readonly string[]).includes(id);

export interface CommandResult { code: number | null; stdout: string; stderr: string }
export type CommandFn = (exe: string, args: string[], input?: string, timeoutMs?: number) => Promise<CommandResult>;

export interface HarnessReply { text: string; sessionId?: string; model?: string; inputTokens?: number; outputTokens?: number }
export interface HarnessRequest { prompt: string; model: string; readOnly?: boolean }

const EXE: Record<HarnessId, string> = { openclaw: 'openclaw', hermes: 'hermes', codepuppy: 'code-puppy' };
/**
 * On Windows a bare `openclaw` resolves to an unrelated installer (~/.local/bin/openclaw.exe) that rejects every real
 * command, so the npm .cmd shim must be run through cmd.exe, exactly as the Codex route does.
 */
const WINDOWS_SHIM: Partial<Record<HarnessId, string>> = { openclaw: 'openclaw.cmd' };

export function launch(id: HarnessId, args: string[], platform: string = process.platform, comspec: string = process.env.ComSpec ?? 'cmd.exe'): { exe: string; args: string[] } {
  const shim = WINDOWS_SHIM[id];
  return platform === 'win32' && shim ? { exe: comspec, args: ['/d', '/s', '/c', shim, ...args] } : { exe: EXE[id], args };
}

/** Model ids end up on a command line (through cmd.exe for some), so only ordinary id characters are allowed. */
const SAFE_MODEL = /^[\w.:/@+-]{1,120}$/;
/** Windows caps a command line near 32k characters; past this a prompt travels by file instead of by argument. */
const MAX_ARG_PROMPT = 6000;
const READ_ONLY_NOTE = '[Constraint] This is a read-only task: do not create, edit or delete files, and do not run state-changing commands.\n\n';

// eslint-disable-next-line no-control-regex
const TERMINAL_CODES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripTerminal = (s: string): string => s.replace(TERMINAL_CODES, '');

const isDefault = (model: string): boolean => !model || model === 'default';

/** Hermes picks a provider separately from the model: "openrouter:meta-llama/llama-4-maverick" -> both flags. */
export function hermesModelArgs(model: string): string[] {
  if (isDefault(model)) return [];
  const at = model.indexOf(':');
  return at > 0 ? ['--provider', model.slice(0, at), '-m', model.slice(at + 1)] : ['-m', model];
}

// ---- output parsers (pure) -------------------------------------------------------------------------------------

/** OpenClaw prints one JSON envelope; the reply is the visible assistant text, and a non-ok status is a failure. */
export function parseOpenClaw(stdout: string): HarnessReply {
  const body = stripTerminal(stdout);
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('openclaw returned no JSON result');
  const env = JSON.parse(body.slice(start, end + 1)) as {
    status?: string; summary?: string; error?: { message?: string } | string;
    result?: { payloads?: { text?: string | null }[]; meta?: { finalAssistantVisibleText?: string;
      agentMeta?: { sessionId?: string; model?: string; usage?: { input?: number; output?: number } } } };
  };
  if (env.status && env.status !== 'ok') {
    const why = typeof env.error === 'string' ? env.error : env.error?.message ?? env.summary ?? env.status;
    throw new Error(`openclaw run failed: ${why}`);
  }
  const meta = env.result?.meta;
  const payloadText = (env.result?.payloads ?? []).map((p) => p.text ?? '').filter(Boolean).join('\n\n');
  const text = (meta?.finalAssistantVisibleText || payloadText).trim();
  if (!text) throw new Error('openclaw finished without an answer');
  const agent = meta?.agentMeta;
  return { text, sessionId: agent?.sessionId, model: agent?.model, inputTokens: agent?.usage?.input, outputTokens: agent?.usage?.output };
}

/** Hermes (quiet mode): stdout is only the answer; the session id is announced on stderr. */
export function parseHermes(stdout: string, stderr: string): HarnessReply {
  const text = stripTerminal(stdout).trim();
  if (!text) throw new Error('hermes finished without an answer');
  if (/No usable credentials/i.test(text)) throw new Error(`hermes auth failed: ${text.slice(0, 200)}`);
  return { text, sessionId: stripTerminal(stderr).match(/session_id:\s*(\S+)/)?.[1] };
}

// Code Puppy has no quiet mode: its answer follows a banner and an update notice, so those known lines are dropped.
const PUPPY_NOISE = [
  /^Computer Use is off/i, /^Executing prompt:/i, /^Current version:/i, /^Latest version:/i,
  /^Core plugins version:/i, /^A new version of code puppy/i, /^Please consider updating/i, /^\u2b06/, /^\.\.\. \[truncated\]$/i,
];
/**
 * After "Executing prompt:" Code Puppy prints the whole prompt back (word-wrapped at its terminal width), then the answer.
 * Whitespace is ignored while matching the echo's tail so the wrapping cannot hide it; the answer is whatever follows.
 */
export function afterPromptEcho(output: string, sent: string): string {
  const marker = output.indexOf('Executing prompt:');
  const tail = sent.replace(/\s+/g, '').slice(-40);
  if (marker < 0 || !tail) return output;
  let flat = '';
  const origin: number[] = [];
  for (let i = marker; i < output.length; i++) {
    if (!/\s/.test(output[i] as string)) { flat += output[i]; origin.push(i); }
  }
  const at = flat.indexOf(tail);
  return at < 0 ? output : output.slice((origin[at + tail.length - 1] as number) + 1);
}

export function parseCodePuppy(stdout: string, sent = ''): HarnessReply {
  const text = afterPromptEcho(stripTerminal(stdout), sent).split(/\r?\n/).filter((l) => !PUPPY_NOISE.some((re) => re.test(l.trim()))).join('\n').trim();
  if (!text) throw new Error('code-puppy finished without an answer');
  return { text };
}

// ---- invocation ------------------------------------------------------------------------------------------------

/** `echo` is the exact prompt text the CLI will repeat back, when it does (Code Puppy), so the parser can drop it. */
interface Invocation { args: string[]; input?: string; echo?: string }

/** How each CLI receives the prompt and the model. `promptFile` is a temp file already holding the prompt. */
export function buildInvocation(id: HarnessId, req: HarnessRequest, promptFile: string): Invocation {
  if (!isDefault(req.model) && !SAFE_MODEL.test(req.model)) throw new Error(`refusing unsafe model id for ${id}: ${JSON.stringify(req.model.slice(0, 40))}`);
  const model = isDefault(req.model) ? [] : [req.model];
  if (id === 'openclaw') {
    return { args: ['agent', '--json', '--agent', 'main', '--message-file', promptFile, ...(model.length ? ['--model', ...model] : [])] };
  }
  if (id === 'hermes') {
    return { args: ['chat', '--query-file', '-', '--oneshot', '-Q', ...hermesModelArgs(req.model)], input: req.prompt };
  }
  const direct = req.prompt.length <= MAX_ARG_PROMPT;
  const prompt = direct ? req.prompt
    : `Your complete task is written in the file ${promptFile}. Read that file first, carry the task out, then reply with only the final answer.`;
  return { args: ['-p', prompt, ...(model.length ? ['-m', ...model] : [])], echo: prompt };
}

export async function runHarness(id: HarnessId, req: HarnessRequest, run: CommandFn, tmpDir: string, timeoutMs?: number): Promise<HarnessReply> {
  mkdirSync(tmpDir, { recursive: true });
  const promptFile = join(tmpDir, `${randomUUID()}.prompt.txt`);
  const prompt = req.readOnly ? READ_ONLY_NOTE + req.prompt : req.prompt;
  writeFileSync(promptFile, prompt, 'utf8');
  try {
    const { args, input, echo } = buildInvocation(id, { ...req, prompt }, promptFile);
    const cmd = launch(id, args);
    const r = await run(cmd.exe, cmd.args, input ?? '', timeoutMs);
    if (r.code !== 0) {
      const tail = stripTerminal(`${r.stderr}\n${r.stdout}`).trim().split(/\r?\n/).slice(-3).join(' ').slice(-300);
      throw new Error(`${EXE[id]} exited ${r.code}: ${tail || 'no output'}`);
    }
    return id === 'openclaw' ? parseOpenClaw(r.stdout) : id === 'hermes' ? parseHermes(r.stdout, r.stderr) : parseCodePuppy(r.stdout, echo);
  } finally {
    rmSync(promptFile, { force: true });
  }
}

// ---- health ------------------------------------------------------------------------------------------------------

export interface HarnessStatus { id: HarnessId; available: boolean; detail: string }
const HEALTH_TTL_MS = 60_000;
let healthCache: { at: number; value: HarnessStatus[] } | null = null;

/** "Is it installed and answering?" Cached: OpenClaw starts slowly and Settings refreshes often. */
export async function harnessHealth(run: CommandFn, now: () => number = Date.now): Promise<HarnessStatus[]> {
  if (healthCache && now() - healthCache.at < HEALTH_TTL_MS) return healthCache.value;
  const value = await Promise.all(HARNESS_IDS.map(async (id): Promise<HarnessStatus> => {
    try {
      const cmd = launch(id, ['--version']);
      const r = await run(cmd.exe, cmd.args, '', 20_000);
      const line = stripTerminal(`${r.stdout}\n${r.stderr}`).split(/\r?\n/).map((l) => l.trim()).find((l) => /\d+\.\d+/.test(l));
      return r.code === 0 ? { id, available: true, detail: line ? line.slice(0, 80) : 'installed' } : { id, available: false, detail: `${EXE[id]} --version failed (exit ${r.code})` };
    } catch (err) {
      return { id, available: false, detail: /ENOENT/.test(String(err)) ? `${EXE[id]} is not installed or not on PATH` : String(err).slice(0, 120) };
    }
  }));
  healthCache = { at: now(), value };
  return value;
}
export const resetHarnessHealth = (): void => { healthCache = null; };
