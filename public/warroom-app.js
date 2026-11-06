// public/warroom-app.js - council chamber UI. Needs (inline, before this file): WR config, md(), esc().
// Wire protocol is documented at the top of warroom/server.py.
/* global WR, md, esc, WarVoice, CardDirector, WarCasting */
'use strict';

const $ = (id) => document.getElementById(id);
const COUNCIL_STAGES = ['recall', 'plan', 'investigate', 'debate', 'verdict', 'record'];
const BUILD_STAGES = ['preflight', 'execute', 'gate', 'review'];
const KIND_LABEL = { plan: 'plan', take: 'take', critique: 'cross-examination', verdict: 'verdict',
  build: 'build', review: 'review', error: 'error' };
const byId = Object.fromEntries(WR.council.map((c) => [c.id, c]));
let ws = null;
let retryMs = 2000;
let retryTimer = null;
let lastPong = 0;
let busySince = 0;
const thinkingSince = {};
const pendingSalvaged = {};

// Card art: WHICH image a seat shows is CardDirector's call (weighted variants per state, see card-director.js and
// card-states/manifest.json). `pose` is a timed one-shot (offense/defense/confused/defeated) layered under speaking.
const cardActivity = Object.fromEntries(WR.council.map((c) => [c.id,
  { thinking: false, speaking: false, building: false, pose: null }]));
const layerState = {};
const stateRequest = {};
const nextRotate = {};
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let director = CardDirector.create(null); // legacy art until the manifest arrives
let currentStage = '';
let defeatedAt = 0;

const desiredCardState = (id) => CardDirector.resolve(cardActivity[id], Date.now(), currentStage);

// Live status panel (warroom-live.js). Its clock is swappable so the demo replay can run on virtual time.
let liveClock = Date.now;
const live = WarLive.mount(document, Object.fromEntries(WR.council.map((c) => [c.id, c.name])),
  { pose: (id, state) => setPose(id, state) }, () => liveClock());

// Voice dropdown under each card (warroom-casting.js): the server lists real voices and validates every change.
const casting = WarCasting.mount(document, (m) => send(m));

function setPose(id, state, ms) {
  if (!cardActivity[id]) return;
  const hold = ms || director.poseMs(state);
  cardActivity[id].pose = { state, until: Date.now() + hold };
  applyCardState(id);
  setTimeout(() => applyCardState(id), hold + 60);
}

function defeatAll() {
  if (Date.now() - defeatedAt < 2000) return; // execute + build_progress both report the same failure
  defeatedAt = Date.now();
  WR.council.forEach((c, i) => setTimeout(() => setPose(c.id, 'defeated'), i * 70));
}

// While a state lasts, now and then swap to another variant of it (gesture changes while talking, a new idle look).
function rotateCards() {
  if (REDUCED_MOTION || document.hidden) return;
  const now = Date.now();
  for (const c of WR.council) {
    const el = seat(c.id);
    if (el && nextRotate[c.id] && now >= nextRotate[c.id]) setCardState(c.id, el.dataset.state, true);
  }
}

function setCardState(id, next, force) {
  const el = seat(id);
  if (!el || (el.dataset.state === next && !force)) return;
  const request = (stateRequest[id] || 0) + 1;
  stateRequest[id] = request;
  // Art is cached for a day under a fixed name; the client version in the URL makes every new build fetch fresh art.
  const url = director.pick(next, id) + '?v=' + WR.version;
  const preload = new Image();
  preload.onerror = () => { if (stateRequest[id] === request) nextRotate[id] = Date.now() + 5000; };
  preload.onload = () => {
    if (stateRequest[id] !== request) return;
    const delay = director.rotateDelayMs(next);
    nextRotate[id] = delay && !REDUCED_MOTION ? Date.now() + delay : 0;
    const a = el.querySelector('.strip-a');
    const b = el.querySelector('.strip-b');
    const aIsActive = (layerState[id] || 'a') === 'a';
    const front = aIsActive ? a : b, back = aIsActive ? b : a;
    back.src = url;
    back.getBoundingClientRect();
    back.style.opacity = '1';
    front.style.opacity = '0';
    layerState[id] = aIsActive ? 'b' : 'a';
    el.dataset.state = next;
    if (next === 'speaking') dimOthers(id);
    else if (!Object.values(cardActivity).some((activity) => activity.speaking)) undimAll();
  };
  preload.src = url;
}

function applyCardState(id) { setCardState(id, desiredCardState(id)); }
function staggerBuilding(on) {
  WR.council.forEach((c, index) => setTimeout(() => {
    cardActivity[c.id].building = on;
    applyCardState(c.id);
  }, index * 70));
}

function dimOthers(heroId) {
  document.querySelectorAll('.seat').forEach((s) =>
    s.classList.toggle('dimmed', s.id !== 'seat-' + heroId));
}
function undimAll() {
  document.querySelectorAll('.seat').forEach((s) => s.classList.remove('dimmed'));
}

// --- rendering ------------------------------------------------------------------------
function clock() {
  const d = new Date();
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}

function fmtDuration(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(total / 3600); const minutes = Math.floor((total % 3600) / 60); const seconds = total % 60;
  if (hours) return hours + 'h ' + minutes + 'm ' + seconds + 's';
  if (minutes) return minutes + 'm ' + seconds + 's';
  return seconds + 's';
}

function fmtTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'not reported';
  if (n >= 1000000) return (n / 1000000).toFixed(2).replace(/\\.00$/, '') + 'm';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
  return String(n);
}

function bubble(who, html, cls, color, label) {
  const d = document.createElement('div');
  d.className = 'bubble' + (cls ? ' ' + cls : '');
  if (color) d.style.setProperty('--ac', color);
  d.innerHTML = '<span class="who">' + esc(who) + '</span>' + (label ? '<span class="tag">' + esc(label) + '</span>' : '') +
    '<span class="when">' + clock() + '</span><div class="body">' + html + '</div>';
  $('log').appendChild(d);
  $('log').scrollTop = $('log').scrollHeight;
  return d;
}

function briefText(text) {
  const plain = String(text || '').replace(/```[\s\S]*?```/g, ' [code] ').replace(/[#*_`>\[\]]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (plain.length <= 260) return plain;
  const cut = plain.slice(0, 260); const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return cut.slice(0, stop > 100 ? stop + 1 : 257) + '...';
}

function disclosure(text, label) {
  return '<div class="brief">' + esc(briefText(text)) + '</div><details><summary>' + esc(label || 'Read full analysis') +
    '</summary><div class="full">' + md(text) + '</div></details>';
}

function agentLine(id, text, kind) {
  if (kind === 'critique') { // the critic goes on offense; whoever they name ("to **research**: ...") defends
    setPose(id, 'offense');
    for (const hit of String(text).matchAll(/\bto \*\*([a-z]+)\*\*/gi)) setPose(hit[1].toLowerCase(), 'defense');
  }
  if (kind === 'error') setPose(id, 'confused');
  const c = byId[id];
  const salvaged = pendingSalvaged[id]; delete pendingSalvaged[id];
  if (!c) return bubble(id, md(text), 'sys');
  const compact = ['plan', 'take', 'critique', 'verdict', 'build', 'review'].includes(kind);
  const label = salvaged ? 'recovered after turn cap' : KIND_LABEL[kind];
  return bubble(c.name + ' \u00b7 ' + c.title, compact ? disclosure(text) : md(text),
    kind === 'error' ? 'err' : kind || '', c.color, label);
}

function seat(id) {
  return $('seat-' + id);
}

function setThinking(id, on) {
  if (on) thinkingSince[id] = Date.now(); else delete thinkingSince[id];
  live.thinking(id, on);
  if (!cardActivity[id]) return;
  cardActivity[id].thinking = on;
  applyCardState(id);
}

function setSpeaking(id, on) {
  if (!cardActivity[id]) return;
  cardActivity[id].speaking = on;
  applyCardState(id);
}

function setBuilding(id, on) {
  if (!cardActivity[id]) return;
  cardActivity[id].building = on;
  applyCardState(id);
}

function setLevel(id, level) {
  const el = seat(id);
  if (el) el.style.setProperty('--lvl', level.toFixed(3));
}

function resetStages(names) {
  $('stages').innerHTML = names.map((n) => '<span class="stage" id="st-' + n + '">' + n + '<i></i></span>').join('');
}

function setStage(name, state, detail) {
  if (state === 'active') currentStage = name; else if (currentStage === name) currentStage = '';
  WR.council.forEach((c) => applyCardState(c.id)); // thinking turns into researching during 'investigate'
  if (state === 'failed' && BUILD_STAGES.includes(name)) defeatAll();
  if ((name === 'recall' || name === 'preflight') && state === 'active') live.reset(); // a new run starts clean
  if (name === 'recall' && state === 'active') resetStages(COUNCIL_STAGES);
  // First build stage seen (any tab, not only the one that clicked Build): swap in the build chips BEFORE styling this one,
  // otherwise the later swap wipes the chips that already finished (preflight showed blank once execute began).
  if (BUILD_STAGES.includes(name) && !$('st-' + name)) resetStages(BUILD_STAGES);
  if (name === 'execute' && state === 'active') staggerBuilding(true);
  if (name === 'execute' && (state === 'done' || state === 'failed' || state === 'inactive')) staggerBuilding(false);
  let el = $('st-' + name);
  if (!el) {
    $('stages').insertAdjacentHTML('beforeend', '<span class="stage" id="st-' + name + '">' + name + '<i></i></span>');
    el = $('st-' + name);
  }
  el.className = 'stage ' + state;
  el.querySelector('i').textContent = detail ? ' ' + detail : '';
  if (state === 'active' && !busySince) busySince = Date.now();
}

function tick() {
  live.tick();
  // (The old 'thinking: X 4s' line is gone: the live panel shows the same facts per agent, on the run's own clock.)
  if (!Object.keys(thinkingSince).length && busySince && !document.querySelector('.stage.active')) busySince = 0;
}

function buildProgress(m) {
  if (m.state === 'failed') defeatAll();
  const panel = $('buildlive'); panel.hidden = false;
  panel._phases = panel._phases || {};
  if (m.phase !== 'complete') panel._phases[m.phase] = m;
  const cells = BUILD_STAGES.map((phase) => {
    const p = panel._phases[phase] || { state: 'waiting', message: 'Waiting' };
    const elapsed = p.elapsed ? ' \u00b7 ' + fmtDuration(p.elapsed) : '';
    return '<div class="buildphase ' + esc(p.state) + '"><b>' + esc(phase) + elapsed + '</b><span>' + esc(p.message) + '</span></div>';
  }).join('');
  const detail = m.detail ? '<details class="builddetail"><summary>Technical detail</summary><pre>' + esc(m.detail) + '</pre></details>' : '';
  const files = m.files && m.files.length ? '<div class="builddetail">Files: ' + m.files.map(esc).join(', ') + '</div>' : '';
  panel.innerHTML = '<h3>' + (m.phase === 'complete' ? esc(m.message) : 'Build in progress') +
    '</h3><div class="buildphases">' + cells + '</div>' + detail + files;
}

// "Build will execute plan X" is rendered once at page load; a summit that locks a new verdict makes it stale.
async function refreshPlanLine() {
  try {
    const r = await fetch('/warroom/planline', { cache: 'no-store' });
    if (r.ok && $('planbox')) $('planbox').innerHTML = await r.text();
  } catch (e) { /* keep the old line; a page refresh fixes it */ }
}

function metrics(m) {
  if (m.kind === 'summit' && m.outcome === 'verdict') refreshPlanLine();
  const money = (x) => '$' + Number(x || 0).toFixed(2);
  const coverage = m.total_calls ? ' · ' + Number(m.token_calls_reported || 0) + '/' + m.total_calls + ' calls reported' : '';
  const tokenText = m.total_tokens == null ? 'not reported' : fmtTokens(m.total_tokens) +
    ' (in ' + fmtTokens(m.input_tokens) + ' / out ' + fmtTokens(m.output_tokens) + ')' + coverage;
  const rows = [['outcome', m.outcome], ['time', fmtDuration(m.total_s)], ['tokens', tokenText],
    ['recorded cost', money(m.total_cost_usd)]];
  if (m.kind === 'summit') {
    const conf = Object.entries(m.confidence || {}).map(([a, v]) => a + ' ' + v[0].toFixed(2) +
      (v[1] !== v[0] ? ' \u2192 ' + v[1].toFixed(2) : '')).join(', ');
    // Since v2.14 'changed' is measured from the before/after answers; older runs only have the agent's own claim.
    const measured = m.changed_minds_claimed != null;
    // Rule 2 (v2.14.2): wording alone is not a changed mind. Rows without mind_rule used rule 1, which counted any rewrite.
    const minds = measured ? m.changed_minds + ' measured' + (m.changed_minds_claimed !== m.changed_minds ? ' (' + m.changed_minds_claimed + ' claimed)' : '') +
      (m.mind_rule === 2 ? '' : ' (old rule, overcounts rewording)') : m.changed_minds == null ? '-' : m.changed_minds + ' (self-reported)';
    rows.push(['specialists', (m.specialists || []).join(', ')], ['evidence cited', m.evidence],
      ['challenges', m.challenges], ['minds changed', minds], ['confidence', conf || '-'],
      ...((m.reworded_agents || []).length ? [['reworded only', m.reworded_agents.join(', ')]] : []),
      ...((m.takes_without_tools || []).length ? [['answered without tools', m.takes_without_tools.join(', ')]] : []),
      ['verdict confidence', m.verdict_confidence], ['plan steps', m.plan_steps],
      ['memory used / saved', (m.memory_lines_used ?? '-') + ' / ' + (m.memories_saved ?? '-')], ['hive entries', m.hive_entries ?? '-']);
  } else {
    rows.push(['files changed', (m.changed_files || []).length], ['checks', m.checks_ok ? 'pass' : 'FAIL'],
      ['review', m.review_status || (m.approved ? 'approved' : 'not approved')], ['criteria met', m.criteria_met],
      ['core rebooted', m.rebooted ? 'yes' : 'no']);
  }
  const stages = Object.entries(m.stages || {}).map(([s, t]) => s + ' ' + fmtDuration(t)).join(' \u00b7 ');
  const failure = m.failure_summary ? '<div class="metricfail">' + esc(m.failure_summary) + '</div>' : '';
  const files = m.changed_files && m.changed_files.length ? '<details><summary>Changed files</summary><div class="full">' +
    m.changed_files.map((f) => '<div>' + esc(f) + '</div>').join('') + '</div></details>' : '';
  const shifts = Object.entries(m.mind_changes || {}).map(([a, x]) => '<div>' + esc(a) + ': ' + x.before.toFixed(2) + ' \u2192 ' +
    x.after.toFixed(2) + (x.changed ? ' \u00b7 ' + esc(x.reasons.join('; '))
      : x.reworded ? ' \u00b7 reworded only, position unchanged (' + Math.round(x.similarity * 100) + '% wording kept)' : ' \u00b7 no change') +
    (x.claimed && !x.changed ? ' \u00b7 claimed a change' : '') +
    (x.capped ? ' \u00b7 held up (no tools)' : x.has_tools === false ? ' \u00b7 answered without tools' : '') + '</div>').join('');
  const mindBox = shifts ? '<details><summary>Mind changes (measured)</summary><div class="full">' + shifts + '</div></details>' : '';
  const gate = m.gate_output ? '<details><summary>Check output</summary><pre>' + esc(m.gate_output) + '</pre></details>' : '';
  $('score').innerHTML = '<h3>' + (m.kind === 'summit' ? 'Council scoreboard' : 'Build scoreboard') + ' <small>run ' +
    esc(m.id) + '</small></h3><table>' + rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(String(r[1] ?? '-')) +
    '</td></tr>').join('').replace(/>undefined</g, '>-<') + '</table><div class="stagetimes">' + esc(stages) + '</div>' + failure + mindBox + files + gate;
  $('score').hidden = false; $('buildbtn').disabled = false;
}

function voiceInfo(v) {
  const el = $('vstat');
  el.textContent = v.state === 'ready' ? v.detail : 'voice: ' + v.state + (v.detail ? ' (' + v.detail + ')' : '');
  el.className = 'vstat ' + v.state;
  $('mic').disabled = !v.stt;
  $('handsfree').disabled = !v.stt;
}

// --- socket ---------------------------------------------------------------------------
function connected() {
  return ws && ws.readyState === 1;
}

function send(obj) {
  if (!connected()) {
    bubble('war room', 'not connected yet; reconnecting...', 'err');
    return false;
  }
  ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  return true;
}

function setConn(on, msg) {
  $('dot').className = 'dot' + (on ? ' on' : '');
  $('stext').textContent = msg;
}

function onBinary(buf) {
  const bytes = new Uint8Array(buf);
  const nl = bytes.indexOf(10);
  if (nl < 0) return;
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(0, nl)));
  WarVoice.enqueue(head.agent_id, buf.slice(nl + 1));
}

function onMessage(m) {
  if (m.pong) {
    lastPong = Date.now();
    retryMs = 2000;
    $('sver').textContent = 'server v' + m.server + ' \u00b7 ' + m.pong;
    if (m.pong !== WR.protocol) bubble('war room', 'protocol mismatch: page ' + WR.protocol + ', server ' + m.pong + '. Hard-refresh.', 'err');
    markPin(m.pinned);
    return;
  }
  if (m.pinned !== undefined) return markPin(m.pinned);
  if (m.type === 'voice') return voiceInfo(m);
  if (m.type === 'casting') return casting.handle(m);
  if (m.type === 'stage') return setStage(m.stage, m.state, m.detail);
  if (m.type === 'provider') {
    const el = $('model-' + m.agent_id);
    if (el) el.textContent = 'route: ' + m.provider + ' / ' + m.model;
    if ((m.attempts || []).some((a) => a.salvaged)) pendingSalvaged[m.agent_id] = true;
    return;
  }
  if (m.type === 'thinking') return setThinking(m.agent_id, m.on);
  if (m.type === 'activity' || m.type === 'meter') return live.handle(m);
  if (m.type === 'build_progress') return buildProgress(m);
  if (m.type === 'metrics') return metrics(m);
  if (m.type === 'transcript') {
    $('heard').textContent = m.text ? 'heard: \u201c' + m.text + '\u201d' : 'heard nothing intelligible';
    if (m.text) bubble('you (voice)', esc(m.text), 'you');
    return;
  }
  if (m.error) return bubble('war room', esc(m.error), 'err');
  if (m.agent_id === 'war-room') return bubble('war room', md(m.text), 'sys');
  if (m.agent_id) agentLine(m.agent_id, m.text, m.kind);
}

function connect() {
  setConn(false, 'connecting...');
  ws = new WebSocket('ws://' + location.hostname + ':' + WR.port);
  ws.binaryType = 'arraybuffer';
  lastPong = Date.now(); // a socket that never answers its first ping must still hit the 45 s self-close below
  ws.onopen = () => {
    // Backoff is NOT reset here: a TCP/WebSocket handshake can succeed against a server that then drops us at once,
    // which made a flaky link retry every 2 s forever. It resets on the first pong (onMessage), proof of a live round trip.
    setConn(true, 'connected');
    send({ type: 'ping' });
    send({ type: 'voice', on: $('speak').checked });
    runPlanLibraryBuild();
  };
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) return onBinary(e.data);
    try {
      onMessage(JSON.parse(e.data));
    } catch (err) {
      bubble('war room', 'bad message from server: ' + esc(String(err)), 'err');
    }
  };
  ws.onclose = () => {
    if (retryTimer) return;
    setConn(false, 'disconnected; retrying in ' + Math.round(retryMs / 1000) + 's');
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, retryMs);
    retryMs = Math.min(retryMs * 2, 30000);
  };
}

// --- actions --------------------------------------------------------------------------
function markPin(id) {
  for (const c of WR.council) seat(c.id).classList.toggle('pinned', c.id === id);
}

// The Plan Library's "Build this plan" button (after its confirm dialog) leaves a fresh, single-use
// same-tab token. A URL flag would let any web page navigate you into a ~$1 build; sessionStorage can't be forged.
function runPlanLibraryBuild() {
  let launch = null;
  try { launch = JSON.parse(sessionStorage.getItem('kr-autobuild') || 'null'); sessionStorage.removeItem('kr-autobuild'); } catch (e) { return; }
  if (!launch || Date.now() - launch.t > 120000) return;
  bubble('war room', 'Building plan <b>' + esc(String(launch.plan)) + '</b> from the Plan Library.', 'sys');
  submit('build');
}

function submit(kind) {
  const input = $('msg');
  const text = input.value.trim();
  WarVoice.unlock();
  if (kind === 'build') {
    $('buildlive').hidden = false; $('buildlive')._phases = {}; $('buildbtn').disabled = true;
    resetStages(BUILD_STAGES);
    buildProgress({ phase: 'preflight', state: 'active', elapsed: 0, message: 'Requesting baseline checks' });
    live.reset();
    live.handle({ type: 'meter', pct: 0, phase: 'requested', label: 'build requested: waiting for the server to confirm' });
    if (!send({ type: 'build' })) $('buildbtn').disabled = false;
    return;
  }
  if (!text) return input.focus();
  if (!send({ type: kind, text })) return;
  bubble(kind === 'summit' ? 'you \u2192 council' : 'you', text.length > 500 ? disclosure(text, 'Read full request') : esc(text), 'you');
  input.value = '';
}

function bindTalk() {
  const mic = $('mic');
  const down = (e) => {
    e.preventDefault();
    send({ type: 'hush' });
    mic.classList.add('hot');
    WarVoice.pressToTalk();
  };
  const up = () => {
    if (!mic.classList.contains('hot')) return;
    mic.classList.remove('hot');
    WarVoice.releaseToTalk();
  };
  mic.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat && document.activeElement !== $('msg') && !mic.disabled) down(e);
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') up();
  });
}

// Replays synthetic server events through the real handlers. Browser speech stands in for the Kokoro voice here.
function runDemo(name, speed, silent) {
  live.reset(); live.live.s.startedAt = Date.now();
  bubble('war room', '<b>Demo replay: ' + esc(name) + '</b> at ' + speed + 'x. Synthetic events through the real handlers: ' +
    'no agents are running and nothing is spent.', 'sys');
  const player = WarDemo.play(name, (m) => {
    onMessage(m);
    const line = m.kind === 'narration' ? m.text : m.spoken;
    if (line && !silent && $('speak').checked && window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(line));
  }, { speed });
  liveClock = player.clock;
  live.live.s.startedAt = player.clock();
  window.__demo = player;
}

function init() {
  WarVoice.init({
    onUtterance: (pcm) => {
      $('heard').textContent = 'transcribing...';
      send(pcm);
    },
    onLevel: setLevel,
    onSpeaking: setSpeaking,
    onMicState: (state, detail) => {
      $('micstate').textContent = { recording: 'listening to you...', listening: 'hands-free: waiting for speech',
        idle: '', error: 'mic error: ' + detail }[state];
    },
  });
  $('council').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-pin]');
    if (!b) return;
    const id = b.dataset.pin;
    send({ type: 'pin', agent_id: seat(id).classList.contains('pinned') ? null : id });
  });
  $('send').onclick = () => submit('text');
  $('summitbtn').onclick = () => submit('summit');
  $('buildbtn').onclick = () => submit('build');
  $('cancelbtn').onclick = () => {
    WarVoice.silence();
    send({ type: 'cancel' });
  };
  $('msg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit(e.ctrlKey ? 'summit' : 'text');
  });
  $('speak').onchange = () => {
    WarVoice.unlock();
    if (!$('speak').checked) WarVoice.silence();
    send({ type: 'voice', on: $('speak').checked });
  };
  $('handsfree').onchange = async () => {
    const ok = await WarVoice.setHandsFree($('handsfree').checked);
    if (!ok) $('handsfree').checked = false;
  };
  bindTalk();
  resetStages(COUNCIL_STAGES);
  const ready = CardDirector.load().then((loaded) => {
    director = loaded;
    for (const c of WR.council) { layerState[c.id] = 'a'; setCardState(c.id, 'idle', true); }
  });
  const previewParams = new URLSearchParams(location.search);
  const ask = previewParams.get('ask'); // Plan Library "reconvene": prefill only, never auto-send
  if (ask) { $('msg').value = ask.slice(0, 4000); history.replaceState(null, '', location.pathname); }
  if (previewParams.has('still')) { // deterministic visual audits: no transitions or animations in flight
    const freeze = document.createElement('style');
    freeze.textContent = '*,*:before,*:after{transition:none!important;animation:none!important}';
    document.head.appendChild(freeze);
  }
  const demo = previewParams.get('demo'); // /warroom?demo=build|build-fail|stall|summit[&speed=20]: no agents, no cost
  if (demo && WarDemo.NAMES.includes(demo)) runDemo(demo, Number(previewParams.get('speed')) || 1, previewParams.has('still'));
  const preview = previewParams.get('previewCards');
  const poses = previewParams.get('previewPoses'); // "main:offense,research:defense": force art, for visual audits
  ready.then(() => {
    if (preview === 'thinking') setThinking('research', true);
    if (preview === 'speaking') setSpeaking('main', true);
    if (preview === 'building') WR.council.forEach((c) => setBuilding(c.id, true));
    if (preview === 'building-speaking') { WR.council.forEach((c) => setBuilding(c.id, true)); setSpeaking('main', true); }
    if (poses) poses.split(',').forEach((pair) => { const [id, state] = pair.split(':'); if (byId[id]) setCardState(id, state, true); });
  });
  setInterval(rotateCards, 1000);
  setInterval(tick, 1000);
  setInterval(() => {
    if (connected()) send({ type: 'ping' });
    if (connected() && lastPong && Date.now() - lastPong > 45000) ws.close();
  }, 15000);
  connect();
}

init();
