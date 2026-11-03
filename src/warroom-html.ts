// src/warroom-html.ts - the War Room council chamber page (served at /warroom).
// Markup + CSS only. Behaviour lives in public/warroom-app.js + public/warroom-voice.js (real JS files,
// node --check-able, no template-literal escaping). Casting comes from warroom/voices.json (one source).
// Bump WARROOM_CLIENT_VERSION on every client change: it shows in the page AND /api/health.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, WARROOM_PORT } from './config.js';
import { CLIENT_MD_JS, esc } from './client-md.js';

export const WARROOM_CLIENT_VERSION = 9;
export const WARROOM_PROTOCOL = 'council-v3'; // must match PROTOCOL in warroom/server.py
export const WARROOM_STATIC = ['warroom-app.js', 'warroom-voice.js', 'mic-worklet.js',
  'warroom-council-cards.png', 'warroom-chamber-bg.png'] as const;

const COLORS: Record<string, string> = {
  main: '#d4a017', research: '#79c0ff', comms: '#a371f7', content: '#3fb950', ops: '#f85149',
};

interface Seat {
  id: string;
  name: string;
  title: string;
  voice: string;
  color: string;
}

function loadCouncil(): Seat[] {
  let cast: Record<string, { name?: string; title?: string; kokoro_voice?: string }> = {};
  try {
    cast = JSON.parse(readFileSync(join(PROJECT_ROOT, 'warroom', 'voices.json'), 'utf8'));
  } catch {
    // page still renders; seats fall back to ids
  }
  return Object.keys(COLORS).map((id) => ({
    id,
    name: cast[id]?.name ?? id,
    title: cast[id]?.title ?? '',
    voice: cast[id]?.kokoro_voice ?? '',
    color: COLORS[id] as string,
  }));
}

const CSS = `
:root{--gold:#d4a017;--bg:#07070d;--panel:#11111b;--line:#3a3020}
*{box-sizing:border-box}
body{background:#05070b;color:#eadfbe;font-family:Georgia,'Times New Roman',serif;margin:0;padding:14px;min-height:100vh;position:relative}
body:before{content:'';position:fixed;inset:0;background:linear-gradient(#02050aaa,#03050bdd),url('/warroom/warroom-chamber-bg.png?v=1') center top/cover no-repeat;z-index:-2}
body:after{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at center top,transparent 15%,#02040a88 72%);z-index:-1;pointer-events:none}
.wrap{max-width:1400px;margin:0 auto}
h1{font-size:31px;text-align:center;letter-spacing:7px;margin:0;color:#f4df9a;text-shadow:0 1px #000,0 0 18px #d4a01766}
.sub{text-align:center;font:italic 12px Georgia;color:#b2a47d;margin:0 0 5px}.sub a{color:#e2bf62}.topnav{position:absolute;right:18px;top:16px;display:flex;gap:7px}.navbtn{color:#e8cf86;text-decoration:none;font:12px system-ui;border:1px solid #8b692d;background:#0b0d13dd;border-radius:7px;padding:7px 10px;box-shadow:inset 0 0 10px #d4a01718}.navbtn:hover{background:#33250e}
#status{text-align:center;font:13px system-ui;margin:6px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#f85149;margin-right:6px}
.dot.on{background:#3fb950;box-shadow:0 0 8px #3fb950}
.vstat{display:block;font:12px system-ui;color:#8b949e;margin-top:3px}.vstat.ready{color:#3fb950}.vstat.failed{color:#f85149}
#council{display:flex;gap:9px;justify-content:center;margin:10px 0 6px;flex-wrap:wrap}
.seat{--lvl:0;position:relative;width:184px;height:310px;text-align:center;border-radius:18px;background-image:url('/warroom/warroom-council-cards.png?v=1');background-size:920px 270px;background-repeat:no-repeat;background-position:var(--card-pos) 0;transition:transform .2s,filter .2s;filter:drop-shadow(0 8px 9px #000);isolation:isolate}
.seat:after{content:'';position:absolute;inset:2px 1px 39px;border-radius:17px;box-shadow:0 0 calc(4px + var(--lvl)*38px) calc(var(--lvl)*7px) var(--ac);pointer-events:none;z-index:-1}
.seat .sigil,.seat>b,.seat>.title{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
.seat .route{position:absolute;top:272px;left:3px;right:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cbbd96;font:10px system-ui;text-shadow:0 1px #000}
.seat .voice{position:absolute;top:289px;left:3px;right:3px;color:#8f856c;font:10px system-ui}
.seat button{position:absolute;top:236px;left:50%;transform:translateX(-50%);width:62px;height:25px;font:11px Georgia;background:#090806bb;border:1px solid #b78a33;color:#f0d88e;border-radius:9px;cursor:pointer;box-shadow:inset 0 0 7px #d4a01722}
.seat button:before{content:' ';font-size:9px}.seat.pinned button{background:#7b5819;color:#fff2bc;box-shadow:0 0 13px var(--ac)}
.seat.thinking:before{content:'';position:absolute;inset:-3px 0 35px;border-radius:18px;border:2px solid transparent;border-top-color:var(--ac);border-bottom-color:var(--ac);animation:spin 1.5s linear infinite}
.seat.speaking{transform:translateY(-7px) scale(1.025);filter:drop-shadow(0 10px 13px #000) brightness(calc(1 + var(--lvl)*.35))}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:1050px){.seat{width:164px;height:284px;background-size:820px 241px}.seat button{top:210px}.seat .route{top:243px}.seat .voice{top:260px}}
#stages{display:flex;justify-content:center;gap:6px;flex-wrap:wrap;margin:8px 0}
.stage{font:12px Georgia;padding:5px 14px;border-radius:9px;border:1px solid #735628;color:#9d8b65;background:linear-gradient(#16140f,#090a0e);box-shadow:inset 0 0 9px #d4a01712}
.stage.active{color:#1a1103;background:linear-gradient(#f4d77c,#a26b16);border-color:#ffe29a;animation:pulse 1.4s ease-in-out infinite}
.stage.done{color:#e6cb7b;border-color:#b88a36}.stage.failed{color:#f85149;border-color:#f85149}.stage.skipped{text-decoration:line-through}
.stage i{font-style:normal;opacity:.75}
@keyframes pulse{50%{box-shadow:0 0 14px var(--gold)}}
#prog{text-align:center;font:12px system-ui;color:var(--gold);min-height:18px}
.main{display:grid;grid-template-columns:1fr 300px;gap:14px;margin-top:8px}
@media(max-width:900px){.main{grid-template-columns:1fr}}
#log{height:45vh;min-height:310px;overflow-y:auto;border:2px solid #8e6a2c;border-radius:4px;padding:18px;background:linear-gradient(#060a11ed,#080b12f5);font:14px/1.55 system-ui;display:flex;flex-direction:column;gap:12px;box-shadow:inset 0 0 0 3px #05060a,inset 0 0 30px #000,0 8px 24px #000}
.bubble{--ac:var(--gold);border-left:3px solid var(--ac);padding:2px 0 2px 12px;max-width:96%}
.bubble .who{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ac)}
.bubble .tag{font-size:10px;margin-left:8px;padding:1px 7px;border-radius:999px;border:1px solid var(--ac);color:var(--ac)}
.bubble .when{font-size:10px;color:#6e7681;margin-left:6px}
.bubble p{margin:5px 0}.bubble ul,.bubble ol{margin:5px 0;padding-left:20px}.bubble h3,.bubble h4{margin:8px 0 4px;color:var(--gold)}
.bubble pre{background:#000;border:1px solid #30363d;border-radius:6px;padding:8px;overflow-x:auto;font-size:12px}
.bubble code{background:#000;padding:1px 5px;border-radius:4px;font-size:12px}.bubble pre code{padding:0}.bubble a{color:#79c0ff}
.bubble.you{--ac:#8b949e;align-self:flex-end;text-align:right}.bubble.sys{--ac:#555;font-style:italic;color:#8b949e}
.bubble.err{--ac:#f85149;color:#f85149}.bubble.verdict{background:#d4a01712;border-radius:0 10px 10px 0;padding:8px 12px}
aside{display:flex;flex-direction:column;gap:12px}
.panel{border:2px solid #8e6a2c;border-radius:4px;background:linear-gradient(#090d15ee,#0c0e14f5);padding:14px;font:13px system-ui;box-shadow:inset 0 0 0 3px #05060a,inset 0 0 22px #000}
.panel h3{margin:0 0 8px;font:600 13px system-ui;color:var(--gold);letter-spacing:.5px}.panel h3 small{color:#6e7681;font-weight:400}
.panel table{width:100%;border-collapse:collapse}.panel td{padding:3px 0;border-bottom:1px solid #1e1e2a}.panel td+td{text-align:right;color:#e8dcc0}
.stagetimes{margin-top:8px;color:#6e7681;font-size:11px}
#mic{display:block;width:116px;height:116px;margin:8px auto 14px;padding:20px;border-radius:50%;border:3px double #ffd26c;background:radial-gradient(circle,#3b280d 0 38%,#0b0b0d 42% 58%,#b37a20 60% 62%,#08090c 65%);color:#ffe7a2;font:600 12px Georgia;cursor:pointer;user-select:none;touch-action:none;box-shadow:0 0 22px #d79b35,inset 0 0 18px #000;text-shadow:0 1px #000}
#mic.hot{background:#f85149;border-color:#f85149;color:#fff;box-shadow:0 0 22px #f85149}
#mic:disabled{opacity:.4;cursor:not-allowed}
#micstate,#heard{font:12px system-ui;color:#8b949e;min-height:16px;margin-top:6px}
.panel label{display:block;margin-top:7px;color:#c9d1d9;cursor:pointer}
.composer{display:flex;gap:8px;margin-top:12px}
input#msg{flex:1;background:#161b22;color:#e8dcc0;border:1px solid var(--line);border-radius:8px;padding:11px 14px;font-size:14px}
button.go{background:linear-gradient(#755724,#3d2d12);color:#fff0bd;border:1px solid #c99a42;border-radius:8px;padding:10px 16px;cursor:pointer;font:14px Georgia;box-shadow:inset 0 0 8px #000}
button.go:hover{background:linear-gradient(#977335,#4e3815)}button.alt{background:#090b10dd;border:1px solid var(--gold);color:#e9c96e}
button.stop{background:transparent;border:1px solid #f85149;color:#f85149}
.hint{font:11px system-ui;color:#6e7681;margin-top:6px}
`;

/** Full-page War Room: council seats, stage tracker, log, voice + scoreboard panels. */
export function renderWarRoom(): string {
  const council = loadCouncil();
  const seats = council
    .map(
      (c, index) =>
        `<div class="seat" id="seat-${esc(c.id)}" style="--ac:${c.color};--card-pos:${index * 25}%"><div class="sigil">${esc(c.name.slice(0, 1))}</div>` +
        `<b>${esc(c.name)}</b><small class="title">${esc(c.title)}</small><small class="route" id="model-${esc(c.id)}">route: waiting</small><small class="voice">voice: ${esc(c.voice)}</small>` +
        `<button data-pin="${esc(c.id)}">Pin</button></div>`,
    )
    .join('');
  const config = JSON.stringify({ port: WARROOM_PORT, protocol: WARROOM_PROTOCOL, version: WARROOM_CLIENT_VERSION, council });
  const v = `?v=${WARROOM_CLIENT_VERSION}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>War Room v${WARROOM_CLIENT_VERSION} - King's Reach Council</title>
<style>${CSS}</style></head><body>
<div class="wrap">
<nav class="topnav"><a class="navbtn" href="/providers">Settings / Models</a><a class="navbtn" href="/">Mission Control</a></nav>
<h1>THE WAR ROOM</h1>
<p class="sub">Plan. Investigate. Cross-examine. Decide. Build. <a href="/">dashboard</a> &middot; client v${WARROOM_CLIENT_VERSION} &middot; <span id="sver">server ?</span></p>
<div id="status"><span class="dot" id="dot"></span><span id="stext">connecting...</span><span class="vstat" id="vstat">voice: ?</span></div>
<div id="council">${seats}</div>
<div id="stages"></div>
<div id="prog"></div>
<div class="main">
<section>
<div id="log"></div>
<div class="composer"><input id="msg" placeholder="Speak to one agent (Enter), or convene the council (Ctrl+Enter)..." autocomplete="off">
<button class="go" id="send">Send</button><button class="go alt" id="summitbtn">Convene council</button></div>
<div class="composer"><button class="go alt" id="buildbtn">Build the verdict</button><button class="go stop" id="cancelbtn">Cancel / hush</button></div>
<div class="hint">Voice tips: say "council, ..." for a full deliberation, "hey Ops, ..." for one agent, "build it" to execute the plan.</div>
</section>
<aside>
<div class="panel"><h3>Voice</h3>
<button id="mic" disabled>Hold to talk (or hold Space)</button>
<div id="micstate"></div><div id="heard"></div>
<label><input type="checkbox" id="handsfree" disabled> Hands-free (auto-detect speech)</label>
<label><input type="checkbox" id="speak" checked> Agents speak aloud</label>
</div>
<div class="panel" id="score" hidden></div>
</aside>
</div>
</div>
<script>
var WR = ${config.replace(/</g, '\\u003c')};
${CLIENT_MD_JS}
</script>
<script src="/warroom/warroom-voice.js${v}"></script>
<script src="/warroom/warroom-app.js${v}"></script>
</body></html>`;
}
