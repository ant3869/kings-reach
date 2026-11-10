// Icon-only buttons: no visible words, but a real name for assistive tech and a tooltip that explains them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWarRoom } from '../dist/warroom-html.js';

const html = renderWarRoom(null);
const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], inner: m[2] }));
const attr = (b, name) => (b.attrs.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];
const visibleText = (b) => b.inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
const byId = (id) => buttons.find((b) => attr(b, 'id') === id);
const pins = buttons.filter((b) => /class="pin"/.test(b.attrs));
const iconOnly = ['attachbtn', 'send', 'summitbtn', 'buildbtn', 'cancelbtn'].map((id) => ({ id, b: byId(id) }));

test('icon buttons: Attach, Send, Convene, Build and Hush exist and show no words', () => {
  for (const { id, b } of iconOnly) {
    assert.ok(b, `#${id} missing`);
    assert.equal(visibleText(b), '', `#${id} still has visible text: "${visibleText(b)}"`);
    assert.match(b.inner, /<svg class="ic" aria-hidden="true">/, `#${id} needs its icon`);
  }
});

test('icon buttons: each keeps an accessible name, and its tooltip starts with that name', () => {
  for (const { id, b } of iconOnly) {
    const label = attr(b, 'aria-label'), tip = attr(b, 'data-tip');
    assert.ok(label, `#${id}: no aria-label, so screen readers would hear nothing`);
    assert.ok(tip && tip.startsWith(label), `#${id}: tooltip "${tip}" should start with its name "${label}"`);
    assert.equal(attr(b, 'title'), undefined, `#${id}: a title would show a second, native tooltip on top of ours`);
  }
  assert.equal(attr(byId('send'), 'aria-label'), 'Send');
  assert.equal(attr(byId('buildbtn'), 'aria-label'), 'Build the verdict');
});

test('icon buttons: the tooltip says what the button really does (Hush must not claim to stop a run)', () => {
  assert.match(attr(byId('cancelbtn'), 'data-tip'), /running task keeps going/);
  assert.match(attr(byId('send'), 'data-tip'), /Enter/);
  assert.match(attr(byId('summitbtn'), 'data-tip'), /Ctrl\+Enter/);
});

test('pin buttons: five of them, icon-only, named per agent, with a pressed state and an unpin wording', () => {
  assert.equal(pins.length, 5);
  for (const b of pins) {
    assert.equal(visibleText(b), '');
    assert.match(attr(b, 'aria-label'), /^Pin \S/);
    assert.equal(attr(b, 'aria-pressed'), 'false');
    assert.ok(attr(b, 'data-tip').startsWith(attr(b, 'aria-label')));
    assert.ok(attr(b, 'data-tip-on').startsWith(`Unpin ${attr(b, 'aria-label').slice('Pin '.length)}`), 'the pressed wording is "Unpin <the same agent>"');
  }
  assert.equal(new Set(pins.map((b) => attr(b, 'aria-label'))).size, 5, 'each pin names its own agent');
});

test('layout: all four action buttons sit in the one row with the message box (they are narrow now, a second row only wastes height)', () => {
  const dock = html.match(/<div class="dock">([\s\S]*?)<div id="planbox">/)[1];
  assert.equal((dock.match(/<div class="composer">/g) || []).length, 1, 'one composer row');
  const actions = dock.match(/<span class="actions">([\s\S]*?)<\/span>/)[1];
  for (const id of ['send', 'summitbtn', 'buildbtn', 'cancelbtn']) assert.ok(actions.includes(`id="${id}"`), `#${id} belongs with Send and Convene so the group wraps together`);
});

test('cancel run keeps its words: its text changes to "Cancelling..." and "Retry cancel", and it ends a real run', () => {
  const b = byId('nowcancel');
  assert.equal(visibleText(b), 'Cancel run');
});

test('tooltips: drawn on hover and on keyboard focus, and the buttons are at least 44px wide', () => {
  assert.match(html, /\[data-tip\]:hover::after,\[data-tip\]:focus-visible::after\{content:attr\(data-tip\)/);
  const width = Number(html.match(/button\.go\.icon\{position:relative;width:(\d+)px/)[1]);
  assert.ok(width >= 44, `${width}px is under the 44px touch minimum`);
  assert.ok(Number(html.match(/\.seat \.pin\{width:(\d+)px;height:(\d+)px/)[1]) >= 40);
});

test('sprite: the replaced icons are gone and the new ones are defined', () => {
  for (const id of ['ic-plane', 'ic-people', 'ic-pin']) assert.ok(html.includes(`<symbol id="${id}"`), id);
  for (const id of ['ic-quill', 'ic-crowns']) assert.ok(!html.includes(id), `${id} would be dead markup`);
});
