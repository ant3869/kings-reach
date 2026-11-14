// src/skills-html.ts - the Skills page (served at /skills): which skills each role gets. Markup + CSS only; behaviour lives in public/skills-app.js.
// Read-only by contract: it shows configuration and integrity, never changes either. See skill-matrix.ts.

import { SHELL_CSS, pageHead, wrapInShell } from './shell.js';
import { ICON_LINKS } from './brand.js';

export const SKILLS_CLIENT_VERSION = 1;

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.45 system-ui,sans-serif;min-height:100vh}
.workspace{max-width:1300px;padding:26px 32px 40px}
h2{margin:22px 0 8px;font:600 11px system-ui;color:var(--faint);letter-spacing:1.2px;text-transform:uppercase}
.note{color:var(--dim);font-size:12.5px;margin:2px 0 10px;max-width:90ch}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:0 0 14px}
.stat{border:1px solid var(--line);border-radius:4px;background:var(--card);padding:10px 14px}
.stat b{display:block;font:500 24px/1.2 Georgia,serif;font-variant-numeric:tabular-nums}.stat span{color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:1px}
.problem{border:1px solid var(--line);border-left:3px solid var(--dim);border-radius:4px;background:var(--card);padding:8px 12px;margin:0 0 7px}
.problem.warning{border-left-color:#f0883e}
table.matrix{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:4px}
.matrix th,.matrix td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.matrix thead th{font:600 11px system-ui;color:var(--faint);letter-spacing:1px;text-transform:uppercase;white-space:nowrap}
.matrix thead th small{display:block;font-weight:400;letter-spacing:0;text-transform:none;color:var(--dim)}
.matrix td.cell{white-space:nowrap}.matrix tr:last-child td,.matrix tr:last-child th{border-bottom:0}
.skillname{font-weight:600}.sub{color:var(--dim);font-size:11.5px;margin-top:2px}
.mark{display:inline-block;min-width:78px}
.mark.required{color:#7ee2a0}.mark.available{color:#79c0ff}.mark.none{color:var(--faint)}.mark.blocked{color:#f0883e}
.badge{font-size:10.5px;text-transform:uppercase;letter-spacing:.8px;border-radius:3px;padding:1px 6px;border:1px solid var(--line);color:var(--dim);margin-left:6px}
.badge.bad{color:#f0883e;border-color:#f0883e66}
.legend{display:flex;gap:18px;flex-wrap:wrap;color:var(--dim);font-size:12.5px;margin:8px 0}
.empty{color:var(--dim);padding:18px;border:1px dashed var(--line);border-radius:4px}
.limits{color:var(--dim);font-size:12.5px;margin:14px 0 0;padding-left:18px;max-width:100ch}
`;

export function renderSkills(token = ''): string {
  const config = JSON.stringify({ token, version: SKILLS_CLIENT_VERSION }).replace(/</g, '\\u003c');
  const body = `<div class="workspace">
${pageHead('The Armoury', 'Skills', 'Which skills each role gets, and whether they can actually load. Read-only: nothing here changes an assignment.')}
<section class="stats" id="stats" aria-label="Totals"></section>
<h2>Needs attention</h2><div id="problems" aria-label="Problems"></div>
<h2>Skills by role</h2>
<div class="legend" aria-label="Legend"><span><b class="mark required">&#9679; Required</b> loaded and followed before the work starts</span><span><b class="mark available">&#9675; Offered</b> the role loads it when the task matches</span><span><b class="mark blocked">&#9888; Blocked</b> assigned, but fails its integrity check, so it is left out</span></div>
<div id="matrix" aria-label="Skill matrix"></div>
<ul class="limits" id="limits" aria-label="What this page cannot tell you"></ul>
</div>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${ICON_LINKS}
<title>Skills - King's Reach Council</title>
<style>${SHELL_CSS}${CSS}</style></head><body>
${wrapInShell('skills', token, body, { version: `Client v${SKILLS_CLIENT_VERSION}` })}
<script>var SKL = ${config};</script>
<script src="/skills/skills-app.js?v=${SKILLS_CLIENT_VERSION}"></script>
</body></html>`;
}
