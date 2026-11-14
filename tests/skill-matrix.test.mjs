// tests/skill-matrix.test.mjs - the role x skill matrix: assignments, blocked skills, config mistakes, and the read-only contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { buildSkillMatrix, MATRIX_LIMITS } from '../dist/skill-matrix.js';
import { renderSkills } from '../dist/skills-html.js';
import { mountSkills } from '../dist/skills-routes.js';
import { readRegistry } from '../dist/skills.js';
import { loadAgentConfigs } from '../dist/agent-config.js';

const ROOT = join(import.meta.dirname, '..');
const skill = (extra = {}) => ({ state: 'active', sha256: 'x', source: { type: 'local' }, installedAt: '2026-01-02T03:04:05Z', ...extra });
const ROLES = [{ id: 'main', name: 'Main' }, { id: 'ops', name: 'Ops' }, { id: 'comms', name: 'Comms', active: false }];
const ok = () => ({ ok: true });

function registry(agents, skills = { alpha: skill(), beta: skill(), gamma: skill() }) { return { version: 1, skills, agents }; }
const cellOf = (m, skillName, role) => m.skills.find((s) => s.name === skillName).cells[role];

test('cells: required beats offered; "via" says whether it came from "*", the role, or both; unassigned is none', () => {
  const m = buildSkillMatrix(registry({
    '*': { required: ['alpha'], available: ['beta'] },
    ops: { required: ['alpha', 'gamma'], available: ['beta', 'gamma'] },
  }), ROLES, ok);
  assert.deepEqual(cellOf(m, 'alpha', 'main'), { status: 'required', via: 'all roles', usable: true });
  assert.deepEqual(cellOf(m, 'alpha', 'ops'), { status: 'required', via: 'both', usable: true });
  assert.deepEqual(cellOf(m, 'beta', 'main'), { status: 'available', via: 'all roles', usable: true });
  assert.deepEqual(cellOf(m, 'beta', 'ops'), { status: 'available', via: 'both', usable: true });
  assert.deepEqual(cellOf(m, 'gamma', 'ops'), { status: 'required', via: 'this role', usable: true }, 'listed as both required and offered: required wins');
  assert.deepEqual(cellOf(m, 'gamma', 'main'), { status: 'none', via: null, usable: true });
});

test('role totals: required / offered / blocked counts per role, and inactive roles are flagged', () => {
  const m = buildSkillMatrix(registry({ '*': { required: ['alpha'], available: [] }, ops: { required: [], available: ['beta', 'gamma'] } }, { alpha: skill(), beta: skill(), gamma: skill() }),
    ROLES, (n) => (n === 'gamma' ? { ok: false, reason: 'content changed since it was approved' } : { ok: true }));
  const by = Object.fromEntries(m.roles.map((r) => [r.id, r]));
  assert.deepEqual([by.main.required, by.main.available, by.main.blocked], [1, 0, 0]);
  assert.deepEqual([by.ops.required, by.ops.available, by.ops.blocked], [1, 2, 1]);
  assert.deepEqual([by.main.active, by.comms.active], [true, false]);
});

test('blocked: an assigned skill that fails its check is flagged in the cell with the reason; an unassigned cell is never "blocked"', () => {
  const m = buildSkillMatrix(registry({ ops: { required: ['alpha'], available: [] } }), ROLES, (n) => (n === 'alpha' ? { ok: false, reason: 'state is disabled' } : { ok: true }));
  assert.deepEqual(cellOf(m, 'alpha', 'ops'), { status: 'required', via: 'this role', usable: false, blocked: 'state is disabled' });
  assert.deepEqual(cellOf(m, 'alpha', 'main'), { status: 'none', via: null, usable: true }, 'main does not get it, so it is not blocked there');
  const p = m.problems.find((x) => x.kind === 'blocked-required');
  assert.equal(p.level, 'warning');
  assert.match(p.text, /"alpha" is required for ops/);
  assert.match(p.text, /state is disabled/);
  assert.match(p.text, /run without it/);
});

test('blocked: an OFFERED (not required) blocked skill is a lesser warning with its own wording', () => {
  const m = buildSkillMatrix(registry({ '*': { required: [], available: ['beta'] } }), ROLES, () => ({ ok: false, reason: 'SKILL.md is missing' }));
  const kinds = m.problems.map((p) => p.kind);
  assert.ok(kinds.includes('blocked-assigned') && !kinds.includes('blocked-required'));
  assert.match(m.problems.find((p) => p.kind === 'blocked-assigned').text, /offered to 3 roles but is blocked \(SKILL\.md is missing\)/);
});

test('config mistakes: a skill assigned but not in the registry becomes a "missing" row and a warning; it is never silently dropped', () => {
  let verified = [];
  const m = buildSkillMatrix(registry({ ops: { required: ['ghost'], available: [] } }), ROLES, (n) => { verified.push(n); return { ok: true }; });
  const row = m.skills.find((s) => s.name === 'ghost');
  assert.equal(row.state, 'missing');
  assert.equal(cellOf(m, 'ghost', 'ops').usable, false, 'cannot load');
  assert.equal(cellOf(m, 'ghost', 'ops').blocked, 'not in the registry');
  assert.ok(m.problems.some((p) => p.kind === 'unknown-skill' && /"ghost"/.test(p.text)));
  assert.equal(verified.includes('ghost'), false, 'the verifier is not asked about a skill that does not exist');
});

test('config mistakes: assignments to a role that is not configured are flagged (a typo or a retired role); "*" is not a role', () => {
  const m = buildSkillMatrix(registry({ '*': { required: [], available: [] }, reasearch: { required: ['alpha'], available: [] } }), ROLES, ok);
  const unknown = m.problems.filter((p) => p.kind === 'unknown-role');
  assert.equal(unknown.length, 1);
  assert.match(unknown[0].text, /"reasearch"/);
  assert.equal(m.roles.some((r) => r.id === '*' || r.id === 'reasearch'), false);
});

test('unassigned: a registered skill that no role gets is noted (info), but one given to everyone through "*" is not', () => {
  const m = buildSkillMatrix(registry({ '*': { required: [], available: ['beta'] } }), ROLES, ok);
  const unassigned = m.problems.filter((p) => p.kind === 'unassigned');
  assert.deepEqual(unassigned.map((p) => /"(\w+)"/.exec(p.text)[1]).sort(), ['alpha', 'gamma']);
  assert.ok(unassigned.every((p) => p.level === 'info'));
});

test('a healthy registry has no problems at all', () => {
  const m = buildSkillMatrix(registry({ '*': { required: ['alpha'], available: ['beta', 'gamma'] } }), ROLES, ok);
  assert.deepEqual(m.problems, []);
});

test('each skill is verified at most once however many roles it is assigned to', () => {
  const calls = {};
  buildSkillMatrix(registry({ '*': { required: ['alpha'], available: [] }, ops: { required: ['alpha'], available: ['alpha'] } }), ROLES, (n) => { calls[n] = (calls[n] ?? 0) + 1; return { ok: true }; });
  assert.deepEqual(calls, { alpha: 1, beta: 1, gamma: 1 });
});

test('rows come out sorted and the result is deterministic (same input, same output)', () => {
  const agents = { ops: { required: ['gamma'], available: ['alpha'] } };
  const a = buildSkillMatrix(registry(agents, { gamma: skill(), alpha: skill(), beta: skill() }), ROLES, ok);
  const b = buildSkillMatrix(registry(agents, { beta: skill(), gamma: skill(), alpha: skill() }), ROLES, ok);
  assert.deepEqual(a.skills.map((s) => s.name), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(a, b);
});

test('skill details: source, state, install date, inline flag and note carry through; a github source shows the repo and a short ref', () => {
  const m = buildSkillMatrix(registry({}, { alpha: skill({ state: 'disabled', inline: true, note: 'trimmed', source: { type: 'github', repo: 'a/b', ref: '0123456789abcdef' } }), beta: skill() }), ROLES, ok);
  const a = m.skills.find((s) => s.name === 'alpha');
  assert.deepEqual([a.state, a.source, a.inline, a.note, a.installedAt], ['disabled', 'github a/b@0123456', true, 'trimmed', '2026-01-02T03:04:05Z']);
  assert.equal(m.skills.find((s) => s.name === 'beta').source, 'local');
});

test('malformed registry data never throws: non-array lists, non-string names, missing fields, no roles, no skills', () => {
  assert.doesNotThrow(() => buildSkillMatrix(registry({ '*': { required: 'x', available: [1, null, '', 'alpha'] }, ops: null, main: {} }, { alpha: skill(), broken: {} }), ROLES, ok));
  const m = buildSkillMatrix(registry({ '*': { required: 'x', available: [1, null, '', 'alpha'] } }), ROLES, ok);
  assert.equal(cellOf(m, 'alpha', 'main').status, 'available', 'the one valid entry in a messy list still counts');
  assert.deepEqual(m.skills.map((s) => s.name), ['alpha', 'beta', 'gamma'], 'only the registry\'s own skills: no junk rows from non-string or empty names');
  assert.deepEqual(buildSkillMatrix({ version: 1, skills: {}, agents: {} }, [], ok), { roles: [], skills: [], problems: [], limits: MATRIX_LIMITS });
});

// --- honesty ------------------------------------------------------------------------------------------------------------------------------
test('limits: the page says it cannot show use or effect, and that is TRUE: nothing in src/ writes the skill_health table', () => {
  assert.match(MATRIX_LIMITS.join(' '), /does not show whether a skill was ever used/);
  assert.match(MATRIX_LIMITS.join(' '), /silently left out/);
  const users = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.ts') && !['db.ts', 'skill-matrix.ts'].includes(f) && /skill_health/.test(readFileSync(join(ROOT, 'src', f), 'utf8')));
  assert.deepEqual(users, [], 'something now touches skill_health: the "nothing records skill use" note is stale, and so is this test');
  const db = readFileSync(join(ROOT, 'src', 'db.ts'), 'utf8');
  assert.deepEqual([...db.matchAll(/skill_health/g)].length, 1, 'db.ts only declares the table');
});

test('the real registry: every assigned skill and every role is real (a typo in skillpack/registry.json fails here)', () => {
  const roles = loadAgentConfigs().map((a) => ({ id: a.id, name: a.name }));
  const m = buildSkillMatrix(readRegistry(), roles, ok); // integrity is judged by the live app; here only the CONFIGURATION is checked
  assert.deepEqual(m.problems.filter((p) => p.kind === 'unknown-skill' || p.kind === 'unknown-role').map((p) => p.text), []);
  assert.ok(m.roles.length >= 5 && m.skills.length >= 8);
  assert.equal(m.skills.every((s) => Object.keys(s.cells).length === m.roles.length), true, 'every skill has a cell for every role');
});

// --- the contract: read-only ----------------------------------------------------------------------------------------------------------------
test('read-only contract: every route is a GET, the client sends no request with a method, and it never mentions the registry file', () => {
  const app = new Hono(); mountSkills(app);
  const mine = app.routes.filter((r) => r.method !== 'ALL');
  assert.ok(mine.length >= 3, `the page, its script and the matrix endpoint; got ${mine.map((r) => r.method + ' ' + r.path)}`);
  assert.deepEqual([...new Set(mine.map((r) => r.method))], ['GET']);
  const js = readFileSync(join(ROOT, 'public', 'skills-app.js'), 'utf8');
  assert.doesNotMatch(js.replace(/\/\/.*$/gm, ''), /method\s*:/i, 'a fetch with a method option is a write path');
  for (const file of ['src/skill-matrix.ts', 'src/skills-routes.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(src, /writeRegistry|writeFileSync|unlinkSync|rmSync|renameSync/, `${file} must not write`);
  }
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'skills-routes.ts'), 'utf8'), /proposed/i, 'the drafts folder is none of this page\'s business');
});

test('routes: the matrix endpoint answers with roles, skills, problems and limits; the page and its script are served', async () => {
  const app = new Hono(); mountSkills(app);
  const res = await app.request('/api/skills/matrix');
  assert.equal(res.status, 200);
  const m = await res.json();
  assert.deepEqual(Object.keys(m).sort(), ['limits', 'problems', 'roles', 'skills']);
  assert.ok(m.roles.length >= 5 && m.skills.length >= 8);
  for (const s of m.skills) assert.deepEqual(Object.keys(s.cells).sort(), m.roles.map((r) => r.id).sort(), s.name);
  const page = await (await app.request('/skills?token=a%22%3E%3Cscript%3E')).text();
  assert.match(page, /Skills/);
  assert.ok(!page.includes('<script>alert') && !page.includes('"><script>'), 'the token cannot break out of the page config');
  assert.ok(page.indexOf('/skills/skills-app.js') > 0);
  const js = await app.request('/skills/skills-app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal((await app.request('/skills/other.js')).status, 404);
});

// --- the client, run for real in a vm with a fake DOM ---------------------------------------------------------------------------------------
async function runClient(matrix, ok_ = true) {
  const els = {}; const el = (id) => (els[id] ??= { id, innerHTML: '' });
  const ctx = vm.createContext({ SKL: { token: '' }, document: { getElementById: el }, fetch: async () => ({ ok: ok_, status: ok_ ? 200 : 500, json: async () => matrix }) });
  vm.runInContext(readFileSync(join(ROOT, 'public', 'skills-app.js'), 'utf8'), ctx);
  await new Promise((r) => setTimeout(r, 20));
  return els;
}
const EVIL = '<img src=x onerror=alert(1)><script>alert(2)</script>" onmouseover="alert(3)\'';
const live = (h) => h.includes('<img') || h.includes('<script') || h.includes('" onmouseover=') || h.includes(EVIL);

test('client: hostile text in skill names, notes, sources, roles, reasons and problems is escaped everywhere', async () => {
  const cell = (c) => ({ status: 'required', via: EVIL, usable: false, blocked: EVIL, ...c });
  const els = await runClient({ limits: [EVIL], problems: [{ level: 'warning', kind: 'x', text: EVIL }],
    roles: [{ id: EVIL, name: EVIL, active: false, required: 1, available: 0, blocked: 1 }],
    skills: [{ name: EVIL, state: EVIL, source: EVIL, installedAt: EVIL, inline: true, note: EVIL, verdict: { ok: false, reason: EVIL }, assignedTo: 1, cells: { [EVIL]: cell() } }] });
  for (const id of ['stats', 'problems', 'matrix', 'limits']) assert.equal(live(els[id].innerHTML), false, `${id}: ${els[id].innerHTML.slice(0, 160)}`);
  assert.ok(els.matrix.innerHTML.includes('&lt;img'), 'it is shown as text');
});

test('client: required, offered, none and blocked cells each say so in words (not colour alone); an empty registry and a failed load are explained', async () => {
  const c = (status, usable = true) => ({ status, via: status === 'none' ? null : 'this role', usable, ...(usable ? {} : { blocked: 'state is disabled' }) });
  const mk = (cells) => ({ limits: [], problems: [], roles: [{ id: 'r', name: 'r', active: true, required: 0, available: 0, blocked: 0 }],
    skills: [{ name: 's', state: 'active', source: 'local', installedAt: null, inline: false, note: null, verdict: { ok: true }, assignedTo: 1, cells: { r: cells } }] });
  assert.match((await runClient(mk(c('required')))).matrix.innerHTML, /Required/);
  assert.match((await runClient(mk(c('available')))).matrix.innerHTML, /Offered/);
  assert.match((await runClient(mk(c('none')))).matrix.innerHTML, /Not assigned/);
  const blocked = (await runClient(mk(c('required', false)))).matrix.innerHTML;
  assert.match(blocked, /Blocked/);
  assert.match(blocked, /state is disabled/);
  assert.match((await runClient({ limits: [], problems: [], roles: [], skills: [] })).problems.innerHTML, /Nothing needs attention/);
  assert.match((await runClient({ limits: [], problems: [], roles: [], skills: [] })).matrix.innerHTML, /No skills are registered/);
  assert.match((await runClient({}, false)).matrix.innerHTML, /Could not load the skill matrix.*500/);
});

test('page: renders in the rail as the active page', () => {
  const html = renderSkills('');
  assert.match(html, /The Armoury/);
  assert.match(html, /<a class="kr-link on" aria-current="page" href="\/skills">/, 'the Skills link is the current page');
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1, 'and it is the only one');
  assert.match(html, /<a class="kr-link" href="\/history"/, 'the other pages are in the rail but not current');
});
