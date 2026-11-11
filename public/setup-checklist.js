// public/setup-checklist.js - the "Getting started" card on the dashboard: what is set up, what is not, and what to do next.
// Fed only by GET /api/setup (every line is a real check made by the server). Plain DOM + textContent: details include
// provider error text, which must never be parsed as HTML. Shown only while something needs attention; hidden when all is well.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.KrSetup = api;
    const host = root.document && root.document.getElementById('setup');
    if (host) api.start(root.document, host, root.fetch.bind(root), new URLSearchParams(root.location.search).get('token'));
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const STATE = { ok: 'Done', todo: 'To do' };
  const RECHECK_LABEL = 'Re-check (one tiny paid call, under 1\u00a2)';

  function render(doc, host, data, onRecheck) {
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const needs = !data.ready || data.problems.length > 0;
    host.textContent = '';
    host.hidden = !needs;
    if (!needs) return;

    const required = data.items.filter((i) => i.required);
    const done = required.filter((i) => i.state === 'ok').length;
    const head = el('div', 'sectionhead');
    const title = el('h2', null, data.ready ? 'Needs attention' : 'Getting started');
    title.id = 'setup-title';
    head.appendChild(title);
    if (!data.ready) head.appendChild(el('span', null, `${done} of ${required.length} done`));
    host.appendChild(head);

    if (!data.ready) {
      const ol = el('ol', 'steps');
      // Finished and optional steps stay visible: a checklist that hides what you did reads as if it forgot.
      data.items.forEach((i) => {
        const li = el('li');
        li.dataset.state = i.state;
        li.dataset.id = i.id;
        li.appendChild(el('span', 'stepstate', i.required ? STATE[i.state] : (i.state === 'ok' ? 'Done' : 'Optional')));
        const body = el('span');
        body.appendChild(el('b', null, i.title));
        body.appendChild(el('span', 'meta', ' \u00b7 ' + i.detail));
        li.appendChild(body);
        if (i.fix) li.appendChild(el('span', 'fix', i.fix));
        ol.appendChild(li);
      });
      host.appendChild(ol);
    }

    if (data.problems.length) {
      host.appendChild(el('h3', null, 'Set up, but not answering'));
      const ul = el('ul', 'problems');
      data.problems.forEach((p) => {
        const li = el('li');
        li.dataset.id = p.id;
        li.appendChild(el('span', 'stepstate', 'Problem'));
        const body = el('span');
        body.appendChild(el('b', null, p.id));
        body.appendChild(el('span', 'meta', ' \u00b7 ' + p.detail));
        li.appendChild(body);
        li.appendChild(el('span', 'fix', p.fix));
        if (p.recheck) {
          const row = el('span', 'recheck');
          const btn = el('button', 'ghost', RECHECK_LABEL);
          btn.type = 'button';
          const status = el('span', 'meta');
          status.setAttribute('role', 'status');
          btn.addEventListener('click', () => onRecheck(p.id, btn, status));
          row.appendChild(btn);
          row.appendChild(status);
          li.appendChild(row);
        }
        ul.appendChild(li);
      });
      host.appendChild(ul);
    }
  }

  function start(doc, host, fetchFn, token) {
    const headers = (extra) => Object.assign({}, extra, token ? { 'x-kings-reach-token': token } : {});
    async function load() {
      try {
        const res = await fetchFn('/api/setup', { headers: headers() });
        if (!res.ok) return; // the dashboard's own banner already reports a failing API; this card just stays hidden
        render(doc, host, await res.json(), recheck);
      } catch (err) { /* offline: nothing to show */ }
    }
    async function recheck(id, btn, status) {
      btn.disabled = true;
      status.textContent = 'Checking...';
      try {
        const res = await fetchFn('/api/providers/' + encodeURIComponent(id) + '/check', { method: 'POST', headers: headers() });
        const r = await res.json();
        if (r.ok) { await load(); return; } // it works now: the card redraws without the problem
        status.textContent = (r.detail || r.error || 'Still not working.');
      } catch (err) { status.textContent = 'Could not reach the server.'; }
      btn.disabled = false;
    }
    load();
    return { load };
  }

  return { render, start };
});
