// public/kr-attach.js - attach files to a chat message. Shared by the dashboard and the War Room (served at /warroom/kr-attach.js).
// Each file is uploaded the moment it is chosen (POST /api/upload, raw bytes), so Send is instant; the message then carries only the
// returned ids and the server finds the files itself. Plain DOM + textContent: file names are untrusted text.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KRAttach = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  // Same limits as src/attachments.ts (the server enforces them; this just says so before wasting an upload).
  const MAX_FILE_BYTES = 20 * 1024 * 1024, MAX_FILES = 5;
  const size = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? Math.round(n / 1024) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  /**
   * o: { button, tray, input, zone, endpoint, note(text, bad), headers?() -> {} }
   *   button opens the picker, tray shows the chips, input receives pasted images, zone accepts dropped files.
   */
  function mount(doc, o) {
    // The auth token rides along when the page was opened with ?token=... (the dashboard passes its own).
    const headers = o.headers || (() => { const t = new URLSearchParams((doc.defaultView || globalThis).location.search).get('token'); return t ? { 'x-kings-reach-token': t } : {}; });
    const entries = []; // { name, size, state: uploading | ready | failed, id, error, thumb }
    const picker = doc.createElement('input');
    picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.tabIndex = -1;
    picker.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(picker);
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

    function render() {
      o.tray.textContent = '';
      o.tray.hidden = !entries.length;
      entries.forEach((en) => {
        const chip = el('span', 'kchip ' + en.state);
        if (en.thumb) { const img = el('img'); img.src = en.thumb; img.alt = ''; chip.appendChild(img); }
        chip.appendChild(el('span', 'kname', en.name));
        chip.appendChild(el('span', 'kstate', en.state === 'uploading' ? 'uploading\u2026' : en.state === 'failed' ? 'failed: ' + en.error : size(en.size)));
        const x = el('button', 'kx', '\u2715');
        x.type = 'button';
        x.setAttribute('aria-label', 'Remove ' + en.name);
        x.addEventListener('click', () => remove(en));
        chip.appendChild(x);
        o.tray.appendChild(chip);
      });
    }

    const discard = (id) => fetch(o.endpoint + '/' + id, { method: 'DELETE', headers: headers() }).catch(() => {}); // best effort: it would expire anyway

    function remove(en) {
      entries.splice(entries.indexOf(en), 1);
      if (en.thumb) URL.revokeObjectURL(en.thumb);
      if (en.id) discard(en.id);
      render();
    }

    async function upload(en, file) {
      try {
        const r = await fetch(o.endpoint, { method: 'POST', body: file,
          headers: { ...headers(), 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' } });
        let d = {};
        try { d = await r.json(); } catch (e) { /* not json */ }
        if (!r.ok || !d.id) throw new Error(d.error || 'HTTP ' + r.status);
        en.id = d.id; en.state = 'ready';
        if (!entries.includes(en)) discard(en.id); // its chip was removed while it was still uploading: do not leave the file behind
      } catch (e) {
        en.state = 'failed'; en.error = String((e && e.message) || e);
      }
      if (entries.includes(en)) render();
    }

    function add(list) {
      for (const file of Array.from(list || [])) {
        if (entries.length >= MAX_FILES) { o.note('At most ' + MAX_FILES + ' files per message.', true); break; }
        const en = { name: file.name || 'pasted-file', size: file.size, state: 'uploading', id: '', error: '',
          thumb: /^image\//.test(file.type) ? URL.createObjectURL(file) : '' };
        entries.push(en);
        if (!file.size) { en.state = 'failed'; en.error = 'it is empty'; }
        else if (file.size > MAX_FILE_BYTES) { en.state = 'failed'; en.error = 'larger than ' + size(MAX_FILE_BYTES); }
        else upload(en, file);
      }
      render();
    }

    o.button.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { add(picker.files); picker.value = ''; });
    // A pasted screenshot becomes an attachment; pasted text is left alone.
    o.input.addEventListener('paste', (e) => {
      const files = e.clipboardData && e.clipboardData.files;
      if (files && files.length) { e.preventDefault(); add(files); }
    });
    const carries = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    ['dragenter', 'dragover'].forEach((t) => o.zone.addEventListener(t, (e) => { if (carries(e)) { e.preventDefault(); o.zone.classList.add('dropping'); } }));
    o.zone.addEventListener('dragleave', (e) => { if (!o.zone.contains(e.relatedTarget)) o.zone.classList.remove('dropping'); });
    o.zone.addEventListener('drop', (e) => { if (!carries(e)) return; e.preventDefault(); o.zone.classList.remove('dropping'); add(e.dataTransfer.files); });

    return {
      /** What to send: { text, attachments } - or null when there is nothing to send, or a file is not ready (it says why). */
      outgoing(text) {
        if (entries.some((e) => e.state === 'uploading')) { o.note('A file is still uploading. Send again in a moment.', true); return null; }
        if (entries.some((e) => e.state === 'failed')) { o.note('A file failed to upload. Remove it (\u2715) and send again.', true); return null; }
        const ids = entries.map((e) => e.id);
        if (!text && !ids.length) return null;
        return { text: text || (ids.length === 1 ? 'Please look at the attached file.' : 'Please look at the attached files.'), attachments: ids };
      },
      /** The names (names()) or the ready-made note (summary(), e.g. "  \u{1F4CE} shot.png") for the transcript. Call before clear(). */
      names: () => entries.map((e) => e.name),
      summary: () => describe(entries.map((e) => e.name)),
      /** The message went out: forget the chips (the files stay, the agent needs them). */
      clear() { entries.splice(0).forEach((e) => e.thumb && URL.revokeObjectURL(e.thumb)); render(); },
      count: () => entries.length,
      MAX_FILE_BYTES, MAX_FILES,
    };
  }

  /** The transcript's note for a message's files, e.g. "  \u{1F4CE} shot.png, notes.pdf". Also used when the server replays a message. */
  const describe = (names) => (names.length ? '  \u{1F4CE} ' + names.join(', ') : '');

  return { mount, size, describe, MAX_FILE_BYTES, MAX_FILES };
});
