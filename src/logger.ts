import pino from 'pino';
import { LOG_LEVEL, NODE_ENV, STORE_DIR } from './config.js';
import { logFileFor, rotateIfLarge } from './log-target.js';

// Real env vars win (one-off debugging: `set LOG_LEVEL=debug`), then .env via config.
const level = process.env.LOG_LEVEL ?? LOG_LEVEL;
const file = logFileFor(process.argv[1], STORE_DIR);

function create(): pino.Logger {
  if (file) {
    // The bridge: its own file, written synchronously (the process exits right after answering), with a `proc` tag.
    rotateIfLarge(file);
    return pino({ level, base: { pid: process.pid, proc: 'bridge' } }, pino.destination({ dest: file, sync: true, mkdir: true }));
  }
  return pino({
    level,
    transport: (process.env.NODE_ENV ?? NODE_ENV) !== 'production' ? { target: 'pino-pretty', options: { colorize: !process.env.NO_COLOR } } : undefined,
  });
}

export const logger = create();
