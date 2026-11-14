// public/routing-app.js - Route advice page behaviour. READ-ONLY: its only request is a GET to /api/routing/advice.
// Needs (inline, before this file): RTE config. Provider and model names come from the run ledger: data, never markup, so all of it goes through esc().
/* global RTE */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => (x == null ? 'unknown' : Math.round(x * 100) + '%');
const secs = (s) => (s.avg == null ? 'unknown' : Math.round(s.avg) + 's (' + s.samples + ' runs)');

/** Missing cost is "unknown", and a recorded $0 says so: neither is ever shown as "free". */
function cost(c) {
  if (c.avgUsd == null) return 'unknown';
  const zero = c.recordedZero ? ' \u00B7 ' + c.recordedZero + ' recorded as $0' : '';
  return '$' + c.avgUsd.toFixed(2) + ' (' + c.samples + ' runs)' + zero;
}

function renderStats(a) {
  const c = a.coverage;
  $('stats').innerHTML = [['Runs read', c.rows], ['Used', c.usable], ['Cancelled, left out', c.cancelledLeftOut], ['Role-runs', c.roleRuns], ['Without route data', c.roleRunsWithoutAttempts], ['Ratings', c.ratings]]
    .map(([label, n]) => '<div class="stat"><b>' + esc(n) + '</b><span>' + esc(label) + '</span></div>').join('');
}

function renderAdvice(a) {
  const items = a.roles.flatMap((r) => r.advice.map((x) => ({ role: r.role, ...x })));
  $('advice').innerHTML = items.length
    ? items.map((x) => '<div class="advice ' + esc(x.level) + '"><small>' + esc(x.level === 'heads-up' ? 'Heads up' : 'Suggestion') + ' \u00B7 ' + esc(x.role) + '</small>' + esc(x.text) + '</div>').join('')
    : '<div class="empty">No advice. Either no route has enough attempts yet, or none stands out from the others. That is the honest answer, not a gap.</div>';
}

function routeRow(s) {
  const failed = s.failures;
  const access = failed.auth + failed.quota + failed.transport, other = failed['turn-limit'] + failed.other;
  const build = s.builds ? s.built + ' of ' + s.builds + ' built' : 'no builds';
  const sub = s.skipped ? '<div class="sub">skipped ' + esc(s.skipped) + 'x' + (s.skipReasons.length ? ': ' + esc(s.skipReasons.join('; ')) : '') + '</div>' : '';
  return '<tr><td><b>' + esc(s.provider) + '</b> \u00B7 ' + esc(s.model) + sub + '</td>' +
    '<td class="n">' + esc(s.attempts) + '</td><td class="n">' + esc(pct(s.reliability)) + '</td>' +
    '<td class="n">' + esc(access) + '</td><td class="n">' + esc(other) + '</td>' +
    '<td class="n">' + esc(secs(s.seconds)) + '</td><td class="n">' + esc(cost(s.cost)) + '</td>' +
    '<td class="n">' + esc(s.verdictRuns) + ' reached a verdict<div class="sub">' + esc(build) + '</div></td>' +
    '<td><span class="conf ' + esc(s.confidence) + '">' + esc(s.confidence) + '</span></td></tr>';
}

function renderRoles(a) {
  $('roles').innerHTML = a.roles.length
    ? a.roles.map((r) => '<h2>' + esc(r.role) + '</h2><table class="routes"><thead><tr><th scope="col">Route</th><th scope="col">Attempts</th><th scope="col">Finished</th>' +
      '<th scope="col" title="Signed out, out of credit, or unreachable: not the model\'s fault">Access problems</th><th scope="col" title="Turn limit and unclassified errors: counted against the route">Other failures</th>' +
      '<th scope="col">Avg time</th><th scope="col">Avg cost</th><th scope="col">Outcomes</th><th scope="col">Evidence</th></tr></thead><tbody>' + r.routes.map(routeRow).join('') + '</tbody></table>').join('')
    : '<div class="empty">No run in the ledger recorded which routes were tried.</div>';
}

async function init() {
  try {
    const res = await fetch('/api/routing/advice', { headers: RTE.token ? { 'x-kings-reach-token': RTE.token } : {} });
    if (!res.ok) throw new Error('/api/routing/advice -> ' + res.status);
    const a = await res.json();
    renderStats(a); renderAdvice(a); renderRoles(a);
    $('limits').innerHTML = a.limits.map((l) => '<li>' + esc(l) + '</li>').join('');
  } catch (err) {
    $('roles').innerHTML = '<div class="empty">Could not load route advice: ' + esc(err.message) + '</div>';
  }
}

init();
