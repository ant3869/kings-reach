// src/warroom-html.ts - the War Room council chamber page (served at /warroom).
// Markup + CSS only. Behaviour lives in public/warroom-app.js + public/warroom-voice.js (real JS files,
// node --check-able, no template-literal escaping). Casting comes from warroom/voices.json (one source).
// Bump WARROOM_CLIENT_VERSION on every client change: it shows in the page AND /api/health.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, WARROOM_PORT } from './config.js';
import { CLIENT_MD_JS, esc } from './client-md.js';
import { activePlan, type PlanSummary } from './history.js';
import { SHELL_CSS, wrapInShell } from './shell.js';

export const WARROOM_CLIENT_VERSION = 37;
export const WARROOM_PROTOCOL = 'council-v6'; // must match PROTOCOL in warroom/server.py
const CARD_ROLES = ['main', 'research', 'comms', 'content', 'ops'] as const;
const CARD_STATES = ['idle', 'thinking', 'speaking', 'building'] as const;
const CARD_ASSETS = CARD_STATES.flatMap((state) =>
  CARD_ROLES.map((role) => `card-states/individual/${state}-${role}.png`));
/** Every file the manifest can hand out (variant art), plus the manifest itself. Read once at startup. */
function manifestAssets(): string[] {
  try {
    const m = JSON.parse(readFileSync(join(PROJECT_ROOT, 'public', 'card-states', 'manifest.json'), 'utf8')) as
      { roles: string[]; pools: Record<string, [string, number][]> };
    const files = new Set<string>();
    for (const pool of Object.values(m.pools)) {
      for (const [template] of pool) for (const role of m.roles) files.add(`card-states/${template.replace('{role}', role)}`);
    }
    return ['card-states/manifest.json', ...files];
  } catch {
    return []; // no manifest: the client falls back to the original four-state art
  }
}
export const WARROOM_STATIC: readonly string[] = ['warroom-app.js', 'warroom-voice.js', 'warroom-live.js', 'warroom-result.js', 'warroom-demo.js',
  'warroom-casting.js', 'card-director.js', 'mic-worklet.js',
  'warroom-council-cards.png', 'warroom-chamber-bg.png', ...CARD_ASSETS, ...manifestAssets()];

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

/** Largest font (px) at which the title still fits the plate: Georgia bold is ~0.53em per character, the plate ~150px. */
export const titleSize = (title: string): number => Math.max(12, Math.min(18, Math.floor(150 / (Math.max(title.length, 1) * 0.53))));

/** `bm_george` -> `George` (the saved voice id, shown until the server's list replaces it). */
export const voiceName = (voice: string): string => {
  const name = voice.split('_').slice(1).join(' ') || voice;
  return name.charAt(0).toUpperCase() + name.slice(1);
};

const CSS = `
@property --lvl{syntax:'<number>';inherits:false;initial-value:0}
:root{--gold:#d4a017;--bg:#07070d;--panel:#11111b;--line:#3a3020}
*{box-sizing:border-box}
body{background:#05070b;color:#eadfbe;font-family:Georgia,'Times New Roman',serif;margin:0;padding:0;min-height:100vh;position:relative}
body:before{content:'';position:fixed;inset:0;background:linear-gradient(#02050aaa,#03050bdd),url('/warroom/warroom-chamber-bg.png?v=1') center top/cover no-repeat;z-index:-2}
body:after{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at center top,transparent 15%,#02040a88 72%);z-index:-1;pointer-events:none}
.kr-main{padding:14px}.kr-main>.kr-auth{margin:-14px -14px 12px}.wrap{max-width:1400px;margin:0 auto}
h1{font-size:31px;text-align:center;letter-spacing:7px;margin:0;color:#f4df9a;text-shadow:0 1px #000,0 0 18px #d4a01766}
.sub{text-align:center;font:italic 12px Georgia;color:#b2a47d;margin:0 0 5px}.sub a{color:#e2bf62}
#status{text-align:center;font:13px system-ui;margin:6px}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#f85149;margin-right:6px}
.dot.on{background:#3fb950;box-shadow:0 0 8px #3fb950}
.vstat{display:block;font:12px system-ui;color:#8b949e;margin-top:3px}.vstat.ready{color:#3fb950}.vstat.failed{color:#f85149}
#council{display:flex;gap:9px;justify-content:center;margin:40px 0 10px;flex-wrap:wrap}/* headroom: the speaker lifts 14px and grows 9%, and transforms take no layout space */
.seat{--lvl:0;position:relative;width:184px;height:310px;text-align:center;border-radius:18px;transition:transform 320ms cubic-bezier(.2,.8,.2,1),opacity 360ms ease,filter 360ms ease;filter:drop-shadow(0 8px 9px #000);isolation:isolate}
.strip-a,.strip-b{position:absolute;left:0;top:0;width:184px;height:270px;border-radius:18px;object-fit:fill;transition:opacity 260ms ease,filter 320ms ease;will-change:opacity;z-index:1;pointer-events:none}
.strip-a{opacity:1}.strip-b{opacity:0}
.seat:after{content:'';position:absolute;inset:12px 8px 51px;border-radius:22px;background:var(--ac);filter:blur(16px);box-shadow:0 0 24px 7px var(--ac),0 0 52px 12px var(--ac);opacity:.10;transition:opacity 420ms ease;pointer-events:none;z-index:0}
/* The card art ships with an EMPTY nameplate (scripts/card_plate.py): name, title, route and voice are live text on it.
   Positions are fractions of the card height (--ch) so the 164px layout below needs no second set of numbers. */
.seat{--ch:270px}
.seat .plate{position:absolute;z-index:3;left:12px;right:12px;top:calc(var(--ch)*.65);text-align:center;pointer-events:none}
.seat .ptitle{display:flex;align-items:center;justify-content:center;height:21px;font:700 var(--tfs,17px)/1 Georgia,serif;color:#f6e9c0;white-space:nowrap;text-shadow:0 1px 2px #000,0 0 9px #000c}
.seat .pname{display:block;margin-top:1px;font:italic 11.5px Georgia,serif;color:#cdbf95;text-shadow:0 1px 2px #000}
.seat .rule{position:absolute;z-index:3;left:24%;right:24%;top:calc(var(--ch)*.795);height:1px;background:linear-gradient(90deg,transparent,#c9a24a,transparent);opacity:.75;pointer-events:none}
.seat .route{position:absolute;z-index:3;top:calc(var(--ch)*.815);left:12px;right:12px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cbbd96;font:10px system-ui;text-shadow:0 1px 2px #000;pointer-events:none}
.seat .voice{position:absolute;z-index:4;top:calc(var(--ch)*.87);left:12px;right:12px;display:flex;align-items:center;justify-content:center;gap:4px;color:#8f856c;font:10px system-ui;text-shadow:0 1px 2px #000}
.seat .voice select{appearance:none;-webkit-appearance:none;max-width:118px;padding:1px 15px;text-align:center;text-align-last:center;color:#d9c995;font:10px system-ui;background:transparent no-repeat right 5px center/8px 5px;border:1px solid transparent;border-radius:6px;text-overflow:ellipsis;cursor:pointer;color-scheme:dark}
/* the caret appears only on hover/focus, so at rest the voice reads as plain text */
.seat .voice:hover select,.seat .voice select:focus{border-color:#b78a33;background-color:#0b0905e6;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='5'%3E%3Cpath d='M0 0h8L4 5z' fill='%23b78a33'/%3E%3C/svg%3E");color:#f4e3a8}
.seat .voice select:disabled{cursor:default;opacity:.8}
.seat .pin{position:absolute;z-index:3;top:calc(var(--ch) + 6px);left:50%;transform:translateX(-50%);width:62px;height:25px;font:11px Georgia;background:#090806bb;border:1px solid #b78a33;color:#f0d88e;border-radius:9px;cursor:pointer;box-shadow:inset 0 0 7px #d4a01722}
.seat.pinned .pin{background:#7b5819;color:#fff2bc;box-shadow:0 0 13px var(--ac)}
@media(max-width:1050px){.seat{--ch:241px;width:164px;height:284px}.strip-a,.strip-b{width:164px;height:241px}.seat .plate{left:9px;right:9px}.seat .voice select{max-width:104px}}
#stages{display:flex;justify-content:center;gap:6px;flex-wrap:wrap;margin:8px 0}
.stage{font:12px Georgia;padding:5px 14px;border-radius:9px;border:1px solid #735628;color:#9d8b65;background:linear-gradient(#16140f,#090a0e);box-shadow:inset 0 0 9px #d4a01712}
.stage.active{color:#000;background:linear-gradient(#f4d77c,#a26b16);border-color:#ffe29a;animation:pulse 1.4s ease-in-out infinite}
.stage.done{color:#e6cb7b;border-color:#b88a36}.stage.failed{color:#f85149;border-color:#f85149}.stage.skipped{text-decoration:line-through}
.stage i{font-style:normal;opacity:.75}
@keyframes pulse{50%{box-shadow:0 0 14px var(--gold)}}
#prog{text-align:center;font:12px system-ui;color:var(--gold);min-height:18px}
.main{display:grid;grid-template-columns:1fr 300px;gap:14px;margin-top:8px}
@media(max-width:900px){.main{grid-template-columns:1fr}}
/* once a run starts (first stage chip exists) shrink the seats so the log and verdict sit above the fold; layout-affecting zoom */
body:has(#stages .stage) #council{zoom:.62;margin:10px 0 4px}

#log{height:45vh;min-height:310px;overflow-y:auto;border:2px solid #8e6a2c;border-radius:4px;padding:18px;background:linear-gradient(#060a11ed,#080b12f5);font:14px/1.55 system-ui;display:flex;flex-direction:column;gap:12px;box-shadow:inset 0 0 0 3px #05060a,inset 0 0 30px #000,0 8px 24px #000}
.bubble{--ac:var(--gold);border-left:3px solid var(--ac);padding:2px 0 2px 12px;max-width:96%}
.bubble .who{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--ac)}
.bubble .tag{font-size:10px;margin-left:8px;padding:1px 7px;border-radius:999px;border:1px solid var(--ac);color:var(--ac)}
.bubble .when{font-size:10px;color:#9aa3ad;margin-left:6px}
.bubble p{margin:5px 0}.bubble ul,.bubble ol{margin:5px 0;padding-left:20px}.bubble h3,.bubble h4{margin:8px 0 4px;color:var(--gold)}
.bubble pre{background:#000;border:1px solid #30363d;border-radius:6px;padding:8px;overflow-x:auto;font-size:12px}
.bubble code{background:#000;padding:1px 5px;border-radius:4px;font-size:12px}.bubble pre code{padding:0}.bubble a{color:#79c0ff}
.bubble.you{--ac:#8b949e;align-self:flex-end;text-align:right}.bubble.sys{--ac:#9aa3ad;font-style:italic;color:#8b949e}
.bubble.err{--ac:#f85149;color:#f85149}.bubble.verdict{background:#d4a01712;border-radius:0 10px 10px 0;padding:8px 12px}
.bubble .brief{font:600 14px/1.5 system-ui;color:#eadfbe;margin:5px 0}.bubble details{margin-top:7px;border-top:1px solid #8e6a2c55;padding-top:6px}.bubble summary{cursor:pointer;color:#d9b85d;font:11px system-ui;text-transform:uppercase;letter-spacing:.5px}.bubble .full{margin-top:8px;color:#bdb6a5}.bubble.you .full{text-align:left}
.buildlive{border:1px solid #8e6a2c;border-radius:8px;background:#080b12e8;margin:8px auto;padding:10px 12px;max-width:980px;font:12px system-ui;box-shadow:inset 0 0 18px #000}.buildlive h3{margin:0 0 8px;color:#e4c468;font:600 13px Georgia}.buildphases{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}.buildphase{border:1px solid #302b22;border-radius:6px;padding:7px;color:#7f786a}.buildphase.active{border-color:#c28b31;color:#f0d78f;box-shadow:inset 0 0 10px #d4a01718}.buildphase.done{border-color:#3fb95088;color:#72d487}.buildphase.failed{border-color:#f85149;color:#ff7b72}.buildphase.attention{border-color:#e3b341;color:#f0c75e}.buildphase.skipped{text-decoration:line-through}.buildphase b,.buildphase span{display:block}.buildphase span{margin-top:3px;color:inherit}.builddetail{margin-top:7px;color:#9d9481}.metricfail{margin-top:9px;border-left:3px solid #f85149;padding:6px 9px;color:#ff9b94;background:#f8514910}@media(max-width:700px){.buildphases{grid-template-columns:1fr 1fr}}
.buildresult{border:1px solid #8e6a2c;border-radius:8px;background:#080b12f2;margin:8px auto;padding:12px 14px;max-width:980px;font:13px system-ui;color:#eadfbe;box-shadow:inset 0 0 18px #000}.buildresult.complete{border-color:#3fb95099}.buildresult.attention{border-color:#e3b341}.buildresult.failed{border-color:#f85149}
.rhead{margin:0 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;font:600 15px Georgia}.rbadge{font:700 12px system-ui;letter-spacing:.6px;padding:3px 9px;border-radius:6px;border:2px solid;white-space:nowrap}.buildresult.complete .rbadge{color:#3fb950}.buildresult.attention .rbadge{color:#e3b341;background:#e3b34118}.buildresult.failed .rbadge{color:#ff7b72;background:#f8514922}.rtitle{color:#f4ead0}
.rdetail{margin:6px 0 10px;line-height:1.5;color:#d9cfb4}.buildresult h4{margin:10px 0 5px;font:700 11px system-ui;letter-spacing:.6px;text-transform:uppercase;color:#b9ad8c}.rissues ul,.rlist ul{margin:0;padding-left:20px}.rissues li{margin:3px 0;color:#f0c75e;line-height:1.4}
.rfiles,.routput{margin-top:8px;color:#b9ad8c}.rfiles summary,.routput summary{cursor:pointer}.routput pre{white-space:pre-wrap;max-height:200px;overflow:auto;margin:6px 0 0;padding:8px;background:#05070c;border-radius:6px;color:#c9d1d9;font:11px Consolas,monospace}
.ractions{margin-top:12px;padding-top:6px;border-top:1px solid #302b22}.raction{display:flex;gap:12px;align-items:center;margin:8px 0;flex-wrap:wrap}.raction button{min-width:190px;min-height:36px}.rhint{flex:1;min-width:220px;color:#b9ad8c;line-height:1.4}.buildresult button:focus-visible{outline:2px solid #e4c468;outline-offset:2px}
.main aside{display:flex;flex-direction:column;gap:12px}
.panel{border:2px solid #8e6a2c;border-radius:4px;background:linear-gradient(#090d15ee,#0c0e14f5);padding:14px;font:13px system-ui;box-shadow:inset 0 0 0 3px #05060a,inset 0 0 22px #000}
.panel h3{margin:0 0 8px;font:600 13px system-ui;color:var(--gold);letter-spacing:.5px}.panel h3 small{color:#6e7681;font-weight:400}
.panel table{width:100%;border-collapse:collapse}.panel td{padding:3px 0;border-bottom:1px solid #1e1e2a}.panel td+td{text-align:right;color:#e8dcc0}
.stagetimes{margin-top:8px;color:#9aa3ad;font-size:11px}
#mic{display:block;width:116px;height:116px;margin:8px auto 14px;padding:20px;border-radius:50%;border:3px double #ffd26c;background:radial-gradient(circle,#3b280d 0 38%,#0b0b0d 42% 58%,#b37a20 60% 62%,#08090c 65%);color:#ffe7a2;font:600 12px Georgia;cursor:pointer;user-select:none;touch-action:none;box-shadow:0 0 22px #d79b35,inset 0 0 18px #000;text-shadow:0 1px #000}
#mic.hot{background:#b62324;border-color:#f85149;color:#fff;box-shadow:0 0 22px #f85149}
#mic:disabled{opacity:.4;cursor:not-allowed}
#micstate,#heard{font:12px system-ui;color:#8b949e;min-height:16px;margin-top:6px}
.panel label{display:block;margin-top:7px;color:#c9d1d9;cursor:pointer}
.composer{display:flex;gap:8px;margin-top:12px}
input#msg{flex:1;background:#161b22;color:#e8dcc0;border:1px solid var(--line);border-radius:8px;padding:11px 14px;font-size:14px}
button.go{background:linear-gradient(#755724,#3d2d12);color:#fff0bd;border:1px solid #c99a42;border-radius:8px;padding:10px 16px;cursor:pointer;font:14px Georgia;box-shadow:inset 0 0 8px #000}
button.go:hover{background:linear-gradient(#977335,#4e3815)}button.alt{background:#090b10dd;border:1px solid var(--gold);color:#e9c96e}
button.stop{background:transparent;border:1px solid #f85149;color:#f85149}
.hint{font:11px system-ui;color:#9aa3ad;margin-top:6px}
.panel h3 small{color:#9aa3ad}
.bubble.verdict{border:1px solid #d4a017;border-left:4px solid #d4a017;box-shadow:0 0 14px #d4a01733}
.bubble .vhead{font:700 12px system-ui;letter-spacing:.5px;color:#f4d77c;text-transform:uppercase}
.bubble .vfull{max-height:40vh;overflow-y:auto;color:#e8dcc0}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible,#mic:focus-visible,a:focus-visible{outline:3px solid #f4d77c;outline-offset:2px}
button.go,input#msg{min-height:44px}
@media(max-width:760px){.main>*,.main aside{min-width:0}.composer{flex-wrap:wrap}.composer input#msg{min-width:0;flex-basis:100%}body{overflow-x:hidden}}
.planline{font:12px/1.5 system-ui;color:#b2a47d;margin-top:8px}.planline a{color:#e2bf62}.planline b{color:#f0d88e}.planline.none{color:#8f856c}
.now{max-width:980px;margin:8px auto;padding:10px 14px;border:1px solid #8e6a2c;border-radius:8px;background:#080b12e8;font:13px system-ui}
.nowhead{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.nowbadge{font:700 12px system-ui;letter-spacing:.6px;padding:4px 10px;border-radius:6px;border:2px solid #6e7681;color:#c9d1d9;min-width:108px;text-align:center}
.nowbadge.working,.nowbadge.running{border-color:#d4a017;color:#f4d77c}.nowbadge.working:before,.nowbadge.running:before{content:'';display:inline-block;width:8px;height:8px;margin-right:6px;border-radius:50%;background:#d4a017;animation:beat 1s ease-in-out infinite}
.nowbadge.quiet{border:2px dashed #e3b341;color:#e3b341}.nowbadge.stalled{border:2px solid #f85149;color:#fff;background:#f8514933;animation:pulse 1s ease-in-out infinite}
.nowbadge.attention{border-color:#e3b341;color:#e3b341;background:#e3b34118}.nowbadge.complete{border-color:#3fb950;color:#3fb950}.nowbadge.failed{border-color:#f85149;color:#f85149;background:#f8514922}.nowbadge.cancelled{border:2px dotted #8b949e;color:#8b949e}
#nowlabel{flex:1;min-width:200px;color:#eadfbe}#nowclock{font-variant-numeric:tabular-nums;color:#8b949e}
.meter{height:10px;margin:9px 0 4px;border-radius:5px;background:#1a1d27;border:1px solid #3a3020;overflow:hidden}
#meterfill{height:100%;width:0;background:repeating-linear-gradient(135deg,#d4a017 0 10px,#a47a10 10px 20px);transition:width .6s ease}
.meter.attention #meterfill{background:#e3b341}.meter.complete #meterfill{background:#3fb950}.meter.failed #meterfill{background:#f85149}.meter.cancelled #meterfill{background:#6e7681}
#meterlabel{font-size:11px;color:#8b949e;min-height:15px}
.arow{display:grid;grid-template-columns:90px 112px 1fr auto 56px;gap:8px;align-items:baseline;padding:3px 0;border-top:1px solid #1e1e2a;font-size:12px}
.arow b{color:#f0d88e}.arow .st{font-weight:700}.arow .txt{color:#cbbd96;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.arow .cnt,.arow .ago{color:#8b949e;font-variant-numeric:tabular-nums}
.arow.quiet .st{color:#e3b341}.arow.stalled .st{color:#f85149}.arow.failed .st{color:#f85149}.arow.complete .st{color:#3fb950}
.caption{margin-top:8px;padding:6px 10px;border-left:3px solid var(--gold);background:#d4a01710;font:italic 13px Georgia;color:#eadfbe;min-height:20px}.caption:empty{border-left-color:transparent;background:none}/* keep the space (no layout jump), drop the gold bar when there is nothing to say */
.feed{list-style:none;margin:6px 0 0;padding:0;font-size:11px;line-height:15px;color:#8b949e}.feed li{padding:1px 0}/* no max-height: the list is bounded by FEED_MAX, and a clipped warning is worse than a taller panel */.feed li.edit:before{content:'\u270e ';color:#d4a017}.feed li.warn{color:#e3b341}.feed li.warn:before{content:'\u26a0 '}.feed li.bad{color:#f85149}.feed li.bad:before{content:'\u2716 '}.feed li.ok:before{content:'\u2714 ';color:#3fb950}.feed li.narr:before{content:'\u266a '}
.badge{position:absolute;z-index:5;top:4px;left:4px;font:700 10px system-ui;padding:2px 6px;border-radius:5px;background:#05070bdd;border:1px solid #6e7681;color:#c9d1d9}.badge:empty{display:none}
.badge.working{border-color:#d4a017;color:#f4d77c}.badge.quiet{border-style:dashed;border-color:#e3b341;color:#e3b341}.badge.stalled{border-color:#f85149;color:#fff;background:#f85149aa}.badge.complete{border-color:#3fb950;color:#3fb950}.badge.failed{border-color:#f85149;color:#f85149}
.seat[data-live='stalled']{outline:3px solid #f85149;outline-offset:3px}.seat[data-live='quiet']{outline:2px dashed #e3b341;outline-offset:3px}/* lasting, non-colour-only cue: the pose art reverts after a few seconds */
@keyframes beat{50%{opacity:.25}}
@keyframes idle-breathe{from{transform:scale(1)}to{transform:scale(1.004)}}
@keyframes think-pulse{from{opacity:.26}to{opacity:.58}}
@keyframes build-pulse{from{opacity:.24}to{opacity:.50}}
.seat[data-state='idle'] .strip-a,.seat[data-state='idle'] .strip-b{animation:idle-breathe 4200ms ease-in-out alternate infinite}
.seat[data-state='thinking']{transform:translateY(-3px)}
.seat[data-state='thinking']:after{opacity:.26;animation:think-pulse 1700ms ease-in-out alternate infinite;will-change:opacity}
.seat[data-state='speaking']{transform:translateY(-14px) scale(1.09);z-index:4}
.seat[data-state='speaking'] .strip-a,.seat[data-state='speaking'] .strip-b{filter:saturate(1.12) brightness(1.06)}
.seat[data-state='speaking']:after{opacity:calc(0.52 + var(--lvl) * 0.38);transition:opacity 70ms linear;will-change:opacity}
.seat[data-state='building']{transform:translateY(-2px) scale(1.012)}
.seat[data-state='building']:after{opacity:.24;animation:build-pulse 2300ms ease-in-out alternate infinite}
.seat.dimmed{opacity:.82;filter:saturate(.72) brightness(.86);transition:opacity 420ms ease,filter 420ms ease}
.seat[data-state='researching']{transform:translateY(-4px)}
.seat[data-state='researching']:after{opacity:.3;animation:think-pulse 1300ms ease-in-out alternate infinite;will-change:opacity}
.seat[data-state='offense']{transform:translateY(-8px) scale(1.045);z-index:3}
.seat[data-state='offense']:after{opacity:.5}
.seat[data-state='defense']{transform:translateY(1px) scale(.985)}
.seat[data-state='defense']:after{opacity:.2}
.seat[data-state='confused']{transform:rotate(-1.4deg) translateY(-2px)}
.seat[data-state='confused']:after{opacity:.16}
.seat[data-state='defeated']{transform:translateY(4px) scale(.975)}
.seat[data-state='defeated'] .strip-a,.seat[data-state='defeated'] .strip-b{filter:saturate(.7) brightness(.88)}
.seat[data-state='defeated']:after{opacity:.04}
@media(prefers-reduced-motion:reduce){
.nowbadge,.nowbadge:before{animation:none!important}#meterfill{transition:none}
.seat,.strip-a,.strip-b,.seat:after{animation:none!important}
.seat{transition:opacity 180ms ease;transform:none!important}
.seat.dimmed{filter:none}
.seat[data-state='idle']:after{opacity:.08}
.seat[data-state='thinking']:after{opacity:.30}
.seat[data-state='speaking']:after{opacity:.70}
.seat[data-state='speaking'],.seat[data-state='offense']{outline:2px solid var(--ac);outline-offset:4px}
.seat[data-state='building']:after{opacity:.34}
}
`;

/** Which plan the Build button will execute (the archive lives on the Plan Library page). */
function planLine(plan: PlanSummary | null): string {
  if (!plan) return `<div class="planline none">No plan on file: convene the council first. <a href="/history">Plan Library</a></div>`;
  const objective = plan.objective.length > 150 ? `${plan.objective.slice(0, 150)}...` : plan.objective;
  return `<div class="planline">Build will execute plan <b>${esc(plan.run)}</b> (${plan.steps} steps): <i>${esc(objective)}</i> &middot; ` +
    `<a href="/history#run=${esc(plan.run)}">review it</a> &middot; <a href="/history">Plan Library</a></div>`;
}

/** Just the plan line, for the page to re-fetch after a summit (it is rendered once at load and goes stale otherwise). */
export function renderPlanLine(plan: PlanSummary | null = activePlan()): string {
  return planLine(plan);
}

/** Full-page War Room: council seats, stage tracker, log, voice + scoreboard panels. */
export function renderWarRoom(plan: PlanSummary | null = activePlan()): string {
  const council = loadCouncil();
  const seats = council
    .map(
      (c) =>
        `<div class="seat" id="seat-${esc(c.id)}" style="--ac:${c.color}" data-state="idle">` +
        `<img class="strip-a" src="/warroom/card-states/individual/idle-${esc(c.id)}.png?v=${WARROOM_CLIENT_VERSION}" alt="">` +
        `<img class="strip-b" alt="">` +
        `<span class="badge" id="badge-${esc(c.id)}"></span>` +
        // Title big, role name small beneath: both live text on the blank plate. The font shrinks for long titles.
        `<div class="plate"><b class="ptitle" style="--tfs:${titleSize(c.title)}px">${esc(c.title || c.name)}</b><span class="pname">${esc(c.name)}</span></div>` +
        `<div class="rule"></div>` +
        `<small class="route" id="model-${esc(c.id)}">waiting</small>` +
        // Shows the saved voice until the server's list arrives (warroom-casting.js then fills in every choice).
        `<label class="voice"><select data-voice-for="${esc(c.id)}" aria-label="Voice for ${esc(c.name)}"><option value="${esc(c.voice)}" selected>${esc(voiceName(c.voice))}</option></select></label>` +
        `<button class="pin" data-pin="${esc(c.id)}">Pin</button></div>`,
    )
    .join('');
  const config = JSON.stringify({ port: WARROOM_PORT, protocol: WARROOM_PROTOCOL, version: WARROOM_CLIENT_VERSION, council });
  const v = `?v=${WARROOM_CLIENT_VERSION}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>War Room v${WARROOM_CLIENT_VERSION} - King's Reach Council</title>
<style>${SHELL_CSS}${CSS}</style></head><body>
${wrapInShell('warroom', '', `<div class="wrap">
<h1>THE WAR ROOM</h1>
<p class="sub">Plan. Investigate. Cross-examine. Decide. Build. client v${WARROOM_CLIENT_VERSION} &middot; <span id="sver">server ?</span></p>
<div id="status"><span class="dot" id="dot"></span><span id="stext">connecting...</span><span class="vstat" id="vstat">voice: ?</span></div>
<div id="council">${seats}</div>
<div id="stages"></div>
<div id="prog"></div>
<section id="now" class="now" aria-label="Live status">
<div class="nowhead"><span id="nowbadge" class="nowbadge idle">\u00b7 IDLE</span><span id="nowlabel" role="status" aria-live="polite">Nothing running. Convene the council or build the verdict.</span><span id="nowclock"></span><button class="go stop" id="nowcancel" hidden>Cancel run</button><span id="cancelnote" role="status" aria-live="polite"></span></div>
<div id="meter" class="meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Estimated progress"><div id="meterfill"></div></div>
<div id="meterlabel"></div>
<div id="agentlines"></div>
<div id="caption" class="caption" role="status" aria-live="polite"></div>
<ol id="feed" class="feed" aria-label="Recent activity"></ol>
</section>
<div id="buildlive" class="buildlive" role="status" aria-live="polite" hidden></div>
<section id="buildresult" class="buildresult" aria-label="Build result" aria-live="polite" hidden></section>
<div class="main">
<section>
<div id="log" role="log" aria-live="polite" aria-label="Council transcript" tabindex="0"></div>
<div class="composer"><input id="msg" placeholder="Speak to one agent (Enter), or convene the council (Ctrl+Enter)..." autocomplete="off">
<button class="go" id="send">Send</button><button class="go alt" id="summitbtn">Convene council</button></div>
<div class="composer"><button class="go alt" id="buildbtn">Build the verdict</button><button class="go stop" id="cancelbtn">Hush voices</button></div>
<div id="planbox">${planLine(plan)}</div>
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
</div>`, { version: `Client v${WARROOM_CLIENT_VERSION}` })}
<script>
var WR = ${config.replace(/</g, '\\u003c')};
${CLIENT_MD_JS}
</script>
<script src="/warroom/card-director.js${v}"></script>
<script src="/warroom/warroom-voice.js${v}"></script>
<script src="/warroom/warroom-live.js${v}"></script>
<script src="/warroom/warroom-result.js${v}"></script>
<script src="/warroom/warroom-casting.js${v}"></script>
<script src="/warroom/warroom-demo.js${v}"></script>
<script src="/warroom/warroom-app.js${v}"></script>
</body></html>`;
}
