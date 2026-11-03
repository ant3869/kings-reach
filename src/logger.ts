import pino from 'pino';
import { LOG_LEVEL, NODE_ENV } from './config.js';

// Real env vars win (one-off debugging: `set LOG_LEVEL=debug`), then .env via config.
export const logger = pino({
  level: process.env.LOG_LEVEL ?? LOG_LEVEL,
  transport:
    (process.env.NODE_ENV ?? NODE_ENV) !== 'production'
      ? { target: 'pino-pretty', options: { colorize: !process.env.NO_COLOR } }
      : undefined,
});
