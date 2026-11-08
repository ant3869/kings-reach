// scripts/difficulty-calibrate.mjs - fit and check the prompt-difficulty model against work that really happened.
//
//   npm run build && node scripts/difficulty-calibrate.mjs [--write] [--show] [--dir <claude projects dir>]
//
// Ground truth is measured, not guessed: every prompt in your Claude session transcripts (~/.claude/projects/*claudeclaw*)
// is paired with the work the model then did before the next prompt (distinct model turns, tool calls, MCP tool calls,
// output tokens). We fit ln(1 + turns + tool calls) on the features in src/difficulty.ts (ridge regression), report how
// well that generalises to prompts it never saw (cross-validation), and how safe the quick-answer `light` mode is
// (how often a prompt that would run without MCP servers really used one).
//   --write  regenerates src/difficulty-model.ts (weights + level anchors) from the fit. Rebuild afterwards.
//   --show   adds short snippets of the worst misses. Only aggregates are printed otherwise; nothing leaves this machine.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assessDifficulty, features, predictEffort, userText } from '../dist/difficulty.js';
import { MODEL } from '../dist/difficulty-model.js';

const NOISE = /^(<command-|<local-command|Caveat:|\[Request interrupted|<system-reminder|<task-notification|This session is being continued)/;
const FEATURES = Object.keys(MODEL.weights);
// Council seats and questions always arrive with a known pipeline stage (see STAGE_LEVEL), so they never use the text heuristic.
const COUNCIL = /^(\[Council question\]|You are (Main|Research|Comms|Content|Ops)\b)/;
const LAMBDA = 20; // ridge strength: held-out accuracy was flat from 5 to 20 and fell off by 60 (162 prompts)

/** The text of a real human prompt, or null for tool results, commands, and harness chatter. */
function promptText(rec) {
  if (rec.type !== 'user' || rec.isMeta || rec.isSidechain) return null;
  const c = rec.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) && !c.some((p) => p.type === 'tool_result') ? c.filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '';
  const t = userText(text).trim();
  return t && !NOISE.test(t) ? t : null;
}

/** Walk one transcript: [{ text, turns, tools, mcpTools, outTokens }] */
function sessionPrompts(file) {
  const out = [];
  let cur = null;
  const seen = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const text = promptText(rec);
    if (text) { cur = { text, turns: 0, tools: 0, mcpTools: 0, outTokens: 0 }; out.push(cur); seen.clear(); continue; }
    if (!cur || rec.type !== 'assistant' || rec.isSidechain) continue;
    const msg = rec.message ?? {};
    for (const part of Array.isArray(msg.content) ? msg.content : []) {
      if (part.type !== 'tool_use') continue;
      cur.tools += 1;
      if (String(part.name).startsWith('mcp__')) cur.mcpTools += 1;
    }
    if (msg.id && !seen.has(msg.id)) { seen.add(msg.id); cur.turns += 1; cur.outTokens += msg.usage?.output_tokens ?? 0; }
  }
  return out;
}

export function load(root = join(homedir(), '.claude', 'projects')) {
  const rows = [];
  for (const dir of readdirSync(root).filter((d) => /claudeclaw|kings/i.test(d))) {
    for (const f of readdirSync(join(root, dir)).filter((n) => n.endsWith('.jsonl'))) {
      const file = join(root, dir, f);
      if (statSync(file).isFile()) for (const p of sessionPrompts(file)) if (p.turns > 0) rows.push({ ...p, council: COUNCIL.test(p.text) });
    }
  }
  return rows;
}

// --- statistics ---------------------------------------------------------------------------------------------
const ranks = (xs) => {
  const order = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2 + 1; // ties share their average rank
    i = j + 1;
  }
  return r;
};
const pearson = (a, b) => {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
};
const spearman = (a, b) => pearson(ranks(a), ranks(b));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const mean = (xs) => xs.reduce((s, v) => s + v, 0) / (xs.length || 1);

/** Solve M x = v by Gaussian elimination with partial pivoting. */
function solve(M, v) {
  const n = v.length, A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !A[c][c]) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => (row[i] ? row[n] / row[i] : 0));
}

/** Ridge regression on standardised features; returns weights and intercept in the features' own units. */
function fitRidge(X, y, lambda = LAMBDA) {
  const n = X.length, k = X[0].length;
  const mu = Array.from({ length: k }, (_, j) => mean(X.map((r) => r[j])));
  const sd = Array.from({ length: k }, (_, j) => Math.sqrt(mean(X.map((r) => (r[j] - mu[j]) ** 2))) || 1);
  const Z = X.map((r) => r.map((v, j) => (v - mu[j]) / sd[j]));
  const my = mean(y);
  const M = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? lambda : 0)));
  const v = Array.from({ length: k }, (_, i) => Z.reduce((s, r, t) => s + r[i] * (y[t] - my), 0));
  const w = solve(M, v);
  const weights = w.map((wi, j) => wi / sd[j]);
  return { weights, intercept: my - weights.reduce((s, wj, j) => s + wj * mu[j], 0) };
}

/**
 * Ridge fit with non-negative weights: a harder-looking prompt must never be predicted to need LESS work. A feature whose
 * best weight is negative has no independent signal here (it is collinear with another), so it is dropped and the rest refit.
 */
function fitNonNegative(X, y) {
  let active = X[0].map((_, j) => j);
  for (;;) {
    const m = fitRidge(X.map((r) => active.map((j) => r[j])), y);
    const worst = m.weights.reduce((w, v, i) => (v < m.weights[w] ? i : w), 0);
    if (m.weights[worst] >= 0 || active.length === 1) {
      const weights = X[0].map(() => 0);
      active.forEach((j, i) => { weights[j] = Math.max(0, m.weights[i]); });
      return { weights, intercept: m.intercept };
    }
    active = active.filter((_, i) => i !== worst);
  }
}

/** Deterministic shuffle so a cross-validation number can be reproduced. */
function shuffled(n, seed) {
  let s = (seed * 2654435761 + 12345) >>> 0;
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; const j = s % (i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx;
}

/** Spearman correlation with real effort on prompts each fit never saw (5-fold, averaged over several shuffles), over everything and over `focus` only. */
function crossValidate(X, y, effort, focus, seeds = 8, folds = 5) {
  const scores = [], focused = [];
  for (let s = 1; s <= seeds; s++) {
    const idx = shuffled(X.length, s), pred = new Array(X.length);
    for (let f = 0; f < folds; f++) {
      const test = idx.filter((_, i) => i % folds === f), train = idx.filter((_, i) => i % folds !== f);
      const m = fitNonNegative(train.map((i) => X[i]), train.map((i) => y[i]));
      for (const i of test) pred[i] = m.intercept + m.weights.reduce((sum, w, j) => sum + w * X[i][j], 0);
    }
    scores.push(spearman(pred, effort));
    if (focus.length >= 20) focused.push(spearman(focus.map((i) => pred[i]), focus.map((i) => effort[i])));
  }
  return { all: mean(scores), focus: focused.length ? mean(focused) : null };
}

/** Anchors that make `level` the share of calibration prompts that were predicted to be easier. */
function levelAnchors(predictions) {
  const sorted = [...predictions].sort((a, b) => a - b), anchors = [];
  for (let p = 0; p <= 100; p += 10) {
    const x = sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))];
    if (!anchors.length || x > anchors[anchors.length - 1][0]) anchors.push([Number(x.toFixed(4)), p / 100]);
    else anchors[anchors.length - 1][1] = p / 100; // a run of identical predictions: the top of the run wins
  }
  return anchors;
}

function modelSource(fit, n, cv, anchors) {
  const w = Object.fromEntries(FEATURES.map((k, j) => [k, Number(fit.weights[j].toFixed(4))]));
  return `// src/difficulty-model.ts - GENERATED by \`node scripts/difficulty-calibrate.mjs --write\`. Do not edit by hand.
// A ridge regression of how much work real prompts caused (ln(1 + model turns + tool calls)) on a few measurable features
// of the prompt, plus the anchors that turn that predicted effort into a 0..1 level (the level is the share of the
// calibration prompts that were easier). Refit whenever your usage changes; the tool prints how well it generalises.

export const MODEL = {
  fittedOn: ${n},
  /** Rank correlation with real effort on prompts the fit had NOT seen (5-fold cross-validation). */
  cvSpearman: ${cv.toFixed(3)},
  intercept: ${Number(fit.intercept.toFixed(4))},
  weights: ${JSON.stringify(w).replace(/"/g, '').replace(/:/g, ': ').replace(/,/g, ', ').replace('{', '{ ').replace('}', ' }')},
  /** [predicted effort, level] pairs, ascending. Between anchors the level is interpolated; outside them it is clamped. */
  anchors: ${JSON.stringify(anchors).replace(/\],\[/g, '], [')} as [number, number][],
};
`;
}

// --- report -------------------------------------------------------------------------------------------------
const args = process.argv.slice(2);
if (process.argv[1]?.endsWith('difficulty-calibrate.mjs')) {
  const root = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : undefined;
  const rows = load(root);
  const free = rows.map((r, i) => (r.council ? -1 : i)).filter((i) => i >= 0); // the prompts the text heuristic really serves
  console.log(`${rows.length} prompts that got a model response; ${free.length} are free-form (the other ${rows.length - free.length} are council-stage prompts, which always arrive with a known stage)`);
  if (rows.length < 60) { console.log('Too few prompts for a trustworthy calibration (need 60+).'); process.exit(0); }

  const X = rows.map((r) => FEATURES.map((k) => features(r.text)[k]));
  const effort = rows.map((r) => r.turns + r.tools);
  const y = effort.map((e) => Math.log1p(e));
  const { all: cv, focus: cvFree } = crossValidate(X, y, effort, free);
  const fit = fitNonNegative(X, y);
  const fitted = X.map((r) => fit.intercept + fit.weights.reduce((s, w, j) => s + w * r[j], 0));
  console.log(`\nA fresh fit generalises to prompts it never saw with rank correlation ${cv.toFixed(3)} (1 = perfect, 0 = no signal).`);
  if (cvFree !== null) console.log(`  ...and ${cvFree.toFixed(3)} on the ${free.length} free-form prompts alone (the real use of this heuristic).`);
  else console.log(`  (fewer than 20 free-form prompts, so no separate free-form figure; gather more usage before trusting it for chat.)`);
  console.log(`Weights: ${FEATURES.map((k, j) => `${k} ${fit.weights[j].toFixed(3)}`).join(', ')}, intercept ${fit.intercept.toFixed(3)}`);
  const dropped = FEATURES.filter((_, j) => fit.weights[j] === 0);
  if (dropped.length) console.log(`No independent signal in this data (weight 0): ${dropped.join(', ')}`);

  if (args.includes('--write')) {
    writeFileSync(new URL('../src/difficulty-model.ts', import.meta.url), modelSource(fit, rows.length, cv, levelAnchors(fitted)));
    console.log('\nWrote src/difficulty-model.ts. Run `npm run build` and re-run this tool to see the live model.');
    process.exit(0);
  }

  const live = rows.map((r) => ({ ...r, a: assessDifficulty(r.text) }));
  const served = free.map((i) => live[i]); // council prompts always carry a stage, so only these meet the text heuristic
  console.log(`\nLIVE model (fitted on ${MODEL.fittedOn} prompts), rank correlation with measured effort:`);
  for (const [name, key] of [['model turns', 'turns'], ['tool calls', 'tools'], ['output tokens', 'outTokens']]) {
    console.log(`  ${name.padEnd(14)} ${spearman(live.map((r) => predictEffort(features(r.text))), rows.map((r) => r[key])).toFixed(3)}`);
  }
  console.log(`\nBy assigned tier, free-form prompts only (n=${served.length}; median measured effort, which should rise low -> mid -> high):`);
  for (const tier of ['low', 'mid', 'high']) {
    const g = served.filter((r) => r.a.tier === tier);
    console.log(`  ${tier.padEnd(5)} n=${String(g.length).padStart(4)} (${served.length ? Math.round((100 * g.length) / served.length) : 0}%)  turns ${String(median(g.map((r) => r.turns))).padStart(3)}  tools ${String(median(g.map((r) => r.tools))).padStart(3)}  outTok ${String(median(g.map((r) => r.outTokens))).padStart(6)}`);
  }
  const levels = served.map((r) => r.a.level);
  console.log(`\nLevel spread across your free-form prompts: ${[0.1, 0.25, 0.5, 0.75, 0.9].map((p) => `p${p * 100}=${[...levels].sort((a, b) => a - b)[Math.floor(p * (levels.length - 1))].toFixed(2)}`).join('  ')}  (an even spread uses the whole ladder)`);

  const lightRuns = live.filter((r) => r.a.light);
  const lostMcp = lightRuns.filter((r) => r.mcpTools > 0);
  console.log(`\nLight mode safety: ${lightRuns.length} of ${live.length} prompts would run without MCP servers; ${lostMcp.length} of those really used an MCP tool (${lightRuns.length ? Math.round((100 * lostMcp.length) / lightRuns.length) : 0}%).`);
  const freeLight = served.filter((r) => r.a.light);
  console.log(`  Free-form only: ${freeLight.length} would run light; ${freeLight.filter((r) => r.mcpTools > 0).length} of those really used an MCP tool.`);
  const heavy = Math.max(8, median(rows.map((r) => r.turns)) * 2);
  const lowButHeavy = served.filter((r) => r.a.tier === 'low' && r.turns >= heavy);
  const highButLight = served.filter((r) => r.a.tier === 'high' && r.turns <= 2);
  console.log(`Worst misses: ${lowButHeavy.length} rated LOW that took ${heavy}+ turns; ${highButLight.length} rated HIGH that took 2 turns or fewer.`);
  if (args.includes('--show')) {
    for (const [title, list] of [['LOW but heavy', lowButHeavy], ['HIGH but light', highButLight], ['LIGHT but used MCP', lostMcp]]) {
      console.log(`\n${title}:`);
      for (const r of list.slice(0, 8)) console.log(`  [${r.a.tier} ~${r.a.score}, ${r.turns} turns, ${r.mcpTools} mcp] ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  }
}
