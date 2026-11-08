// src/model-rank.ts - put a provider's models in weakest -> strongest order, from nothing but their names.
// Generation first, size within a generation: claude-sonnet-4-6 < claude-opus-4-6 < claude-sonnet-5 < claude-opus-5-5.
// It is a heuristic and says so: a name with no version number cannot be ranked, so it is simply left out of ladders
// (the user can still route to it normally). Pure, so the ordering is easy to test and to argue with.

/** First match wins, so "flash-lite" counts as lite. Weights stay below 10: size never outranks a whole minor version. */
const SIZE: [RegExp, number][] = [
  [/(^|[^a-z])(nano|lite|mini)([^a-z]|$)/, -3],
  [/(^|[^a-z])(haiku|flash|small)([^a-z]|$)/, -2],
  [/(^|[^a-z])spark([^a-z]|$)/, -1],
  [/(^|[^a-z])(max|ultra|heavy)([^a-z]|$)/, 2],
  [/(^|[^a-z])(opus|pro|large)([^a-z]|$)/, 1],
];

/** Models that do not answer text prompts (image, speech, embeddings...) must never land on a chat ladder. */
const NOT_CHAT = /(^|[^a-z])(image|voice|transcribe|speech|tts|whisper|audio|video|embed\w*|rerank\w*)([^a-z]|$)/;

/** Higher = stronger. null when the name carries no version number, or the model is not a text-chat model. */
export function modelRank(id: string): number | null {
  const name = id.toLowerCase();
  if (NOT_CHAT.test(name)) return null;
  // First "major" or "major.minor" / "major-minor" (minor at most two digits, so "235b" is not read as a minor version).
  const m = name.match(/(\d+)(?:[.-](\d{1,2})(?!\d))?/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  const size = SIZE.find(([re]) => re.test(name))?.[1] ?? 0;
  return major * 1000 + minor * 10 + size;
}

/** The rankable models, weakest first. Equal ranks keep a stable, alphabetical order. */
export function rankModels(ids: string[]): string[] {
  const ranked = [...new Set(ids)]
    .map((id) => ({ id, rank: modelRank(id) }))
    .filter((m): m is { id: string; rank: number } => m.rank !== null);
  return ranked.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id)).map((m) => m.id);
}

/** Everything from `low` to `high` inclusive on a ranked list (either end may be passed first). Empty if either is unranked. */
export function modelRange(ranked: string[], low: string, high: string): string[] {
  const a = ranked.indexOf(low), b = ranked.indexOf(high);
  if (a < 0 || b < 0) return [];
  return ranked.slice(Math.min(a, b), Math.max(a, b) + 1);
}
