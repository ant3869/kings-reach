/** Cost footer: 5 display modes. Sparse is better than dense. */

export type CostFooterMode = 'compact' | 'verbose' | 'cost' | 'full' | 'off';

const PRICE_PER_1K: Record<string, { in: number; out: number }> = {
  sonnet: { in: 0.003, out: 0.015 },
  opus: { in: 0.015, out: 0.075 },
  haiku: { in: 0.00025, out: 0.00125 },
  default: { in: 0.003, out: 0.015 },
};

export function shortModelName(model: string): string {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet-4')) return 'sonnet-4';
  if (m.includes('sonnet')) return 'sonnet';
  if (!m) return 'sonnet-4';
  // Strip date suffixes like -20260514 and vendor prefixes.
  return m
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .slice(0, 24);
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(n)));
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const key = shortModelName(model);
  const tier = PRICE_PER_1K[key] ?? PRICE_PER_1K.sonnet ?? PRICE_PER_1K.default;
  const rate = tier ?? { in: 0.003, out: 0.015 };
  return (inputTokens / 1000) * rate.in + (outputTokens / 1000) * rate.out;
}

export function formatCostFooter(
  model: string,
  inputTokens: number,
  outputTokens: number,
  mode: CostFooterMode = 'compact',
): string {
  if (mode === 'off') return '';
  const short = shortModelName(model);
  const cost = estimateCost(model, inputTokens, outputTokens);
  const costStr = `~$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
  switch (mode) {
    case 'compact':
      return `[${short}]`;
    case 'verbose':
      return `[${short} | ${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out]`;
    case 'cost':
      return `[${short} | ${costStr}]`;
    case 'full':
      return `[${short} | ${formatTokens(inputTokens)} in / ${formatTokens(outputTokens)} out | ${costStr}]`;
    default:
      return `[${short}]`;
  }
}

export function parseCostFooterMode(raw: string): CostFooterMode {
  const v = (raw || '').toLowerCase();
  if (v === 'verbose' || v === 'cost' || v === 'full' || v === 'off' || v === 'compact') {
    return v;
  }
  return 'compact';
}
