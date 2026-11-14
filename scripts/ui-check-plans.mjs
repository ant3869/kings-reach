// scripts/ui-check-plans.mjs - Plan Library: revisions of a question, compare, and the plan of record, in real Chrome.
// Read-only against the live store. Promote is exercised with fetch stubbed IN THE PAGE, so the exact request is asserted but nothing is written
// to the real plan-of-record file. Cases are found from /api/history rather than hardcoded, and skipped (visibly) if a store has none.

const STUB_PROMOTE = `window.__posts = []; (() => { const real = window.fetch.bind(window);
  window.fetch = (url, opts) => { if (opts && opts.method === 'POST' && /\\/promote$/.test(String(url))) {
    window.__posts.push({ url: String(url), body: opts.body });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })); }
    return real(url, opts); }; })();`;

export async function planChecks({ open, js, check, sleep, base }) {
  const overview = await (await fetch(`${base}/api/history`)).json();
  const archived = new Set(overview.archived);
  const byThread = new Map();
  for (const r of overview.runs.filter((x) => x.kind === 'summit' && x.revisions > 1)) {
    const key = r.question.trim().toLowerCase().replace(/\s+/g, ' ');
    byThread.set(key, [...(byThread.get(key) ?? []), r]);
  }
  const threads = [...byThread.values()];
  const rich = threads.find((t) => t.filter((r) => archived.has(r.id)).length >= 2);
  const bare = threads.find((t) => t.every((r) => !archived.has(r.id)));
  const single = overview.runs.find((r) => r.kind === 'summit' && r.revisions === 1 && archived.has(r.id));

  const select = async (id) => { await js(`document.querySelector('#list button[data-id="${id}"]').click()`); await sleep(700); };
  const text = (sel) => js(`(document.querySelector(${JSON.stringify(sel)}) || {}).innerText || ''`);

  await open('/history', { pre: STUB_PROMOTE });
  check('plan library: the active-plan bar shows no plan-of-record warning when no plan of record exists', (await js(`document.querySelectorAll('#active .warnline').length`)) === 0);

  if (!rich) {
    check('plan library: lineage checks (no thread of 2+ archived plans in this store: skipped)', true, 'skipped');
  } else {
    const [a, b] = rich.filter((r) => archived.has(r.id));
    check('plan library: a thread member shows how many revisions its question has in the list', /\d+ revisions/.test(await text(`#list button[data-id="${a.id}"]`)));
    await select(a.id);
    const section = await text('#detail');
    check('plan library: the detail lists the revisions of the same question', new RegExp(`Revisions of this question \\(${a.revisions}\\)`, 'i').test(section)); // headings are uppercased by CSS, and innerText reflects that
    check('plan library: it says plainly that the grouping is inferred', /inferred/i.test(section) && /identical question text/i.test(section));
    check('plan library: this plan is marked, and the other archived revision offers Compare',
      /this plan/.test(section) && (await js(`document.querySelectorAll('#detail [data-act=compare][data-other="${b.id}"]').length`)) === 1);
    check('plan library: no plan of record is claimed before one is chosen', (await js(`[...document.querySelectorAll('#detail .badge')].filter((x) => /plan of record/i.test(x.textContent)).length`)) === 0);

    await js(`document.querySelector('#detail [data-act=compare][data-other="${b.id}"]').click()`);
    await sleep(700);
    const cmp = await text('#compare');
    check('plan library: compare shows both plan ids, what changed and what running each cost',
      cmp.includes(a.id) && cmp.includes(b.id) && /What running each cost/.test(cmp) && /Objective (unchanged|changed)/.test(cmp), cmp.slice(0, 160).replace(/\n/g, ' '));
    check('plan library: compare is honest that step pairing is a heuristic', /heuristic/i.test(cmp) || !/Steps/.test(cmp));
    check('plan library: compare renders no script or live markup from plan text', (await js(`document.querySelectorAll('#compare script, #compare img').length`)) === 0);

    const btn = await js(`(() => { const x = document.querySelector('#detail [data-act=promote]'); return x ? JSON.stringify({ t: x.textContent, p: x.getAttribute('aria-pressed'), v: x.dataset.value }) : null })()`);
    const parsed = btn ? JSON.parse(btn) : null;
    check('plan library: an unpromoted plan offers "Make plan of record"', !!parsed && parsed.t === 'Make plan of record' && parsed.p === 'false' && parsed.v === 'true', btn);
    await js(`document.querySelector('#detail [data-act=promote]').click()`);
    await sleep(900);
    const posts = JSON.parse(await js(`JSON.stringify(window.__posts)`));
    check('plan library: Make plan of record sends exactly one promote request with value true',
      posts.length === 1 && posts[0].url === `/api/history/${a.id}/promote` && JSON.parse(posts[0].body).value === true, JSON.stringify(posts));
    check('plan library: nothing was written to the real store by this check', !(await (await fetch(`${base}/api/history`)).json()).runs.some((r) => r.isPlanOfRecord));
  }

  if (!bare) {
    check('plan library: unarchived-revision checks (no such thread in this store: skipped)', true, 'skipped');
  } else {
    await select(bare[0].id);
    const d = await text('#detail');
    check('plan library: revisions without an archive are listed but flagged "not archived"', /not archived/i.test(d));
    check('plan library: and they offer neither Compare nor Make plan of record',
      (await js(`document.querySelectorAll('#detail [data-act=compare], #detail [data-act=promote]').length`)) === 0);
  }

  if (!single) {
    check('plan library: single-revision check (no such plan in this store: skipped)', true, 'skipped');
  } else {
    await select(single.id);
    check('plan library: a question asked once shows no revisions panel, but can still be made the plan of record',
      !/Revisions of this question/.test(await text('#detail')) && (await js(`document.querySelectorAll('#detail [data-act=promote]').length`)) === 1);
  }
}
