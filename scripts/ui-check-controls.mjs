// scripts/ui-check-controls.mjs - the browser checks for the page controls: Stop War Room's confirm-first flow, the War Room
// icons and composer row, and the hold-to-talk button. Split out of ui-check.mjs to keep that file under 600 lines.
// Everything it needs from the runner is passed in, so it shares the runner's one browser and one tally.

export async function controlChecks({ open, js, check, sleep, cdp }) {
  // --- Dashboard: Stop War Room is refused while work runs, asks first, and only "stop anyway" sends force ----------------------
  // The stop request and the dialog are stubbed on the page: this must never be able to reach the real War Room.
  const stopStub = (answer) => `window.__stops = []; window.__asked = []; window.__answer = ${answer};
    window.confirm = (m) => { window.__asked.push(m); return window.__answer; };
    const realFetch = window.fetch.bind(window);
    window.fetch = (u, o) => { if (!String(u).includes('api/warroom/stop')) return realFetch(u, o);
      const body = o && o.body ? JSON.parse(o.body) : {}; window.__stops.push(body);
      return Promise.resolve(body.force === true
        ? new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ ok: false, busy: 2, error: 'The War Room is busy: 2 tasks are still running.' }), { status: 409, headers: { 'Content-Type': 'application/json' } })); };`;
  const pressStop = async () => { await js(`document.querySelector('[data-action="war-stop"]').click()`); await sleep(500); };
  const stopFacts = async () => JSON.parse(await js(`JSON.stringify({ stops: window.__stops, asked: window.__asked, notice: document.getElementById('notice').textContent })`));
  await open('/', { pre: stopStub('false') });
  await pressStop();
  const declined = await stopFacts();
  check('stop: a busy War Room asks before stopping, and saying no sends no second request', declined.asked.length === 1 && /still running/.test(declined.asked[0]) && declined.stops.length === 1 && declined.stops[0].force === undefined, JSON.stringify(declined));
  check('stop: declining says the work continues', /left running/.test(declined.notice) && /continues/.test(declined.notice), declined.notice);
  await open('/', { pre: stopStub('true') });
  await pressStop();
  const accepted = await stopFacts();
  check('stop: only an explicit yes sends force, after the plain request was refused', accepted.stops.length === 2 && accepted.stops[0].force === undefined && accepted.stops[1].force === true, JSON.stringify(accepted));
  check('stop: it says plainly that running work was ended', /running work was ended/.test(accepted.notice), accepted.notice);
  // --- War Room icons: they render, controls keep their meaning, the message box still fits, recording swaps its caption ----
  await open('/warroom', { fake: true });
  const drawnHidden = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.id || e.className || e.tagName))`));
  check('icons: nothing marked hidden is actually drawn (a display rule on a button once re-showed Cancel run while idle)', drawnHidden.length === 0, JSON.stringify(drawnHidden));
  const iconFacts = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('svg.ic')].map((s) => { const r = s.getBoundingClientRect(); const id = s.querySelector('use').getAttribute('href'); return { id, w: Math.round(r.width), h: Math.round(r.height), defined: !!document.querySelector(id) }; }))`));
  check('icons: every icon renders at a visible size and points at a real symbol', iconFacts.length >= 6 && iconFacts.every((i) => i.w >= 18 && i.h >= 18 && i.defined), JSON.stringify(iconFacts));
  const bar = JSON.parse(await js(`JSON.stringify(Object.fromEntries(['attachbtn', 'msg', 'send', 'summitbtn'].map((id) => [id, Math.round(document.getElementById(id).getBoundingClientRect().top)])))`));
  check('icons: attach, message box, Send and Convene stay on one row', new Set(Object.values(bar)).size === 1, JSON.stringify(bar));
  check('icons: Send still reads "Send" (the icon is decoration, not the label)', (await js(`document.getElementById('send').textContent.trim()`)) === 'Send' && (await js(`document.getElementById('buildbtn').textContent.trim()`)) === 'Build the verdict');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }); // a laptop-sized window, where the row is tightest
  await sleep(200);
  const fit = JSON.parse(await js(`(() => { const i = document.getElementById('msg'), cs = getComputedStyle(i); const c = document.createElement('canvas').getContext('2d'); c.font = cs.font;
    return JSON.stringify({ text: Math.ceil(c.measureText(i.placeholder).width), room: Math.floor(i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) }); })()`));
  check('icons: the message box placeholder is not cut off beside the wider buttons (at 1100px wide)', fit.text <= fit.room, JSON.stringify(fit));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const micBox = JSON.parse(await js(`JSON.stringify((() => { const r = document.getElementById('mic').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })())`));
  check('icons: hold-to-talk is a big, round target (at least 96px, far over the 44px touch minimum)', micBox.w >= 96 && micBox.h >= 96 && micBox.w === micBox.h, JSON.stringify(micBox));
  const micText = (cls) => js(`(() => { const e = document.querySelector('#mic .${cls}'); return e ? getComputedStyle(e).display : 'missing'; })()`);
  const micIdle = { cap: await micText('miccap'), rec: await micText('micrec') };
  await js(`document.getElementById('mic').classList.add('hot')`);
  const held = { cap: await micText('miccap'), rec: await micText('micrec') };
  await js(`document.getElementById('mic').classList.remove('hot')`);
  check('icons: holding the mic swaps "Hold to talk" for the recording caption, and releasing swaps it back', micIdle.cap !== 'none' && micIdle.rec === 'none' && held.cap === 'none' && held.rec !== 'none' && (await micText('micrec')) === 'none', JSON.stringify({ micIdle, held }));

  // --- Cards grow with the screen: a fixed 184px card was tiny on a wide monitor ------------------------------------------------
  const seatFacts = async () => JSON.parse(await js(`JSON.stringify({ zoom: Number(getComputedStyle(document.getElementById('council')).zoom), width: Math.round(document.querySelector('.seat').getBoundingClientRect().width), rows: new Set([...document.querySelectorAll('.seat')].map((s) => Math.round(s.getBoundingClientRect().top))).size, seats: document.querySelectorAll('.seat').length, ran: document.body.classList.contains('ran'), chips: document.querySelectorAll('#stages .stage').length })`));
  const screen = (width, height) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await open('/warroom', { fake: true });
  for (const [w, h, zoom] of [[1440, 900, 1], [1600, 900, 1.15], [1920, 1080, 1.3], [2560, 1440, 1.45]]) {
    await screen(w, h);
    await sleep(250);
    const s = await seatFacts();
    check(`cards: IDLE at ${w}x${h} the row is zoomed x${zoom}, cards are about ${Math.round(184 * zoom)}px wide, and all five stay on one row (the idle page draws stage chips; they must not shrink the cards)`, s.zoom === zoom && Math.abs(s.width - Math.round(184 * zoom)) <= 2 && s.rows === 1 && s.seats === 5 && !s.ran && s.chips > 0, JSON.stringify(s));
  }
  await open('/warroom?demo=build&speed=30&still=1', { fake: true });
  await screen(1920, 1080); // after open(): open() always resets the viewport to 1440x900
  await sleep(600);
  const running = await seatFacts();
  check('cards: while a run is going the compact size scales with the screen too (x0.8 at 1920px, still one row)', running.ran && running.zoom === 0.8 && running.rows === 1, JSON.stringify(running));
  await screen(1440, 900);
  await sleep(250);
  const runningSmall = await seatFacts();
  check('cards: while a run is going at 1440px they are the compact x0.62', runningSmall.ran && runningSmall.zoom === 0.62, JSON.stringify(runningSmall));
}
