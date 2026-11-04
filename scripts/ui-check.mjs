// scripts/ui-check.mjs - drives REAL Chrome over the DevTools protocol against the running dashboard (:3141).
// Run after a deploy:  node scripts/ui-check.mjs      (set CHROME_PATH if chrome-headless-shell lives elsewhere)
//
// The War Room's WebSocket is replaced by a recording fake before the page loads, so we can assert exactly what
// a click WOULD have sent (e.g. a Build) without spending money or touching the real council.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.UI_CHECK_BASE ?? 'http://127.0.0.1:3141';
const CHROME = process.env.CHROME_PATH ?? join(process.env.LOCALAPPDATA ?? '',
  'ms-playwright', 'chromium_headless_shell-1248', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Project drive only (never C:): the throwaway Chrome profile lives under the gitignored store/.
const PROFILES = join(dirname(dirname(fileURLToPath(import.meta.url))), 'store', 'ui-check');
mkdirSync(PROFILES, { recursive: true });
const profile = mkdtempSync(join(PROFILES, 'profile-'));
const chrome = spawn(CHROME, ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });

const FAKE_WS = `window.__sent = [];
window.WebSocket = class { constructor(u) { this.url = u; this.readyState = 1; this.binaryType = '';
  setTimeout(() => this.onopen && this.onopen({}), 40); }
  send(m) { window.__sent.push(String(m)); } close() {} };`;

let results = [];
function check(name, ok, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
}

// Fixed debugging ports can fall in a Windows-excluded range (bind error 0x271D), so let Chrome pick one and
// read it from the DevToolsActivePort file it writes into the profile.
async function connect() {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 75; i++) {
    try {
      if (!existsSync(portFile)) throw new Error('not yet');
      const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* chrome still starting */ }
    await sleep(200);
  }
  throw new Error(`Chrome did not start (CHROME_PATH=${CHROME}): ${chromeErr.slice(-400)}`);
}

const ws = new WebSocket(await connect());
await new Promise((resolve) => ws.addEventListener('open', resolve));
let nextId = 0;
const pending = new Map();
const loaded = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Page.loadEventFired') loaded.splice(0).forEach((fn) => fn());
});
const cdp = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + JSON.stringify(r.result.exceptionDetails.exception?.description));
  return r.result?.result?.value;
};
async function open(path, { fake = false, pre = '' } = {}) {
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  // Fixed desktop viewport: the headless default (~800px) wraps the five cards onto two rows, which would make
  // layout assertions depend on the window rather than the page.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const added = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `${fake ? FAKE_WS : ''}\n${pre}` });
  const done = new Promise((resolve) => loaded.push(resolve));
  await cdp('Page.navigate', { url: BASE + path });
  await done;
  await sleep(700); // fetches + the fake socket's onopen
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: added.result.identifier });
}
const sent = async () => JSON.parse(await js('JSON.stringify(window.__sent || [])')).map((s) => { try { return JSON.parse(s); } catch { return s; } });
const builds = async () => (await sent()).filter((m) => m && m.type === 'build').length;

try {
  // --- War Room hand-off from the Plan Library -------------------------------------------------
  const token = (ageMs) => `sessionStorage.setItem('kr-autobuild', JSON.stringify({plan:'89ef3ae8', t: Date.now() - ${ageMs}}));`;
  await open('/warroom', { fake: true, pre: token(1000) });
  check('fresh library token starts exactly one build', (await builds()) === 1, `sent=${JSON.stringify(await sent())}`);
  check('the token is single-use', (await js(`sessionStorage.getItem('kr-autobuild')`)) === null);

  await open('/warroom', { fake: true, pre: token(300000) });
  check('stale library token (5 min old) does NOT build', (await builds()) === 0);

  await open('/warroom', { fake: true });
  check('no token: opening the War Room never builds', (await builds()) === 0);

  await open('/warroom?autobuild=1', { fake: true });
  check('?autobuild=1 in the URL cannot trigger a build', (await builds()) === 0);

  await open('/warroom?ask=Reopen%20plan%20abc', { fake: true });
  check('?ask= prefills the message box', (await js(`document.getElementById('msg').value`)) === 'Reopen plan abc');
  check('?ask= never auto-sends anything', (await sent()).every((m) => ['ping', 'voice'].includes(m.type)), JSON.stringify(await sent()));
  check('?ask= is removed from the URL after use', !(await js('location.search')));
  check('War Room names the plan Build will run', (await js(`document.querySelector('.planline').textContent`)).includes('Build will execute plan'));

  // --- Card art on the live page: right art, loaded, aligned ------------------------------------
  const seats = async (query) => {
    await open(`/warroom?previewCards=${query}&still=1`, { fake: true });
    return JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.seat')].map((s) => {
      const r = s.getBoundingClientRect();
      const img = [...s.querySelectorAll('img')].find((i) => i.style.opacity === '1') || s.querySelector('.strip-a');
      return { id: s.id.slice(5), state: s.dataset.state, top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
        src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 };
    }))`));
  };
  // The art a seat may show is whatever the manifest pools say for its state; assert membership, not one filename.
  const manifest = await (await fetch(`${BASE}/warroom/card-states/manifest.json`)).json();
  const allowed = (state, id) => manifest.pools[state].map(([tpl]) => `/warroom/card-states/${tpl.replace('{role}', id)}`);
  const showsPool = (c, state) => allowed(state, c.id).includes(c.src);
  const urls = [...new Set(Object.keys(manifest.pools).flatMap((s) => manifest.roles.flatMap((r) => allowed(s, r))))];
  const bad = [];
  for (let i = 0; i < urls.length; i += 40) {
    await Promise.all(urls.slice(i, i + 40).map(async (u) => {
      const res = await fetch(BASE + u);
      if (!res.ok || res.headers.get('content-type') !== 'image/webp') bad.push(`${u} ${res.status}`);
    }));
  }
  check(`every manifest image is served as image/webp (${urls.length} files)`, bad.length === 0, bad.slice(0, 3).join('; '));

  let cards = await seats('speaking');
  check('all five cards have loaded art', cards.length === 5 && cards.every((c) => c.loaded), cards.map((c) => c.loaded).join());
  check('speaker shows speaking art from its pool, the others stay idle', cards.every((c) => showsPool(c, c.id === 'main' ? 'speaking' : 'idle')), cards.map((c) => c.src.split('/').slice(-2).join('/')).join(' '));
  const rest = cards.filter((c) => c.id !== 'main');
  check('non-speaking cards share one top edge and size', rest.every((c) => c.top === rest[0].top && c.w === rest[0].w && c.h === rest[0].h), JSON.stringify(rest.map((c) => [c.top, c.w, c.h])));
  check('the speaker is lifted above the row', cards.find((c) => c.id === 'main').top <= rest[0].top - 6, `main ${cards[0].top}px vs row ${rest[0].top}px`);
  cards = await seats('building');
  check('building shows every card in its building art', cards.every((c) => showsPool(c, 'building') && c.loaded));
  cards = await seats('thinking');
  check('thinking changes only the thinker', cards.every((c) => showsPool(c, c.id === 'research' ? 'thinking' : 'idle')));
  // Each seat in a DIFFERENT state at once: the point of the variant system.
  const mix = { main: 'offense', research: 'defense', comms: 'confused', content: 'defeated', ops: 'researching' };
  await open(`/warroom?previewPoses=${Object.entries(mix).map(([id, s]) => `${id}:${s}`).join(',')}&still=1`, { fake: true });
  cards = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.seat')].map((s) => {
    const img = [...s.querySelectorAll('img')].find((i) => i.style.opacity === '1');
    return { id: s.id.slice(5), state: s.dataset.state, src: img.getAttribute('src'), loaded: img.complete && img.naturalWidth > 0 };
  }))`));
  check('five seats can each show a different state at once', cards.every((c) => c.state === mix[c.id] && showsPool(c, mix[c.id]) && c.loaded), cards.map((c) => `${c.id}:${c.state}`).join(' '));
  check('cards never use the removed live-subtitle overlay', (await js(`document.querySelectorAll('[data-sub]').length`)) === 0);

  // --- Live status: replay synthetic events through the real handlers (no agents, no cost) --------
  const waitFor = async (expr, ms = 9000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr)) return true; await sleep(100); } return false; };
  const badge = `document.getElementById('nowbadge').textContent`;
  const meterNow = `Number(document.getElementById('meter').getAttribute('aria-valuenow'))`;

  await open('/warroom?demo=build&speed=8&still=1', { fake: true });
  check('mid-build: badge says WORKING and the meter is partway', await waitFor(`/WORKING/.test(${badge}) && ${meterNow} > 0 && ${meterNow} < 100`));
  check('mid-build: an agent row names the current action with real counts', await waitFor(`!!document.querySelector('.arow.working') && /Editing|Reading|Searching/.test(document.querySelector('.arow.working .txt').textContent)`));
  check('mid-build: the working agent\'s card carries a text badge, not just a glow', await waitFor(`/working/.test(document.getElementById('badge-ops').textContent)`));
  check('mid-build: ops is drawn in building art', await waitFor(`document.getElementById('seat-ops').dataset.state === 'building'`));
  check('mid-build: commentary is visible as a caption even with speech off', await waitFor(`document.getElementById('caption').textContent.length > 10`));
  check('progress bar is accessible (role, range, live label)', await js(`(() => { const m = document.getElementById('meter'); return m.getAttribute('role') === 'progressbar' && m.getAttribute('aria-valuemax') === '100' && document.getElementById('nowlabel').getAttribute('aria-live') === 'polite'; })()`));
  check('the demo never sends anything to the server', (await sent()).every((m) => ['ping', 'voice'].includes(m.type)), JSON.stringify(await sent()));
  check('a finished build ends DONE at exactly 100%', await waitFor(`/DONE/.test(${badge}) && ${meterNow} === 100`, 30000));
  check('finished build: no seat is left in building art and no badge says working', await js(`[...document.querySelectorAll('.seat')].every((s) => s.dataset.state !== 'building') && ![...document.querySelectorAll('.badge')].some((b) => /working/.test(b.textContent))`));
  check('finished build: the build panel has no cell stuck on waiting/active', await js(`[...document.querySelectorAll('.buildphase')].length === 4 && [...document.querySelectorAll('.buildphase')].every((c) => c.classList.contains('done'))`));
  check('finished build: every stage chip is done', await js(`['preflight','execute','gate','review'].every((n) => document.getElementById('st-' + n) && document.getElementById('st-' + n).classList.contains('done'))`));

  await open('/warroom?demo=build-fail&speed=30&still=1', { fake: true });
  check('failed build ends FAILED (never 100%) with a visible reason', await waitFor(`/FAILED/.test(${badge}) && ${meterNow} < 100`, 15000) && /checks failed/i.test(await js(`document.getElementById('feed').textContent + document.getElementById('caption').textContent`)));
  check('failed build: the gate chip is FAILED, not success-coloured, and review is skipped', await js(`document.getElementById('st-gate').classList.contains('failed') && document.getElementById('st-review').classList.contains('skipped')`));
  check('failed build: the build panel shows gate failed + review skipped, nothing stuck', await js(`(() => { const c = [...document.querySelectorAll('.buildphase')].map((x) => x.className.replace('buildphase ', '')); return c.join() === 'done,done,failed,skipped'; })()`));
  check('failed build: the badge states the actual cause', /Automated checks failed/.test(await js(`document.getElementById('nowlabel').textContent`)));
  check('failed build: the fallback warning is fully on screen, not clipped', await js(`(() => { const w = document.querySelector('#feed li.warn'); const p = document.getElementById('now').getBoundingClientRect(); if (!w) return false; const r = w.getBoundingClientRect(); return r.height > 0 && r.bottom <= p.bottom + 1; })()`));
  check('failed build: the cards react (defeated pose)', await waitFor(`[...document.querySelectorAll('.seat')].some((s) => s.dataset.state === 'defeated')`, 4000));
  check('failed build: the fallback is visible in the feed', await js(`/could not finish/.test(document.getElementById('feed').textContent)`));

  await open('/warroom?demo=summit&speed=30&still=1', { fake: true });
  check('summit scoreboard shows minds changed as MEASURED, with the claim beside it', await waitFor(`/1 measured \\(2 claimed\\)/.test(document.getElementById('score').textContent)`, 9000));
  check('scoreboard flags the answer that came from a route without tools', await js(`/answered without tools/.test(document.getElementById('score').textContent)`));
  check('scoreboard lists per-agent confidence shifts, including a tool-less hold-up', await js(`(() => { const t = document.getElementById('score').textContent; return /research: 0\\.91 \\u2192 0\\.62/.test(t) && /held up \\(no tools\\)/.test(t) && /claimed a change/.test(t); })()`));

  await open('/warroom?demo=stall&speed=20&still=1', { fake: true });
  const seen = new Set();
  for (const end = Date.now() + 14000; Date.now() < end && !seen.has('CANCELLED');) {
    for (const word of ['WORKING', 'QUIET', 'STALLED', 'CANCELLED']) if (new RegExp(word).test(await js(badge))) seen.add(word);
    await sleep(100);
  }
  check('silence escalates WORKING -> QUIET -> STALLED, then CANCELLED is its own state', ['WORKING', 'QUIET', 'STALLED', 'CANCELLED'].every((w) => seen.has(w)), [...seen].join());
  check('cancelled is not shown as a failure', !/FAILED/.test(await js(badge)));
  check('the old wall-clock "thinking:" line is gone (the panel owns timing)', (await js(`document.getElementById('prog').textContent`)) === '');
  await open('/warroom?demo=stall&speed=40&still=1', { fake: true });
  check('a stalled seat keeps a lasting outline after its pose art reverts', await waitFor(`document.getElementById('seat-ops').dataset.live === 'stalled'`, 9000));


  // --- Plan Library -----------------------------------------------------------------------------
  await open('/history', { fake: true });
  const rows = () => js(`document.querySelectorAll('#list button').length`);
  const total = await rows();
  check('library lists every run', total >= 8, `${total} rows`);
  check('stats are populated', (await js(`document.querySelectorAll('#stats .stat').length`)) === 6);

  await js(`document.querySelector('.chip[data-kind=build]').click()`);
  check('"Builds" filter shows only builds', (await js(`[...document.querySelectorAll('#list .badge.kind-build')].length === document.querySelectorAll('#list button').length`)) && (await rows()) >= 2);
  await js(`document.querySelector('.chip[data-kind=all]').click()`);

  await js(`(()=>{const q=document.getElementById('q');q.value='c39601ea';q.dispatchEvent(new Event('input'))})()`);
  check('search by run id narrows the list to one', (await rows()) === 1);
  await js(`(()=>{const q=document.getElementById('q');q.value='';q.dispatchEvent(new Event('input'))})()`);

  await js(`document.querySelector('#list button[data-id="89ef3ae8"]').click()`);
  await sleep(600);
  const detail = await js(`document.getElementById('detail').innerText`);
  check('selecting a plan shows verdict, steps and follow-through', /Verdict/i.test(detail) && /Plan \(21 steps\)/i.test(detail) && /Follow-through/i.test(detail));
  check('deep link is reflected in the URL', (await js('location.hash')) === '#run=89ef3ae8');

  await js(`document.querySelector('#detail [data-act=build]').click()`);
  await sleep(600);
  check('"Build this plan" asks for confirmation first', (await js(`document.getElementById('confirm').open`)) === true);
  const dialog = await js(`document.getElementById('confirm').innerText`);
  check('the confirmation warns this plan was already built', /already been built \d+ time/.test(dialog), dialog.slice(0, 120).replace(/\n/g, ' '));
  await js(`document.querySelector('#confirm [value=cancel]').click()`);
  await sleep(200);
  check('cancelling builds nothing and leaves no token', (await js(`document.getElementById('confirm').open`)) === false && (await js(`sessionStorage.getItem('kr-autobuild')`)) === null && (await builds()) === 0);

  await js(`document.querySelector('#list button[data-id="e91a379f"]').click()`);
  await sleep(600);
  const buildText = await js(`document.getElementById('detail').innerText`);
  check('a build links back to the plan it executed', /Executed plan\s+89ef3ae8/.test(buildText));
  check('a failed build explains why', /did not complete|failed|not approved/i.test(buildText));

  await js(`document.querySelector('#detail [data-act=reconvene]').click()`);
  await sleep(1200);
  check('"Reconvene" opens the War Room with a prefilled, unsent prompt',
    (await js('location.pathname')) === '/warroom' && /reopen the saved plan from run 89ef3ae8/i.test(await js(`document.getElementById('msg').value`)));
} catch (err) {
  check('ui-check ran to completion', false, String(err));
} finally {
  ws.close();
  chrome.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* chrome may still hold a lock; temp dir, harmless */ }
}

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} of ${results.length} FAILED` : `\nALL ${results.length} UI CHECKS PASS`);
process.exit(failed ? 1 : 0);
