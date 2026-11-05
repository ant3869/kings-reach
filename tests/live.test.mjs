// Browser-side live status: the state machine and the demo scripts that exercise it (no DOM, no agents, no cost).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { PROJECT_ROOT } from '../dist/config.js';

// Browser files (UMD, no DOM needed for the logic): load them in a bare vm context exactly as a page would.
const sandbox = { setTimeout, clearTimeout, Date };
for (const file of ['warroom-live.js', 'warroom-demo.js']) vm.runInNewContext(readFileSync(join(PROJECT_ROOT, 'public', file), 'utf8'), sandbox);
const { WarLive, WarDemo } = sandbox;
const plain = (x) => JSON.parse(JSON.stringify(x)); // vm arrays are another realm's: compare by value
const script = (name) => plain(WarDemo.script(name));

function clocked() {
  let t = 1_000_000;
  const live = WarLive.create(() => t);
  return { live, advance: (s) => { t += s * 1000; } };
}
const tool = (id, text, extra = {}) => ({ type: 'activity', kind: 'tool', agent_id: id, text, ...extra });

test('silence escalates working -> quiet -> stalled, and any event resets it', () => {
  const { live, advance } = clocked();
  live.thinking('ops', true);
  live.handle(tool('ops', 'Running: npm test'));
  assert.equal(live.overall().key, 'working');
  advance(WarLive.QUIET_S + 1);
  assert.equal(live.overall().key, 'quiet');
  advance(WarLive.STALL_S);
  const stalled = live.overall();
  assert.equal(stalled.key, 'stalled');
  assert.match(stalled.text, /ops: no news for \d+s/);
  live.handle(tool('ops', 'Reading a.ts'));
  assert.equal(live.overall().key, 'working');
});

test('outcomes are distinct and sticky: complete, failed, cancelled', () => {
  for (const [state, failed] of [['complete', false], ['failed', true], ['cancelled', false]]) {
    const { live } = clocked();
    live.thinking('ops', true);
    live.handle({ type: 'meter', pct: 40, phase: 'execute', label: 'x' });
    live.handle({ type: 'activity', kind: 'done', agent_id: 'ops' });
    live.handle({ type: 'meter', pct: state === 'complete' ? 100 : 40, phase: state, label: state, failed, state, final: true });
    assert.equal(live.overall().key, state);
  }
});

test('a failed result tells the page to react, with a pose and a visible feed entry', () => {
  const { live } = clocked();
  live.thinking('research', true);
  const hints = live.handle({ type: 'activity', kind: 'result', agent_id: 'research', ok: false });
  assert.deepEqual(plain(hints.pose), ['research', 'defeated']);
  assert.equal(live.classify(live.s.agents.research), 'failed');
  assert.ok(live.s.feed.some((f) => f.kind === 'bad'));
});

test('a failed route is a warning with a confused pose, and the next route restarts the turn count', () => {
  const { live } = clocked();
  live.thinking('ops', true);
  live.handle({ type: 'activity', kind: 'turn', agent_id: 'ops', turn: 24, max_turns: 24 });
  const hints = live.handle({ type: 'activity', kind: 'route', agent_id: 'ops', state: 'failed', text: 'claude could not finish' });
  assert.deepEqual(plain(hints.pose), ['ops', 'confused']);
  live.handle({ type: 'activity', kind: 'route', agent_id: 'ops', state: 'try', text: 'Asking codex' });
  assert.equal(live.s.agents.ops.turn, 0);
});

test('counts come from the server, and a new call starts from zero', () => {
  const { live } = clocked();
  live.thinking('ops', true);
  live.handle(tool('ops', 'Editing a.ts', { reads: 3, edits: 1, turn: 4, max_turns: 40, edit: true }));
  assert.equal(live.describe(live.s.agents.ops), 'turn 4/40 \u00b7 3 read \u00b7 1 edited');
  live.thinking('ops', false);
  live.thinking('ops', true);
  assert.equal(live.describe(live.s.agents.ops), '');
});

test('narration is kept as the caption and in the feed (visible even when speech is off)', () => {
  const { live } = clocked();
  live.handle({ type: 'activity', kind: 'narration', agent_id: 'main', text: 'Checks passed.' });
  assert.equal(live.s.caption.text, 'Checks passed.');
  assert.equal(live.s.feed.at(-1).kind, 'narr');
});

test('a finished agent never reads "Starting", but keeps the real last action when it has one', () => {
  const { live } = clocked();
  for (const [id, ok] of [['main', true], ['ops', false]]) {   // streamed nothing at all (e.g. a plain HTTP provider)
    live.thinking(id, true);
    live.handle({ type: 'activity', kind: 'result', agent_id: id, ok });
  }
  assert.equal(live.s.agents.main.text, 'Answered');
  assert.equal(live.s.agents.ops.text, 'Gave no usable answer');
  live.thinking('research', true);
  live.handle(tool('research', 'Reading src/agent.ts'));
  live.handle({ type: 'activity', kind: 'result', agent_id: 'research', ok: true });
  assert.equal(live.s.agents.research.text, 'Reading src/agent.ts');
});

test('a stale caption is dropped when a run finishes cleanly, but a failure keeps its reason', () => {
  const done = (state) => ({ type: 'meter', pct: state === 'complete' ? 100 : 55, phase: 'record', label: '', final: true, state, failed: state === 'failed' });
  for (const [state, kept] of [['complete', false], ['failed', true], ['cancelled', true]]) {
    const { live, advance } = clocked();
    live.handle({ type: 'activity', kind: 'narration', agent_id: 'main', text: 'Still working. 1 action so far.' });
    advance(WarLive.CAPTION_STALE_MS / 1000 + 5);
    live.handle(done(state));
    assert.equal(Boolean(live.s.caption), kept, state);
  }
  // ...and a caption spoken just before the end ("Build complete and approved") survives.
  const { live, advance } = clocked();
  live.handle({ type: 'activity', kind: 'narration', agent_id: 'main', text: 'Build complete and approved.' });
  advance(2);
  live.handle(done('complete'));
  assert.equal(live.s.caption.text, 'Build complete and approved.');
});

test('warnings and failures survive a flood of routine lines', () => {
  const { live } = clocked();
  live.thinking('ops', true);
  live.handle({ type: 'activity', kind: 'route', agent_id: 'ops', state: 'failed', text: 'claude could not finish' });
  for (let i = 0; i < 40; i++) live.handle({ type: 'activity', kind: 'narration', agent_id: 'main', text: 'n' + i });
  assert.ok(live.s.feed.some((f) => f.kind === 'warn' && /could not finish/.test(f.text)));
  assert.ok(live.s.feed.length <= 8);
  assert.equal(live.s.feed.at(-1).text, 'n39', 'newest line is still kept');
});

test('feed is bounded', () => {
  const { live } = clocked();
  for (let i = 0; i < 50; i++) live.handle({ type: 'activity', kind: 'narration', agent_id: 'main', text: 'n' + i });
  assert.ok(live.s.feed.length <= 8);
});

test('browser and server agree on the silence thresholds (they are duplicated, so drift must fail loudly)', () => {
  const py = readFileSync(join(PROJECT_ROOT, 'warroom', 'live.py'), 'utf8');
  const m = py.match(/^QUIET_S, STALL_S = (\d+), (\d+)/m);
  assert.ok(m, 'live.py must define QUIET_S, STALL_S on one line');
  assert.equal(WarLive.QUIET_S, Number(m[1]));
  assert.equal(WarLive.STALL_S, Number(m[2]));
});

test('the wire protocol string matches on both ends', () => {
  const server = readFileSync(join(PROJECT_ROOT, 'warroom', 'server.py'), 'utf8').match(/^PROTOCOL = "([^"]+)"/m);
  const page = readFileSync(join(PROJECT_ROOT, 'src', 'warroom-html.ts'), 'utf8').match(/WARROOM_PROTOCOL = '([^']+)'/);
  assert.ok(server && page);
  assert.equal(server[1], page[1]);
});

test('every demo script is ordered, ends in exactly one final meter, and pairs each start with a finish', () => {
  for (const name of plain(WarDemo.NAMES)) {
    const steps = script(name);
    assert.ok(steps.length >= 6, name);
    const times = steps.map(([t]) => t);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${name} must be in time order`);
    const finals = steps.filter(([, m]) => m.type === 'meter' && m.final);
    assert.equal(finals.length, 1, `${name} must end with one final state`);
    const ons = steps.filter(([, m]) => m.type === 'thinking' && m.on).length;
    const offs = steps.filter(([, m]) => m.type === 'thinking' && !m.on).length;
    assert.equal(ons, offs, `${name}: every agent that starts must stop`);
  }
});

test('the demo meter moves on turns and never runs backwards before the final state', () => {
  for (const name of ['build', 'stall']) {
    const pcts = script(name).map(([, m]) => m).filter((m) => m.type === 'meter' && !m.final).map((m) => m.pct);
    assert.deepEqual(pcts, [...pcts].sort((a, b) => a - b), `${name}: ${pcts}`);
    // The stall demo is one turn then silence: a frozen bar there is the truth, not a defect.
    if (name === 'build') assert.ok(new Set(pcts).size > 6, `build bar should visibly move, got ${[...new Set(pcts)]}`);
  }
});

test('the demo summit resolves every council stage (a DONE badge over dim chips looks broken)', () => {
  const last = {};
  for (const [, m] of script('summit')) if (m.type === 'stage') last[m.stage] = m.state;
  for (const stage of ['recall', 'plan', 'investigate', 'debate', 'verdict', 'record']) assert.equal(last[stage], 'done', stage);
});

test('demo builds resolve every phase of the build panel (no cell left waiting or active)', () => {
  for (const name of ['build', 'build-fail']) {
    const last = {};
    for (const [, m] of script(name)) if (m.type === 'build_progress' && m.phase !== 'complete') last[m.phase] = m.state;
    for (const phase of ['preflight', 'execute', 'gate', 'review']) {
      assert.ok(['done', 'failed', 'skipped'].includes(last[phase]), `${name}: ${phase} ended ${last[phase]}`);
    }
  }
});

test('replaying the demos on a virtual clock ends in the right visible state', () => {
  const expected = { build: 'complete', 'build-fail': 'failed', stall: 'cancelled', summit: 'complete' };
  for (const [name, want] of Object.entries(expected)) {
    const { live, advance } = clocked();
    let prev = 0;
    for (const [t, m] of script(name)) {
      advance(t - prev); prev = t;
      if (m.type === 'thinking') live.thinking(m.agent_id, m.on);
      else if (m.type === 'activity' || m.type === 'meter') live.handle(m);
    }
    assert.equal(live.overall().key, want, name);
  }
});

test('the stall demo passes through quiet and stalled before it is cancelled', () => {
  const { live, advance } = clocked();
  const seen = new Set();
  let now = 0;
  for (const [t, m] of script('stall')) {
    while (now + 5 <= t) { advance(5); now += 5; seen.add(live.overall().key); } // the page re-reads the clock every second
    advance(t - now); now = t;
    if (m.type === 'thinking') live.thinking(m.agent_id, m.on);
    else if (m.type === 'activity' || m.type === 'meter') live.handle(m);
    seen.add(live.overall().key);
  }
  for (const key of ['working', 'quiet', 'stalled', 'cancelled']) assert.ok(seen.has(key), `${key} never shown: ${[...seen]}`);
});
