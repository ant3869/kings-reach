// src/attachments.ts - files the user attaches in the dashboard or the War Room: store them, find them again, and forget them.
// They live in workspace/uploads (like Telegram's) and are addressed by an opaque id, never by a path the browser sent:
// a client can only point an agent at a file this module saved, not at C:\Windows\... or the .env.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Attachment } from './attach-format.js';
import { cleanupOldUploads, sanitizeFilename, UPLOADS_DIR } from './media.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES = 5;
/** <ms>-<6 hex>_<sanitised name>. Charset has no path separator, so an id can never leave the uploads folder. */
export const UPLOAD_ID = /^\d{10,}-[0-9a-f]{6}_[A-Za-z0-9._-]{1,100}$/;

export const displayName = (id: string): string => id.slice(id.indexOf('_') + 1);

export class UploadError extends Error {}

export function storeUpload(bytes: Uint8Array, rawName: string, dir = UPLOADS_DIR): { id: string; name: string; size: number } {
  if (!bytes.length) throw new UploadError('that file is empty');
  if (bytes.length > MAX_FILE_BYTES) throw new UploadError(`file too large (max ${MAX_FILE_BYTES / 2 ** 20} MB)`);
  const id = `${Date.now()}-${randomBytes(3).toString('hex')}_${sanitizeFilename(path.basename(rawName.replace(/\\/g, '/')))}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id), bytes);
  return { id, name: displayName(id), size: bytes.length };
}

export type Resolved = { items: Attachment[] } | { error: string };

/** Turn the ids a client sent into files that really exist. Anything else is refused with a sentence the user can act on. */
export function resolveAttachments(ids: unknown, dir = UPLOADS_DIR): Resolved {
  if (ids == null) return { items: [] };
  if (!Array.isArray(ids)) return { error: 'attachments must be a list of upload ids' };
  if (ids.length > MAX_FILES) return { error: `at most ${MAX_FILES} files per message` };
  const items: Attachment[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !UPLOAD_ID.test(id)) return { error: 'that attachment id is not valid' };
    const full = path.join(dir, id);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      return { error: `${displayName(id)} is no longer available (uploads are kept for 24 hours): attach it again` };
    }
    items.push({ id, name: displayName(id), path: full });
  }
  return { items };
}

/** Remove one upload (the user took the chip off before sending). Returns whether something was deleted. */
export function removeUpload(id: string, dir = UPLOADS_DIR): boolean {
  if (!UPLOAD_ID.test(id)) return false;
  const full = path.join(dir, id);
  if (!fs.existsSync(full)) return false;
  fs.rmSync(full, { force: true });
  return true;
}

let lastSweep = 0;
/** Old uploads are only swept when Telegram starts, and Telegram may not be running: so also sweep (at most hourly) on upload. */
export function sweepOften(now = Date.now()): void {
  if (now - lastSweep < 3_600_000) return;
  lastSweep = now;
  try {
    cleanupOldUploads();
  } catch {
    // best effort: housekeeping never blocks an upload
  }
}
