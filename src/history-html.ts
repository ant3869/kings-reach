// src/history-html.ts - the Plan Library page (served at /history): every council, plan and build the War Room
// has run, with stats and actions. Markup + CSS only; behaviour lives in public/history-app.js (page) and public/history-plans.js (revisions, compare, plan of record).

import { CLIENT_MD_JS } from './client-md.js';
import { SHELL_CSS, pageHead, wrapInShell } from './shell.js';
import { ICON_LINKS } from './brand.js';

export const HISTORY_CLIENT_VERSION = 7;

// Page-specific rules only: palette, rail and the shared button/notice/input kit come from shell.ts.
const CSS = `
:root{--gold:var(--acc);--panel:var(--card);--text:var(--txt);--muted:var(--dim);--good:var(--green);--warn:var(--amber);--bad:var(--red)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,sans-serif;min-height:100vh}
.workspace{max-width:1500px;padding:26px 32px 40px}
a{color:var(--acc)}
h2{margin:18px 0 8px;font:600 11px system-ui;color:var(--faint);letter-spacing:1.2px;text-transform:uppercase}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 14px}
.stat{position:relative;border:1px solid var(--line);border-radius:4px;background:var(--card);padding:12px 14px 11px;overflow:hidden}
.stat:before{content:'';position:absolute;left:0;top:0;right:0;height:2px;background:linear-gradient(90deg,var(--acc),transparent 70%);opacity:.7}
.stat b{display:block;font:500 26px/1.2 Georgia,serif;color:var(--txt);font-variant-numeric:tabular-nums}
.stat span{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:1px}
.stat small{display:block;color:var(--dim);font-size:11.5px;margin-top:3px}
.activebar{border:1px solid #c7a44b55;border-radius:4px;background:var(--acc-soft);padding:11px 16px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.activebar .grow{flex:1;min-width:240px}.activebar.none{border-color:var(--line);background:var(--card);color:var(--dim)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:16px 0 12px}
.chip{border:1px solid var(--line);background:transparent;color:var(--dim);border-radius:4px;padding:6px 14px;cursor:pointer;font:12.5px system-ui}
.chip:hover{color:var(--txt);border-color:#3a4047}.chip.on{border-color:var(--acc);color:#f0e2b0;background:var(--acc-soft)}
input[type=search]{min-width:200px;flex:1;max-width:360px;margin-left:auto}
.cols{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:16px;align-items:start}
@media(max-width:1000px){.cols{grid-template-columns:1fr}}
#list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:76vh;overflow-y:auto;padding-right:4px}
#list button{all:unset;box-sizing:border-box;width:100%;cursor:pointer;display:block;border:1px solid var(--line);border-left:3px solid var(--line);border-radius:4px;background:var(--card);padding:10px 12px}
#list button:has(.badge.good){border-left-color:var(--green)}#list button:has(.badge.warn){border-left-color:var(--amber)}#list button:has(.badge.bad){border-left-color:var(--red)}
#list button:hover{background:var(--raised);border-color:#3a4047}#list button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}
#list button.sel{border-color:var(--acc);background:var(--acc-soft)}
.row1{display:flex;gap:7px;align-items:center;flex-wrap:wrap}.when{color:var(--faint);font-size:11px;margin-left:auto}
.q{margin:6px 0 4px;color:#d6d1c3;font:13px/1.4 system-ui;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.meta{color:var(--faint);font-size:11px}
.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.badge{font:600 10px system-ui;letter-spacing:.8px;text-transform:uppercase;border-radius:3px;padding:2px 7px;border:1px solid currentColor;background:#ffffff08}
.kind-summit{color:var(--blue)}.kind-build{color:var(--acc)}.good{color:var(--green)}.warn{color:var(--amber)}.bad{color:var(--red)}.muted{color:var(--dim)}
.id{font:12px ui-monospace,Consolas,monospace;color:var(--faint)}
#detail{border:1px solid var(--line);border-radius:4px;background:var(--card);padding:20px 24px;min-height:320px}
#detail h3{margin:0 0 4px;font:500 21px/1.3 Georgia,serif;color:var(--txt)}
#detail .empty{color:var(--faint);padding:70px 0;text-align:center;font:italic 14px Georgia,serif}
#detail .empty:before{content:'\\2756';display:block;margin-bottom:10px;font-size:22px;color:var(--acc);opacity:.6;font-style:normal}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 8px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--faint);font:600 10px system-ui;text-transform:uppercase;letter-spacing:1px;padding:5px 8px 5px 0;border-bottom:1px solid var(--line)}
th.num{text-align:right}
td{padding:7px 8px 7px 0;border-bottom:1px solid var(--rule);vertical-align:top}td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr:last-child td{border-bottom:0}
.owner{font:600 10px system-ui;text-transform:uppercase;letter-spacing:.8px;white-space:nowrap}
.verdict{border-left:2px solid var(--acc);padding:2px 0 2px 16px;margin:10px 0;max-height:360px;overflow-y:auto;line-height:1.6;color:#d6d1c3}
.verdict p{margin:6px 0}.verdict h3,.verdict h4{margin:12px 0 4px;color:var(--acc);font-size:14px}.verdict ul,.verdict ol{padding-left:20px}
.diff{list-style:none;padding:0;margin:6px 0}.diff li{margin:7px 0}.diff-a{border-left:3px solid var(--red);padding-left:8px}.diff-b{border-left:3px solid var(--green);padding-left:8px}.warnline{margin-top:6px;color:var(--amber)}#compare h3{margin-top:16px}#compare h4{margin:14px 0 4px}
.chips{display:flex;gap:6px;flex-wrap:wrap}.chips span{border:1px solid var(--line);border-radius:3px;padding:2px 10px;font-size:12px;color:var(--dim)}
.bar{display:flex;height:20px;border-radius:3px;overflow:hidden;border:1px solid var(--line);background:#0a0d10}
.bar i{display:block;font:normal 10px/20px system-ui;color:#0a0a0a;text-align:center;overflow:hidden;white-space:nowrap}
.bar-legend{color:var(--faint);font-size:11px;margin:5px 0}
.conf{display:inline-block;width:110px;height:6px;border-radius:3px;background:var(--rule);overflow:hidden;vertical-align:middle;margin:0 6px}.conf i{display:block;height:100%;background:var(--acc)}
details{margin:10px 0;border-top:1px solid var(--rule);padding-top:8px}summary{cursor:pointer;color:var(--dim);font:600 11px system-ui;text-transform:uppercase;letter-spacing:1px}summary:hover{color:var(--acc)}
pre{background:#07090b;border:1px solid var(--line);border-radius:4px;padding:12px;overflow:auto;max-height:340px;font-size:12px;white-space:pre-wrap}
ul.files{margin:4px 0;padding-left:18px;font:12px ui-monospace,Consolas,monospace;color:var(--dim)}
.linkbtn{all:unset;color:var(--acc);cursor:pointer;text-decoration:underline}
.actbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}.actbar .btn[aria-pressed=true]{background:var(--acc);color:#10100a;border-color:var(--acc);font-weight:600}
dialog{background:var(--card);color:var(--txt);border:1px solid var(--acc);border-radius:6px;max-width:520px;padding:22px 24px;box-shadow:0 20px 60px #000c}
dialog::backdrop{background:#000b}dialog h3{margin:0 0 10px;color:var(--txt);font:500 19px Georgia,serif}dialog p{line-height:1.55;color:var(--dim)}
dialog .actions{justify-content:flex-end}
#toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%);background:var(--raised);border:1px solid var(--acc);color:#f0e2b0;padding:9px 18px;border-radius:4px;opacity:0;pointer-events:none;transition:opacity .25s;z-index:50}
#toast.show{opacity:1}
@media(max-width:820px){.workspace{padding:18px 14px 30px}input[type=search]{margin-left:0;max-width:none}}
`;

/** The Plan Library page. The token (if configured) is embedded so same-origin fetches can authenticate. */
export function renderHistory(token = ''): string {
  const config = JSON.stringify({ token, version: HISTORY_CLIENT_VERSION }).replace(/</g, '\\u003c');
  const body = `<div class="workspace">
${pageHead('The Royal Archives', 'Plan Library', 'Every council, plan and build the War Room has ever run. Load a plan, rebuild it, or reconvene on it.')}
<section class="stats" id="stats" aria-label="Statistics"></section>
<section class="activebar none" id="active"></section>
<div class="toolbar">
<button class="chip on" data-kind="all">All</button><button class="chip" data-kind="summit">Councils</button><button class="chip" data-kind="build">Builds</button>
<select id="outcome" aria-label="Outcome"><option value="">Any outcome</option></select>
<input type="search" id="q" placeholder="Search question or run id..." aria-label="Search">
<button class="btn" id="refresh">Refresh</button>
</div>
<div class="cols"><ul id="list" aria-label="Runs"></ul><article id="detail"><div class="empty">Select a scroll from the archive to read its plan, results and follow-through.</div></article></div>
</div>
<dialog id="confirm"></dialog><div id="toast" role="status" aria-live="polite"></div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ICON_LINKS}
<title>Plan Library - King's Reach Council</title>
<style>${SHELL_CSS}${CSS}</style></head><body>
${wrapInShell('history', token, body, { version: `Client v${HISTORY_CLIENT_VERSION}` })}
<script>
var HIST = ${config};
${CLIENT_MD_JS}
</script>
<script src="/history/history-plans.js?v=${HISTORY_CLIENT_VERSION}"></script>
<script src="/history/history-app.js?v=${HISTORY_CLIENT_VERSION}"></script>
</body></html>`;
}
