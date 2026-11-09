// scripts/ui-check.mjs - drives REAL Chrome over the DevTools protocol against the running dashboard (:3141).
// Run after a deploy:  node scripts/ui-check.mjs      (set CHROME_PATH if chrome-headless-shell lives elsewhere)
//
// The War Room's WebSocket is replaced by a recording fake before the page loads, so we can assert exactly what
// a click WOULD have sent (e.g. a Build) without spending money or touching the real council.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
window.WebSocket = class { constructor(u) { window.__ws = this; this.url = u; this.readyState = 1; this.binaryType = '';
  setTimeout(() => this.onopen && this.onopen({}), 40); }
  send(m) { window.__sent.push(typeof m === 'string' ? m : 'BINARY:' + m.byteLength); } close() {} };`;

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
  const showsPool = (c, state) => allowed(state, c.id).includes(c.src.split('?')[0]);
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
  const greet = JSON.stringify(JSON.stringify({ agent_id: 'war-room', text: 'Welcome to the War Room (server v0, test).' }));
  const greetings = () => js(`[...document.querySelectorAll('#log > *')].filter((b) => b.textContent.includes('server v0, test')).length`);
  await js(`window.__ws.onmessage({ data: ${greet} }); window.__ws.onmessage({ data: ${greet} }); window.__ws.onmessage({ data: ${greet} })`);
  check('reconnects do not stack Welcome bubbles: three greetings show once', (await greetings()) === 1, String(await greetings()));
  await js(`send(new Int16Array(16000).buffer)`);
  check('microphone audio goes out as one binary frame, not JSON', (await sent()).filter((m) => typeof m === 'string' && m.startsWith('BINARY:')).join() === 'BINARY:32000' && !(await sent()).some((m) => m && m.type === undefined && typeof m === 'object'), JSON.stringify(await sent()));
  check('card art URLs carry the client version so a stale cached copy can never show', await js(`[...document.querySelectorAll('.strip-a,.strip-b')].filter((i) => i.getAttribute('src')).every((i) => i.getAttribute('src').endsWith('?v=' + WR.version))`), '');
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
  check('failed build: the badge states the actual cause', /automated checks failed/i.test(await js(`document.getElementById('nowlabel').textContent`)));
  check('failed build: the fallback warning is fully on screen, not clipped', await js(`(() => { const w = document.querySelector('#feed li.warn'); const p = document.getElementById('now').getBoundingClientRect(); if (!w) return false; const r = w.getBoundingClientRect(); return r.height > 0 && r.bottom <= p.bottom + 1; })()`));
  check('failed build: the cards react (defeated pose)', await waitFor(`[...document.querySelectorAll('.seat')].some((s) => s.dataset.state === 'defeated')`, 4000));
  check('failed build: the fallback is visible in the feed', await js(`/could not finish/.test(document.getElementById('feed').textContent)`));

  // --- the Build result card: what happened, are my files still changed, what can I do (demo events only: no cost) ---
  const card = `document.getElementById('buildresult')`;
  const actionIds = `[...${card}.querySelectorAll('button[data-action]')].map((b) => b.dataset.action).join()`;
  check('failed build: a card says what happened and that the files are kept', await waitFor(`!${card}.hidden && /did not pass the checks/.test(${card}.textContent) && /3 files changed and kept on disk/.test(${card}.textContent)`, 8000));
  check('failed build: the only way forward offered is Fix (never keep or re-check failing code)', (await js(actionIds)) === 'fix');
  check('failed build: the check output is on the card', await js(`/TS2322/.test(${card}.textContent)`));

  await open('/warroom?demo=build-review&speed=30&still=1', { fake: true });
  check('review rejection ends NEEDS REVIEW, never FAILED', await waitFor(`/NEEDS REVIEW/.test(${badge}) && !/FAILED/.test(${badge})`, 15000), await js(badge));
  check('review rejection: the status line says why in plain words', await js(`/not satisfied/.test(document.getElementById('nowlabel').textContent)`));
  check('review rejection: the cards are NOT drawn defeated (nothing broke)', await js(`![...document.querySelectorAll('.seat')].some((s) => s.dataset.state === 'defeated')`));
  check('review rejection: the build panel marks the review amber, not red', await js(`document.querySelector('.buildphase.attention') !== null && document.querySelector('.buildphase.failed') === null`));
  check('card: headline, what happened to the files, and what is still wrong', await js(`/Built, but Research is not satisfied/.test(${card}.textContent) && /kept exactly as written/.test(${card}.textContent) && /never measured/.test(${card}.querySelector('.rissues').textContent)`));
  check('card: the kept files are listed', await js(`/3 files changed and kept on disk/.test(${card}.textContent) && ${card}.querySelectorAll('.rlist li').length === 3`));
  check('card: three options, each explained in visible text (not just a tooltip)', (await js(actionIds)) === 'review,fix,accept' && await js(`[...${card}.querySelectorAll('.raction')].every((r) => r.querySelector('.rhint').textContent.length > 30)`));
  check('card: amber border, and the badge carries a glyph and a word', await js(`getComputedStyle(${card}).borderTopColor === 'rgb(227, 179, 65)' && /NEEDS YOUR DECISION/.test(${card}.querySelector('.rbadge').textContent)`));
  check('card: no inline handlers or markup injection (text only)', await js(`${card}.querySelectorAll('[onclick], script, img').length === 0`));
  await js(`document.querySelector('#buildresult button[data-action=fix]').click(); document.querySelector('#buildresult button[data-action=fix]').click();`);
  const followups = (await sent()).filter((m) => m && m.type === 'build_followup');
  check('clicking Fix sends exactly one build_followup (a second click while it runs does nothing)', followups.length === 1 && followups[0].action === 'fix', JSON.stringify(followups));
  check('while a follow-up runs every option is disabled, and the page never asks for a whole new build', await js(`[...${card}.querySelectorAll('button[data-action]')].every((b) => b.disabled)`) && (await builds()) === 0);
  await js(`window.__ws.onmessage({ data: JSON.stringify({ type: 'meter', pct: 55, phase: 'cancelled', label: 'cancelled', failed: false, state: 'cancelled', final: true, note: '' }) })`);
  check('when that run ends (even cancelled) the options come back', await js(`[...${card}.querySelectorAll('button[data-action]')].every((b) => !b.disabled)`));
  await js(`window.__ws.onmessage({ data: JSON.stringify({ type: 'build_result', state: 'attention', headline: 'Replayed card', detail: 'sent to a page that just connected', issues: [], files: [], output: '', actions: [{ id: 'accept', label: 'Keep as is', hint: 'Accept the files as they are. Free. Restarts the core if the changes need it.' }] }) })`);
  check('a card sent on connect (after a refresh) shows its buttons again', (await js(actionIds)) === 'accept' && /Replayed card/.test(await js(`${card}.textContent`)));
  await js(`document.getElementById('buildbtn').click()`);
  check('starting a new build clears the old card (it describes files about to change)', await js(`${card}.hidden === true && ${card}.textContent === ''`) && (await builds()) === 1);

  await open('/warroom?demo=build&speed=30&still=1', { fake: true });
  check('a clean build gets a plain BUILT card with no buttons', await waitFor(`!${card}.hidden && /BUILT/.test(${card}.textContent) && ${card}.querySelectorAll('button').length === 0`, 15000));

  await open('/warroom?demo=summit&speed=30&still=1', { fake: true });
  // Make the footer deliberately stale; a verdict must refresh it (a real summit left it naming the previous plan).
  await js(`document.getElementById('planbox').innerHTML = '<b>STALE</b>'`);
  check('a locked verdict refreshes the "Build will execute plan" line', await waitFor(`!/STALE/.test(document.getElementById('planbox').textContent) && /Build will execute plan|No plan on file/.test(document.getElementById('planbox').textContent)`, 9000));
  check('the plan line endpoint serves the same fragment the page renders', (await (await fetch(`${BASE}/warroom/planline`)).text()).includes('planline'));
  check('summit scoreboard shows minds changed as MEASURED, with the claim beside it', await waitFor(`/1 measured \\(2 claimed\\)/.test(document.getElementById('score').textContent)`, 9000));
  check('a reworded-only seat is listed apart from changed minds and says its position is unchanged', await js(`(() => { const t = document.getElementById('score').textContent; return /reworded only\\s*content/.test(t) && /content: 0\\.80 \\u2192 0\\.78 \\u00b7 reworded only, position unchanged \\(21% wording kept\\)/.test(t) && !/content: .*claimed a change/.test(t); })()`));
  check('a finished summit has every stage chip resolved under its DONE badge', await waitFor(`['recall','plan','investigate','debate','verdict','record'].every((n) => document.getElementById('st-' + n) && document.getElementById('st-' + n).classList.contains('done'))`, 9000));
  check('a finished summit keeps a row for every agent that worked (main, research, ops), all DONE', await waitFor(`['main','research','ops'].every((id) => [...document.querySelectorAll('.arow')].some((r) => r.textContent.includes(id === 'main' ? 'Main' : id === 'research' ? 'Research' : 'Ops') && /DONE/.test(r.textContent)))`, 9000));
  check('no finished agent row still says "Starting"', await js(`![...document.querySelectorAll('.arow')].some((r) => /Starting/.test(r.textContent))`));
  check('an emptied caption leaves no styled empty bar behind', await js(`(() => { const c = document.getElementById('caption'); if (c.textContent.trim()) return true; const s = getComputedStyle(c); return s.backgroundColor === 'rgba(0, 0, 0, 0)' && (s.borderLeftColor === 'rgba(0, 0, 0, 0)' || s.borderLeftWidth === '0px'); })()`));
  check('the scoreboard never prints "undefined" or "NaN"', await js(`!/undefined|NaN/.test(document.getElementById('score').textContent)`));
  check('an uncapped tool-less debate answer is still labelled as such', await js(`/content: .*answered without tools/.test(document.getElementById('score').textContent)`));
  check('scoreboard flags the answer that came from a route without tools', await js(`/answered without tools/.test(document.getElementById('score').textContent)`));
  check('scoreboard lists per-agent confidence shifts, including a tool-less hold-up', await js(`(() => { const t = document.getElementById('score').textContent; return /research: 0\\.91 \\u2192 0\\.62/.test(t) && /held up \\(no tools\\)/.test(t) && /claimed a change/.test(t); })()`));

  // Last on purpose: the sparse row REPLACES the scoreboard, so every other scoreboard assertion must run before it.
  check('a sparse metrics row (older or partial data) renders without "undefined" or "NaN"', await js(`(() => { metrics({ type: 'metrics', kind: 'summit', outcome: 'verdict', id: 'sparse01', total_s: 5, specialists: [], mind_changes: {} }); return !/undefined|NaN/.test(document.getElementById('score').textContent) && /sparse01/.test(document.getElementById('score').textContent); })()`));

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

  // --- Card nameplates: live text on the blank plate, pin below the card, voice dropdown under the route ---
  await open('/warroom?previewCards=idle&still=1', { fake: true });
  const plate = JSON.parse(await js(`JSON.stringify(WR.council.map((c) => {
    const seat = document.getElementById('seat-' + c.id); const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
    const t = seat.querySelector('.ptitle'); const n = seat.querySelector('.pname');
    return { id: c.id, title: c.title, name: c.name, shownTitle: t.textContent, shownName: n.textContent,
      titlePx: parseFloat(getComputedStyle(t).fontSize), namePx: parseFloat(getComputedStyle(n).fontSize),
      fits: t.scrollWidth <= seat.querySelector('.plate').clientWidth + 1,
      card: box(seat.querySelector('.strip-a')), pin: box(seat.querySelector('.pin')), route: box(seat.querySelector('.route')), voice: box(seat.querySelector('.voice')), sel: box(seat.querySelector('.voice select')),
      selAlign: getComputedStyle(seat.querySelector('.voice select')).textAlignLast, routeAlign: getComputedStyle(seat.querySelector('.route')).textAlign,
      titleBox: box(t), nameBox: box(n), emblemLine: seat.querySelector('.rule').getBoundingClientRect().top }; }))`));
  check('nameplate: title is the big live line and the role name the small one beneath it', plate.every((p) => p.shownTitle === (p.title || p.name) && p.shownName === p.name && p.titlePx > p.namePx && p.titleBox.bottom <= p.nameBox.top + 1), JSON.stringify(plate.map((p) => [p.shownTitle, p.titlePx])));
  check('nameplate: every title fits the plate on one line', plate.every((p) => p.fits), plate.filter((p) => !p.fits).map((p) => p.title).join());
  check('layout: Pin sits below the card, not on it', plate.every((p) => p.pin.top >= p.card.bottom - 1), JSON.stringify(plate.map((p) => [Math.round(p.pin.top), Math.round(p.card.bottom)])));
  check('layout: route and voice are on the card plate, below the title and name', plate.every((p) => p.route.top >= p.nameBox.bottom - 1 && p.voice.top >= p.route.bottom - 1 && p.voice.bottom <= p.card.bottom), JSON.stringify(plate[0]));
  const mid = (b) => (b.left + b.right) / 2;
  check('alignment: title, role, route and voice are all centred on the card', plate.every((p) => [p.titleBox, p.nameBox, p.sel].every((b) => Math.abs(mid(b) - mid(p.card)) <= 1.5) && p.selAlign === 'center' && p.routeAlign === 'center'), JSON.stringify(plate.map((p) => [Math.round(mid(p.card)), Math.round(mid(p.titleBox)), Math.round(mid(p.nameBox)), Math.round(mid(p.sel))])));
  const rise = (key) => plate.map((p) => Math.round(p[key].top - p.card.top));
  check('alignment: the role, route and voice lines sit at the same height on every card', ['nameBox', 'route', 'sel'].every((k) => Math.max(...rise(k)) - Math.min(...rise(k)) <= 1), JSON.stringify({ role: rise('nameBox'), route: rise('route'), voice: rise('sel') }));
  const cast = { type: 'casting', current: { main: 'bm_george', research: 'bm_fable', comms: 'bf_isabella', content: 'af_heart', ops: 'am_onyx' },
    voices: [['af_heart', 'Heart', 'American female'], ['am_onyx', 'Onyx', 'American male'], ['bf_isabella', 'Isabella', 'British female'], ['bm_fable', 'Fable', 'British male'], ['bm_george', 'George', 'British male']].map(([id, name, group]) => ({ id, name, group })) };
  await js(`window.__ws.onmessage({ data: ${JSON.stringify(JSON.stringify(cast))} })`);
  const picks = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('select[data-voice-for]')].map((s) => ({ id: s.dataset.voiceFor, value: s.value, options: s.options.length, groups: s.querySelectorAll('optgroup').length })))`));
  check('voice dropdown: every seat lists the server voices with its own voice selected', picks.length === 5 && picks.every((p) => p.options === 5 && p.groups === 4 && p.value === cast.current[p.id]), JSON.stringify(picks[0]));
  await js(`(function () { var s = document.querySelector('select[data-voice-for="ops"]'); s.value = 'bf_isabella'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  check('voice dropdown: choosing a voice sends set_voice for that seat only', JSON.stringify((await sent()).filter((m) => m.type === 'set_voice')) === JSON.stringify([{ type: 'set_voice', agent_id: 'ops', voice: 'bf_isabella' }]), JSON.stringify(await sent()));
  await js(`window.__ws.onmessage({ data: ${JSON.stringify(JSON.stringify({ ...cast, current: { ...cast.current, ops: 'am_onyx' } }))} })`);
  check('voice dropdown: the server answer puts the saved voice back', (await js(`document.querySelector('select[data-voice-for="ops"]').value`)) === 'am_onyx');
  const here = JSON.parse(await js(`JSON.stringify((function () { var r = document.querySelector('select[data-voice-for="main"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })())`));
  const border = () => js(`getComputedStyle(document.querySelector('select[data-voice-for="main"]')).borderTopColor`);
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(250);
  const resting = await border();
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: here.x, y: here.y }); await sleep(250);
  const hovered = await border();
  check('voice dropdown: looks like plain text until hovered, then shows it is a control', resting === 'rgba(0, 0, 0, 0)' && hovered !== resting, `${resting} -> ${hovered}`);
  const council = JSON.parse(await js(`JSON.stringify((function () { var r = document.getElementById('council').getBoundingClientRect(); return { x: r.left - 6, y: r.top - 6, width: r.width + 12, height: r.height + 12, scale: 1 }; })())`));
  const plateShot = await cdp('Page.captureScreenshot', { format: 'png', clip: council });
  mkdirSync(join(dirname(PROFILES), 'logs'), { recursive: true });
  writeFileSync(join(dirname(PROFILES), 'logs', 'live-nameplates.png'), Buffer.from(plateShot.result.data, 'base64'));

  // --- Provider settings: dropdowns of valid choices, never free text (nothing here is saved) ---------
  await open('/providers');
  for (let i = 0; i < 60 && !(await js(`document.querySelectorAll('.route').length`)); i++) await sleep(250); // the page's provider checks take a few seconds
  const routeInfo = JSON.parse(await js(`JSON.stringify({
    inputs: document.querySelectorAll('.route input').length,
    rows: document.querySelectorAll('.route').length,
    selects: [...document.querySelectorAll('.route')].every((r) => r.querySelector('select.prov') && r.querySelector('select.model')),
    invalid: document.querySelectorAll('select.model.invalid').length })`));
  check('provider page: routes are dropdowns (no free-text boxes)', routeInfo.rows > 0 && routeInfo.inputs === 0 && routeInfo.selects, JSON.stringify(routeInfo));
  check('provider page: every saved route is a valid pair (nothing flagged red)', routeInfo.invalid === 0, `${routeInfo.invalid} flagged`);
  // Screenshot BEFORE the switch test below mutates the page (an earlier shot showed the simulated switch, not the saved config).
  const shot = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  mkdirSync(join(dirname(PROFILES), 'logs'), { recursive: true });
  writeFileSync(join(dirname(PROFILES), 'logs', 'live-providers.png'), Buffer.from(shot.result.data, 'base64'));
  const afterSwitch = JSON.parse(await js(`(function () {
    var row = document.querySelector('.route'); var sel = row.querySelector('select.prov');
    sel.value = 'chatgpt'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    var m = [...document.querySelector('.route').querySelectorAll('select.model option')].map((o) => o.value);
    return JSON.stringify({ n: m.length, allCx: m.every((v) => v.startsWith('cx/')), flagged: document.querySelectorAll('select.model.invalid').length }); })()`));
  check('provider page: switching a route to ChatGPT offers only ChatGPT models, none flagged', afterSwitch.n > 0 && afterSwitch.allCx && afterSwitch.flagged === 0, JSON.stringify(afterSwitch));

  // --- Difficulty tiers editor: Low/High ends fill in the models between, which can be unticked (never saved) ---
  await open('/providers');
  for (let i = 0; i < 60 && !(await js(`document.querySelectorAll('.tprow').length`)); i++) await sleep(250);
  const tierState = () => js(`JSON.stringify({ on: document.getElementById('tiers-on').checked, ladder: (window.state.tiers && window.state.tiers.providers.claude) || null })`).then(JSON.parse);
  const setSel = async (cls, value) => { await js(`(function () { var s = document.querySelector('.tprow[data-provider="claude"] .${cls}'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); })()`); await sleep(150); };
  const claudeRanked = JSON.parse(await js(`JSON.stringify(window.ranked.claude || [])`));
  const tiersBox = JSON.parse(await js(`JSON.stringify({ off: document.getElementById('tiers').classList.contains('off'), checked: document.getElementById('tiers-on').checked, rows: document.querySelectorAll('.tprow').length,
    textInputs: [...document.querySelectorAll('#tiers input')].filter((i) => i.type !== 'checkbox').length })`));
  // Whether tiers are on is the owner's saved choice, not the test's: assert the panel agrees with its own switch.
  check('tiers: panel mirrors its on/off switch, one row per rankable provider, and no free-text inputs', tiersBox.off === !tiersBox.checked && tiersBox.rows > 0 && tiersBox.textInputs === 0, JSON.stringify(tiersBox));
  if (claudeRanked.length >= 3) {
    const [lo, hi] = [claudeRanked[0], claudeRanked[claudeRanked.length - 1]];
    const inner = claudeRanked.slice(1, -1);
    await js(`(function () { var c = document.getElementById('tiers-on'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(200);
    check('tiers: switched on (by the owner earlier, or just now) there is a Claude ladder', (await tierState()).on === true && Array.isArray((await tierState()).ladder), JSON.stringify(await tierState()));
    await setSel('tlow', lo); await setSel('thigh', hi);
    check('tiers: picking Low and High allows every model between them, in weakest-to-strongest order', JSON.stringify((await tierState()).ladder) === JSON.stringify(claudeRanked), JSON.stringify(await tierState()));
    const chips = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.tprow[data-provider="claude"] .tchip')].map((c) => [c.value, c.checked]))`));
    check('tiers: the in-between models are offered as ticked boxes', JSON.stringify(chips.map((c) => c[0])) === JSON.stringify(inner) && chips.every((c) => c[1]), JSON.stringify(chips));
    if (inner.length) {
      await js(`(function () { var c = document.querySelector('.tprow[data-provider="claude"] .tchip'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
      await sleep(150);
      const trimmed = (await tierState()).ladder;
      check('tiers: unticking a model removes it but keeps both ends', trimmed[0] === lo && trimmed[trimmed.length - 1] === hi && !trimmed.includes(inner[0]) && trimmed.length === claudeRanked.length - 1, JSON.stringify(trimmed));
    }
    await setSel('tlow', hi); await setSel('thigh', lo); // ends given the wrong way round
    const flipped = (await tierState()).ladder;
    check('tiers: ends entered backwards are put in weakest-to-strongest order', flipped[0] === lo && flipped[flipped.length - 1] === hi, JSON.stringify(flipped));
    await setSel('tlow', ''); await setSel('thigh', '');
    check('tiers: clearing both ends stops tiering that provider', (await tierState()).ladder === null, JSON.stringify(await tierState()));
  } else {
    check('tiers: needs 3+ rankable Claude models to exercise the range editor (skipped)', true);
  }

  // --- Stop button: visible only while a run is pending, cancels the dashboard chat, then the console recovers -----------
  const stubFetch = `(function () {
    var real = window.fetch.bind(window), release = null;
    window.__cancels = [];
    window.fetch = function (url, init) {
      var u = String(url);
      if (u.indexOf('api/chat') >= 0) return new Promise(function (resolve) { release = function () { resolve(new Response(JSON.stringify({ cancelled: true, text: 'Stopped.', agentId: 'main' }), { headers: { 'Content-Type': 'application/json' } })); }; });
      if (u.indexOf('api/runs/cancel') >= 0) { window.__cancels.push(JSON.parse(init.body)); if (release) release(); return Promise.resolve(new Response('{"cancelled":1}', { headers: { 'Content-Type': 'application/json' } })); }
      return real(url, init);
    };
  })();`;
  await open('/', { pre: stubFetch });
  const stopState = async () => JSON.parse(await js(`JSON.stringify({ hidden: document.getElementById('stopbtn').hidden, sendDisabled: document.getElementById('sendbtn').disabled,
    shown: document.getElementById('stopbtn').offsetParent !== null, cancels: window.__cancels, last: [...document.querySelectorAll('#chatlog .msg')].pop().textContent, lastClass: [...document.querySelectorAll('#chatlog .msg')].pop().className })`));
  const idle = await stopState();
  check('stop: the Stop button is hidden when nothing is running', idle.hidden === true && idle.shown === false, JSON.stringify(idle));
  await js(`(function () { var i = document.getElementById('chatmsg'); i.value = 'a long job'; document.getElementById('sendbtn').click(); })()`);
  await sleep(250);
  const busy = await stopState();
  check('stop: Stop appears (and Send is disabled) while the run is pending', busy.hidden === false && busy.shown === true && busy.sendDisabled === true, JSON.stringify(busy));
  check('stop: Stop sits beside Send in the composer, same row', await js(`(function () { var s = document.getElementById('stopbtn').getBoundingClientRect(), n = document.getElementById('sendbtn').getBoundingClientRect(); return s.right <= n.left + 1 && Math.abs(s.top - n.top) < 2; })()`));
  await js(`document.getElementById('stopbtn').click()`);
  await sleep(400);
  const after = await stopState();
  check('stop: clicking Stop cancels the dashboard chat by chat id', JSON.stringify(after.cancels) === JSON.stringify([{ chatId: 'dashboard' }]), JSON.stringify(after.cancels));
  check('stop: the log shows the run as stopped, and the console is ready again', after.last.includes('Stopped.') && after.lastClass.includes('stopped') && after.hidden === true && after.sendDisabled === false, JSON.stringify(after));

  // --- War Room: Cancel run (live header) is separate from Hush voices; pending, ack, retry -----------------
  await open('/warroom', { fake: true });
  const deliver = (m) => js(`window.__ws.onmessage({ data: ${JSON.stringify(JSON.stringify(m))} })`);
  const cancelUi = async () => JSON.parse(await js(`JSON.stringify({ hidden: document.getElementById('nowcancel').hidden, disabled: document.getElementById('nowcancel').disabled,
    text: document.getElementById('nowcancel').textContent, note: document.getElementById('cancelnote').textContent })`));
  check('cancel: Cancel run is hidden while nothing runs', (await cancelUi()).hidden === true);
  await deliver({ type: 'meter', pct: 10, phase: 'plan', label: 'plan', failed: false });
  check('cancel: Cancel run appears in the live header while a run is active', (await cancelUi()).hidden === false, JSON.stringify(await cancelUi()));
  await js(`document.getElementById('cancelbtn').click()`);
  check('cancel: Hush voices sends hush and never cancel the run', (await sent()).some((m) => m && m.type === 'hush') && !(await sent()).some((m) => m && m.type === 'cancel'), JSON.stringify(await sent()));
  check('cancel: the hush receipt says the run keeps going', (await cancelUi()).note.includes('keeps going'), JSON.stringify(await cancelUi()));
  await js(`document.getElementById('nowcancel').click()`);
  const pending = await cancelUi();
  check('cancel: clicking Cancel run sends cancel and shows a pending state', (await sent()).filter((m) => m && m.type === 'cancel').length === 1 && pending.disabled === true && pending.text === 'Cancelling...', JSON.stringify(pending));
  await deliver({ type: 'cancel_ack', stopped: 2 });
  check('cancel: the server ack is shown', (await cancelUi()).note.includes('confirmed: stopping 2 tasks'), JSON.stringify(await cancelUi()));
  await deliver({ type: 'meter', pct: 40, phase: 'cancelled', label: 'cancelled', failed: false, state: 'cancelled', final: true });
  check('cancel: the CANCELLED badge replaces the run and the button hides', (await js(`document.getElementById('nowbadge').textContent`)).includes('CANCELLED') && (await cancelUi()).hidden === true);
  await open('/warroom', { fake: true, pre: `window.__fastRetry = true; var __st = window.setTimeout; window.setTimeout = function (f, ms) { return __st(f, ms === 8000 ? 300 : ms); };` });
  await deliver({ type: 'meter', pct: 10, phase: 'plan', label: 'plan', failed: false });
  await js(`document.getElementById('nowcancel').click()`);
  await sleep(600);
  const stuck = await cancelUi();
  check('cancel: with no ack and no CANCELLED, a retry hint appears and the button re-enables', stuck.disabled === false && stuck.text === 'Retry cancel' && stuck.note.includes('Retry'), JSON.stringify(stuck));

  // --- Dashboard runs panel: origin, elapsed ticker, Stop only for dashboard-owned runs ---------------------
  const stubRuns = (runs) => `(function () { var real = window.fetch.bind(window); window.__cancels = [];
    window.fetch = function (url, init) { var u = String(url);
      if (u.indexOf('api/runs/cancel') >= 0) { window.__cancels.push(JSON.parse(init.body)); return Promise.resolve(new Response('{"cancelled":1}', { headers: { 'Content-Type': 'application/json' } })); }
      if (u.indexOf('api/runs') >= 0) return Promise.resolve(new Response(JSON.stringify({ runs: ${runs} }), { headers: { 'Content-Type': 'application/json' } }));
      return real(url, init); }; })();`;
  await open('/', { pre: stubRuns(`[{ id: 'd1', agentId: 'main', chatId: 'dashboard', startedAt: 1, seconds: 5 }, { id: 't1', agentId: 'comms', chatId: '555123', startedAt: 1, seconds: 70 }]`) });
  const runRows = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#runs .run')].map(function (r) { return { text: r.textContent, stop: !!r.querySelector('button[data-action=stop-run]') }; }))`));
  check('runs: a Telegram or scheduled run shows its origin and elapsed time', runRows.length === 2 && runRows[1].text.includes('Chat 555123') && runRows[1].text.includes('1:1'), JSON.stringify(runRows));
  check('runs: Stop is offered for the dashboard run only', runRows[0].stop === true && runRows[1].stop === false, JSON.stringify(runRows));
  const t0 = await js(`document.querySelector('#runs .runtime').textContent`);
  await sleep(2200);
  check('runs: the elapsed time ticks without a refresh', (await js(`document.querySelector('#runs .runtime').textContent`)) !== t0, t0);
  await js(`document.querySelector('button[data-action=stop-run]').click()`);
  await sleep(400);
  check('runs: Stop this run cancels by run id and gives a receipt', JSON.stringify(await js(`window.__cancels`)) === JSON.stringify([{ id: 'd1' }]) && (await js(`document.querySelector('#runs .runnote').textContent`)).includes('Stop sent'));
  await open('/', { pre: stubRuns('[]') });
  check('runs: empty state renders', (await js(`document.getElementById('runs').textContent`)).includes('Nothing is running'));
  await open('/', { pre: `(function () { var real = window.fetch.bind(window); window.fetch = function (u, i) { return String(u).indexOf('api/runs') >= 0 && String(u).indexOf('cancel') < 0 ? Promise.resolve(new Response('{}', { status: 500 })) : real(u, i); }; })();` });
  check('runs: a failing endpoint shows an error state, not a stale list', (await js(`document.getElementById('runs').textContent`)).includes('Could not read'));
  // --- Attaching files to a message (War Room + dashboard). Real uploads to the real server; the socket / chat call is faked: no agent runs. ---
  const UP_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'workspace', 'uploads');
  const onDisk = (id) => existsSync(join(UP_DIR, id));
  const attachFile = (name, content, type = 'text/plain', size = 0) => js(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${size} ? new Uint8Array(${size}) : ${JSON.stringify(content)}], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} })); const i = document.querySelector('input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
  const chips = `[...document.querySelectorAll('#attachtray .kchip')]`;
  const keep = [];
  await open('/warroom', { fake: true });
  check('attach: the War Room has an Attach button with an accessible name, and no tray until a file is chosen', await js(`document.getElementById('attachbtn').getAttribute('aria-label') === 'Attach files' && document.getElementById('attachtray').hidden === true`));
  await attachFile('notes.txt', 'the secret word is rhubarb');
  check('attach: a chosen file uploads at once and shows its name and size', await waitFor(`${chips}.length === 1 && ${chips}[0].classList.contains('ready') && /notes\\.txt/.test(${chips}[0].textContent) && /\\d+ B/.test(${chips}[0].textContent)`, 8000));
  await js(`document.getElementById('msg').value = 'what is the secret word?'; document.getElementById('send').click()`);
  const m1 = (await sent()).find((m) => m && m.type === 'text');
  check('attach: the message goes out with its file id (never a path), exactly once', !!m1 && m1.text === 'what is the secret word?' && m1.attachments.length === 1 && /^\d{10,}-[0-9a-f]{6}_notes\.txt$/.test(m1.attachments[0]) && !JSON.stringify(m1).includes('workspace'), JSON.stringify(m1));
  if (m1) keep.push(...m1.attachments);
  check('attach: the file really is on the server', !!m1 && onDisk(m1.attachments[0]));
  check('attach: the transcript shows which file went with it, and the tray empties', await js(`/what is the secret word\\?\\s+\u{1F4CE} notes\\.txt/u.test(document.getElementById('log').textContent) && document.getElementById('attachtray').hidden === true`));
  await attachFile('plan.pdf', 'x');
  await waitFor(`${chips}.length === 1 && ${chips}[0].classList.contains('ready')`, 8000);
  await js(`document.getElementById('msg').value = ''; document.getElementById('send').click()`);
  const m2 = (await sent()).filter((m) => m && m.type === 'text')[1];
  check('attach: a file with no words still sends, with a sensible default question', !!m2 && m2.text === 'Please look at the attached file.' && m2.attachments.length === 1, JSON.stringify(m2));
  if (m2) keep.push(...m2.attachments);
  await js(`document.getElementById('msg').value = ''; document.getElementById('send').click()`);
  check('attach: nothing typed and nothing attached sends nothing', (await sent()).filter((m) => m && m.type === 'text').length === 2);
  await attachFile('draft.md', 'abc');
  await waitFor(`${chips}.length === 1 && ${chips}[0].classList.contains('ready')`, 8000);
  const draft = await js(`(() => { document.querySelector('#attachtray .kx').click(); return true; })()`);
  await sleep(500);
  check('attach: removing a chip empties the tray and deletes the file from the server', await js(`document.getElementById('attachtray').hidden === true`) && readdirSync(UP_DIR).every((f) => !f.endsWith('_draft.md')));
  await attachFile('big.bin', '', 'application/octet-stream', 21 * 1024 * 1024);
  check('attach: a file over 20 MB is refused at once, with the reason, and never uploaded', await waitFor(`${chips}.length === 1 && ${chips}[0].classList.contains('failed') && /larger than 20\\.0 MB/.test(${chips}[0].textContent)`, 3000) && readdirSync(UP_DIR).every((f) => !f.endsWith('_big.bin')));
  await js(`document.getElementById('msg').value = 'try anyway'; document.getElementById('send').click()`);
  check('attach: a failed file blocks the send and says what to do', (await sent()).filter((m) => m && m.type === 'text').length === 2 && await js(`/failed to upload.*Remove it/.test(document.getElementById('log').textContent)`));
  await js(`document.querySelector('#attachtray .kx').click()`);
  await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['dropped'], 'dropped.txt', { type: 'text/plain' })); const z = document.getElementById('chatzone'); const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }); z.dispatchEvent(over); window.__overPrevented = over.defaultPrevented; window.__outlined = z.classList.contains('dropping'); z.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
  check('attach: dropping a file on the chat attaches it (and the zone lights up while dragging)', await js(`window.__overPrevented === true && window.__outlined === true`) && await waitFor(`${chips}.length === 1 && /dropped\\.txt/.test(${chips}[0].textContent)`, 8000));
  await js(`document.querySelector('#attachtray .kx').click()`);
  await js(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['PNGDATA'], 'image.png', { type: 'image/png' })); const p = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.getElementById('msg').dispatchEvent(p); window.__pasteTaken = p.defaultPrevented; })()`);
  check('attach: pasting a screenshot attaches it, with a thumbnail', await js(`window.__pasteTaken === true`) && await waitFor(`${chips}.length === 1 && !!${chips}[0].querySelector('img')`, 8000));
  await js(`document.querySelector('#attachtray .kx').click()`);
  await js(`(() => { const dt = new DataTransfer(); dt.setData('text/plain', 'just words'); const p = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }); document.getElementById('msg').dispatchEvent(p); window.__textPaste = p.defaultPrevented; })()`);
  check('attach: pasting plain text is left alone', await js(`window.__textPaste === false && document.getElementById('attachtray').hidden === true`));
  await js(`(() => { const dt = new DataTransfer(); for (let i = 1; i <= 6; i++) dt.items.add(new File(['x'], 'f' + i + '.txt', { type: 'text/plain' })); const i = document.querySelector('input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change')); })()`);
  check('attach: at most five files per message, and it says so', await js(`${chips}.length === 5 && /At most 5 files/.test(document.getElementById('log').textContent)`));
  for (let i = 0; i < 5; i++) await js(`(document.querySelector('#attachtray .kx') || {click() {}}).click()`);
  await sleep(600);
  check('attach: removing every chip leaves nothing behind on the server', readdirSync(UP_DIR).every((f) => !/_f[1-6]\.txt$|_dropped\.txt$|_image\.png$/.test(f)));
  check('attach: the hidden file picker is not a tab stop or announced', await js(`(() => { const i = document.querySelector('input[type=file]'); return i.hidden && i.tabIndex === -1 && i.getAttribute('aria-hidden') === 'true'; })()`));

  const stubChat = `(function () { var real = window.fetch.bind(window); window.__chats = []; window.fetch = function (u, i) { if (String(u).indexOf('api/chat') >= 0) { window.__chats.push(JSON.parse(i.body)); return Promise.resolve(new Response(JSON.stringify({ text: 'It says rhubarb.', agentId: 'main' }), { status: 200, headers: { 'Content-Type': 'application/json' } })); } return real(u, i); }; })();`;
  await open('/', { pre: stubChat });
  check('attach: the dashboard console has the same Attach button', await js(`document.getElementById('attachbtn').getAttribute('aria-label') === 'Attach files' && document.getElementById('attachtray').hidden === true`));
  await attachFile('report.txt', 'rhubarb');
  await waitFor(`${chips}.length === 1 && ${chips}[0].classList.contains('ready')`, 8000);
  await js(`document.getElementById('chatmsg').value = 'what does it say?'; document.querySelector('[data-action=send-chat]').click()`);
  const chat = JSON.parse(await js(`JSON.stringify(window.__chats)`));
  check('attach: the dashboard sends the message with the file id to /api/chat', chat.length === 1 && chat[0].message === 'what does it say?' && chat[0].attachments.length === 1 && /_report\.txt$/.test(chat[0].attachments[0]) && chat[0].agentId === 'main', JSON.stringify(chat));
  if (chat[0]) keep.push(...chat[0].attachments);
  check('attach: the dashboard log shows the file name under the message, and the reply arrives', await waitFor(`/report\\.txt/.test(document.querySelector('#chatlog .sentfiles').textContent) && /It says rhubarb/.test(document.getElementById('chatlog').textContent)`, 4000));
  await attachFile('big.bin', '', 'application/octet-stream', 21 * 1024 * 1024);
  await js(`document.getElementById('chatmsg').value = 'again'; document.querySelector('[data-action=send-chat]').click()`);
  check('attach: a failed file blocks the dashboard send too, with a visible notice', (await js(`window.__chats.length`)) === 1 && await js(`!document.getElementById('notice').hidden && /failed to upload/.test(document.getElementById('notice').textContent)`));
  await js(`document.querySelector('#attachtray .kx').click()`);
  for (const id of keep) await fetch(`${BASE}/api/upload/${id}`, { method: 'DELETE', headers: { Origin: BASE } }).catch(() => {});
  check('attach: the test left no uploads behind', readdirSync(UP_DIR).every((f) => !keep.includes(f)));
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
