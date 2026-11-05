// src/history-html.ts - the Plan Library page (served at /history): every council, plan and build the War Room
// has run, with stats and actions. Markup + CSS only; behaviour lives in public/history-app.js.

import { CLIENT_MD_JS } from './client-md.js';

export const HISTORY_CLIENT_VERSION = 3;

const CSS = `
:root{--gold:#d4a017;--bg:#06080d;--panel:#0d111a;--line:#3a3020;--text:#eadfbe;--muted:#8f856c;--good:#3fb950;--warn:#d29922;--bad:#f85149;--blue:#79c0ff}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at top,#141a28,var(--bg) 60%);color:var(--text);font:14px system-ui,sans-serif;min-height:100vh}
.wrap{max-width:1380px;margin:auto;padding:20px}
a{color:#e2bf62}
header{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap}
h1{margin:0;font:600 30px Georgia,serif;letter-spacing:2px;color:#f0d88e;text-transform:uppercase}
h2{margin:18px 0 8px;font:600 14px Georgia,serif;color:var(--gold);letter-spacing:.5px;text-transform:uppercase}
.sub{color:var(--muted);font:italic 13px Georgia,serif;margin-top:4px}
nav{display:flex;gap:7px;flex-wrap:wrap}
nav a,.btn{color:#e8cf86;text-decoration:none;font:12px system-ui;border:1px solid #8b692d;background:#0b0d13dd;border-radius:7px;padding:7px 11px;cursor:pointer}
nav a:hover,.btn:hover{background:#33250e}
.btn.primary{background:linear-gradient(#755724,#3d2d12);color:#fff0bd;border-color:#c99a42}
.btn.primary:hover{background:linear-gradient(#977335,#4e3815)}
.btn:disabled{opacity:.45;cursor:default}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:9px;margin:16px 0 10px}
.stat{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px 12px}
.stat b{display:block;font:600 22px Georgia,serif;color:#f0d88e}.stat span{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.stat small{display:block;color:var(--muted);font-size:11px;margin-top:2px}
.activebar{border:1px solid #8e6a2c;border-radius:8px;background:#d4a0170f;padding:10px 14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.activebar .grow{flex:1;min-width:240px}.activebar.none{border-color:var(--line);background:var(--panel);color:var(--muted)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:14px 0 10px}
.chip{border:1px solid var(--line);background:var(--panel);color:var(--muted);border-radius:999px;padding:5px 13px;cursor:pointer;font:12px system-ui}
.chip.on{border-color:var(--gold);color:#f0d88e;background:#d4a01718}
select,input[type=search]{background:#10141e;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:7px 10px;font:12px system-ui}
input[type=search]{min-width:200px;flex:1;max-width:340px}
.cols{display:grid;grid-template-columns:minmax(300px,430px) 1fr;gap:14px;align-items:start}
@media(max-width:900px){.cols{grid-template-columns:1fr}}
#list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px;max-height:78vh;overflow-y:auto}
#list button{all:unset;box-sizing:border-box;width:100%;cursor:pointer;display:block;border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px 12px}
#list button:hover{border-color:#8e6a2c}#list button.sel{border-color:var(--gold);background:#d4a01710;box-shadow:inset 3px 0 0 var(--gold)}
.row1{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.when{color:var(--muted);font-size:11px;margin-left:auto}
.q{margin:6px 0 4px;color:#d8ccaa;font:13px/1.4 system-ui;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{color:var(--muted);font-size:11px}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.badge{font:600 10px system-ui;letter-spacing:.5px;text-transform:uppercase;border-radius:999px;padding:2px 8px;border:1px solid currentColor}
.kind-summit{color:var(--blue)}.kind-build{color:#e2bf62}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.muted{color:var(--muted)}
.id{font:12px ui-monospace,Consolas,monospace;color:#b2a47d}
#detail{border:1px solid #8e6a2c;border-radius:8px;background:linear-gradient(#0a0e17f2,#0c0f16f8);padding:18px 20px;min-height:300px;box-shadow:inset 0 0 28px #000}
#detail h3{margin:0 0 4px;font:600 20px Georgia,serif;color:#f0d88e}
#detail .empty{color:var(--muted);font-style:italic;padding:40px 0;text-align:center}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 6px}
.notice{border-left:3px solid var(--warn);background:#d299220f;padding:8px 12px;margin:10px 0;color:#d8c58a;font-size:13px}
.notice.bad{border-color:var(--bad);background:#f8514910;color:#ff9b94}
table{width:100%;border-collapse:collapse;font-size:12.5px}th{text-align:left;color:var(--muted);font:600 10px system-ui;text-transform:uppercase;letter-spacing:.5px;padding:4px 8px 4px 0;border-bottom:1px solid var(--line)}
th.num{text-align:right}
td{padding:6px 8px 6px 0;border-bottom:1px solid #1b1f2b;vertical-align:top}td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.owner{font:600 10px system-ui;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.verdict{border-left:3px solid var(--gold);padding:2px 0 2px 14px;margin:8px 0;max-height:340px;overflow-y:auto;line-height:1.55}
.verdict p{margin:6px 0}.verdict h3,.verdict h4{margin:10px 0 4px;color:var(--gold);font-size:14px}.verdict ul,.verdict ol{padding-left:20px}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips span{border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12px}
.bar{display:flex;height:22px;border-radius:5px;overflow:hidden;border:1px solid var(--line);background:#10141e}
.bar i{display:block;font:normal 10px/22px system-ui;color:#0a0a0a;text-align:center;overflow:hidden;white-space:nowrap}
.bar-legend{color:var(--muted);font-size:11px;margin:4px 0}
.conf{display:inline-block;width:110px;height:8px;border-radius:4px;background:#1b1f2b;overflow:hidden;vertical-align:middle;margin:0 6px}.conf i{display:block;height:100%;background:var(--gold)}
details{margin:8px 0;border-top:1px solid #8e6a2c44;padding-top:6px}summary{cursor:pointer;color:#d9b85d;font:600 11px system-ui;text-transform:uppercase;letter-spacing:.5px}
pre{background:#000;border:1px solid #30363d;border-radius:6px;padding:10px;overflow:auto;max-height:340px;font-size:12px;white-space:pre-wrap}
ul.files{margin:4px 0;padding-left:18px;font:12px ui-monospace,Consolas,monospace;color:#c9bf9f}
.linkbtn{all:unset;color:#e2bf62;cursor:pointer;text-decoration:underline}
dialog{background:#0d111a;color:var(--text);border:1px solid var(--gold);border-radius:10px;max-width:520px;padding:20px 22px;box-shadow:0 0 40px #000}
dialog::backdrop{background:#000a}dialog h3{margin:0 0 10px;color:#f0d88e;font:600 18px Georgia,serif}dialog p{line-height:1.5}
dialog .actions{justify-content:flex-end}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1c2433;border:1px solid var(--gold);color:#f0d88e;padding:9px 18px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .25s}
#toast.show{opacity:1}
@media(prefers-reduced-motion:reduce){#toast{transition:none}}
`;

/** The Plan Library page. The token (if configured) is embedded so same-origin fetches can authenticate. */
export function renderHistory(token = ''): string {
  const config = JSON.stringify({ token, version: HISTORY_CLIENT_VERSION }).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plan Library - King's Reach Council</title>
<style>${CSS}</style></head><body>
<div class="wrap">
<header><div><h1>Plan Library</h1><div class="sub">Every council, plan and build the War Room has ever run. Load a plan, rebuild it, or reconvene on it.</div></div>
<nav><a href="/warroom">War Room</a><a href="/">Mission Control</a><a href="/providers">Settings / Models</a></nav></header>
<section class="stats" id="stats" aria-label="Statistics"></section>
<section class="activebar none" id="active"></section>
<div class="toolbar">
<button class="chip on" data-kind="all">All</button><button class="chip" data-kind="summit">Councils</button><button class="chip" data-kind="build">Builds</button>
<select id="outcome" aria-label="Outcome"><option value="">Any outcome</option></select>
<input type="search" id="q" placeholder="Search question or run id..." aria-label="Search">
<button class="btn" id="refresh">Refresh</button>
</div>
<div class="cols"><ul id="list" aria-label="Runs"></ul><article id="detail"><div class="empty">Select a run to see its plan, results and follow-through.</div></article></div>
</div>
<dialog id="confirm"></dialog><div id="toast" role="status" aria-live="polite"></div>
<script>
var HIST = ${config};
${CLIENT_MD_JS}
</script>
<script src="/history/history-app.js?v=${HISTORY_CLIENT_VERSION}"></script>
</body></html>`;
}
