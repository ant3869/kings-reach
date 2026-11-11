// public/warroom-panels.js - Council Status + Recent Messages side panels and a numbered phase stepper.
// Every number comes from /warroom/status.json (uptime, memory count, active plan) or from this page's own DOM (model routes, transcript).
// No source means an honest "unavailable" / "none", never a placeholder figure. Mounts only when html[data-royal] is set; localStorage['kr-panels'] = 'off' also disables it.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WarPanels = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const RECENT = 5, SNIPPET = 90, REFRESH_MS = 60000;
  const S = 'html[data-royal] '; // every rule is scoped to the royal flag, so flag off changes nothing
  const CSS = S + '#stages{counter-reset:ph}' + S + '#stages .stage:before{counter-increment:ph;content:counter(ph);display:inline-block;min-width:1.3em;margin-right:6px;' +
    'text-align:center;border:1px solid currentColor;border-radius:50%;font-size:10px;line-height:1.3em}' +
    S + '.kpanel dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px}' + S + '.kpanel dt{color:#9aa3ad}' + S + '.kpanel dd{margin:0;text-align:right}' +
    S + '.kpanel ol{margin:0;padding:0;list-style:none;font-size:12px}' + S + '.kpanel li{padding:4px 0;border-top:1px solid #3a3020}' + S + '.kpanel li:first-child{border-top:0}' +
    S + '.kpanel li b{color:var(--gold,#d4a017)}' + S + '.kpanel .none{color:#9aa3ad}';

  function fmtUptime(sec) {
    if (typeof sec !== 'number' || !isFinite(sec) || sec < 0) return 'unavailable';
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d ? d + 'd ' + h + 'h' : h ? h + 'h ' + m + 'm' : m + 'm';
  }

  /** Last n transcript entries as {who, text} from the log's .bubble nodes. */
  function recentFrom(bubbles, n) {
    return Array.from(bubbles).slice(-n).map((b) => {
      const who = b.querySelector('.who'), body = b.querySelector('.body');
      const text = ((body && body.textContent) || '').replace(/\s+/g, ' ').trim();
      return { who: (who && who.textContent) || '', text: text.length > SNIPPET ? text.slice(0, SNIPPET) + '...' : text };
    });
  }

  function mount(doc, fetchFn) {
    const aside = doc.querySelector('.main > aside'); // the War Room column, not the site nav's aside
    if (!aside) return null;
    const style = doc.createElement('style'); style.textContent = CSS; doc.head.appendChild(style);
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const status = el('div', 'panel kpanel'), recent = el('div', 'panel kpanel');
    status.id = 'cstatus'; recent.id = 'crecent';
    status.setAttribute('aria-label', 'Council status'); recent.setAttribute('aria-label', 'Recent messages');
    aside.insertBefore(recent, aside.firstChild); aside.insertBefore(status, aside.firstChild);
    let snap = null, fetchedAt = 0;

    function drawStatus() {
      const routes = Array.from(doc.querySelectorAll('#council .route'));
      const routed = routes.filter((r) => r.textContent && r.textContent !== 'waiting').length;
      const up = snap ? fmtUptime(snap.uptimeSec + (Date.now() - fetchedAt) / 1000) : 'unavailable';
      const mem = snap && typeof snap.memories === 'number' ? snap.memories.toLocaleString('en-US') : 'unavailable';
      status.replaceChildren(el('h3', '', 'Council Status'));
      const dl = el('dl');
      const row = (k, v) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); };
      row('Uptime', up); row('Memory entries', mem);
      row('Seats routed (this page, not provider health)', routes.length ? routed + '/' + routes.length : 'unavailable');
      row('Active plan', !snap ? 'unavailable' : snap.plan ? snap.plan.run + ' (' + snap.plan.steps + ' steps)' : 'No active plan');
      status.appendChild(dl);
    }
    function drawRecent() {
      const items = recentFrom(doc.querySelectorAll('#log .bubble'), RECENT);
      recent.replaceChildren(el('h3', '', 'Recent Messages'));
      if (!items.length) { recent.appendChild(el('div', 'none', 'No messages yet.')); return; }
      const ol = el('ol');
      for (const it of items) { const li = el('li'); li.appendChild(el('b', '', it.who + ': ')); li.appendChild(doc.createTextNode(it.text)); ol.appendChild(li); }
      recent.appendChild(ol);
    }
    function load() {
      return Promise.resolve(fetchFn('/warroom/status.json')).then((r) => r.json()).then((j) => { snap = j; fetchedAt = Date.now(); })
        .catch(() => { snap = null; }).then(drawStatus);
    }
    drawStatus(); drawRecent(); load();
    const win = doc.defaultView;
    const obs = (sel, fn) => { const t = doc.querySelector(sel); if (t && win && win.MutationObserver) new win.MutationObserver(fn).observe(t, { childList: true, subtree: true, characterData: true }); };
    obs('#log', drawRecent); obs('#council', drawStatus);
    return { load, drawStatus, drawRecent, timer: win ? win.setInterval(load, REFRESH_MS) : 0 };
  }

  if (typeof document !== 'undefined' && document.querySelector) {
    // Only under the royal flag (warroom-royal.js must load first and set html[data-royal]).
    let off = false; try { off = localStorage.getItem('kr-panels') === 'off'; } catch (e) { /* storage blocked: stay on */ }
    if (!off && document.documentElement.hasAttribute('data-royal')) mount(document, (u) => fetch(u, { cache: 'no-store' }));
  }
  return { fmtUptime, recentFrom, mount, CSS };
});
