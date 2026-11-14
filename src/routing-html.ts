// src/routing-html.ts - the Route advice page (served at /routing). Markup + CSS only; behaviour lives in public/routing-app.js.
// Read-only and advisory by contract: see routing-advice.ts.

import { SHELL_CSS, pageHead, wrapInShell } from './shell.js';
import { ICON_LINKS } from './brand.js';

export const ROUTING_CLIENT_VERSION = 1;

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,sans-serif;min-height:100vh}
.workspace{max-width:1300px;padding:26px 32px 40px}
h2{margin:22px 0 8px;font:600 11px system-ui;color:var(--faint);letter-spacing:1.2px;text-transform:uppercase}
.note{color:var(--dim);font-size:12.5px;margin:2px 0 10px;max-width:90ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 14px}
.stat{border:1px solid var(--line);border-radius:4px;background:var(--card);padding:10px 14px}
.stat b{display:block;font:500 24px/1.2 Georgia,serif;font-variant-numeric:tabular-nums}.stat span{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:1px}
.advice{border:1px solid var(--line);border-left:3px solid #79c0ff;border-radius:4px;background:var(--card);padding:8px 12px;margin:0 0 7px}
.advice.heads-up{border-left-color:#f0883e}
.advice small{display:block;color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:1px;margin-bottom:2px}
table.routes{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:4px;margin:0 0 6px}
.routes th,.routes td{padding:7px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.routes thead th{font:600 11px system-ui;color:var(--faint);letter-spacing:1px;text-transform:uppercase;white-space:nowrap}
.routes td.n{font-variant-numeric:tabular-nums;white-space:nowrap}.routes tr:last-child td{border-bottom:0}
.sub{color:var(--dim);font-size:11.5px}
.conf{font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;border-radius:3px;padding:1px 6px;border:1px solid var(--line);color:var(--dim)}
.conf.reasonable{color:#7ee2a0;border-color:#7ee2a066}.conf.limited{color:#f0e2b0;border-color:#c7a44b66}
.empty{color:var(--dim);padding:18px;border:1px dashed var(--line);border-radius:4px}
.limits{color:var(--dim);font-size:12.5px;margin:14px 0 0;padding-left:18px;max-width:100ch}
`;

export function renderRouting(token = ''): string {
  const config = JSON.stringify({ token, version: ROUTING_CLIENT_VERSION }).replace(/</g, '\\u003c');
  const body = `<div class="workspace">
${pageHead('The Scouts', 'Route advice', 'What past runs say about which provider and model finishes the work for each role. Advice only: nothing here changes a route.')}
<section class="stats" id="stats" aria-label="Evidence"></section>
<h2>Advice</h2><div id="advice" aria-label="Advice"></div>
<h2>Evidence by role</h2><div id="roles" aria-label="Routes by role"></div>
<ul class="limits" id="limits" aria-label="What this page cannot tell you"></ul>
</div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ICON_LINKS}
<title>Route advice - King's Reach Council</title>
<style>${SHELL_CSS}${CSS}</style></head><body>
${wrapInShell('routing', token, body, { version: `Client v${ROUTING_CLIENT_VERSION}` })}
<script>var RTE = ${config};</script>
<script src="/routing/routing-app.js?v=${ROUTING_CLIENT_VERSION}"></script>
</body></html>`;
}
