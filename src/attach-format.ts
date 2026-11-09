// src/attach-format.ts - how attached files are shown to an agent. Pure (no fs): the difficulty scorer needs it too.
// warroom/attachments.py builds the SAME text for the War Room; tests on both sides pin the exact wording, so they cannot drift.

export interface Attachment {
  id: string;
  name: string;
  path: string;
}

export const ATTACH_OPEN =
  '[Attached files: the user attached these. Open each with your file tools (images and PDFs too) before you answer.]';
export const ATTACH_CLOSE = '[end of attached files]';

/** The text appended to a message so the agent knows where its files are. Empty when nothing is attached. */
export function attachmentBlock(items: readonly Attachment[]): string {
  if (!items.length) return '';
  return ['', '', ATTACH_OPEN, ...items.map((a) => `- ${a.name}: ${a.path}`), ATTACH_CLOSE].join('\n');
}

const BLOCK = /\n*\[Attached files:[^\]]*\][\s\S]*?\[end of attached files\]/g;

export function hasAttachments(message: string): boolean {
  return message.includes(ATTACH_OPEN);
}

/** The user's words without the file list: paths are not part of how hard the question is. */
export function withoutAttachments(message: string): string {
  return message.replace(BLOCK, '');
}
