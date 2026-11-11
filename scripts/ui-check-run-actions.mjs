// scripts/ui-check-run-actions.mjs - what you can do with one run in the Plan Library: rate it, and export it as Markdown.
// Run with a run's detail already open. Two things are stubbed on the page so this can run against your real history:
// the rating request (it must never write your real ratings file) and the browser's save/clipboard (so we can read what it would write).
// Fetching the Markdown itself is read-only and goes to the real server.

export async function runActionChecks({ js, check, sleep }) {
  await js(`window.__rated = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (u, o) => { if (!String(u).includes('/rating')) return realFetch(u, o);
      window.__rated.push({ url: String(u), body: JSON.parse(o.body) });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, rating: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } })); };
    window.__saved = []; window.__copied = null;
    URL.createObjectURL = (blob) => { window.__blob = blob; return 'blob:stub'; };
    HTMLAnchorElement.prototype.click = function () { window.__saved.push(this.download); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__copied = t; return Promise.resolve(); } } });`);

  // --- rating ---
  const group = JSON.parse(await js(`JSON.stringify((() => { const g = document.querySelector('#detail .actbar'); return g && { label: g.getAttribute('aria-label'), buttons: [...g.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')]) }; })())`));
  check('a run offers "Useful" and "Not useful" in a labelled group, neither pre-selected',
    !!group && /useful/i.test(group.label) && JSON.stringify(group.buttons) === JSON.stringify([['Useful', 'false'], ['Not useful', 'false']]), JSON.stringify(group));
  await js(`document.querySelector('#detail [data-act=rate][data-value="1"]').click()`);
  await sleep(900);
  const sent = JSON.parse(await js('JSON.stringify(window.__rated)'));
  check('"Useful" sends 1 for this one run', sent.length === 1 && sent[0].body.value === 1 && /\/api\/history\/[0-9a-f]{8}\/rating$/.test(sent[0].url), JSON.stringify(sent));
  check('keyboard focus is still on the button after the page redraws', (await js(`document.activeElement && document.activeElement.dataset && document.activeElement.dataset.value`)) === '1');

  // --- export ---
  const share = JSON.parse(await js(`JSON.stringify((() => { const g = document.querySelector('#detail [aria-label="Share this run"]'); return g && [...g.querySelectorAll('button')].map((b) => b.textContent); })())`));
  check('a run offers Download and Copy Markdown in a labelled group', JSON.stringify(share) === JSON.stringify(['Download Markdown', 'Copy Markdown']), JSON.stringify(share));
  const id = await js(`document.querySelector('#detail [data-act=export]').dataset.id`);
  await js(`document.querySelector('#detail [data-act=export]').click()`);
  await sleep(1200);
  const saved = JSON.parse(await js(`JSON.stringify({ names: window.__saved, size: window.__blob ? window.__blob.size : 0, type: window.__blob ? window.__blob.type : '', toast: document.getElementById('toast').textContent })`));
  check('Download Markdown saves kings-reach-<kind>-<id>.md as text/markdown', saved.names.length === 1 && saved.names[0] === `kings-reach-build-${id}.md` && /^text\/markdown/.test(saved.type) && saved.size > 300, JSON.stringify(saved));
  check('the download is confirmed in the toast', /Saved kings-reach-build-/.test(saved.toast));
  await js(`document.querySelector('#detail [data-act=copy]').click()`);
  await sleep(1200);
  const copied = await js('window.__copied');
  check('Copy Markdown puts the whole report on the clipboard', typeof copied === 'string' && copied.startsWith(`# King's Reach report: build ${id}`) && /## Changed files/.test(copied) && /## Run/.test(copied), String(copied).slice(0, 80));
  check('the report is not shipped with secret-looking values', !/sk-ant-|-----BEGIN [A-Z ]*PRIVATE KEY/.test(copied || ''));
}
