// scripts/demo-shots.mjs - screenshots of the War Room live-status panel at chosen moments of a demo replay.
// Visual proof without a paid run:  node scripts/demo-shots.mjs            -> store/logs/live-*.png
// Chrome profile + output stay under store/ (project drive only, gitignored).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.UI_CHECK_BASE ?? 'http://127.0.0.1:3141';
const CHROME = process.env.CHROME_PATH ?? join(process.env.LOCALAPPDATA ?? '',
  'ms-playwright', 'chromium_headless_shell-1248', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'store', 'logs');
const PROFILES = join(ROOT, 'store', 'ui-check');
mkdirSync(PROFILES, { recursive: true });
const profile = mkdtempSync(join(PROFILES, 'shots-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// [file, demo, speed, virtual second to capture]
const SHOTS = [
  ['live-build-working.png', 'build', 8, 36],
  ['live-build-done.png', 'build', 40, 142],
  ['live-build-failed.png', 'build-fail', 40, 110],
  ['live-stall-stalled.png', 'stall', 20, 105],
];

const chrome = spawn(CHROME, ['--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let cdpUrl = '';
for (let i = 0; i < 75 && !cdpUrl; i++) {
  try {
    const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
    cdpUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.type === 'page')?.webSocketDebuggerUrl ?? '';
  } catch { await sleep(200); }
}
if (!cdpUrl) { chrome.kill(); throw new Error('Chrome did not start; set CHROME_PATH'); }
const ws = new WebSocket(cdpUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const cdp = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });

try {
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  // Fake socket: the shot must never talk to the real council.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: 'window.WebSocket = class { constructor(){ this.readyState = 1; setTimeout(() => this.onopen && this.onopen({}), 40); } send(){} close(){} };' });
  for (const [file, demo, speed, at] of SHOTS) {
    await cdp('Page.navigate', { url: `${BASE}/warroom?demo=${demo}&speed=${speed}&still=1` });
    await sleep(900 + (at * 1000) / speed);
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, file), Buffer.from(shot.result.data, 'base64'));
    console.log('wrote', join('store', 'logs', file));
  }
} finally {
  ws.close(); chrome.kill(); await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* temp dir */ }
}
