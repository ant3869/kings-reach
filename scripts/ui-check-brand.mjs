// scripts/ui-check-brand.mjs - the crest and the War Room's voice notices, in real Chrome.
// Split out of ui-check.mjs to keep that file under 600 lines; everything it needs is passed in so it shares the runner's browser and tally.

export async function brandChecks({ open, js, check, sleep }) {
  // --- The crest is on every page: tab icon links, and the nav crest really loads (a broken image has naturalWidth 0) ----------------
  for (const page of ['/', '/warroom', '/history', '/providers']) {
    await open(page, { fake: page === '/warroom' });
    await sleep(500);
    const f = JSON.parse(await js(`JSON.stringify({
      icon: [...document.querySelectorAll('link[rel=icon]')].map((l) => l.getAttribute('href')),
      touch: !!document.querySelector('link[rel=apple-touch-icon]'),
      nav: (() => { const i = document.querySelector('.kr-seal img'); return i ? { w: i.naturalWidth, shown: Math.round(i.getBoundingClientRect().width) } : null; })() })`));
    check(`crest ${page}: tab icon and touch icon are linked`, f.icon.includes('/brand/favicon.ico') && f.touch, JSON.stringify(f));
    check(`crest ${page}: the nav crest loads and is shown at 44px`, !!f.nav && f.nav.w >= 96 && f.nav.shown === 44, JSON.stringify(f.nav));
  }
  await open('/warroom', { fake: true });
  await sleep(500);
  check('royal: no little crest badge on the cards (they were removed)', JSON.parse(await js(`document.querySelectorAll('.seat svg.crest').length`)) === 0);
  const head = JSON.parse(await js(`JSON.stringify((() => { const i = document.querySelector('.wr-crest'); return i ? { w: i.naturalWidth, shown: Math.round(i.getBoundingClientRect().width) } : null; })())`));
  check('crest War Room: the header crest loads and is shown at 72px', !!head && head.w >= 256 && head.shown === 72, JSON.stringify(head));

  // --- Royal look is the default; ?royal=0 turns it off and is remembered; ?royal=1 brings it back ------------------------------
  const royal = () => js(`document.documentElement.hasAttribute('data-royal')`);
  await open('/warroom', { fake: true, pre: `try { localStorage.clear(); } catch (e) {}` });
  check('royal: a browser that never chose gets the royal look', (await royal()) === true);
  await open('/warroom?royal=0', { fake: true });
  check('royal: ?royal=0 turns it off', (await royal()) === false);
  await open('/warroom', { fake: true });
  check('royal: and the choice is remembered on the next visit', (await royal()) === false);
  await open('/warroom?royal=1', { fake: true });
  check('royal: ?royal=1 brings it back', (await royal()) === true);

  // --- A silent run says why: with "Agents speak aloud" unticked the page says so, once --------------------------------------------
  await open('/warroom', { fake: true });
  const notices = () => js(`[...document.querySelectorAll('#log .sys')].filter((e) => /Voices are off/.test(e.textContent)).length`);
  await js(`document.getElementById('speak').checked = false; document.getElementById('msg').value = 'hello'; document.getElementById('send').click()`);
  await sleep(300);
  check('voices: sending with "Agents speak aloud" unticked says the run will be silent', (await notices()) === 1);
  await js(`document.getElementById('msg').value = 'again'; document.getElementById('send').click()`);
  await sleep(300);
  check('voices: and says it only once, not on every message', (await notices()) === 1);
  await js(`document.getElementById('speak').checked = true; document.getElementById('speak').onchange(); document.getElementById('msg').value = 'loud'; document.getElementById('send').click()`);
  await sleep(300);
  check('voices: with the box ticked there is no notice', (await notices()) === 1);
}
