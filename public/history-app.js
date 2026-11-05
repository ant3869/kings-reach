// public/history-app.js - Plan Library behaviour. Needs (inline, before this file): HIST config, md(), esc().
// Data comes from /api/history*; the only writes are "load as active plan" and the build hand-off.
/* global HIST, md, esc */
'use strict';

const $ = (id) => document.getElementById(id);
const ROLE_COLOR = { main: '#d4a017', research: '#79c0ff', comms: '#a371f7', content: '#3fb950', ops: '#f85149' };
const OUTCOMES = {
  verdict: ['Verdict locked', 'good'], built: ['Built', 'good'], needs_work: ['Needs work', 'warn'],
  no_changes: ['Approved, nothing changed', 'warn'], preflight_failed: ['Preflight failed', 'bad'],
  no_verdict: ['No verdict', 'bad'], no_takes: ['No takes', 'bad'],
};
const STAGE_COLORS = ['#79c0ff', '#a371f7', '#3fb950', '#d4a017', '#f85149', '#8b949e'];

let overview = null;
const filter = { kind: 'all', outcome: '', q: '' };
let selectedId = null;

// --- formatting ------------------------------------------------------------------------
const outcomeOf = (o) => OUTCOMES[o] || [String(o).replace(/_/g, ' '), 'muted'];
const money = (n) => '$' + Number(n || 0).toFixed(2);
const pct = (n) => (n == null ? 'n/a' : Math.round(n * 100) + '%');
function duration(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
function when(iso) {
  const d = new Date(iso); // recorded in local time, so it parses back as local time
  return isNaN(d) ? String(iso) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const badge = (outcome) => { const [label, tone] = outcomeOf(outcome); return `<span class="badge ${tone}">${esc(label)}</span>`; };

// --- api -------------------------------------------------------------------------------
async function api(path, options) {
  const headers = HIST.token ? { 'x-claudeclaw-token': HIST.token } : {};
  const res = await fetch(path, Object.assign({ headers }, options || {}));
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || 'HTTP ' + res.status);
  return body;
}

function toast(text) {
  const el = $('toast');
  el.textContent = text; el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2600);
}

// --- stats + active plan ---------------------------------------------------------------
function renderStats() {
  const s = overview.stats;
  const cards = [
    ['Runs', s.runs, `${s.summits} councils, ${s.builds} builds`],
    ['Verdicts locked', s.verdicts, `of ${s.summits} councils`],
    ['Build success', pct(s.buildSuccessRate), `${s.built} built, ${s.needsWork} need work, ${s.noChanges} no-op`],
    ['Total spend', money(s.totalCostUsd), s.avgBuildCostUsd == null ? '' : `~${money(s.avgBuildCostUsd)} per build`],
    ['Time in session', duration(s.totalSeconds), s.avgBuildSeconds == null ? '' : `~${duration(s.avgBuildSeconds)} per build`],
    ['Avg confidence', s.avgConfidence == null ? 'n/a' : s.avgConfidence.toFixed(2), 'Main\'s verdict confidence'],
  ];
  $('stats').innerHTML = cards.map(([label, value, note]) =>
    `<div class="stat"><span>${esc(label)}</span><b>${esc(value)}</b><small>${esc(note)}</small></div>`).join('');
}

function renderActive() {
  const a = overview.active, el = $('active');
  el.classList.toggle('none', !a);
  if (!a) { el.innerHTML = 'No plan on file. Convene the council in the <a href="/warroom">War Room</a> to lock a verdict.'; return; }
  el.innerHTML = `<div class="grow"><b>Plan on file</b> <span class="id">${esc(a.run)}</span> &middot; ${a.steps} steps by ${esc(a.owners.join(', '))}` +
    `<div class="meta clamp2" title="${esc(a.objective)}">${esc(a.objective)}</div></div>` +
    `<button class="btn" data-act="open" data-id="${esc(a.run)}">Review</button>` +
    `<button class="btn primary" data-act="build" data-id="${esc(a.run)}">Build this plan...</button>`;
}

// --- list ------------------------------------------------------------------------------
function visibleRuns() {
  const q = filter.q.trim().toLowerCase();
  return overview.runs.filter((r) =>
    (filter.kind === 'all' || r.kind === filter.kind) && (!filter.outcome || r.outcome === filter.outcome) &&
    (!q || r.id.includes(q) || r.title.toLowerCase().includes(q) || r.question.toLowerCase().includes(q)));
}

function renderOutcomeOptions() {
  const seen = [...new Set(overview.runs.map((r) => r.outcome))].sort();
  $('outcome').innerHTML = '<option value="">Any outcome</option>' +
    seen.map((o) => `<option value="${esc(o)}"${o === filter.outcome ? ' selected' : ''}>${esc(outcomeOf(o)[0])}</option>`).join('');
}

function renderList() {
  const runs = visibleRuns();
  $('list').innerHTML = runs.length ? runs.map((r) => {
    const facts = r.kind === 'summit'
      ? [duration(r.totalSeconds), money(r.costUsd), r.confidence == null ? '' : 'conf ' + r.confidence.toFixed(2),
        r.mindsChanged == null ? '' : 'minds changed ' + r.mindsChanged + (r.mindsClaimed !== r.mindsChanged ? ' (claimed ' + r.mindsClaimed + ')' : ''),
        r.builds ? `${r.builds} build${r.builds > 1 ? 's' : ''}` : '']
      : [duration(r.totalSeconds), money(r.costUsd), r.changedFiles + ' files', r.criteriaMet ? r.criteriaMet + ' criteria' : ''];
    return `<li><button data-act="open" data-id="${esc(r.id)}" class="${r.id === selectedId ? 'sel' : ''}">` +
      `<div class="row1"><span class="badge kind-${esc(r.kind)}">${r.kind === 'summit' ? 'council' : 'build'}</span>${badge(r.outcome)}` +
      `<span class="when">${esc(when(r.started))}</span></div>` +
      `<div class="q">${esc(r.title)}</div><div class="meta"><span class="id">${esc(r.id)}</span> &middot; ${esc(facts.filter(Boolean).join(' &middot; ').replace(/&middot;/g, '\u00b7'))}</div>` +
      `</button></li>`;
  }).join('') : '<li class="meta" style="padding:14px">No runs match these filters.</li>';
}

// --- detail pieces ---------------------------------------------------------------------
function stageBar(stages) {
  const entries = Object.entries(stages || {}).filter(([, s]) => s > 0);
  const total = entries.reduce((n, [, s]) => n + s, 0);
  if (!total) return '<span class="meta">No stage timings recorded.</span>';
  const segs = entries.map(([name, s], i) =>
    `<i style="width:${(s / total * 100).toFixed(1)}%;background:${STAGE_COLORS[i % STAGE_COLORS.length]}" title="${esc(name)} ${duration(s)}">${s / total > .09 ? esc(name) : ''}</i>`);
  return `<div class="bar">${segs.join('')}</div><div class="bar-legend">${entries.map(([n, s]) => `${esc(n)} ${duration(s)}`).join(' &middot; ')}</div>`;
}

function agentsTable(agents) {
  const rows = Object.entries(agents || {});
  if (!rows.length) return '<span class="meta">No agent accounting recorded.</span>';
  return '<table><tr><th>Agent</th><th>Model</th><th class="num">Calls</th><th class="num">Turns</th><th class="num">Time</th><th class="num">Cost</th></tr>' +
    rows.map(([id, a]) => {
      const failed = (a.failures || []).length;
      const wasSalvaged = (a.attempts || []).some((x) => x.salvaged);
      return `<tr><td><span class="owner" style="color:${ROLE_COLOR[id] || '#ccc'}">${esc(id)}</span></td>` +
        `<td>${esc((a.models || []).join(', ') || '-')}${failed ? ` <span class="bad" title="provider attempts that errored before a fallback succeeded">(${failed} failed attempt${failed > 1 ? 's' : ''})</span>` : ''}${wasSalvaged ? ' <span class="tag" title="a turn-capped attempt was recovered and answered before fallback">salvaged</span>' : ''}</td>` +
        `<td class="num">${a.calls || 0}</td><td class="num">${a.turns || 0}</td><td class="num">${duration(a.seconds)}</td><td class="num">${money(a.cost_usd)}</td></tr>`;
    }).join('') + '</table>';
}

function planSteps(plan) {
  const steps = plan.plan || [];
  return '<table><tr><th>#</th><th>Owner</th><th>Step</th><th>Done when</th></tr>' + steps.map((s, i) =>
    `<tr><td class="num">${i + 1}</td><td><span class="owner" style="color:${ROLE_COLOR[s.owner] || '#ccc'}">${esc(s.owner)}</span></td>` +
    `<td>${esc(s.step)}</td><td class="meta">${esc(s.done_when)}</td></tr>`).join('') + '</table>';
}

const bullets = (items) => (items && items.length ? '<ul>' + items.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<span class="meta">none</span>');
const section = (title, html) => `<h2>${esc(title)}</h2>${html}`;

function plansSection(d) {
  const p = d.plan;
  if (!p) {
    return '<div class="notice">This verdict was overwritten before the plan archive existed, so only its metrics survive. ' +
      'It cannot be loaded or rebuilt. Plans locked from now on are kept permanently.</div>';
  }
  const conf = typeof p.confidence === 'number' ? p.confidence : null;
  return section('Objective', `<div>${esc(p.objective || '')}</div>`) +
    section('Verdict', `<div class="verdict">${md(p.verdict || '')}</div>` +
      `<div class="chips">${(p.decided_by || []).map((x) => `<span>${esc(x)}</span>`).join('')}</div>` +
      (conf == null ? '' : `<div class="meta" style="margin-top:8px">Confidence <span class="conf"><i style="width:${Math.round(conf * 100)}%"></i></span>${conf.toFixed(2)}</div>`)) +
    (p.dissent && p.dissent.length ? section('Dissent', bullets(p.dissent)) : '') +
    section(`Plan (${(p.plan || []).length} steps)`, planSteps(p)) +
    section('Success metrics', bullets(p.success_metrics)) +
    (d.planMarkdown ? `<details><summary>Full council record (takes, evidence)</summary><div class="verdict">${md(d.planMarkdown)}</div></details>` : '');
}

function actionsFor(d) {
  const id = d.planId;
  if (!d.plan || !id) return '';
  const isActive = d.active === id;
  return `<div class="actions">` +
    `<button class="btn" data-act="activate" data-id="${esc(id)}"${isActive ? ' disabled' : ''}>${isActive ? 'Active plan' : 'Load as active plan'}</button>` +
    `<button class="btn primary" data-act="build" data-id="${esc(id)}">Build this plan...</button>` +
    `<button class="btn" data-act="reconvene" data-id="${esc(id)}">Reconvene on this</button></div>`;
}

function buildsSection(d) {
  if (!d.builds.length) return section('Follow-through', '<span class="meta">No build has been run from this plan yet.</span>');
  return section(`Follow-through (${d.builds.length} build${d.builds.length > 1 ? 's' : ''})`,
    '<table><tr><th>Build</th><th>Outcome</th><th class="num">Files</th><th class="num">Criteria</th><th class="num">Cost</th><th>When</th></tr>' +
    d.builds.map((b) => `<tr><td><button class="linkbtn id" data-act="open" data-id="${esc(b.id)}">${esc(b.id)}</button></td><td>${badge(b.outcome)}</td>` +
      `<td class="num">${b.changedFiles}</td><td class="num">${esc(b.criteriaMet || '-')}</td><td class="num">${money(b.costUsd)}</td><td class="meta">${esc(when(b.started))}</td></tr>`).join('') + '</table>');
}

function artifactsSection(d) {
  if (!d.artifacts.length) return '';
  return section('Deliverables', '<ul class="files">' + d.artifacts.map((f) =>
    `<li><button class="linkbtn" data-act="artifact" data-id="${esc(d.planId)}" data-name="${esc(f.name)}">${esc(f.name)}</button> (${Math.max(1, Math.round(f.bytes / 1024))} KB)</li>`).join('') +
    '</ul><div id="artifact"></div>');
}

function summitDetail(d) {
  const r = d.run;
  return `<h3>Council <span class="id">${esc(r.id)}</span> ${badge(r.outcome)}</h3>` +
    `<div class="meta">${esc(when(r.started))} &middot; ${duration(r.total_s)} &middot; ${money(r.total_cost_usd)} &middot; ` +
    `${(r.specialists || []).length} specialists &middot; ${r.memory_lines_used || 0} memories recalled</div>` +
    actionsFor(d) +
    `<details><summary>Question put to the council</summary><pre>${esc((d.plan && d.plan.question) || r.question)}</pre></details>` +
    plansSection(d) + buildsSection(d) +
    section('Stage timings', stageBar(r.stages)) + section('Who did the work', agentsTable(r.agents)) + artifactsSection(d);
}

// Older records have no failure_summary; the booleans they do have still say what went wrong.
function buildFailureReason(r) {
  const why = [];
  if (r.outcome === 'preflight_failed') why.push('the baseline checks failed before any agent ran');
  else {
    if (r.checks_ok === false) why.push('automated checks failed');
    if (r.checks_ok !== false && r.approved === false) why.push('Research did not approve it');
    if ((r.execution_failures || []).length) why.push(`${r.execution_failures.join(', ')} returned no build report`);
  }
  return 'This build did not complete: ' + (why.join('; ') || 'no reason was recorded') + '.';
}

function buildDetail(d) {
  const r = d.run;
  const files = Array.isArray(r.changed_files) ? r.changed_files : [];
  const verdict = r.outcome === 'built' ? '' : r.outcome === 'no_changes'
    ? '<div class="notice">Research approved this build, but no file changed, so nothing was actually built.</div>'
    : `<div class="notice bad">${esc(r.failure_summary || buildFailureReason(r))}</div>`;
  return `<h3>Build <span class="id">${esc(r.id)}</span> ${badge(r.outcome)}</h3>` +
    `<div class="meta">${esc(when(r.started))} &middot; ${duration(r.total_s)} &middot; ${money(r.total_cost_usd)} &middot; ` +
    `checks ${r.checks_ok ? 'passed' : 'failed'} &middot; review ${esc(r.review_status || 'n/a')} &middot; ` +
    `${esc(r.criteria_met || 'n/a')} criteria met${r.metrics_total == null && r.criteria_met ? ' (legacy tally, unreliable)' : ''}` +
    `${r.rebooted ? ' &middot; core rebooted' : ''}</div>` +
    (r.legacy_outcome ? `<div class="meta">Originally recorded as "${esc(r.legacy_outcome)}" although no file changed; reclassified.</div>` : '') +
    (d.planId ? `<div class="meta">Executed plan <button class="linkbtn id" data-act="open" data-id="${esc(d.planId)}">${esc(d.planId)}</button>` +
      `${r.verdict_run ? '' : ' (inferred: this build predates plan tracking)'}</div>` : '<div class="notice">The plan this build executed could not be identified.</div>') +
    verdict + actionsFor(d) +
    section(`Changed files (${files.length})`, files.length ? `<ul class="files">${files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<span class="meta">No files changed.</span>') +
    section('Automated checks', `<pre>${esc(r.gate_output || '(none recorded)')}</pre>`) +
    ((r.execution_failures || []).length ? section('Owners without a report', bullets(r.execution_failures)) : '') +
    section('Stage timings', stageBar(r.stages)) + section('Who did the work', agentsTable(r.agents)) +
    (r.total_tokens ? `<div class="meta" style="margin-top:8px">${r.total_tokens.toLocaleString()} tokens (${(r.input_tokens || 0).toLocaleString()} in, ${(r.output_tokens || 0).toLocaleString()} out)</div>` : '') +
    artifactsSection(d) +
    (d.plan ? `<details><summary>The plan it executed</summary>${plansSection(d)}</details>` : '');
}

async function showDetail(id) {
  selectedId = id;
  renderList();
  const el = $('detail');
  el.innerHTML = '<div class="empty">Loading...</div>';
  try {
    const d = await api('/api/history/' + encodeURIComponent(id));
    if (selectedId !== id) return; // user clicked on elsewhere meanwhile
    el.innerHTML = d.run.kind === 'build' ? buildDetail(d) : summitDetail(d);
    // Single-column layout (phones): the detail sits below the list, so bring it into view.
    if (window.matchMedia('(max-width:900px)').matches) el.scrollIntoView({ block: 'start' });
  } catch (err) {
    el.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

// --- actions ---------------------------------------------------------------------------
async function activate(id) {
  const r = await api(`/api/history/${encodeURIComponent(id)}/activate`, { method: 'POST' });
  await refresh();
  return r;
}

async function confirmBuild(id) {
  const s = overview.stats, dlg = $('confirm');
  const est = s.avgBuildCostUsd == null ? 'There is no build history yet to estimate from.'
    : `Builds so far average about ${duration(s.avgBuildSeconds)} and ${money(s.avgBuildCostUsd)}.`;
  // Warn when this exact plan has been built before: re-running a stale plan can undo later fixes.
  let history = '';
  try {
    const prior = (await api('/api/history/' + encodeURIComponent(id))).builds;
    if (prior.length) {
      const good = prior.filter((b) => b.outcome === 'built').length;
      history = `<div class="notice">This plan has already been built ${prior.length} time${prior.length > 1 ? 's' : ''} ` +
        `(${good} successful). The project has probably changed since it was written; consider "Reconvene on this" first so the plan is audited against the current code.</div>`;
    }
  } catch (err) { /* the warning is advisory; the dialog still works without it */ }
  dlg.innerHTML = `<h3>Build plan ${esc(id)}?</h3>${history}` +
    `<p>This loads the plan, switches to the War Room and starts the Build immediately. Agents will edit files in the project ` +
    `and may reboot the core when checks pass. ${esc(est)}</p>` +
    `<div class="actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="go">Build now</button></div>`;
  dlg.showModal();
  dlg.onclick = async (e) => {
    const v = e.target.value;
    if (!v) return;
    dlg.close();
    if (v !== 'go') return;
    try {
      await activate(id);
      sessionStorage.setItem('kr-autobuild', JSON.stringify({ plan: id, t: Date.now() }));
      location.href = '/warroom';
    } catch (err) { toast(err.message); }
  };
}

function reconvene(id) {
  const objective = (overview.runs.find((r) => r.id === id) || {}).question || '';
  const prompt = `Council, reopen the saved plan from run ${id}${objective ? ` ("${objective.slice(0, 120)}...")` : ''}. ` +
    'Audit the CURRENT repository against it and produce a delta plan: only the success metrics that remain unmet, anything broken or ' +
    'stale (versions, file names, line numbers), and how each one will be verified visually and by tests. Do not repeat finished work and do not downgrade anything.';
  location.href = '/warroom?ask=' + encodeURIComponent(prompt);
}

async function onAction(e) {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const { act, id, name } = t.dataset;
  try {
    if (act === 'open') { if (location.hash === '#run=' + id) showDetail(id); else location.hash = 'run=' + id; }
    else if (act === 'activate') { await activate(id); toast(`Plan ${id} is now the active plan.`); showDetail(id); }
    else if (act === 'build') await confirmBuild(id);
    else if (act === 'reconvene') reconvene(id);
    else if (act === 'artifact') {
      const r = await api(`/api/history/${encodeURIComponent(id)}/artifact/${encodeURIComponent(name)}`);
      $('artifact').innerHTML = `<details open><summary>${esc(name)}</summary><div class="verdict">${/\.md$/i.test(name) ? md(r.text) : `<pre>${esc(r.text)}</pre>`}</div></details>`;
    }
  } catch (err) { toast(err.message); }
}

// --- boot ------------------------------------------------------------------------------
async function refresh() {
  overview = await api('/api/history');
  renderStats(); renderActive(); renderOutcomeOptions(); renderList();
}

function routeFromHash() {
  const m = /run=([0-9a-f]{8})/.exec(location.hash);
  if (m) showDetail(m[1]);
}

async function init() {
  document.addEventListener('click', onAction);
  document.querySelectorAll('.chip').forEach((chip) => chip.addEventListener('click', () => {
    filter.kind = chip.dataset.kind;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === chip));
    renderList();
  }));
  $('outcome').onchange = () => { filter.outcome = $('outcome').value; renderList(); };
  $('q').oninput = () => { filter.q = $('q').value; renderList(); };
  $('refresh').onclick = () => refresh().then(() => toast('Refreshed.')).catch((err) => toast(err.message));
  window.addEventListener('hashchange', routeFromHash);
  window.addEventListener('focus', () => refresh().catch(() => {}));
  try { await refresh(); } catch (err) { $('detail').innerHTML = `<div class="notice bad">Could not load history: ${esc(err.message)}</div>`; return; }
  routeFromHash();
}

init();
