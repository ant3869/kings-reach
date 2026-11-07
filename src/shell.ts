// src/shell.ts - the one navigation frame every page renders inside: a persistent side rail, so moving
// between Command, War Room, Plan Library and Settings is a same-tab click, never a new window.
// Also the small shared component kit (page header, buttons, notices) so pages stay visually consistent.

export type PageId = 'command' | 'warroom' | 'history' | 'settings';

export interface ShellOptions {
  /** In-page anchors shown under the active page, e.g. [['#missions', 'Missions']]. */
  sub?: ReadonlyArray<readonly [href: string, label: string]>;
  /** Extra markup for the rail footer (the dashboard puts its privacy toggle here). */
  footer?: string;
  /** Shown in the footer, e.g. "Client v6". */
  version?: string;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// 16px stroke icons, drawn inline so the rail needs no assets and inherits the text colour.
const ICONS: Record<PageId, string> = {
  command: '<path d="M2 3.5h12v9H2zM4.5 6.5l2 1.5-2 1.5M8 10h3"/>',
  warroom: '<path d="M2 13h12M3 13V7l5-4 5 4v6M6 13V9h4v4"/>',
  history: '<path d="M3 2.5h8l2 2v9H3zM5.5 7h5M5.5 9.5h5M5.5 12h3"/>',
  settings: '<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>',
};

// `note` is the royal flavour line under each label: the plain name stays primary so nobody has to guess.
const PAGES: ReadonlyArray<{ id: PageId; href: string; label: string; note: string; group: string }> = [
  { id: 'command', href: '/', label: 'Command', note: 'The Throne Room', group: 'The Court' },
  { id: 'warroom', href: '/warroom', label: 'War Room', note: 'The Council Chamber', group: 'The Court' },
  { id: 'history', href: '/history', label: 'Plan Library', note: 'The Royal Archives', group: 'The Archives' },
  { id: 'settings', href: '/providers', label: 'Settings', note: 'Alliances & Routes', group: 'The Realm' },
];

// A small crown for the crest: stroke-only so it takes the gold from CSS.
const CROWN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18.5h18M3.5 17 2.5 8l5 4 4.5-7 4.5 7 5-4-1 9z"/><circle cx="12" cy="3.2" r=".6"/></svg>';

/** Links keep the access token so a token-protected install never drops you at a locked page. */
const withToken = (href: string, token: string): string =>
  token && !href.startsWith('#') ? `${href}?token=${encodeURIComponent(token)}` : href;

function renderRail(active: PageId, token: string, opts: ShellOptions): string {
  let lastGroup = '';
  const items = PAGES.map((p) => {
    const heading = p.group === lastGroup ? '' : `<div class="kr-group">${p.group}</div>`;
    lastGroup = p.group;
    const on = p.id === active;
    const sub = on && opts.sub?.length
      ? `<div class="kr-subs">${opts.sub.map(([href, label]) => `<a href="${esc(href)}">${esc(label)}</a>`).join('')}</div>`
      : '';
    return `${heading}<a class="kr-link${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''} href="${esc(withToken(p.href, token))}">` +
      `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[p.id]}</svg>` +
      `<span class="kr-label">${p.label}<small>${p.note}</small></span></a>${sub}`;
  }).join('');
  return `<aside class="kr-rail" aria-label="King's Reach navigation">
<a class="kr-brand" href="${esc(withToken('/', token))}"><span class="kr-seal">${CROWN}</span><span><strong>King's Reach</strong><small>The Royal Council</small></span></a>
<nav class="kr-nav" aria-label="Pages">${items}</nav>
<div class="kr-foot"><div class="kr-status"><span class="kr-dot" id="kr-war-dot"></span><span id="kr-war-text">War room: checking</span></div>
${opts.version ? `<div>${esc(opts.version)}</div>` : ''}${opts.footer ?? ''}</div>
</aside>`;
}

/**
 * The "Claude is signed out" prompt. Polls /api/claude/auth (20s; 2s while a sign-in is open), offers one button that
 * opens the browser sign-in, and says "back online" when it lands. Dynamic text goes in via textContent, never markup.
 */
const AUTH_BANNER_JS = `
var box=document.getElementById('kr-auth'),was=null;
function hd(w){var x=T?{'x-kings-reach-token':T}:{};if(w)x['Content-Type']='application/json';return x}
function el(tag,text,cls){var n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n}
function paintAuth(s){
  if(s.loggedIn){box.hidden=was!=='out';if(was==='out'){box.className='kr-auth ok';box.replaceChildren(el('b','Claude is signed in.'),el('span',' The council and chat are back on their main route.'));setTimeout(function(){box.hidden=true},5000)}was='in';return}
  was='out';box.hidden=false;box.className='kr-auth';var l=s.login||{},parts=[];
  if(l.phase==='waiting'){
    parts.push(el('b','Waiting for you to finish signing in...'),el('span',' A browser tab should have opened.'));
    if(l.url&&/^https:/.test(l.url)){var a=el('a','Open the sign-in page');a.href=l.url;a.target='_blank';a.rel='noopener noreferrer';parts.push(a)}
  }else{
    parts.push(el('b','Claude is signed out.'),el('span',' Chat and the council are running on fallback models.'));
    var b=el('button','Sign in to Claude','btn primary');b.id='kr-signin';b.onclick=function(){b.disabled=true;fetch('/api/claude/login',{method:'POST',headers:hd(true)}).then(pollAuth)};parts.push(b);
    if(l.phase==='failed')parts.push(el('span','Last attempt failed: '+(l.detail||'unknown'),'kr-auth-err'));
  }
  box.replaceChildren.apply(box,parts);
}
function pollAuth(){fetch('/api/claude/auth',{headers:hd(false)}).then(function(r){return r.json()}).then(function(s){paintAuth(s);setTimeout(pollAuth,s.login&&s.login.phase==='waiting'?2000:20000)}).catch(function(){setTimeout(pollAuth,20000)})}
pollAuth();
`;

/** Keeps the rail's war-room indicator honest. Tiny, failure-tolerant, no dependencies. */
function railScript(token: string): string {
  const t = JSON.stringify(token).replace(/</g, '\\u003c');
  return `<script>(function(){var T=${t},dot=document.getElementById('kr-war-dot'),txt=document.getElementById('kr-war-text');
function tick(){fetch('/api/warroom/status',{headers:T?{'x-kings-reach-token':T}:{}}).then(function(r){return r.json()}).then(function(s){
dot.className='kr-dot'+(s.running?' up':'');txt.textContent='War room: '+(s.running?'online':'offline')}).catch(function(){dot.className='kr-dot';txt.textContent='War room: unknown'})}
tick();setInterval(tick,20000);
${AUTH_BANNER_JS}
var on=document.querySelector('.kr-link.on');if(on&&on.scrollIntoView)on.scrollIntoView({inline:'center',block:'nearest'})})()</script>`;
}

/** Wrap a page's content in the shared frame. `content` becomes the right-hand workspace. */
export function wrapInShell(active: PageId, token: string, content: string, opts: ShellOptions = {}): string {
  return `<a class="kr-skip" href="#kr-main">Skip to content</a>\n<div class="kr-app">\n${renderRail(active, token, opts)}\n<div class="kr-main" id="kr-main">\n<div class="kr-auth" id="kr-auth" role="alert" hidden></div>\n${content}\n</div>\n</div>\n${railScript(token)}`;
}

/** Page header used by Plan Library and Settings. */
export function pageHead(eyebrow: string, title: string, blurb: string, actions = ''): string {
  return `<header class="kr-head"><div><div class="kr-eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p class="kr-blurb">${esc(blurb)}</p></div>${actions ? `<div class="kr-head-actions">${actions}</div>` : ''}</header>`;
}

export const SHELL_CSS = `
:root{--bg:#090b0e;--rail:#0c0f12;--card:#101317;--raised:#15191e;--line:#292e34;--rule:#20252a;--txt:#e8e3d7;--dim:#a5a7a3;--faint:#989c9b;--acc:#c7a44b;--acc-soft:#c7a44b1a;--blue:#b8c6d1;--green:#79c291;--amber:#d9a441;--red:#e57982}
.kr-app{min-height:100vh;display:grid;grid-template-columns:208px minmax(0,1fr)}
.kr-rail{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:22px 14px 16px;background:#0c0f12f2;border-right:1px solid #292e34;font:13px system-ui,sans-serif;z-index:20;backdrop-filter:blur(8px)}
.kr-brand{display:flex;align-items:center;gap:10px;margin:0 6px 26px;color:#e8e3d7;text-decoration:none}
.kr-seal{width:36px;height:36px;display:grid;place-items:center;border:1px solid #c7a44b;border-radius:3px 3px 50% 50%/3px 3px 40% 40%;color:#c7a44b;background:linear-gradient(#c7a44b24,#c7a44b0a);box-shadow:inset 0 0 8px #c7a44b1f}
.kr-brand strong{display:block;font:600 15px Georgia,serif;letter-spacing:.3px}.kr-brand small{display:block;margin-top:2px;color:#a5a7a3;font-size:11px;letter-spacing:.3px}
.kr-nav{display:flex;flex-direction:column;gap:2px;overflow-y:auto}
.kr-group{margin:16px 8px 6px;color:#989c9b;font-size:10px;letter-spacing:1.2px;text-transform:uppercase}.kr-group:first-child{margin-top:0}
.kr-link{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:4px;color:#a5a7a3;text-decoration:none;border:1px solid transparent}
.kr-link:hover{color:#e8e3d7;background:#15191e}.kr-link:focus-visible{outline:2px solid #c7a44b;outline-offset:1px}
.kr-link.on{color:#f0e2b0;background:#c7a44b1a;border-color:#c7a44b40}.kr-link svg{flex:none;opacity:.85}.kr-link.on svg{color:#c7a44b;opacity:1}
.kr-label{display:flex;flex-direction:column;line-height:1.25}.kr-label small{color:#7f8280;font:italic 10.5px Georgia,serif;letter-spacing:.2px}.kr-link.on .kr-label small{color:#b59b5a}
.kr-subs{display:flex;flex-direction:column;margin:2px 0 4px 20px;padding-left:12px;border-left:1px solid #292e34}
.kr-subs a{padding:5px 8px;color:#989c9b;text-decoration:none;font-size:12px;border-radius:3px}.kr-subs a:hover{color:#e8e3d7;background:#15191e}
.kr-foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid #20252a;color:#989c9b;font-size:11px;line-height:1.7}
.kr-foot button{margin-top:8px;width:100%}
.kr-status{display:flex;align-items:center;gap:7px;color:#a5a7a3}
.kr-dot{width:7px;height:7px;border-radius:50%;background:#e57982;box-shadow:0 0 0 3px #e579821f}.kr-dot.up{background:#79c291;box-shadow:0 0 0 3px #79c2911f;animation:kr-beat 2.6s ease-in-out infinite}
@keyframes kr-beat{50%{box-shadow:0 0 0 5px #79c29110}}
.kr-main{min-width:0}
.kr-auth{position:sticky;top:0;z-index:15;display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;padding:10px 32px;background:#1d1708f2;border-bottom:1px solid #c7a44b88;color:#eadfbe;font:13px system-ui,sans-serif;backdrop-filter:blur(8px)}
.kr-auth[hidden]{display:none}.kr-auth b{color:#f0e2b0}.kr-auth a{color:#e2bf62}.kr-auth .btn{min-height:30px;padding:4px 14px}
.kr-auth.ok{background:#0f1b14f2;border-bottom-color:#79c29177}.kr-auth.ok b{color:#9bd8ae}.kr-auth-err{color:#f0b8bd}
@media(max-width:820px){
.kr-app{display:block}
.kr-rail{position:sticky;top:0;height:auto;flex-direction:row;align-items:center;gap:10px;padding:8px 12px;border-right:0;border-bottom:1px solid #292e34}
.kr-brand{margin:0}.kr-brand strong,.kr-brand small,.kr-group,.kr-subs,.kr-foot,.kr-label small{display:none}
.kr-nav{flex-direction:row;overflow-x:auto;gap:4px}.kr-link{padding:8px 10px;white-space:nowrap}
}

/* ---- polish: motion, focus, scrollbars, royal ornament ---- */
html{scroll-behavior:smooth;scroll-padding-top:16px;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
*{scrollbar-width:thin;scrollbar-color:#3a4047 transparent}
::selection{background:#c7a44b55;color:#fff}
.kr-skip{position:fixed;left:12px;top:-60px;z-index:99;padding:8px 14px;background:#c7a44b;color:#14110a;border-radius:4px;font:600 13px system-ui;text-decoration:none;transition:top .15s}.kr-skip:focus{top:12px}
/* Cross-document view transitions (Chromium): the rail stays planted while the page content fades through. */
@view-transition{navigation:auto}
.kr-rail{view-transition-name:kr-rail}
::view-transition-group(kr-rail){animation-duration:0s}
::view-transition-old(root),::view-transition-new(root){animation-duration:.16s;animation-timing-function:ease}
.workspace,.kr-main>.wrap{animation:kr-rise .28s cubic-bezier(.2,.7,.2,1) both}
@keyframes kr-rise{from{opacity:0;transform:translateY(6px)}}
/* One easing for every interactive surface, so nothing snaps. */
a,button,select,input,.stat,.provider,.role,.agentcard,.chip,.kr-link,section,#list button{transition:border-color .16s ease,background-color .16s ease,color .16s ease,box-shadow .16s ease,transform .16s ease,opacity .16s ease}
button:not(:disabled):active,.btn:not(:disabled):active,.chip:active{transform:translateY(1px)}
:focus-visible{outline:2px solid #c7a44b;outline-offset:2px}
.stat:hover,.provider:hover,.role:hover{border-color:#c7a44b55}
/* Page heads: a gold rule ending in a small diamond, the royal flourish used on every page. */
.kr-head,.commandhead{position:relative;border-bottom:0!important}
.kr-head:after,.commandhead:after{content:'';position:absolute;left:0;right:0;bottom:0;height:1px;background:linear-gradient(90deg,#c7a44b99,#292e34 35%,#292e34)}
.kr-head:before,.commandhead:before{content:'';position:absolute;left:0;bottom:-3px;width:6px;height:6px;background:#c7a44b;transform:rotate(45deg);z-index:1}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important;animation:none!important}@view-transition{navigation:none}}

/* ---- shared component kit (Plan Library, Settings) ---- */
.kr-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;flex-wrap:wrap;padding-bottom:16px;margin-bottom:18px;border-bottom:1px solid var(--line)}
.kr-eyebrow{color:var(--acc);font:600 11px system-ui,sans-serif;letter-spacing:1.4px;text-transform:uppercase}
.kr-head h1{margin:4px 0 4px;font:500 26px/1.2 Georgia,serif;color:var(--txt);letter-spacing:.2px}
.kr-blurb{margin:0;max-width:70ch;color:var(--dim);font-size:13px;line-height:1.5}
.kr-head-actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:7px 14px;background:transparent;color:var(--txt);border:1px solid var(--line);border-radius:4px;font:13px system-ui,sans-serif;text-decoration:none;cursor:pointer}
.btn:hover{border-color:var(--acc);background:var(--acc-soft)}.btn:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.btn.primary{background:var(--acc);border-color:var(--acc);color:#14110a;font-weight:600}.btn.primary:hover{background:#d8b960;border-color:#d8b960}
.btn.danger{color:var(--red)}.btn.danger:hover{border-color:var(--red);background:#e579821a}
.btn:disabled{opacity:.45;cursor:default;pointer-events:none}
.notice{border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:4px;background:#d9a4410d;color:#dccfa6;padding:10px 14px;font-size:13px;line-height:1.5}
.notice.bad{border-left-color:var(--red);background:#e579820d;color:#f0b8bd}
select,input[type=search],input[type=text]{background:#0a0d10;color:var(--txt);border:1px solid var(--line);border-radius:4px;padding:8px 10px;font:13px system-ui,sans-serif;min-height:34px}
select:focus,input:focus{outline:2px solid var(--acc);outline-offset:1px;border-color:var(--acc)}
`;
