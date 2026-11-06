// public/warroom-casting.js - the voice dropdown under each card.
// The server (warroom/casting.py) owns the truth: it lists the voices the local Kokoro model really has and only
// accepts one of them. This file just shows that list and sends the pick. Loaded before warroom-app.js.
/* exported WarCasting */
'use strict';

const WarCasting = (() => {
  const escape = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** [{label, voices}] in the order the server sent them (it sorts: American f/m, then British f/m). */
  function groups(voices) {
    const order = [];
    const by = {};
    for (const v of voices) {
      if (!by[v.group]) { by[v.group] = []; order.push(v.group); }
      by[v.group].push(v);
    }
    return order.map((label) => ({ label, voices: by[label] }));
  }

  /** <optgroup>s of <option>s with `current` selected. A current voice the list lacks (model file missing) stays selectable. */
  function optionsHtml(voices, current) {
    const known = voices.some((v) => v.id === current);
    const lead = known || !current ? '' : `<option value="${escape(current)}" selected>${escape(current)}</option>`;
    return lead + groups(voices).map((g) => `<optgroup label="${escape(g.label)}">` + g.voices.map((v) =>
      `<option value="${escape(v.id)}"${v.id === current ? ' selected' : ''}>${escape(v.name)}</option>`).join('') + '</optgroup>').join('');
  }

  /** Wire the selects under #council. `send` is the war room socket's send(). Returns {handle} for 'casting' messages. */
  function mount(doc, send) {
    doc.getElementById('council').addEventListener('change', (e) => {
      const select = e.target.closest ? e.target.closest('select[data-voice-for]') : null;
      if (select) send({ type: 'set_voice', agent_id: select.dataset.voiceFor, voice: select.value });
    });
    return {
      handle(message) {
        for (const select of doc.querySelectorAll('select[data-voice-for]')) {
          const id = select.dataset.voiceFor;
          select.innerHTML = optionsHtml(message.voices || [], (message.current || {})[id]);
          select.disabled = !(message.voices || []).length; // no voice file: show the name, offer no choices
        }
      },
    };
  }

  return { groups, optionsHtml, mount };
})();
if (typeof module !== 'undefined') module.exports = WarCasting;
