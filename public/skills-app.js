// public/skills-app.js - Skills page behaviour. READ-ONLY: its only request is a GET to /api/skills/matrix.
// Needs (inline, before this file): SKL config. Every value from the registry goes through esc(): skill names and notes are data, never markup.
/* global SKL */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function load() {
  const res = await fetch('/api/skills/matrix', { headers: SKL.token ? { 'x-kings-reach-token': SKL.token } : {} });
  if (!res.ok) throw new Error('/api/skills/matrix -> ' + res.status);
  return res.json();
}

/** One cell. Words as well as symbols, so the meaning never depends on colour alone. */
function cell(c) {
  if (c.status === 'none') return '<td class="cell"><span class="mark none" title="Not assigned to this role">&ndash;</span></td>';
  const word = c.status === 'required' ? '\u25CF Required' : '\u25CB Offered';
  const via = c.via ? ' (via ' + c.via + ')' : '';
  if (!c.usable) return '<td class="cell"><span class="mark blocked" title="' + esc('Blocked: ' + c.blocked + via) + '">\u26A0 Blocked</span><div class="sub">' + esc(c.blocked) + '</div></td>';
  return '<td class="cell"><span class="mark ' + c.status + '" title="' + esc(c.status + via) + '">' + word + '</span></td>';
}

function renderStats(m) {
  const active = m.skills.filter((s) => s.state === 'active' && s.verdict.ok).length;
  const blocked = m.skills.filter((s) => s.state !== 'missing' && !s.verdict.ok).length;
  const warnings = m.problems.filter((p) => p.level === 'warning').length;
  $('stats').innerHTML = [['Roles', m.roles.length], ['Skills', m.skills.filter((s) => s.state !== 'missing').length], ['Loadable', active], ['Blocked', blocked], ['Warnings', warnings]]
    .map(([label, n]) => '<div class="stat"><b>' + esc(n) + '</b><span>' + esc(label) + '</span></div>').join('');
}

function renderProblems(m) {
  $('problems').innerHTML = m.problems.length
    ? m.problems.map((p) => '<div class="problem ' + esc(p.level) + '">' + (p.level === 'warning' ? '\u26A0 ' : '') + esc(p.text) + '</div>').join('')
    : '<div class="empty">Nothing needs attention: every assignment points at a real skill and role, and every assigned skill passes its check.</div>';
}

function renderMatrix(m) {
  if (!m.skills.length) { $('matrix').innerHTML = '<div class="empty">No skills are registered.</div>'; return; }
  const head = '<thead><tr><th scope="col">Skill</th>' + m.roles.map((r) =>
    '<th scope="col">' + esc(r.id) + '<small>' + esc(r.required) + ' required, ' + esc(r.available) + ' offered' + (r.active ? '' : ', inactive') + '</small></th>').join('') + '</tr></thead>';
  const rows = m.skills.map((s) => {
    const state = s.state === 'active' ? '' : '<span class="badge bad">' + esc(s.state) + '</span>';
    const sub = [s.source, s.inline ? 'pasted into prompts for tool-less providers' : '', s.installedAt ? 'installed ' + String(s.installedAt).slice(0, 10) : '', s.note || ''].filter(Boolean).join(' \u00B7 ');
    return '<tr><th scope="row"><span class="skillname">' + esc(s.name) + '</span>' + state + '<div class="sub">' + esc(sub) + '</div></th>' + m.roles.map((r) => cell(s.cells[r.id])).join('') + '</tr>';
  }).join('');
  $('matrix').innerHTML = '<table class="matrix">' + head + '<tbody>' + rows + '</tbody></table>';
}

async function init() {
  try {
    const m = await load();
    renderStats(m); renderProblems(m); renderMatrix(m);
    $('limits').innerHTML = m.limits.map((l) => '<li>' + esc(l) + '</li>').join('');
  } catch (err) {
    $('matrix').innerHTML = '<div class="empty">Could not load the skill matrix: ' + esc(err.message) + '</div>';
  }
}

init();
