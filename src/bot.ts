// src/bot.ts - Telegram channel (grammy). Thin glue: security gate ->
// FIFO queue -> memory inject -> agent/delegate -> exfil guard -> reply.
// Heavy lifting lives in agent.ts / orchestrator.ts / memory.ts / voice.ts.

import { Bot, Context, InputFile } from 'grammy';
import fs from 'node:fs';
import {
  ALLOWED_CHAT_ID,
  DEFAULT_AGENT_ID,
  MAX_MESSAGE_LENGTH,
  SHOW_COST_FOOTER,
  TELEGRAM_BOT_TOKEN,
  VOICE_REPLY_DEFAULT,
  effectiveMaxTurns,
} from './config.js';
import { enqueue } from './message-queue.js';
import {
  delegateToAgent,
  getAgentRegistry,
  initOrchestrator,
  parseDelegation,
} from './orchestrator.js';
import { runAgent, signInPrompt } from './agent.js';
import { buildMemoryContext, saveConversationTurn } from './memory.js';
import { formatCostFooter, parseCostFooterMode } from './cost-footer.js';
import { transcribeAudio, synthesizeSpeech } from './voice.js';
import {
  buildDocumentMessage,
  buildPhotoMessage,
  buildVideoMessage,
  cleanupOldUploads,
  downloadMedia,
} from './media.js';
import {
  getMemoryById,
  getSession,
  pinMemory,
  saveStructuredMemoryAtomic,
  setSession,
} from './db.js';
import { logger } from './logger.js';
import { redactSecrets } from './exfil-guard.js';

export interface BotHandle {
  bot: Bot;
  start: () => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/** Exfil guard: every outgoing Telegram text passes through here. Static import = fail-closed. */
async function exfilFilter(text: string): Promise<string> {
  const { text: safe, redactions } = redactSecrets(text);
  if (redactions.length) logger.warn({ redactions }, 'exfil guard redacted outgoing text');
  return safe;
}

/** Chat allowlist gate. Empty ALLOWED_CHAT_ID = deny everyone (only /chatid answers). */
export function isAllowed(chatId: string | number): boolean {
  if (!ALLOWED_CHAT_ID) return false;
  const allow = ALLOWED_CHAT_ID.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allow.includes(String(chatId));
}

function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

async function replyLong(ctx: Context, text: string): Promise<void> {
  for (const part of chunk(text, MAX_MESSAGE_LENGTH)) {
    await ctx.reply(part);
  }
}

function withFooter(text: string, footer: string): string {
  if (!footer) return text;
  const sep = text.endsWith('\n') ? '' : '\n';
  return `${text}${sep}${footer}`;
}

interface TurnResult {
  text: string;
  footer: string;
  sessionId?: string;
  agentId: string;
}

/** One agent turn: memory inject, route (delegate or main), footer, persist. */
async function agentTurn(chatId: string, input: string, tick: () => void): Promise<TurnResult> {
  let memory = '';
  try {
    memory = await buildMemoryContext(chatId, input);
  } catch (err) {
    logger.warn({ err, chatId }, 'memory inject failed (non-fatal)');
  }
  const message = memory ? `${memory}\n\n[user]\n${input}` : input;

  const delegation = parseDelegation(input);
  if (delegation) {
    const res = await delegateToAgent(delegation.agentId, delegation.prompt, chatId, tick);
    const safe = await exfilFilter(res.text);
    try {
      await saveConversationTurn(chatId, input, safe, res.sessionId, res.agentId);
    } catch (err) {
      logger.warn({ err }, 'saveConversationTurn failed (non-fatal)');
    }
    return { text: safe, footer: `[${res.agentId}]`, sessionId: res.sessionId, agentId: res.agentId };
  }

  const agentId = DEFAULT_AGENT_ID || 'main';
  let prev: string | undefined;
  try {
    prev = getSession(chatId, agentId) ?? undefined;
  } catch {
    prev = undefined;
  }
  const raw = await runAgent({
    message,
    agentId,
    sessionId: prev,
    onTyping: tick,
    maxTurns: effectiveMaxTurns(),
  });
  const answer = (raw.text ?? '(empty response)').trim() || '(empty response)';
  const safe = await exfilFilter(answer);
  const mode = parseCostFooterMode(SHOW_COST_FOOTER);
  const footer = formatCostFooter(
    raw.model ?? 'sonnet-4',
    raw.inputTokens ?? 0,
    raw.outputTokens ?? 0,
    mode,
  );
  const nextSession = raw.newSessionId ?? prev;
  try {
    if (nextSession) setSession(chatId, nextSession, agentId);
  } catch (err) {
    logger.warn({ err }, 'setSession failed (non-fatal)');
  }
  try {
    await saveConversationTurn(chatId, input, safe, nextSession, agentId);
  } catch (err) {
    logger.warn({ err }, 'saveConversationTurn failed (non-fatal)');
  }
  return { text: safe, footer, sessionId: nextSession, agentId };
}

async function answerAndReply(ctx: Context, chatId: string, input: string, voiceReply: boolean): Promise<void> {
  const tick = (): void => {
    void ctx.replyWithChatAction('typing').catch(() => undefined);
  };
  tick();
  let res: TurnResult;
  try {
    res = await agentTurn(chatId, input, tick);
  } catch (err) {
    logger.error({ err, chatId }, 'agent turn failed');
    await ctx.reply(signInPrompt(err) ?? `Agent error: ${String(err).slice(0, 500)}`);
    return;
  }
  await replyLong(ctx, withFooter(res.text, res.footer));
  if (voiceReply) {
    try {
      const audio = await synthesizeSpeech(res.text);
      if (audio) await ctx.replyWithVoice(new InputFile(audio, 'reply.mp3'));
    } catch (err) {
      logger.warn({ err }, 'voice reply failed (text already sent)');
    }
  }
}

function deny(ctx: Context): Promise<void> {
  return ctx.reply('Not authorized.').then(() => undefined);
}

const HELP_TEXT = [
  'Commands:',
  '/chatid — show this chat id',
  '/agents — list known agents',
  '/delegate <agent> <task> — hand off to a specialist (@agent: task also works)',
  '/pin <id|text> — pin a memory by id, or save + pin new text',
  '/voice — toggle voice replies for this chat (coming from voice notes by default)',
  '/help — this list',
].join('\n');

const voiceReplyChats = new Set<string>();

export function createBot(): BotHandle {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  initOrchestrator();
  try {
    cleanupOldUploads();
  } catch {
    // best effort
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.command('chatid', async (ctx) => {
    // Always answers: it is how the owner learns the id to put in ALLOWED_CHAT_ID.
    const id = String(ctx.chat?.id ?? '');
    const hint = isAllowed(id) ? '' : '\nNot on the allowlist yet: add it to ALLOWED_CHAT_ID in .env and restart.';
    await ctx.reply(`chat id: ${id}${hint}`);
  });

  bot.command(['start', 'help'], async (ctx) => {
    const id = String(ctx.chat?.id ?? '');
    if (!isAllowed(id)) return deny(ctx);
    await ctx.reply(HELP_TEXT);
  });

  bot.command('agents', async (ctx) => {
    const id = String(ctx.chat?.id ?? '');
    if (!isAllowed(id)) return deny(ctx);
    const known = [...getAgentRegistry().keys()].join(', ') || '(none)';
    await ctx.reply(`agents: ${known}`);
  });

  bot.command('delegate', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '');
    if (!isAllowed(chatId)) return deny(ctx);
    const args = (ctx.match as string ?? '').trim();
    const m = args.match(/^([a-z][a-z0-9_-]{0,29})\s+([\s\S]+)/);
    if (!m || !m[1] || !m[2]) {
      await ctx.reply('Usage: /delegate <agent> <task>');
      return;
    }
    const input = `@${m[1]}: ${m[2].trim()}`;
    await enqueue(chatId, () => answerAndReply(ctx, chatId, input, false));
  });

  bot.command('pin', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '');
    if (!isAllowed(chatId)) return deny(ctx);
    const args = (ctx.match as string ?? '').trim();
    if (!args) {
      await ctx.reply('Usage: /pin <memory id|text to remember>');
      return;
    }
    try {
      if (/^\d+$/.test(args)) {
        const id = Number(args);
        if (!getMemoryById(id)) {
          await ctx.reply(`No memory with id ${id}.`);
          return;
        }
        pinMemory(id);
        await ctx.reply(`Pinned memory ${id}.`);
        return;
      }
      const id = saveStructuredMemoryAtomic({
        chat_id: chatId,
        agent_id: DEFAULT_AGENT_ID || 'main',
        source: 'telegram-pin',
        raw_text: args,
        summary: args.slice(0, 500),
        importance: 0.9,
      });
      pinMemory(id);
      await ctx.reply(`Pinned memory ${id}.`);
    } catch (err) {
      await ctx.reply(`Pin failed: ${String(err).slice(0, 300)}`);
    }
  });

  bot.command('voice', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '');
    if (!isAllowed(chatId)) return deny(ctx);
    if (voiceReplyChats.has(chatId)) {
      voiceReplyChats.delete(chatId);
      await ctx.reply('Voice replies off.');
    } else {
      voiceReplyChats.add(chatId);
      await ctx.reply('Voice replies on.');
    }
  });

  // Text (skip /commands — those have handlers above).
  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '');
    if (!isAllowed(chatId)) return deny(ctx);
    const text = (ctx.message?.text ?? '').trim();
    if (!text || text.startsWith('/')) return;
    const voiceReply = VOICE_REPLY_DEFAULT || voiceReplyChats.has(chatId);
    await enqueue(chatId, () => answerAndReply(ctx, chatId, text, voiceReply));
  });

  async function handleVoice(ctx: Context): Promise<void> {
    const chatId = String(ctx.chat?.id ?? '');
    if (!isAllowed(chatId)) return deny(ctx);
    const fileId =
      ctx.message?.voice?.file_id ?? ctx.message?.audio?.file_id ?? null;
    if (!fileId) {
      await ctx.reply('No audio found in that message.');
      return;
    }
    await enqueue(chatId, async () => {
      await ctx.replyWithChatAction('typing').catch(() => undefined);
      let local = '';
      try {
        local = await downloadMedia(TELEGRAM_BOT_TOKEN, fileId, 'voice.oga');
        const transcript = (await transcribeAudio(local)).trim();
        if (!transcript) {
          await ctx.reply('(could not transcribe that voice note)');
          return;
        }
        await ctx.reply(`Heard: ${transcript.slice(0, 1000)}`);
        await answerAndReply(ctx, chatId, transcript, true);
      } catch (err) {
        logger.error({ err }, 'voice note handling failed');
        await ctx.reply(`Voice handling failed: ${String(err).slice(0, 300)}`);
      } finally {
        if (local) {
          try {
            fs.rmSync(local, { force: true });
          } catch {
            // best effort
          }
        }
      }
    });
  }
  bot.on('message:voice', handleVoice);

  async function handleMedia(ctx: Context, kind: 'photo' | 'document' | 'video'): Promise<void> {
    const chatId = String(ctx.chat?.id ?? '');
    if (!isAllowed(chatId)) return deny(ctx);
    const msg = ctx.message as Record<string, unknown> | undefined;
    let fileId: string | null = null;
    let filename: string | undefined;
    let caption = '';
    if (kind === 'photo') {
      const photos = (msg?.['photo'] as Array<{ file_id?: string }> | undefined) ?? [];
      fileId = photos.at(-1)?.file_id ?? null;
      caption = String((msg?.['caption'] as string | undefined) ?? '');
    } else if (kind === 'document') {
      const doc = msg?.['document'] as { file_id?: string; file_name?: string } | undefined;
      fileId = doc?.file_id ?? null;
      filename = doc?.file_name;
      caption = String((msg?.['caption'] as string | undefined) ?? '');
    } else {
      const vid = msg?.['video'] as { file_id?: string } | undefined;
      fileId = vid?.file_id ?? null;
      caption = String((msg?.['caption'] as string | undefined) ?? '');
    }
    if (!fileId) {
      await ctx.reply('No file found in that message.');
      return;
    }
    const fid: string = fileId;
    await enqueue(chatId, async () => {
      await ctx.replyWithChatAction('typing').catch(() => undefined);
      try {
        const local = await downloadMedia(TELEGRAM_BOT_TOKEN, fid, filename);
        const input =
          kind === 'photo'
            ? buildPhotoMessage(local, caption)
            : kind === 'document'
              ? buildDocumentMessage(local, filename ?? 'file', caption)
              : buildVideoMessage(local, caption);
        await answerAndReply(ctx, chatId, input, false);
      } catch (err) {
        logger.error({ err }, 'media handling failed');
        await ctx.reply(`Media handling failed: ${String(err).slice(0, 300)}`);
      }
    });
  }
  bot.on('message:photo', (ctx) => handleMedia(ctx, 'photo'));
  bot.on('message:document', (ctx) => handleMedia(ctx, 'document'));
  bot.on('message:video', (ctx) => handleMedia(ctx, 'video'));

  bot.catch((err) => {
    logger.error({ err: String(err.error) }, 'grammy error');
  });

  return {
    bot,
    start: async () => {
      logger.info('telegram bot starting (long polling)');
      await bot.start();
    },
    sendMessage: async (chatId: string, text: string) => {
      for (const part of chunk(await exfilFilter(text), MAX_MESSAGE_LENGTH)) {
        await bot.api.sendMessage(chatId, part);
      }
    },
  };
}
