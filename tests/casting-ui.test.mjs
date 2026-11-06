// The voice dropdown under each card: shows what the server lists, sends a change, never invents a choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../dist/config.js';
import { titleSize, voiceName } from '../dist/warroom-html.js';

// A browser script: run it the way the page does, in a sandbox that offers `module` so it can hand itself back.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(readFileSync(join(PROJECT_ROOT, 'public', 'warroom-casting.js'), 'utf8'), sandbox);
const WarCasting = sandbox.module.exports;
const plain = (value) => JSON.parse(JSON.stringify(value)); // objects built inside the sandbox have foreign prototypes

const voices = [
  { id: 'af_heart', name: 'Heart', group: 'American female' },
  { id: 'am_onyx', name: 'Onyx', group: 'American male' },
  { id: 'bm_george', name: 'George', group: 'British male' },
  { id: 'bm_lewis', name: 'Lewis', group: 'British male' },
];

test('voices are grouped in server order, one optgroup per accent and gender', () => {
  const g = plain(WarCasting.groups(voices));
  assert.deepEqual(g.map((x) => x.label), ['American female', 'American male', 'British male']);
  assert.deepEqual(g[2].voices.map((v) => v.name), ['George', 'Lewis']);
});

test('the current voice is the selected option; everything else is unselected', () => {
  const html = WarCasting.optionsHtml(voices, 'bm_george');
  assert.equal((html.match(/<option /g) || []).length, 4);
  assert.match(html, /<option value="bm_george" selected>George<\/option>/);
  assert.equal((html.match(/selected/g) || []).length, 1);
  assert.equal((html.match(/<optgroup /g) || []).length, 3);
});

test('a saved voice missing from the list stays visible (voice file gone) but adds no fake choices', () => {
  const html = WarCasting.optionsHtml([], 'bm_george');
  assert.equal((html.match(/<option /g) || []).length, 1);
  assert.match(html, /selected>bm_george</);
});

test('hostile names cannot inject markup', () => {
  const html = WarCasting.optionsHtml([{ id: 'x"><script>', name: '<img onerror=1>', group: '"><b>' }], '');
  assert.ok(!/<script|<img|<b>/.test(html), html);
});

// A fake document: one #council, two selects.
function fakeDoc() {
  const listeners = {};
  const selects = ['main', 'ops'].map((id) => ({ dataset: { voiceFor: id }, innerHTML: '', disabled: false, value: '', closest(sel) { return sel === 'select[data-voice-for]' ? this : null; } }));
  return {
    selects,
    getElementById: () => ({ addEventListener: (type, fn) => { listeners[type] = fn; } }),
    querySelectorAll: () => selects,
    fire: (type, target) => listeners[type]({ target }),
  };
}

test('choosing a voice sends exactly one set_voice for that seat', () => {
  const doc = fakeDoc();
  const sent = [];
  WarCasting.mount(doc, (m) => sent.push(m));
  doc.selects[1].value = 'am_onyx';
  doc.fire('change', doc.selects[1]);
  assert.deepEqual(plain(sent), [{ type: 'set_voice', agent_id: 'ops', voice: 'am_onyx' }]);
});

test('a casting message fills every seat from the server list and its current voice; no list disables the dropdown', () => {
  const doc = fakeDoc();
  const cast = WarCasting.mount(doc, () => {});
  cast.handle({ type: 'casting', voices, current: { main: 'bm_george', ops: 'am_onyx' } });
  assert.match(doc.selects[0].innerHTML, /value="bm_george" selected/);
  assert.match(doc.selects[1].innerHTML, /value="am_onyx" selected/);
  assert.equal(doc.selects[0].disabled, false);
  cast.handle({ type: 'casting', voices: [], current: { main: 'bm_george' } });
  assert.equal(doc.selects[0].disabled, true);
});

test('title font shrinks for long titles and the voice id reads as a name', () => {
  assert.equal(titleSize('Hand of the King'), 17);
  assert.ok(titleSize('Master of Whisperers') < titleSize('Royal Bard'));
  assert.equal(titleSize('Royal Bard'), 18);
  assert.ok(titleSize('x'.repeat(60)) >= 12, 'never unreadably small');
  assert.equal(titleSize(''), 18);
  assert.equal(voiceName('bm_george'), 'George');
  assert.equal(voiceName('af_heart'), 'Heart');
  assert.equal(voiceName(''), '');
});
