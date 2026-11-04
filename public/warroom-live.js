// public/warroom-live.js - the "what is happening RIGHT NOW" panel: status badge, progress meter, one row per agent,
// recent-activity feed and the spoken-commentary caption. Fed ONLY by server events ({type:'activity'|'meter'|'thinking'}),
// never by timers pretending to be progress; the one timer here (tick) only re-reads the clock to show silence honestly.
// The state machine is pure (no DOM) so node can test it; render functions touch the page only when one exists.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WarLive = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const QUIET_S = 45, STALL_S = 90; // keep in step with warroom/live.py (the server speaks the same thresholds)
  const FEED_MAX = 8;
  // Non-colour cues: every state has a glyph AND a word, so the page reads correctly without colour or sound.
  const BADGES = {
    idle: ['\u00b7', 'IDLE'], working: ['\u25b6', 'WORKING'], quiet: ['\u2026', 'QUIET'], stalled: ['\u26a0', 'STALLED'],
    running: ['\u25b6', 'RUNNING'], complete: ['\u2714', 'DONE'], failed: ['\u2716', 'FAILED'], cancelled: ['\u25a0', 'CANCELLED'],
  };

  function create(now) {
    const clock = now || Date.now;
    const s = { agents: {}, meter: null, phaseSince: 0, phase: '', feed: [], caption: null, startedAt: 0 };

    const agent = (id) => (s.agents[id] = s.agents[id] || {
      id, working: false, outcome: null, text: '', turn: 0, maxTurns: 0, reads: 0, edits: 0, tools: 0, lastAt: 0, posed: false });
    // Bounded, but warnings and failures outlive routine lines: a fallback must not scroll away within seconds.
    const push = (kind, id, text) => {
      s.feed.push({ at: clock(), kind, id, text });
      if (s.feed.length <= FEED_MAX) return;
      const routine = s.feed.findIndex((f) => f.kind !== 'warn' && f.kind !== 'bad');
      s.feed.splice(routine === -1 ? 0 : routine, 1);
    };

    function reset() { s.agents = {}; s.meter = null; s.feed = []; s.caption = null; s.phase = ''; s.startedAt = clock(); }

    /** A call began or ended (the existing 'thinking' message). Begin = fresh counters for that call. */
    function thinking(id, on) {
      const a = agent(id);
      if (on) Object.assign(a, { working: true, outcome: null, text: 'Starting', turn: 0, maxTurns: 0, reads: 0, edits: 0, tools: 0, lastAt: clock(), posed: false });
      else a.working = false;
      if (on && !s.startedAt) s.startedAt = clock();
    }

    /** One server message. Returns hints for the page: {pose:[id,state]} for card reactions. */
    function handle(m) {
      const hints = {};
      if (m.type === 'meter') {
        if (m.phase !== s.phase && !m.final) { s.phase = m.phase; s.phaseSince = clock(); }
        s.meter = m;
        return hints;
      }
      const a = agent(m.agent_id || 'main');
      if (m.kind === 'narration') {
        s.caption = { id: a.id, text: m.text, at: clock() };
        push('narr', a.id, m.text);
        return hints;
      }
      if (m.kind === 'result') {
        a.outcome = m.ok ? 'ok' : 'failed';
        a.working = false;
        push(m.ok ? 'ok' : 'bad', a.id, m.ok ? 'finished with a structured answer' : 'returned no usable answer');
        if (!m.ok) hints.pose = [a.id, 'defeated'];
        return hints;
      }
      if (m.kind === 'done') { a.working = false; return hints; }
      a.lastAt = clock();
      a.working = true;
      a.posed = false;
      if (m.kind === 'route') {
        a.text = m.text;
        if (m.state === 'try') { a.turn = 0; a.maxTurns = 0; }
        if (m.state === 'failed' || m.state === 'salvage') { push('warn', a.id, m.text); hints.pose = [a.id, 'confused']; }
        else push('route', a.id, m.text);
      } else {
        if (m.text && m.kind === 'tool') a.text = m.text;
        if (m.turn) { a.turn = m.turn; a.maxTurns = m.max_turns || a.maxTurns; }
        a.reads = m.reads != null ? m.reads : a.reads;
        a.edits = m.edits != null ? m.edits : a.edits;
        a.tools = m.tools != null ? m.tools : a.tools;
        if (m.edit) push('edit', a.id, m.text);
      }
      return hints;
    }

    /** working | quiet | stalled | ok | failed | idle, from what the server last told us and when. */
    function classify(a) {
      if (a.working) {
        const idle = (clock() - a.lastAt) / 1000;
        return idle >= STALL_S ? 'stalled' : idle >= QUIET_S ? 'quiet' : 'working';
      }
      return a.outcome === 'ok' ? 'complete' : a.outcome === 'failed' ? 'failed' : 'idle';
    }

    /** The one badge for the whole room: worst agent state wins, then the run's own final state. */
    function overall() {
      const states = Object.values(s.agents).map((a) => [a, classify(a)]);
      for (const want of ['stalled', 'quiet']) {
        const hit = states.find(([, st]) => st === want);
        if (hit) {
          const secs = Math.round((clock() - hit[0].lastAt) / 1000);
          return { key: want, text: hit[0].id + ': no news for ' + secs + 's' + (want === 'stalled' ? ' - may be stuck. Cancel if this continues.' : ' - probably a long step') };
        }
      }
      const live = states.filter(([, st]) => st === 'working');
      if (live.length) return { key: 'working', text: live.map(([a]) => a.id).join(', ') + (live.length > 1 ? ' are working' : ' is working') };
      const m = s.meter;
      if (m && m.final) return { key: m.state || (m.failed ? 'failed' : 'complete'), text: m.state === 'cancelled' ? 'Cancelled by you. Nothing further will run.' : m.failed ? (s.caption ? s.caption.text : 'Stopped: see the log for why.') : 'Finished.' };
      if (m) return { key: 'running', text: m.label || m.phase || 'between steps' };
      return { key: 'idle', text: 'Nothing running. Convene the council or build the verdict.' };
    }

    function describe(a) {
      const bits = [];
      if (a.maxTurns) bits.push('turn ' + a.turn + '/' + a.maxTurns);
      if (a.reads) bits.push(a.reads + ' read');
      if (a.edits) bits.push(a.edits + ' edited');
      return bits.join(' \u00b7 ');
    }

    return { s, reset, thinking, handle, classify, overall, describe, push, clock };
  }

  // ---- DOM (only when a page exists) -------------------------------------------------------------------------------
  function fmt(secs) { const t = Math.max(0, Math.round(secs)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); }

  function mount(doc, names, hooks, clock) {
    const live = create(clock);
    const $ = (id) => doc.getElementById(id);
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
    const nameOf = (id) => names[id] || id;

    function paintSeat(id, key) {
      const badge = $('badge-' + id);
      if (!badge) return;
      const seat = $('seat-' + id);
      if (seat) { if (key === 'quiet' || key === 'stalled') seat.dataset.live = key; else delete seat.dataset.live; }
      const [glyph, word] = BADGES[key] || BADGES.idle;
      badge.className = 'badge ' + key;
      badge.textContent = key === 'idle' ? '' : glyph + ' ' + word.toLowerCase();
    }

    function render() {
      const o = live.overall();
      const [glyph, word] = BADGES[o.key] || BADGES.idle;
      $('nowbadge').className = 'nowbadge ' + o.key;
      $('nowbadge').textContent = glyph + ' ' + word;
      $('nowlabel').textContent = o.text;
      const m = live.s.meter, pct = m ? m.pct : 0;
      $('meterfill').style.width = pct + '%';
      $('meter').setAttribute('aria-valuenow', String(pct));
      $('meter').className = 'meter ' + (m && m.final ? (m.state || (m.failed ? 'failed' : 'complete')) : 'active');
      const phaseClock = live.s.phaseSince && m && !m.final ? ' \u00b7 this step ' + fmt((live.clock() - live.s.phaseSince) / 1000) : '';
      $('meterlabel').textContent = m ? (m.final ? '' : '~' + pct + '% (estimate) \u00b7 ') + (m.label || '') + phaseClock : '';
      $('nowclock').textContent = live.s.startedAt && !(m && m.final) ? 'running ' + fmt((live.clock() - live.s.startedAt) / 1000) : '';
      const rows = $('agentlines');
      rows.textContent = '';
      for (const a of Object.values(live.s.agents)) {
        const key = live.classify(a);
        paintSeat(a.id, key);
        if (key === 'idle') continue;
        const row = el('div', 'arow ' + key);
        const ago = a.lastAt ? Math.round((live.clock() - a.lastAt) / 1000) : 0;
        row.append(el('b', '', nameOf(a.id)), el('span', 'st', (BADGES[key] || BADGES.idle).join(' ')),
          el('span', 'txt', a.text), el('span', 'cnt', live.describe(a)), el('span', 'ago', a.working ? ago + 's ago' : ''));
        rows.append(row);
        if ((key === 'stalled' || key === 'quiet') && !a.posed && hooks.pose) { a.posed = true; hooks.pose(a.id, 'confused'); }
      }
      const cap = live.s.caption;
      $('caption').textContent = cap ? nameOf(cap.id) + ': ' + cap.text : '';
      const feed = $('feed');
      feed.textContent = '';
      for (const f of live.s.feed.slice().reverse()) feed.append(el('li', f.kind, nameOf(f.id) + ' \u00b7 ' + f.text));
    }

    return {
      live,
      handle(m) { const hints = live.handle(m); if (hints.pose && hooks.pose) hooks.pose(hints.pose[0], hints.pose[1]); render(); },
      thinking(id, on) { live.thinking(id, on); render(); },
      reset() { live.reset(); render(); },
      tick: render,
      render,
    };
  }

  return { create, mount, BADGES, QUIET_S, STALL_S, fmt };
});
