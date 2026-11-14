// scripts/ui-check-skills.mjs - the Skills page (role x skill matrix) in real Chrome, against the live registry.
// Read-only is part of the contract: the page's requests are recorded and must all be GETs. Every rendered cell is cross-checked against the API.

const RECORD_FETCH = `window.__fetches = []; const f = window.fetch; window.fetch = (u, o) => { window.__fetches.push({ url: String(u), method: ((o && o.method) || 'GET').toUpperCase() }); return f(u, o); };`;

export async function skillChecks({ open, js, check, sleep, base }) {
  const matrix = await (await fetch(`${base}/api/skills/matrix`)).json();
  await open('/skills', { pre: RECORD_FETCH });
  for (let i = 0; i < 30 && !(await js(`document.querySelectorAll('#matrix tbody tr').length`)); i++) await sleep(200);

  const page = JSON.parse(await js(`JSON.stringify({
    active: (document.querySelector('.kr-link.on') || {}).textContent || '', title: document.title,
    rows: document.querySelectorAll('#matrix tbody tr').length, heads: [...document.querySelectorAll('#matrix thead th')].map((t) => t.firstChild.textContent),
    stats: [...document.querySelectorAll('#stats .stat b')].map((b) => b.textContent), limits: document.querySelectorAll('#limits li').length,
    problems: document.querySelectorAll('#problems .problem').length + document.querySelectorAll('#problems .empty').length })`));
  check('skills: the page is in the rail as the active page', /Skills/.test(page.active), page.active);
  check('skills: one row per skill and one column per role, from the live registry',
    page.rows === matrix.skills.length && page.heads.length === matrix.roles.length + 1 && matrix.roles.every((r) => page.heads.includes(r.id)), JSON.stringify(page.heads));
  check('skills: the totals render', page.stats.length === 5 && page.stats[0] === String(matrix.roles.length), JSON.stringify(page.stats));
  check('skills: "needs attention" answers (a list, or an honest "nothing")', page.problems > 0);
  check('skills: it says what it cannot tell you (use and effect are not recorded)', page.limits >= 2);

  // Every cell: the class on screen must be what the API says. A matrix that looks right but disagrees with the data is worse than none.
  const cells = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#matrix tbody tr')].map((tr) => ({
    skill: tr.querySelector('.skillname').textContent, marks: [...tr.querySelectorAll('td .mark')].map((m) => m.className.replace('mark ', '').trim()) })))`));
  const expectClass = (c) => (c.status === 'none' ? 'none' : c.usable ? c.status : 'blocked');
  const mismatches = [];
  for (const row of cells) {
    const s = matrix.skills.find((x) => x.name === row.skill);
    const want = matrix.roles.map((r) => expectClass(s.cells[r.id]));
    if (JSON.stringify(want) !== JSON.stringify(row.marks)) mismatches.push({ skill: row.skill, want, got: row.marks });
  }
  check('skills: every cell on screen matches the API (required / offered / none / blocked)', cells.length === matrix.skills.length && mismatches.length === 0, JSON.stringify(mismatches).slice(0, 240));

  const words = await js(`[...document.querySelectorAll('#matrix td .mark')].every((m) => m.textContent.trim().length > 0)`);
  check('skills: meaning is in words and symbols, not colour alone (no empty cell marks)', words === true);

  const fetches = JSON.parse(await js(`JSON.stringify(window.__fetches)`));
  const own = fetches.filter((f) => /\/api\/skills\//.test(f.url));
  check('skills: the page only ever reads: every request it makes is a GET', own.length >= 1 && own.every((f) => f.method === 'GET'), JSON.stringify(fetches));
  check('skills: nothing on the page can edit an assignment (no buttons, inputs or forms in the matrix)', (await js(`document.querySelectorAll('#matrix button, #matrix input, #matrix select, #matrix form').length`)) === 0);
}
