// public/warroom-demo.js - replay of synthetic server events through the REAL War Room handlers. No agents run, nothing
// is spent, nothing on disk changes: open /warroom?demo=build  (also build-fail, stall, summit; &speed=20 to go faster).
// Time is virtual (logical seconds x speed), so the same script that takes 2 minutes to read can be tested in a second.
// Events mirror warroom/live.py + council.py message shapes exactly; if those change, tests/live.test.mjs breaks here.
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WarDemo = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const NAMES = ['build', 'build-fail', 'stall', 'summit'];

  function builder() {
    const T = [];
    const at = (t, m) => T.push([t, m]);
    // Same arithmetic as warroom/live.py: the bar moves on every turn, (owners finished + turn/max_turns) / owners.
    const cur = { phase: '', label: '', base: 0, span: 0, expected: 1, finished: 0 };
    const b = {
      T, at,
      stage: (t, stage, state, detail) => at(t, { type: 'stage', stage, state, detail: detail || '' }),
      meter: (t, pct, phase, label, extra) => at(t, { type: 'meter', pct, phase, label, failed: false, ...(extra || {}) }),
      say: (t, id, text, spoken, kind) => at(t, { agent_id: id, text, kind: kind || 'build', spoken }),
      narr: (t, id, text) => at(t, { type: 'activity', kind: 'narration', agent_id: id, text }),
      on: (t, id) => at(t, { type: 'thinking', agent_id: id, on: true }),
      off: (t, id) => at(t, { type: 'thinking', agent_id: id, on: false }),
      route: (t, id, state, text, provider) => at(t, { type: 'activity', kind: 'route', agent_id: id, state, text, provider: provider || 'claude' }),
      // Which phase the meter is in: base/span are percentage points, expected = agent calls in the phase.
      phase: (phase, label, base, span, expected) => Object.assign(cur, { phase, label, base, span, expected: expected || 1, finished: 0 }),
      turn: (t, id, n, max, reads, edits) => {
        at(t, { type: 'activity', kind: 'turn', agent_id: id, text: 'turn ' + n + '/' + max, turn: n, max_turns: max, reads, edits, tools: reads + edits });
        if (cur.phase) {
          const pct = Math.min(99, Math.round(cur.base + cur.span * (cur.finished + n / max) / cur.expected));
          at(t, { type: 'meter', pct, phase: cur.phase, label: cur.label + ' \u00b7 ' + id + ' turn ' + n + '/' + max, failed: false });
        }
      },
      finishCall: () => { cur.finished += 1; },
      tool: (t, id, text, o) => at(t, { type: 'activity', kind: 'tool', agent_id: id, text, turn: o.turn, max_turns: o.max, reads: o.reads, edits: o.edits, tools: o.reads + o.edits, edit: !!o.edit, target: o.target }),
      done: (t, id, ok) => { at(t, { type: 'activity', kind: 'done', agent_id: id }); at(t, { type: 'activity', kind: 'result', agent_id: id, ok }); },
      progress: (t, phase, state, message, extra) => at(t, { type: 'build_progress', phase, state, elapsed: 0, message, ...(extra || {}) }),
      status: (t, text) => at(t, { agent_id: 'war-room', text }),
      final: (t, state, ok) => at(t, { type: 'meter', pct: ok ? 100 : 55, phase: state, label: state, failed: state === 'failed', state, final: true }),
    };
    return b;
  }

  function build(failing) {
    const b = builder();
    b.stage(0, 'preflight', 'active', 'checking clean baseline');
    b.meter(0, 1, 'preflight', 'preflight \u00b7 compiling and syntax-checking before anyone edits');
    b.narr(0, 'main', 'Checking the baseline first. Nobody edits anything until it is clean.');
    b.stage(6, 'preflight', 'done', 'baseline clean');
    b.progress(6, 'preflight', 'done', 'Baseline is clean');
    b.meter(6, 4, 'preflight', 'preflight');
    b.stage(7, 'execute', 'active', 'starting implementation');
    b.meter(7, 5, 'execute', 'execute \u00b7 2 owner(s) implementing');
    b.phase('execute', 'execute \u00b7 2 owner(s) implementing', 4, 72, 2);
    b.narr(7, 'main', 'Baseline is clean. 2 owners start building: ops, research.');
    // ops: reads, then edits, optionally dies and is rescued
    b.on(8, 'ops');
    b.route(8, 'ops', 'try', 'Asking claude (default)');
    b.turn(10, 'ops', 1, 40, 0, 0);
    b.tool(11, 'ops', 'Reading src/agent.ts', { turn: 1, max: 40, reads: 1, edits: 0, target: 'src/agent.ts' });
    b.turn(16, 'ops', 2, 40, 1, 0);
    b.tool(17, 'ops', 'Searching the code for "attempts"', { turn: 2, max: 40, reads: 1, edits: 0, target: 'attempts' });
    b.turn(24, 'ops', 3, 40, 1, 0);
    b.tool(25, 'ops', 'Editing src/activity.ts', { turn: 3, max: 40, reads: 1, edits: 1, edit: true, target: 'src/activity.ts' });
    b.narr(25, 'ops', 'First change, in activity.');
    if (failing) {
      b.route(40, 'ops', 'failed', 'claude could not finish: Reached maximum number of turns (40)', 'claude');
      b.narr(40, 'ops', 'Claude could not finish. Trying the next route.');
      b.route(41, 'ops', 'try', 'Asking codex (default) with the earlier attempt\'s notes', 'codex');
      b.tool(55, 'ops', 'Edited src/agent.ts', { turn: 0, max: 0, reads: 1, edits: 2, edit: true, target: 'src/agent.ts' });
    } else {
      b.turn(38, 'ops', 6, 40, 3, 1);
      b.tool(39, 'ops', 'Editing src/agent.ts', { turn: 6, max: 40, reads: 3, edits: 2, edit: true, target: 'src/agent.ts' });
      b.narr(39, 'ops', 'Now changing agent.');
    }
    b.done(60, 'ops', true);
    b.finishCall();
    b.off(60, 'ops');
    b.say(60, 'ops', '- wire the activity stream: done', 'The activity stream is wired in.', 'build');
    b.progress(60, 'execute', 'active', 'ops finished; 2 file(s) reported');
    b.on(61, 'research');
    b.turn(63, 'research', 1, 40, 0, 0);
    b.tool(65, 'research', 'Editing tests/live.test.mjs', { turn: 1, max: 40, reads: 0, edits: 1, edit: true, target: 'tests/live.test.mjs' });
    b.done(90, 'research', true);
    b.off(90, 'research');
    b.say(90, 'research', '- add tests: done', 'Tests are in.', 'build');
    b.stage(91, 'execute', 'done', '2/2 owners; 3 files');
    b.progress(91, 'execute', 'done', '2/2 owners reported; 3 file(s)');
    b.meter(91, 77, 'execute', 'execute');
    b.narr(91, 'main', 'Implementation is in: 3 files changed. Running the automated checks now.');
    b.stage(92, 'gate', 'active');
    b.meter(92, 78, 'gate', 'gate \u00b7 running automated checks');
    if (failing) {
      b.stage(104, 'gate', 'done', '12s');
      b.stage(104, 'gate', 'failed', 'checks failed'); // the server marks done when the coroutine returns, then failed
      b.progress(104, 'gate', 'failed', 'Automated checks failed', { detail: 'tsc: src/agent.ts(41,3): error TS2322' });
      b.status(104, 'checks FAILED: tsc: src/agent.ts(41,3): error TS2322');
      b.narr(104, 'main', 'Checks failed. The changes stay on disk but are not activated, and review is skipped.');
      b.stage(105, 'review', 'skipped', 'gate failed');
      b.progress(105, 'review', 'skipped', 'Review skipped because automated checks failed');
      b.narr(106, 'main', 'Build did not succeed. Automated checks failed; changes remain on disk but were not activated.');
      b.progress(106, 'complete', 'failed', 'Automated checks failed; changes remain on disk but were not activated.');
      b.final(106, 'failed', false);
      return b.T;
    }
    b.stage(104, 'gate', 'done', '12s');
    b.progress(104, 'gate', 'done', 'Automated checks passed');
    b.narr(104, 'main', 'Checks passed. Research is reviewing the changes.');
    b.stage(105, 'review', 'active');
    b.meter(105, 84, 'review', 'review \u00b7 research is checking changed files against the verdict');
    b.phase('review', 'review \u00b7 research is checking changed files against the verdict', 84, 12, 1);
    b.on(106, 'research');
    b.turn(110, 'research', 1, 16, 0, 0);
    b.tool(112, 'research', 'Reading src/activity.ts', { turn: 1, max: 16, reads: 1, edits: 0, target: 'src/activity.ts' });
    b.done(130, 'research', true);
    b.off(130, 'research');
    b.say(130, 'research', '**Approved**', 'The build matches the verdict. Approved.', 'review');
    b.stage(131, 'review', 'done', '25s');
    b.progress(131, 'review', 'done', 'Research approved the build');
    b.meter(131, 92, 'reboot', 'reboot \u00b7 restarting the core, then waiting for it to answer');
    b.narr(131, 'ops', 'Core code changed. Restarting it and waiting for it to come back.');
    b.narr(137, 'ops', 'The core is back up.');
    b.narr(138, 'main', 'Build complete and approved.');
    b.progress(138, 'complete', 'done', 'Build completed and approved', { files: ['src/activity.ts', 'src/agent.ts', 'tests/live.test.mjs'] });
    b.final(138, 'complete', true);
    return b.T;
  }

  /** ops goes silent mid-edit; the page must escalate working -> quiet -> stalled, then show the cancel honestly. */
  function stall() {
    const b = builder();
    b.stage(0, 'execute', 'active', 'starting implementation');
    b.meter(0, 5, 'execute', 'execute \u00b7 1 owner(s) implementing');
    b.phase('execute', 'execute \u00b7 1 owner(s) implementing', 4, 72, 1);
    b.on(1, 'ops');
    b.route(1, 'ops', 'try', 'Asking claude (default)');
    b.turn(3, 'ops', 1, 40, 0, 0);
    b.tool(4, 'ops', 'Running: npm test', { turn: 1, max: 40, reads: 0, edits: 0, target: 'npm test' });
    b.narr(60, 'ops', 'Nothing new from me for 56 seconds. Either a long step, or I am stuck.');
    b.narr(110, 'ops', 'Nothing new from me for 106 seconds. Either a long step, or I am stuck.');
    b.final(130, 'cancelled', false);
    b.off(130, 'ops');
    return b.T;
  }

  function summit() {
    const b = builder();
    b.stage(0, 'recall', 'active'); b.meter(0, 1, 'recall', 'recall'); b.stage(2, 'recall', 'done', '2s');
    b.stage(3, 'plan', 'active'); b.on(3, 'main'); b.turn(6, 'main', 1, 10, 0, 0); b.off(12, 'main'); b.stage(13, 'plan', 'done', '10s');
    b.stage(14, 'investigate', 'active'); b.meter(14, 12, 'investigate', 'investigate');
    b.on(14, 'research'); b.on(14, 'ops');
    b.tool(20, 'research', 'Fetching playwright.dev/docs/cli', { turn: 2, max: 24, reads: 1, edits: 0 });
    b.tool(22, 'ops', 'Reading package.json', { turn: 1, max: 24, reads: 1, edits: 0, target: 'package.json' });
    b.done(70, 'research', true); b.off(70, 'research'); b.done(75, 'ops', true); b.off(75, 'ops');
    b.stage(76, 'investigate', 'done', '62s');
    b.narr(76, 'main', 'Both specialists are back with evidence. Cross-examination next.');
    b.final(80, 'complete', true);
    return b.T;
  }

  function script(name) {
    if (name === 'build') return build(false);
    if (name === 'build-fail') return build(true);
    if (name === 'stall') return stall();
    if (name === 'summit') return summit();
    return [];
  }

  /** Play a script through `deliver(msg)` on a virtual clock. Returns {clock, stop, done}. */
  function play(name, deliver, opts) {
    const speed = Math.max(1, Number(opts && opts.speed) || 1);
    const t0 = Date.now();
    const timers = [];
    const clock = () => t0 + (Date.now() - t0) * speed;
    const events = script(name);
    const last = events.length ? events[events.length - 1][0] : 0;
    const done = new Promise((resolve) => {
      for (const [t, msg] of events) timers.push(setTimeout(() => deliver(msg), (t * 1000) / speed));
      timers.push(setTimeout(resolve, (last * 1000) / speed + 50));
    });
    return { clock, stop: () => timers.forEach(clearTimeout), done, events, speed };
  }

  return { NAMES, script, play };
});
