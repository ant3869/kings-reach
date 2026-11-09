// src/media.ts - Telegram file download + Claude context builders.
// Path resolution: fileURLToPath everywhere, never cwd-dependent.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');
export const UPLOADS_DIR = path.join(PROJECT_ROOT, 'workspace', 'uploads');

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 100) || 'file';
}

/** Download a Telegram file to workspace/uploads and return the local path. */
export async function downloadMedia(
  botToken: string,
  fileId: string,
  originalFilename?: string,
): Promise<string> {
  const metaRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  if (!metaRes.ok) throw new Error(`telegram getFile failed: ${metaRes.status}`);
  const meta = (await metaRes.json()) as { ok: boolean; result?: { file_path?: string } };
  const remotePath = meta.result?.file_path;
  if (!remotePath) throw new Error('telegram getFile returned no file_path');

  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${remotePath}`);
  if (!fileRes.ok) throw new Error(`telegram download failed: ${fileRes.status}`);

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const base = sanitizeFilename(originalFilename ?? path.basename(remotePath));
  const localPath = path.join(UPLOADS_DIR, `${Date.now()}_${base}`);
  fs.writeFileSync(localPath, Buffer.from(await fileRes.arrayBuffer()));
  return localPath;
}

export function buildPhotoMessage(localPath: string, caption?: string): string {
  return ['[Photo]', `path: ${localPath}`, caption ? `caption: ${caption}` : '']
    .filter(Boolean)
    .join('\n');
}

export function buildDocumentMessage(localPath: string, filename: string, caption?: string): string {
  return ['[Document]', `file: ${filename}`, `path: ${localPath}`, caption ? `caption: ${caption}` : '']
    .filter(Boolean)
    .join('\n');
}

export function buildVideoMessage(localPath: string, caption?: string): string {
  return [
    '[Video]',
    `path: ${localPath}`,
    'Analyze with the Gemini API (GOOGLE_API_KEY from .env) if frame inspection is needed.',
    caption ? `caption: ${caption}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Delete uploads older than maxAgeMs (default 24h). Called on startup. */
export function cleanupOldUploads(maxAgeMs = 24 * 60 * 60 * 1000): void {
  if (!fs.existsSync(UPLOADS_DIR)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of fs.readdirSync(UPLOADS_DIR)) {
    const full = path.join(UPLOADS_DIR, entry);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true });
    } catch {
      // best effort: one bad file never blocks startup
    }
  }
}
