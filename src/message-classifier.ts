/** Simple vs complex routing. Opt-in, cheap, obvious. */

export type MessageComplexity = 'simple' | 'complex';

const SIMPLE_EXACT = new Set([
  'ok',
  'okay',
  'k',
  'yes',
  'no',
  'yep',
  'nope',
  'thanks',
  'thank you',
  'thx',
  'got it',
  'gotit',
  'sure',
  'fine',
  'cool',
  'great',
  'perfect',
  'hi',
  'hello',
  'hey',
  'bye',
]);

const EMOJI_ONLY = /^[\p{Emoji}\p{Extended_Pictographic}\s]+$/u;

export function classifyMessage(text: string): MessageComplexity {
  const t = (text || '').trim();
  if (!t) return 'simple';
  if (t.length <= 2) return 'simple';
  if (SIMPLE_EXACT.has(t.toLowerCase())) return 'simple';
  if (EMOJI_ONLY.test(t)) return 'simple';
  if (t.startsWith('/') && t.length < 20) return 'simple';
  return 'complex';
}
