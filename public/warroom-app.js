// public/warroom-app.js - council chamber UI. Needs (inline, before this file): WR config, md(), esc().
// Wire protocol is documented at the top of warroom/server.py.
/* global WR, md, esc, WarVoice */
'use strict';

const $ = (id) => document.getElementById(id);
const COUNCIL_STAGES = ['recall', 'plan', 'investigate', 'debate', 'verdict', 'record'];
const BUILD_STAGES = ['execute', 'gate', 'review'];
const KIND_LABEL = { plan: 'plan', take: 'take', critique: 'cross-examination', verdict: 'verdict',
  build: 'build', review: 'review', error: 'error' };
const byId = Object.fromEntries(WR.council.map((c) => [c.id, c]));
let ws = null;
let retryMs = 2000;
let retryTimer = null;
let lastPong = 0;
let busySince = 0;
const thinkingSince = {};

// --- rendering ------------------------------------------------------------------------
function clock() {
  const d = new Date();
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
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

function agentLine(id, text, kind) {
  const c = byId[id];
  if (!c) return bubble(id, md(text), 'sys');
  return bubble(c.name + ' \u00b7 ' + c.title, md(text), kind === 'error' ? 'err' : kind || '', c.color, KIND_LABEL[kind]);
}

function seat(id) {
  return $('seat-' + id);
}

function setThinking(id, on) {
  const el = seat(id);
  if (!el) return;
  el.classList.toggle('thinking', on);
  if (on) thinkingSince[id] = Date.now();
  else delete thinkingSince[id];
}

function setSpeaking(id, on) {
  const el = seat(id);
  if (el) el.classList.toggle('speaking', on);
}

function setLevel(id, level) {
  const el = seat(id);
  if (el) el.style.setProperty('--lvl', level.toFixed(3));
}

function resetStages(names) {
  $('stages').innerHTML = names.map((n) => '<span class="stage" id="st-' + n + '">' + n + '<i></i></span>').join('');
}

function setStage(name, state, detail) {
  if (name === 'recall' && state === 'active') resetStages(COUNCIL_STAGES);
  if (name === 'execute' && !$('st-execute')) resetStages(BUILD_STAGES);
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
  const parts = Object.keys(thinkingSince).map((id) => {
    const s = Math.floor((Date.now() - thinkingSince[id]) / 1000);
    return (byId[id] ? byId[id].name : id) + ' ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  });
  $('prog').textContent = parts.length ? 'thinking: ' + parts.join('  \u00b7  ') : '';
  if (!parts.length && busySince && !document.querySelector('.stage.active')) busySince = 0;
}

function metrics(m) {
  const money = (x) => '$' + Number(x || 0).toFixed(2);
  const rows = [['outcome', m.outcome], ['time', m.total_s + 's'], ['cost', money(m.total_cost_usd)]];
  if (m.kind === 'summit') {
    const conf = Object.entries(m.confidence || {}).map(([a, v]) => a + ' ' + v[0].toFixed(2) +
      (v[1] !== v[0] ? ' \u2192 ' + v[1].toFixed(2) : '')).join(', ');
    rows.push(['specialists', (m.specialists || []).join(', ')], ['evidence cited', m.evidence],
      ['challenges', m.challenges], ['minds changed', m.changed_minds], ['confidence', conf || '-'],
      ['verdict confidence', m.verdict_confidence], ['plan steps', m.plan_steps],
      ['memory used / saved', m.memory_lines_used + ' / ' + m.memories_saved], ['hive entries', m.hive_entries]);
  } else {
    rows.push(['files changed', (m.changed_files || []).length], ['checks', m.checks_ok ? 'pass' : 'FAIL'],
      ['review', m.approved ? 'approved' : 'not approved'], ['criteria met', m.criteria_met],
      ['core rebooted', m.rebooted ? 'yes' : 'no']);
  }
  const stages = Object.entries(m.stages || {}).map(([s, t]) => s + ' ' + t + 's').join(' \u00b7 ');
  $('score').innerHTML = '<h3>' + (m.kind === 'summit' ? 'Council scoreboard' : 'Build scoreboard') + ' <small>run ' +
    esc(m.id) + '</small></h3><table>' + rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(String(r[1] ?? '-')) +
    '</td></tr>').join('').replace(/>undefined</g, '>-<') + '</table><div class="stagetimes">' + esc(stages) + '</div>';
  $('score').hidden = false;
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
    $('sver').textContent = 'server v' + m.server + ' \u00b7 ' + m.pong;
    if (m.pong !== WR.protocol) bubble('war room', 'protocol mismatch: page ' + WR.protocol + ', server ' + m.pong + '. Hard-refresh.', 'err');
    markPin(m.pinned);
    return;
  }
  if (m.pinned !== undefined) return markPin(m.pinned);
  if (m.type === 'voice') return voiceInfo(m);
  if (m.type === 'stage') return setStage(m.stage, m.state, m.detail);
  if (m.type === 'provider') {
    const el = $('model-' + m.agent_id);
    if (el) el.textContent = 'route: ' + m.provider + ' / ' + m.model;
    return;
  }
  if (m.type === 'thinking') return setThinking(m.agent_id, m.on);
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
  ws.onopen = () => {
    retryMs = 2000;
    setConn(true, 'connected');
    send({ type: 'ping' });
    send({ type: 'voice', on: $('speak').checked });
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

function submit(kind) {
  const input = $('msg');
  const text = input.value.trim();
  WarVoice.unlock();
  if (kind === 'build') return send({ type: 'build' });
  if (!text) return input.focus();
  if (!send({ type: kind, text })) return;
  bubble(kind === 'summit' ? 'you \u2192 council' : 'you', esc(text), 'you');
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
  setInterval(tick, 1000);
  setInterval(() => {
    if (connected()) send({ type: 'ping' });
    if (connected() && lastPong && Date.now() - lastPong > 45000) ws.close();
  }, 15000);
  connect();
}

init();
