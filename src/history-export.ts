// src/history-export.ts - one run as a single Markdown document, so it can be handed to another agent (or a person) cold.
// Built from the ledger row, the saved plan, the builds that executed it and its deliverables. Secrets are redacted because
// the whole point is that the file leaves the machine. Read-only; user input is only ever a run id, validated by runDetail().

import { redactSecrets } from './exfil-guard.js';
import { defaultPaths, readArtifact, runDetail, type LedgerPaths } from './history.js';

const ARTIFACT_CHARS = 20_000;
// Shown by a dedicated section; every other recorded field is appended as-is so nothing the ledger knows is dropped.
const SHOWN = new Set(['id', 'kind', 'question', 'started', 'outcome', 'stages', 'agents', 'total_s', 'total_cost_usd', 'changed_files', 'gate_output', 'verdict_run']);

const cell = (v: unknown): string => String(v ?? '-').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
const table = (head: string[], rows: unknown[][]): string =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

/** A code fence that cannot be closed by anything inside it. */
export function fence(text: string, lang = ''): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const bar = '`'.repeat(longest + 1);
  return `${bar}${lang}\n${text.replace(/\n$/, '')}\n${bar}`;
}

/** Push every heading one level down (outside code fences) so the report keeps a single top-level title. */
export function demoteHeadings(md: string): string {
  let open: string | null = null;
  return md.split('\n').map((line) => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!open) open = m[1];
      else if (m[1][0] === open[0] && m[1].length >= open.length) open = null;
      return line;
    }
    return !open && /^#{1,5} /.test(line) ? `#${line}` : line;
  }).join('\n');
}

type Json = Record<string, unknown>;
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** Fallback for runs archived without their .md: the plan JSON, in the same order the page shows it. */
function planFromJson(plan: Json): string {
  const steps = Array.isArray(plan.plan) ? (plan.plan as Json[]) : [];
  return [
    `Objective: ${String(plan.objective ?? '')}`,
    plan.verdict ? `\n### Verdict (confidence ${String(plan.confidence ?? 'n/a')})\n${String(plan.verdict)}` : '',
    list(plan.success_criteria).length ? `\n### Success criteria\n${list(plan.success_criteria).map((c) => `- ${c}`).join('\n')}` : '',
    steps.length ? `\n### Plan\n${steps.map((s, i) => `${i + 1}. **${String(s.owner)}**: ${String(s.step)}\n   - Done when: ${String(s.done_when)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export function exportMarkdown(id: string, p: LedgerPaths = defaultPaths(), env?: Record<string, string>):
  { filename: string; markdown: string; redactions: string[] } | null {
  const d = runDetail(id, p);
  if (!d) return null;
  const r = d.run;
  const isBuild = r.kind === 'build';
  const out: string[] = [];
  const add = (...parts: string[]) => out.push(...parts, '');

  add(`# King's Reach report: ${isBuild ? 'build' : 'council'} ${r.id}`,
    `A complete record of one ${isBuild ? 'build' : 'council run'}, exported from King's Reach. Nothing is summarised away: the plan, the outcome, the evidence and the deliverables are below. ` +
    `Paths are relative to the King's Reach repository unless absolute.`);

  const facts: unknown[][] = [['Run', r.id], ['Kind', isBuild ? 'build' : 'council'], ['Outcome', r.outcome], ['Started', r.started],
    ['Duration', `${Math.round(Number(r.total_s ?? 0))} s`], ['Cost', `$${Number(r.total_cost_usd ?? 0).toFixed(2)}`]];
  if (d.rating) facts.push(['Your rating', d.rating === 1 ? 'useful' : 'not useful']);
  if (isBuild) {
    facts.push(['Automated checks', r.checks_ok ? 'passed' : 'failed'], ['Review', r.review_status ?? 'n/a'], ['Approved', r.approved ?? 'n/a'],
      ['Criteria met', r.criteria_met ?? 'n/a'], ['Core rebooted', r.rebooted ? 'yes' : 'no'], ['Executed plan', d.planId ?? 'unknown']);
  } else {
    facts.push(['Verdict confidence', r.verdict_confidence ?? 'n/a'], ['Plan steps', r.plan_steps ?? 'n/a'], ['Specialists', list(r.specialists).join(', ') || 'n/a'], ['Memories recalled', r.memory_lines_used ?? 0]);
  }
  add('## Run', table(['Field', 'Value'], facts));
  if (r.failure_summary) add('### Why it did not complete', String(r.failure_summary));

  add('## Question', String(r.question ?? d.plan?.question ?? ''));

  if (isBuild) {
    const files = list(r.changed_files);
    add(`## Changed files (${files.length})`, files.length ? files.map((f) => `- ${f}`).join('\n') : 'No files changed.');
    if (r.gate_output) add('## Automated check output', fence(String(r.gate_output)));
  } else if (d.builds.length) {
    add('## Builds that executed this plan', table(['Build', 'Outcome', 'Files', 'Criteria', 'Cost', 'Started'],
      d.builds.map((b) => [b.id, b.outcome, b.changedFiles, b.criteriaMet ?? 'n/a', `$${b.costUsd.toFixed(2)}`, b.started])));
  }

  const title = isBuild ? `The plan this build executed (run ${d.planId ?? 'unknown'})` : 'The plan';
  if (d.planMarkdown) add(`## ${title}`, demoteHeadings(d.planMarkdown));
  else if (d.plan) add(`## ${title}`, planFromJson(d.plan));
  else add(`## ${title}`, isBuild ? 'The plan this build executed could not be identified.' : `No plan was locked for this run (outcome: ${r.outcome}).`);

  const stages = Object.entries((r.stages ?? {}) as Record<string, number>);
  if (stages.length) add('## Stage timings', table(['Stage', 'Seconds'], stages));
  const agents = Object.entries((r.agents ?? {}) as Record<string, Json>);
  if (agents.length) {
    add('## Who did the work', table(['Agent', 'Cost', 'Turns', 'Seconds', 'Calls', 'Models'],
      agents.map(([name, a]) => [name, `$${Number(a.cost_usd ?? 0).toFixed(2)}`, a.turns, a.seconds, a.calls, list(a.models).join(', ')])));
  }

  for (const { name } of d.artifacts) {
    const text = d.planId ? readArtifact(d.planId, name, p) : null;
    if (text === null) continue;
    const cut = text.length > ARTIFACT_CHARS;
    add(`## Deliverable: ${name}`, fence(cut ? text.slice(0, ARTIFACT_CHARS) : text),
      ...(cut ? [`_Cut at ${ARTIFACT_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters. Full file: workspace/council/${d.planId}/${name}_`] : []));
  }

  const rest = Object.fromEntries(Object.entries(r).filter(([k]) => !SHOWN.has(k)));
  if (Object.keys(rest).length) add('## Other recorded fields', 'Everything else the ledger stored for this run, unedited.', fence(JSON.stringify(rest, null, 2), 'json'));

  const { text, redactions } = redactSecrets(out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n', env);
  return {
    filename: `kings-reach-${isBuild ? 'build' : 'council'}-${r.id}.md`,
    markdown: redactions.length ? `${text}\n_${redactions.length} secret-looking value type(s) were redacted from this export._\n` : text,
    redactions,
  };
}
