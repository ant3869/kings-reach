// scripts/verify.mjs - the deploy/verify ritual as one command: `npm run verify [-- --turn]`.
// Reads .env itself (the token never hits a command line or log). Exit code 0 = all PASS.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'store', 'logs');
const WANT_TURN = process.argv.includes('--turn');

function readEnv() {
  const out = {};
  const text = fs.existsSync(path.join(ROOT, '.env')) ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq <= 0) continue;
    const value = line.slice(eq + 1).trim();
    const quoted = /^(['"])(.*?)\1/.exec(value);
    out[line.slice(0, eq).trim()] = quoted ? quoted[2] : value.startsWith('#') ? '' : value.replace(/\s#.*$/, '').trim(); // mirrors src/env.ts
  }
  return out;
}
const ENV = readEnv();
const DASH = Number(ENV.DASHBOARD_PORT || 3141);
const WAR = Number(ENV.WARROOM_PORT || 7860);
const TOKEN = ENV.DASHBOARD_TOKEN || '';

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  return ok;
}

/** Raw HTTP so we control Host/Origin headers exactly. Resolves {status, body, upgraded}. */
function request({ port, method = 'GET', urlPath = '/', headers = {}, body }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, timeout: 15000 }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode, upgraded: true, body: '' });
    });
    req.on('error', (err) => resolve({ status: 0, body: String(err) }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}
const authed = (extra = {}) => ({ ...extra, ...(TOKEN ? { 'x-claudeclaw-token': TOKEN } : {}) });

const readPidFile = (name) => {
  try {
    return Number(fs.readFileSync(path.join(ROOT, 'store', name), 'utf8').trim()) || null;
  } catch {
    return null;
  }
};

/**
 * Twin test: launch a SECOND server and require it to refuse and exit. This proves the
 * single-instance lock directly. (netstat is unreliable from sandboxed agent shells:
 * listeners hidden, pids shown as 0.)
 */
function twinRefuses(label, exe, args, expect) {
  try {
    const out = execFileSync(exe, args, { cwd: ROOT, encoding: 'utf8', timeout: 30_000, stdio: 'pipe', env: { ...process.env, NO_COLOR: '1' } });
    return check(`${label} twin refused`, false, `twin exited 0 (it RAN): ${out.slice(-200)}`);
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    return check(`${label} twin refused`, err.status === 1 && expect.test(text), `exit ${err.status ?? err.code}: ${text.trim().split(/\r?\n/).pop()?.slice(0, 120)}`);
  }
}

function extractScripts(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
}

function checkServedPage(label, html) {
  const js = extractScripts(html);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `served-${label}.js`);
  fs.writeFileSync(file, js, 'utf8');
  let syntaxOk = true;
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    syntaxOk = false;
    console.log(String(err.stderr || err).slice(0, 800));
  }
  check(`${label}: served JS extracted + node --check`, js.length > 1000 && syntaxOk, `${js.length} bytes -> ${path.relative(ROOT, file)}`);

  // Run the SERVED md() (function declarations hoist even though DOM code throws in a VM).
  const ctx = vm.createContext({});
  try {
    vm.runInContext(js, ctx, { timeout: 2000 });
  } catch {
    /* expected: no DOM here */
  }
  if (!check(`${label}: served md() present`, typeof ctx.md === 'function')) return;
  const out = ctx.md('**bold** and `code`\n\n- one\n- two\n\n1. first\n\n[site](https://example.com)\n\n<img src=x onerror=alert(1)> [x](https://a.b/"onmouseover="y)');
  check(`${label}: md renders bold/code/lists/links`,
    out.includes('<strong>bold</strong>') && out.includes('<code>code</code>') && out.includes('<ul><li>one</li><li>two</li></ul>')
      && out.includes('<ol><li>first</li></ol>') && out.includes('<a href="https://example.com"'));
  check(`${label}: md escapes injected HTML/attributes`, !out.includes('<img') && !out.includes('"onmouseover'));
}

// A chat line: has agent_id, is not a status line, and is not a stage/thinking/voice event.
const isReply = (m) => Boolean(m.agent_id) && m.agent_id !== 'war-room' && !m.type;

function wsSession(timeoutMs) {
  return new Promise((resolve) => {
    const seen = [];
    const ws = new WebSocket(`ws://127.0.0.1:${WAR}`);
    const finish = (why) => {
      try { ws.close(); } catch { /* ignore */ }
      resolve({ seen, why });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    ws.onerror = () => { clearTimeout(timer); finish('error'); };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // spoken audio clips
      const m = JSON.parse(String(ev.data));
      seen.push(m);
      if (seen.length === 1) ws.send(JSON.stringify({ type: 'ping' }));
      else if (m.pong) {
        if (!WANT_TURN) { clearTimeout(timer); finish('done'); return; }
        ws.send(JSON.stringify({ type: 'text', text: 'verify probe: reply with the single word ALIVE.' }));
      } else if (isReply(m) && seen.length > 2) { clearTimeout(timer); finish('done'); }
    };
  });
}

async function main() {
  console.log(`ClaudeClaw verify  (dashboard :${DASH}, war room :${WAR}, token ${TOKEN ? 'set' : 'not set'})\n`);

  const h = await request({ port: DASH, urlPath: '/api/health', headers: authed() });
  let health = {};
  try { health = JSON.parse(h.body); } catch { /* reported below */ }
  if (check('GET /api/health', h.status === 200 && health.ok === true, `HTTP ${h.status}`)) {
    console.log(`      core v${health.version} pid ${health.pid} up ${health.uptimeSec}s | clients ${JSON.stringify(health.clients)} | agents ${health.agents}`);
    console.log(`      war room ${JSON.stringify(health.warroom)} | db ${JSON.stringify(health.db?.counts)}`);
    check('core pid file == serving core pid', readPidFile('claudeclaw.pid') === health.pid, `file ${readPidFile('claudeclaw.pid')}`);
    check('war room running + pid known', health.warroom?.running === true && Boolean(health.warroom?.pid));
  }

  twinRefuses('core', process.execPath, ['dist/index.js'], /Another core is running/);
  if (ENV.WARROOM_PYTHON) twinRefuses('war room', ENV.WARROOM_PYTHON, ['-u', 'warroom/server.py'], /another war room is running/);
  else check('war room twin refused', false, 'WARROOM_PYTHON not set in .env');

  for (const [label, urlPath] of [['dashboard', '/'], ['warroom', '/warroom'], ['providers', '/providers']]) {
    const page = await request({ port: DASH, urlPath });
    if (check(`GET ${urlPath}`, page.status === 200, `${page.body.length} bytes`)) {
      if (label !== 'providers') checkServedPage(label, page.body);
      else {
        const js = extractScripts(page.body);
        const file = path.join(LOG_DIR, 'served-providers.js');
        fs.writeFileSync(file, js, 'utf8');
        let syntaxOk = true;
        try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch { syntaxOk = false; }
        check('providers: served JS extracted + node --check', js.length > 1000 && syntaxOk, `${js.length} bytes`);
      }
    }
  }
  for (const name of ['warroom-app.js', 'warroom-voice.js', 'mic-worklet.js']) {
    const r = await request({ port: DASH, urlPath: `/warroom/${name}` });
    const file = path.join(LOG_DIR, `served-${name}`);
    fs.writeFileSync(file, r.body, 'utf8');
    let ok = r.status === 200 && /javascript/.test(String(r.headers?.['content-type'] ?? ''));
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); } catch { ok = false; }
    check(`GET /warroom/${name} (+ node --check)`, ok, `HTTP ${r.status}, ${r.body.length} bytes`);
  }
  for (const name of ['warroom-council-cards.png', 'warroom-chamber-bg.png']) {
    const asset = await request({ port: DASH, method: 'HEAD', urlPath: `/warroom/${name}` });
    check(`HEAD /warroom/${name}`, asset.status === 200 && asset.headers?.['content-type'] === 'image/png',
      `HTTP ${asset.status}, ${asset.headers?.['content-type'] ?? 'no content-type'}`);
  }
  const traversal = await request({ port: DASH, urlPath: '/warroom/..%2f.env' });
  check('static route refuses traversal', traversal.status === 404 && !/TOKEN|API_KEY/.test(traversal.body), `HTTP ${traversal.status}`);

  const providerApi = await request({ port: DASH, urlPath: '/api/providers', headers: authed() });
  let providerData = {};
  try { providerData = JSON.parse(providerApi.body); } catch { /* reported below */ }
  check('provider network API (no secrets)', providerApi.status === 200 && providerData.providers?.length >= 8
    && !/OPENAI_API_KEY\s*[:=]\s*[^m]/.test(providerApi.body), `HTTP ${providerApi.status}, ${providerData.providers?.length ?? 0} providers`);

  const evilHost = await request({ port: DASH, urlPath: '/api/agents', headers: authed({ Host: 'evil.example:' + DASH }) });
  check('DNS-rebinding Host refused', evilHost.status === 403, `HTTP ${evilHost.status}`);
  const csrf = await request({ port: DASH, method: 'POST', urlPath: '/api/tasks', headers: authed({ Origin: 'http://evil.example', 'Content-Type': 'text/plain' }), body: '{}' });
  check('cross-origin POST refused', csrf.status === 403, `HTTP ${csrf.status}`);
  if (TOKEN) {
    const noTok = await request({ port: DASH, urlPath: '/api/agents' });
    check('missing token refused', noTok.status === 401, `HTTP ${noTok.status}`);
  }
  const upgrade = (origin) => request({
    port: WAR,
    headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...(origin ? { Origin: origin } : {}) },
  });
  const evilWs = await upgrade('http://evil.example');
  check('war room refuses foreign Origin', !evilWs.upgraded && evilWs.status === 403, `HTTP ${evilWs.status}`);
  const goodWs = await upgrade(`http://localhost:${DASH}`);
  check('war room accepts dashboard Origin', goodWs.upgraded === true, `HTTP ${goodWs.status}`);

  const s = await wsSession(WANT_TURN ? 180_000 : 10_000);
  const pong = s.seen.find((m) => m.pong);
  check('ws welcome', s.seen[0]?.agent_id === 'war-room', (s.seen[0]?.text || s.why).slice(0, 80));
  check('ws ping -> pong', pong?.pong === 'council-v3', pong ? `server v${pong.server} pid ${pong.pid}` : s.why);
  check('pong pid == war room pid file', Boolean(pong) && pong.pid === readPidFile('warroom.pid'), `file ${readPidFile('warroom.pid')}`);
  if (WANT_TURN) {
    const reply = s.seen.slice(2).find(isReply);
    // Non-empty is not enough: canned failure text is still text. Demand the asked-for word.
    check('ws real agent turn', /alive/i.test(reply?.text ?? ''), reply ? `${reply.agent_id}: ${reply.text.slice(0, 160)}` : s.why);
  }

  console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASS'}`);
  process.exitCode = failed ? 1 : 0;
}

main();
