// public/history-plans.js - Plan Library: revisions of a question, side-by-side compare, and the plan of record.
// Loaded BEFORE history-app.js, which owns the page. These functions use its helpers (esc, badge, when, money, section, api, $) only when they are
// called, never while this file loads. Every piece of plan text goes through esc(): plans are model output and must never be treated as markup.
/* global esc, badge, when, money, section, api, $ */
'use strict';

const NOT_ARCHIVED = 'Its verdict was overwritten before plans were archived, so it counts as a revision but cannot be loaded, compared or promoted.';

function revisionTags(p, t, activeId) {
  return [
    p.id === t.planOfRecord ? '<span class="badge good">plan of record</span>' : '',
    p.id === activeId ? '<span class="badge warn">active</span>' : '',
    p.archived ? '' : `<span class="badge bad" title="${esc(NOT_ARCHIVED)}">not archived</span>`,
  ].filter(Boolean).join(' ');
}

/** The other plans for the same question. Hidden when there is only one: a thread of one has nothing to compare. */
function lineageSection(d) {
  const t = d.lineage;
  if (!t || t.plans.length < 2) return '';
  const me = d.planId, canCompare = Boolean(d.plan);
  const rows = t.plans.map((p, i) => {
    const action = p.id === me ? '<span class="meta">this plan</span>'
      : p.archived && canCompare ? `<button class="btn" data-act="compare" data-id="${esc(me)}" data-other="${esc(p.id)}">Compare</button>` : '';
    return `<tr><td class="num">${i + 1}</td><td><button class="linkbtn id" data-act="open" data-id="${esc(p.id)}">${esc(p.id)}</button></td>` +
      `<td class="meta">${esc(when(p.started))}</td><td class="num">${p.confidence == null ? '-' : p.confidence.toFixed(2)}</td><td class="num">${p.steps}</td>` +
      `<td class="num">${p.builds ? `${p.built}/${p.builds} built` : '-'}</td><td>${revisionTags(p, t, d.active)}</td><td>${action}</td></tr>`;
  }).join('');
  return section(`Revisions of this question (${t.plans.length})`,
    `<div class="meta">Grouped by ${esc(t.basis)}.</div>` +
    '<table><tr><th class="num">#</th><th>Plan</th><th>When</th><th class="num">Conf</th><th class="num">Steps</th><th class="num">Builds</th><th></th><th></th></tr>' + rows + '</table>' +
    '<div id="compare" aria-live="polite"></div>');
}

/** The "make plan of record" toggle, for the actions bar. Empty when the run has no plan to promote. */
function promoteButton(d) {
  if (!d.plan || !d.planId || !d.lineage) return '';
  const on = d.lineage.planOfRecord === d.planId;
  return `<button class="btn" data-act="promote" data-id="${esc(d.planId)}" data-value="${on ? 'false' : 'true'}" aria-pressed="${on}"` +
    ` title="${on ? 'Take back the choice' : 'Mark this as the plan of record for its question. It does not change which plan Build runs.'}">` +
    `${on ? 'Plan of record (take back)' : 'Make plan of record'}</button>`;
}

/** Shown on the active-plan bar when Build would run a different plan than the one chosen for the same question. */
function recordWarning(a) {
  if (!a || a.isPlanOfRecord !== false) return '';
  return `<div class="meta warnline">Not the plan of record for this question: Build would run this plan, not <span class="id">${esc(a.planOfRecord)}</span>. ` +
    `<button class="btn" data-act="activate" data-id="${esc(a.planOfRecord)}">Load the plan of record</button></div>`;
}

// --- compare ---------------------------------------------------------------------------------------------------------
const pctOf = (n) => Math.round(n * 100) + '%';

function listDiffHtml(title, diff) {
  if (!diff.onlyA.length && !diff.onlyB.length) return diff.kept.length ? `<div class="meta">${esc(title)}: ${diff.kept.length} unchanged.</div>` : '';
  const items = (xs, cls, label) => xs.map((x) => `<li class="${cls}"><span class="meta">${label}</span> ${esc(x)}</li>`).join('');
  return `<h4>${esc(title)}</h4><ul class="diff">${items(diff.onlyA, 'diff-a', 'only in A')}${items(diff.onlyB, 'diff-b', 'only in B')}</ul>` +
    (diff.kept.length ? `<div class="meta">${diff.kept.length} unchanged.</div>` : '');
}

function stepLine(s) { return `<b>${esc(s.owner || '?')}</b> ${esc(s.step)}`; }

function stepsHtml(steps) {
  if (!steps.pairs.length && !steps.onlyA.length && !steps.onlyB.length) return '';
  const pairs = steps.pairs.map((p) => {
    if (p.same && !p.ownerChanged && !p.doneWhenChanged) return `<li><span class="meta">unchanged</span> ${stepLine(p.a)}</li>`;
    const notes = [p.same ? '' : `reworded, ${pctOf(p.similarity)} word overlap`, p.ownerChanged ? `owner ${esc(p.a.owner)} to ${esc(p.b.owner)}` : '', p.doneWhenChanged ? 'done-when changed' : ''].filter(Boolean).join(', ');
    return `<li><span class="meta">${notes}</span><div class="diff-a">${stepLine(p.a)}</div><div class="diff-b">${stepLine(p.b)}</div></li>`;
  }).join('');
  return '<h4>Steps</h4><div class="meta">Steps are paired by word overlap, which is a heuristic: judge the pairs yourself.</div><ul class="diff">' + pairs +
    steps.onlyA.map((s) => `<li class="diff-a"><span class="meta">removed</span> ${stepLine(s)}</li>`).join('') +
    steps.onlyB.map((s) => `<li class="diff-b"><span class="meta">added</span> ${stepLine(s)}</li>`).join('') + '</ul>';
}

function runFactsRow(label, a, b, fmt) { return `<tr><td>${esc(label)}</td><td class="num">${fmt(a)}</td><td class="num">${fmt(b)}</td></tr>`; }

function compareHtml(r) {
  const c = r.comparison, ca = c.confidence;
  const delta = ca.delta == null ? 'n/a' : (ca.delta > 0 ? '+' : '') + ca.delta.toFixed(2);
  return `<h3>Compare <span class="id">${esc(c.a)}</span> (A) with <span class="id">${esc(c.b)}</span> (B)</h3>` +
    (r.sameThread ? '' : '<div class="notice">These plans answer different questions, so differences below are not revisions.</div>') +
    `<div class="meta">Objective ${c.objective.same ? 'unchanged' : 'changed'} &middot; verdict ${c.verdictSame ? 'unchanged' : 'changed'} &middot; confidence ${ca.a == null ? '-' : ca.a.toFixed(2)} to ${ca.b == null ? '-' : ca.b.toFixed(2)} (${delta})</div>` +
    (c.objective.same ? '' : `<div class="diff-a"><span class="meta">A objective</span> ${esc(c.objective.a)}</div><div class="diff-b"><span class="meta">B objective</span> ${esc(c.objective.b)}</div>`) +
    listDiffHtml('Success criteria', c.criteria) + listDiffHtml('Success metrics', c.metrics) + listDiffHtml('Dissent', c.dissent) + listDiffHtml('Decided by', c.decidedBy) +
    stepsHtml(c.steps) +
    '<h4>What running each cost</h4><table><tr><th></th><th class="num">A</th><th class="num">B</th></tr>' +
    runFactsRow('Council cost', r.runs.a.costUsd, r.runs.b.costUsd, money) + runFactsRow('Council time (s)', Math.round(r.runs.a.totalSeconds), Math.round(r.runs.b.totalSeconds), String) +
    runFactsRow('Builds (built)', `${r.runs.a.builds} (${r.runs.a.built})`, `${r.runs.b.builds} (${r.runs.b.built})`, String) + '</table>';
}

async function showCompare(a, b) {
  const el = $('compare');
  if (!el) return;
  el.innerHTML = '<div class="empty">Comparing...</div>';
  try {
    el.innerHTML = compareHtml(await api(`/api/history/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}`));
    el.scrollIntoView({ block: 'nearest' });
  } catch (err) { el.innerHTML = `<div class="notice bad">Could not compare: ${esc(err.message)}</div>`; }
}

async function setPlanOfRecord(id, value) {
  return api(`/api/history/${encodeURIComponent(id)}/promote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) });
}
