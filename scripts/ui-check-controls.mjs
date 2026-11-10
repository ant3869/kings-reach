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
  check('icons: every icon renders at a visible size and points at a real symbol', iconFacts.length >= 5 && iconFacts.every((i) => i.w >= 18 && i.h >= 18 && i.defined), JSON.stringify(iconFacts));
  const bar = JSON.parse(await js(`JSON.stringify(Object.fromEntries(['attachbtn', 'msg', 'send', 'summitbtn', 'buildbtn', 'cancelbtn'].map((id) => [id, Math.round(document.getElementById(id).getBoundingClientRect().top)])))`));
  check('icons: attach, message box, Send, Convene, Build and Hush all stay on one row', new Set(Object.values(bar)).size === 1, JSON.stringify(bar));
  // --- Icon-only buttons: no words on them, a name for assistive tech, a tooltip on hover and on keyboard focus ------------------
  const iconIds = ['attachbtn', 'send', 'summitbtn', 'buildbtn', 'cancelbtn'];
  const facts = JSON.parse(await js(`JSON.stringify(${JSON.stringify(iconIds)}.map((id) => { const b = document.getElementById(id), r = b.getBoundingClientRect(); return { id, text: b.textContent.trim(), name: b.getAttribute('aria-label'), tip: b.dataset.tip, w: Math.round(r.width), h: Math.round(r.height) }; }))`));
  check('icon buttons: Attach, Send, Convene, Build and Hush show no words, keep a name and a tooltip, and are at least 44px', facts.every((f) => f.text === '' && f.name && f.tip && f.tip.startsWith(f.name) && f.w >= 44 && f.h >= 44), JSON.stringify(facts));
  const tipOf = (sel) => js(`(() => { const c = getComputedStyle(document.querySelector('${sel}'), '::after').content; return c === 'none' || c === 'normal' ? '' : c.slice(1, -1); })()`);
  const mouseTo = async (x, y) => { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(120); };
  await mouseTo(1, 1);
  const atRest = [];
  for (const id of iconIds) atRest.push(await tipOf('#' + id));
  check('icon buttons: no tooltip is showing until you point at or tab to a button', atRest.every((t) => t === ''), JSON.stringify(atRest));
  const shown = {};
  for (const f of facts) {
    const p = JSON.parse(await js(`JSON.stringify((() => { const r = document.getElementById('${f.id}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
    await mouseTo(p.x, p.y);
    shown[f.id] = await tipOf('#' + f.id);
  }
  check('icon buttons: pointing at each one shows its tooltip', facts.every((f) => shown[f.id] === f.tip), JSON.stringify(shown));
  await mouseTo(1, 1);
  await js(`document.getElementById('msg').focus()`);
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await sleep(120);
  const tabbed = JSON.parse(await js(`JSON.stringify({ id: document.activeElement.id, focusVisible: document.activeElement.matches(':focus-visible') })`));
  check('icon buttons: tabbing to Send shows its tooltip with no mouse at all', tabbed.id === 'send' && tabbed.focusVisible && (await tipOf('#send')) === 'Send (Enter)', JSON.stringify({ ...tabbed, tip: await tipOf('#send') }));
  const pinState = async () => JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.pin')].map((b) => ({ id: b.dataset.pin, pressed: b.getAttribute('aria-pressed'), tip: b.dataset.tip, name: b.getAttribute('aria-label'), text: b.textContent.trim() })))`));
  const rest = await pinState();
  check('pin: five icon-only buttons, each named for its agent, none pressed', rest.length === 5 && rest.every((p) => p.pressed === 'false' && p.text === '' && p.name.startsWith('Pin ') && p.tip.startsWith(p.name)), JSON.stringify(rest));
  await js(`onMessage({ pinned: 'research' })`);
  const on = await pinState();
  check('pin: pinning one agent presses only that button and its tooltip becomes "Unpin ..."', on.length === 5 && on.every((p) => (p.id === 'research') === (p.pressed === 'true') && p.tip.startsWith(p.id === 'research' ? 'Unpin ' : 'Pin ')), JSON.stringify(on));
  await js(`onMessage({ pinned: null })`);
  const off = await pinState();
  check('pin: unpinning puts every tooltip back to "Pin ..."', off.every((p) => p.pressed === 'false' && p.tip === rest.find((r) => r.id === p.id).tip), JSON.stringify(off));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false }); // a laptop-sized window, where the row is tightest
  await sleep(200);
  const fit = JSON.parse(await js(`(() => { const i = document.getElementById('msg'), cs = getComputedStyle(i); const c = document.createElement('canvas').getContext('2d'); c.font = cs.font;
    return JSON.stringify({ text: Math.ceil(c.measureText(i.placeholder).width), room: Math.floor(i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) }); })()`));
  check('icons: the message box placeholder is not cut off beside the wider buttons (at 1100px wide)', fit.text <= fit.room, JSON.stringify(fit));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const micBox = JSON.parse(await js(`JSON.stringify((() => { const r = document.querySelector('#mic .micface').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })())`));
  check('icons: hold-to-talk is a big, round target (at least 96px, far over the 44px touch minimum)', micBox.w >= 96 && micBox.h >= 96 && micBox.w === micBox.h, JSON.stringify(micBox));
  const art = JSON.parse(await js(`(async () => { const res = await fetch('/warroom/warroom-mic.webp'); const bg = getComputedStyle(document.querySelector('#mic .micface')).backgroundImage; const img = new Image(); img.src = /url\\("?([^")]+)/.exec(bg)[1]; await img.decode(); return JSON.stringify({ status: res.status, type: res.headers.get('content-type'), bg: bg.includes('warroom-mic.webp'), natural: img.naturalWidth }); })()`));
  check('mic art: the picture is served as image/webp, the button uses it, and it decodes at 320px', art.status === 200 && art.type === 'image/webp' && art.bg && art.natural === 320, JSON.stringify(art));
  check('mic art: the button still reads as one control named "Hold to talk" (picture hidden from assistive tech)', (await js(`(() => { const m = document.getElementById('mic'); return m.getAttribute('aria-label') + '|' + m.querySelector('.micface').getAttribute('aria-hidden') + '|' + m.querySelector('.miccap').textContent; })()`)) === 'Hold to talk (or hold Space)|true|Hold to talk');
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
    const dock = JSON.parse(await js(`JSON.stringify((() => { const m = document.getElementById('msg').getBoundingClientRect(), l = document.getElementById('log').getBoundingClientRect(); return { top: Math.round(m.top), bottom: Math.round(m.bottom), vh: innerHeight, logH: Math.round(l.height), scrolls: document.documentElement.scrollHeight > innerHeight }; })())`));
    check(`message box: at ${w}x${h} the message box is on screen without scrolling (page ${dock.scrolls ? 'is taller than the window, so the dock holds it' : 'fits'})`, dock.top >= 0 && dock.bottom <= dock.vh, JSON.stringify(dock));
    if (w >= 1500) check(`transcript: at ${w}x${h} the idle log is the shorter 36% of the height`, Math.abs(dock.logH - Math.round(h * 0.36)) <= 2 || dock.logH === 240, JSON.stringify(dock));
  }
  await open('/warroom?demo=build&speed=30&still=1', { fake: true });
  await screen(1920, 1080); // after open(): open() always resets the viewport to 1440x900
  await sleep(600);
  const running = await seatFacts();
  check('cards: while a run is going the compact size scales with the screen too (x0.8 at 1920px, still one row)', running.ran && running.zoom === 0.8 && running.rows === 1, JSON.stringify(running));
  const runLog = Number(await js(`Math.round(document.getElementById('log').getBoundingClientRect().height)`));
  check('transcript: while a run is going the log gets its height back (45% at 1080p)', Math.abs(runLog - Math.round(1080 * 0.45)) <= 2, String(runLog));
  await screen(1440, 900);
  await sleep(250);
  const runningSmall = await seatFacts();
  check('cards: while a run is going at 1440px they are the compact x0.62', runningSmall.ran && runningSmall.zoom === 0.62, JSON.stringify(runningSmall));
}
