// public/warroom-result.js - the Build result card: what happened, are my files still changed, what is still wrong, and what can
// I do about it WITHOUT running the whole plan again. Fed only by {type:'build_result'} from the server (warroom/buildflow.py);
// it sends {type:'build_followup', action} back. Plain DOM + textContent (no innerHTML: the text includes file names and
// a reviewer's words). The decisions about wording live on the server and are unit-tested there; this file only draws them.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WarResult = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // Every state has a glyph AND a word (the page must read without colour), like the live badge.
  const BADGE = { complete: ['\u2714', 'BUILT'], attention: ['\u26a0', 'NEEDS YOUR DECISION'], failed: ['\u2716', 'NOT BUILT'] };

  function mount(doc, send) {
    const host = doc.getElementById('buildresult');
    let busy = false;
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const buttons = () => Array.from(host.querySelectorAll('button[data-action]'));
    const setBusy = (on) => { busy = on; host.setAttribute('aria-busy', String(on)); buttons().forEach((b) => { b.disabled = on; }); };

    function choose(action) {
      if (busy) return;
      setBusy(true);
      if (send({ type: 'build_followup', action }) === false) setBusy(false); // the socket was closed: nothing started
    }

    function list(title, items, cls) {
      const box = el('div', cls);
      if (title) box.appendChild(el('h4', null, title));
      const ul = el('ul');
      items.forEach((t) => ul.appendChild(el('li', null, t)));
      box.appendChild(ul);
      return box;
    }

    function show(card) {
      const state = BADGE[card.state] ? card.state : 'failed';
      host.textContent = '';
      host.className = 'buildresult ' + state;
      host.hidden = false;
      const head = el('h3', 'rhead');
      head.appendChild(el('span', 'rbadge', BADGE[state][0] + ' ' + BADGE[state][1]));
      head.appendChild(el('span', 'rtitle', card.headline || ''));
      host.appendChild(head);
      if (card.detail) host.appendChild(el('p', 'rdetail', card.detail));
      if (card.issues && card.issues.length) host.appendChild(list('Still wrong', card.issues, 'rissues'));
      if (card.files && card.files.length) {
        const d = el('details', 'rfiles');
        d.appendChild(el('summary', null, card.files.length + (card.files.length === 1 ? ' file' : ' files') + ' changed and kept on disk'));
        d.appendChild(list('', card.files, 'rlist'));
        host.appendChild(d);
      }
      if (card.output) {
        const d = el('details', 'routput');
        d.appendChild(el('summary', null, 'Check output'));
        d.appendChild(el('pre', null, card.output));
        host.appendChild(d);
      }
      if (card.actions && card.actions.length) {
        const box = el('div', 'ractions');
        box.appendChild(el('h4', null, 'What now? None of these starts the whole build again.'));
        card.actions.forEach((a) => {
          const row = el('div', 'raction');
          const b = el('button', 'go alt', a.label);
          b.type = 'button';
          b.dataset.action = a.id;
          b.addEventListener('click', () => choose(a.id));
          row.appendChild(b);
          row.appendChild(el('span', 'rhint', a.hint));
          box.appendChild(row);
        });
        host.appendChild(box);
      }
      setBusy(false);
    }

    return {
      show,
      /** A run ended (any outcome): the buttons may be used again if the card is still showing. */
      settle() { if (!host.hidden) setBusy(false); },
      /** A brand-new build starts: the old card describes files that are about to change. */
      clear() { host.hidden = true; host.textContent = ''; busy = false; },
    };
  }

  return { mount, BADGE };
});
