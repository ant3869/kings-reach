// scripts/ui-check-routing.mjs - the Route advice page in real Chrome, against the live ledger.
// Read-only and advisory is part of the contract: the page's requests are recorded and must all be GETs, and it must offer no way to change a route.

const RECORD_FETCH = `window.__fetches = []; const f = window.fetch; window.fetch = (u, o) => { window.__fetches.push({ url: String(u), method: ((o && o.method) || 'GET').toUpperCase() }); return f(u, o); };`;

export async function routingChecks({ open, js, check, sleep, base }) {
  const advice = await (await fetch(`${base}/api/routing/advice`)).json();
  await open('/routing', { pre: RECORD_FETCH });
  for (let i = 0; i < 30 && !(await js(`document.querySelectorAll('#roles table').length + document.querySelectorAll('#roles .empty').length`)); i++) await sleep(200);

  const page = JSON.parse(await js(`JSON.stringify({
    active: (document.querySelector('.kr-link.on') || {}).textContent || '', stats: [...document.querySelectorAll('#stats .stat b')].map((b) => b.textContent),
    tables: document.querySelectorAll('#roles table').length, rows: document.querySelectorAll('#roles tbody tr').length,
    advice: document.querySelectorAll('#advice .advice').length, empty: document.querySelectorAll('#advice .empty').length, limits: document.querySelectorAll('#limits li').length })`));
  const routeCount = advice.roles.reduce((n, r) => n + r.routes.length, 0), adviceCount = advice.roles.reduce((n, r) => n + r.advice.length, 0);
  check('routing: the page is in the rail as the active page', /Route advice/.test(page.active), page.active);
  check('routing: the evidence totals come from the ledger and match the API', page.stats.join() === [advice.coverage.rows, advice.coverage.usable, advice.coverage.cancelledLeftOut, advice.coverage.roleRuns, advice.coverage.roleRunsWithoutAttempts, advice.coverage.ratings].join(), JSON.stringify(page.stats));
  check('routing: one table per role and one row per route', page.tables === advice.roles.length && page.rows === routeCount, JSON.stringify({ page, roles: advice.roles.length, routeCount }));
  check('routing: every piece of advice is shown, or an honest "no advice" is', adviceCount ? page.advice === adviceCount : page.empty === 1, JSON.stringify({ shown: page.advice, api: adviceCount }));
  check('routing: it says what it cannot tell you (completion, not quality)', page.limits >= 5 && /not whether the answer was good/.test(await js(`document.getElementById('limits').innerText`)));

  // Cross-check the numbers on screen against the API, row by row: the Attempts column and the Evidence badge.
  const shown = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#roles tbody tr')].map((tr) => ({ attempts: tr.children[1].textContent, finished: tr.children[2].textContent, evidence: tr.querySelector('.conf').textContent })))`));
  const wanted = advice.roles.flatMap((r) => r.routes.map((s) => ({ attempts: String(s.attempts), finished: s.reliability == null ? 'unknown' : `${Math.round(s.reliability * 100)}%`, evidence: s.confidence })));
  check('routing: attempts, finished-rate and evidence level on screen equal the API for every route', JSON.stringify(shown) === JSON.stringify(wanted), JSON.stringify(shown.slice(0, 2)));

  const cells = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#roles tbody tr')].map((tr) => ({ time: tr.children[5].textContent, cost: tr.children[6].textContent })))`));
  const routes = advice.roles.flatMap((r) => r.routes);
  const bad = routes.flatMap((s, i) => [
    ...(s.seconds.avg == null && cells[i].time !== 'unknown' ? [`time row ${i}: ${cells[i].time}`] : []),
    ...(s.cost.avgUsd == null && cells[i].cost !== 'unknown' ? [`cost row ${i}: ${cells[i].cost}`] : []),
    ...(s.cost.avgUsd === 0 && !/recorded as \$0/.test(cells[i].cost) ? [`$0 row ${i}: ${cells[i].cost}`] : []),
  ]);
  check('routing: a missing time or cost reads "unknown", and a recorded $0 says so (never "free")', cells.length === routes.length && bad.length === 0 && !/\bfree\b/i.test(cells.map((c) => c.cost).join(' ')), bad.join('; '));
  check('routing: the live ledger exercises both the unknown and the recorded-$0 paths (else this check proves little)', routes.some((s) => s.cost.avgUsd == null) && routes.some((s) => s.cost.avgUsd === 0), 'skipped if the ledger lacks them');
  const fetches = JSON.parse(await js(`JSON.stringify(window.__fetches)`));
  check('routing: the page only ever reads: every request it makes is a GET', fetches.some((f) => /\/api\/routing\//.test(f.url)) && fetches.every((f) => f.method === 'GET'), JSON.stringify(fetches.slice(0, 3)));
  check('routing: nothing on the page can change a route (no buttons, inputs, selects or forms)', (await js(`document.querySelectorAll('#roles button, #roles input, #roles select, #advice button, #advice input, form').length`)) === 0);
}
