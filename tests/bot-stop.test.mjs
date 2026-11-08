// tests/bot-stop.test.mjs
// Telegram /stop, end to end through the real bot (grammY) with a fake Telegram API. The agent runner, memory, database,
// orchestrator, voice and media are faked at their module edges; the run registry and the per-chat queue are the real ones.
// Telegram can't be exercised live here (the bot refuses every chat until ALLOWED_CHAT_ID is set), so this is the coverage.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (f) => pathToFileURL(resolve('dist', f)).href;
const OWNER = 42, STRANGER = 99;

const realConfig = await import(dist('config.js'));
const control = await import(dist('run-control.js'));

const agentRuns = [];
mock.module(dist('config.js'), { namedExports: { ...realConfig, TELEGRAM_BOT_TOKEN: '123:TEST', ALLOWED_CHAT_ID: String(OWNER) } });
mock.module(dist('agent.js'), {
  namedExports: {
    signInPrompt: () => undefined,
    // Registers like the real runAgent and then waits until it is cancelled (or released by the test).
    runAgent: async (opts) => {
      const run = control.startRun({ agentId: 'main', chatId: opts.chatId });
      agentRuns.push({ message: opts.message, chatId: opts.chatId });
      try {
        await new Promise((_, reject) => run.signal.addEventListener('abort', () => reject(new control.RunCancelled()), { once: true }));
      } finally { run.finish(); }
    },
  },
});
mock.module(dist('orchestrator.js'), { namedExports: { delegateToAgent: async () => ({}), getAgentRegistry: () => new Map(), initOrchestrator: () => {}, parseDelegation: () => null } });
mock.module(dist('memory.js'), { namedExports: { buildMemoryContext: async () => '', saveConversationTurn: async () => {} } });
mock.module(dist('db.js'), { namedExports: { getMemoryById: () => null, getSession: () => null, pinMemory: () => {}, saveStructuredMemoryAtomic: () => 0, setSession: () => {} } });
mock.module(dist('voice.js'), { namedExports: { transcribeAudio: async () => '', synthesizeSpeech: async () => null } });
mock.module(dist('media.js'), {
  namedExports: { buildDocumentMessage: () => '', buildPhotoMessage: () => '', buildVideoMessage: () => '', cleanupOldUploads: () => {}, downloadMedia: async () => '' },
});

const { createBot } = await import(dist('bot.js'));
const { bot } = createBot();
bot.botInfo = { id: 1, is_bot: true, first_name: 'kr', username: 'kr_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };

const sent = []; // what the bot said, per chat
bot.api.config.use(async (_prev, method, payload) => {
  if (method === 'sendMessage') {
    sent.push({ chat: Number(payload.chat_id), text: String(payload.text) });
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: Number(payload.chat_id), type: 'private' }, text: String(payload.text) } };
  }
  return { ok: true, result: true };
});

let updateId = 0;
const say = (chat, text) => bot.handleUpdate({
  update_id: ++updateId,
  message: {
    message_id: updateId, date: 0, chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false, first_name: 't' }, text,
    ...(text.startsWith('/') ? { entities: [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }] } : {}),
  },
});
const until = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 10)); } };
const said = (chat) => sent.filter((s) => s.chat === chat).map((s) => s.text);
const reset = () => { sent.length = 0; agentRuns.length = 0; };

test('/stop cancels the run in progress, clears what is queued behind it, and says so', async () => {
  reset();
  await say(OWNER, 'long job'); // must return at once: a blocked update loop could never receive /stop
  await until(() => control.activeRuns().length === 1);
  await say(OWNER, 'second message'); // waits behind the first
  await say(OWNER, 'third message');
  assert.equal(agentRuns.length, 1, 'only the first message is running; the others are queued');

  await say(OWNER, '/stop');
  await until(() => said(OWNER).some((t) => t.startsWith('Stopped')));
  assert.equal(said(OWNER).find((t) => t.startsWith('Stopped')), 'Stopped the run in progress and cleared 2 queued messages.');
  await until(() => control.activeRuns().length === 0);
  await new Promise((r) => setTimeout(r, 100)); // anything wrongly left in the queue would start now
  assert.equal(agentRuns.length, 1, 'the cleared messages never ran');
  assert.deepEqual(said(OWNER).filter((t) => /error|failed/i.test(t)), [], 'a cancel is not reported as an agent error');
});

test('/stop with nothing running says so; one queued message alone is reported in the singular', async () => {
  reset();
  await say(OWNER, '/stop');
  await until(() => said(OWNER).length === 1);
  assert.deepEqual(said(OWNER), ['Nothing is running.']);

  reset();
  await say(OWNER, 'job');
  await until(() => control.activeRuns().length === 1);
  await say(OWNER, 'next');
  await say(OWNER, '/stop');
  await until(() => said(OWNER).some((t) => t.startsWith('Stopped')));
  assert.match(said(OWNER).find((t) => t.startsWith('Stopped')), /cleared 1 queued message\.$/);
  await until(() => control.activeRuns().length === 0);
});

test("/stop from a chat that is not allowed is refused and cannot stop the owner's run", async () => {
  reset();
  await say(OWNER, 'job');
  await until(() => control.activeRuns().length === 1);
  await say(STRANGER, '/stop');
  await until(() => said(STRANGER).length === 1);
  assert.deepEqual(said(STRANGER), ['Not authorized.']);
  assert.equal(control.activeRuns().length, 1, "the owner's run is untouched");
  await say(OWNER, '/stop');
  await until(() => control.activeRuns().length === 0);
});

test('/help lists /stop', async () => {
  reset();
  await say(OWNER, '/help');
  await until(() => said(OWNER).length === 1);
  assert.match(said(OWNER)[0], /\/stop — cancel the run in progress/);
});
