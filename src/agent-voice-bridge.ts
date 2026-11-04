// src/agent-voice-bridge.ts - the war room's door into the Node side (agents, memory, hive mind).
// Called by warroom/agent_bridge.py. Request: ONE JSON object on stdin. Reply: ONE JSON line.
//
//   {op:'ask', agent, prompt, system?, chatId?, resume?, readOnly?, maxTurns?, schema?, memoryQuery?}
//       -> {ok, text, data, costUsd, numTurns, durationMs, model, memoryUsed}
//   {op:'recall', chatId, query}                    -> {ok, context}
//   {op:'record', chatId, question?, answer?, agent?, hive?: [{agent, action, summary, meta?}]}
//       -> {ok, memories}   (awaits ingestion: a short-lived CLI must not drop it)
//
// By hand / from an agent's Bash tool:
//   node dist/agent-voice-bridge.js main "say hi"            (op ask)
//   node dist/agent-voice-bridge.js --recall "auth bug"       (memory + hive mind, plain text)

import fs from 'node:fs';
import { getAgentConfig } from './agent-config.js';
import { ProviderRoutesError, runAgent, wastedCost } from './agent.js';
import { getDb, getSession, initDatabase, logConversation, logToHiveMind, openReadOnly, setSession } from './db.js';
import { providerHasTools } from './provider-config.js';
import type { Activity } from './activity.js';
import { buildMemoryContext } from './memory.js';
import { ingestConversationTurn } from './memory-ingest.js';

interface HiveEntry {
  agent: string;
  action: string;
  summary: string;
  meta?: unknown;
}

interface BridgeRequest {
  op?: 'ask' | 'recall' | 'record';
  agent?: string;
  prompt?: string;
  system?: string;
  chatId?: string;
  resume?: boolean;
  readOnly?: boolean;
  tools?: 'required' | 'preferred' | 'none';
  maxTurns?: number;
  schema?: Record<string, unknown>;
  /** Stream `{event:'activity',...}` lines on stdout while the agent works; the final reply is still the last line. */
  activity?: boolean;
  memoryQuery?: string;
  query?: string;
  question?: string;
  answer?: string;
  hive?: HiveEntry[];
}

type Reply = Record<string, unknown> & { ok: boolean };

function readRequest(): BridgeRequest {
  const argv = process.argv.slice(2);
  if (argv[0] === '--recall') return { op: 'recall', query: argv.slice(1).join(' '), chatId: 'warroom' };
  if (argv[0] && argv[0] !== '-') return { op: 'ask', agent: argv[0], prompt: argv[1] ?? '' };
  return JSON.parse(fs.readFileSync(0, 'utf8')) as BridgeRequest;
}

function memoryCount(): number {
  return (getDb().prepare('SELECT COUNT(*) n FROM memories').get() as { n: number }).n;
}

/** One line of live progress. Never throws: a broken pipe must not kill the agent it is describing. */
function emitActivity(a: Activity): void {
  try { process.stdout.write(`${JSON.stringify({ event: 'activity', ...a })}\n`); } catch { /* observer is gone */ }
}

async function ask(req: BridgeRequest): Promise<Reply> {
  const agentId = req.agent ?? 'main';
  if (!getAgentConfig(agentId)) return { ok: false, text: `Unknown agent: ${agentId}` };
  const chatId = req.chatId ?? 'warroom';
  let memory = '';
  if (req.memoryQuery) memory = await buildMemoryContext(chatId, req.memoryQuery).catch(() => '');
  const sessionId = req.resume ? (getSession(chatId, agentId) ?? undefined) : undefined;
  let r;
  try {
    r = await runAgent({
      message: memory ? `${memory}\n\n${req.prompt ?? ''}` : (req.prompt ?? ''),
      agentId, sessionId, chatId, systemPrompt: req.system || undefined,
      readOnly: req.readOnly, toolNeed: req.tools, maxTurns: req.maxTurns, schema: req.schema,
      onActivity: req.activity ? emitActivity : undefined,
    });
  } catch (err) {
    if (err instanceof ProviderRoutesError) {
      return { ok: false, text: `all provider routes failed for ${agentId}`, attempts: err.attempts, costUsd: wastedCost(err.attempts) };
    }
    throw err;
  }
  if (req.resume && r.newSessionId) setSession(chatId, r.newSessionId, agentId);
  const ok = !r.error && (Boolean(r.text) || r.structured !== undefined);
  return {
    ok,
    text: ok ? (r.text ?? '') : `agent ${agentId} failed (${r.error ?? 'no result'})${r.text ? `: ${r.text}` : ''}`,
    data: r.structured ?? null,
    costUsd: r.costUsd ?? 0,
    inputTokens: r.inputTokens ?? null,
    outputTokens: r.outputTokens ?? null,
    numTurns: r.numTurns ?? 0,
    durationMs: r.durationMs ?? 0,
    model: r.model ?? '',
    provider: r.provider ?? '',
    hasTools: r.provider ? providerHasTools(r.provider) : false,
    attempts: r.attempts ?? [],
    memoryUsed: memory ? memory.split('\n').length - 1 : 0,
  };
}

async function record(req: BridgeRequest): Promise<Reply> {
  const chatId = req.chatId ?? 'warroom';
  for (const h of req.hive ?? []) {
    if (h.agent && h.action && h.summary) logToHiveMind(h.agent, h.action, h.summary.slice(0, 1000), h.meta);
  }
  const before = memoryCount();
  if (req.question && req.answer) {
    const agentId = req.agent ?? 'main';
    logConversation(chatId, 'user', req.question, agentId);
    logConversation(chatId, 'assistant', req.answer, agentId);
    await ingestConversationTurn(chatId, 'user', req.question, undefined, agentId);
    await ingestConversationTurn(chatId, 'assistant', req.answer, undefined, agentId);
  }
  return { ok: true, memories: memoryCount() - before, hive: (req.hive ?? []).length };
}

async function main(): Promise<void> {
  const req = readRequest();
  try {
    initDatabase();
  } catch (err) {
    // A sandboxed agent (e.g. codex) may run `--recall` where the DB is not writable. Recall only reads, so degrade to that.
    if (req.op !== 'recall') throw err;
    openReadOnly();
  }
  let reply: Reply;
  if (req.op === 'recall') {
    const context = await buildMemoryContext(req.chatId ?? 'warroom', req.query ?? '');
    if (process.argv[2] === '--recall') {
      console.log(context || '(no relevant memory)'); // human/agent readable
      return;
    }
    reply = { ok: true, context };
  }
  else if (req.op === 'record') reply = await record(req);
  else reply = await ask(req);
  console.log(JSON.stringify(reply));
}

main().catch((err) => {
  console.log(JSON.stringify({ ok: false, text: `Bridge error: ${String(err).slice(0, 400)}` }));
  process.exit(0); // stdout JSON contract: never crash the Python caller
});
