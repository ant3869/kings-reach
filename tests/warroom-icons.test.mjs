// The War Room's icon sprite: every icon a button uses must exist, be decoration only, and never be a button's only name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWarRoom } from '../dist/warroom-html.js';

const html = renderWarRoom(null);
const symbols = [...html.matchAll(/<symbol id="(ic-[a-z]+)"/g)].map((m) => m[1]);
const uses = [...html.matchAll(/<use href="#(ic-[a-z]+)"/g)].map((m) => m[1]);
const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1], inner: m[2] }));

test('icons: the sprite is defined exactly once and every symbol has a unique id', () => {
  assert.equal(html.split('<symbol ').length - 1, symbols.length);
  assert.equal(new Set(symbols).size, symbols.length, `duplicate ids in ${symbols}`);
  assert.equal(html.split('focusable="false"').length - 1, 1, 'one hidden sprite, not one per button');
});

test('icons: every <use> points at a symbol that exists', () => {
  assert.ok(uses.length >= 6, `expected the page to use its icons, found ${uses}`);
  for (const id of uses) assert.ok(symbols.includes(id), `#${id} is used but not defined`);
});

test('icons: no symbol is defined and then never used (dead markup)', () => {
  for (const id of symbols) assert.ok(uses.includes(id), `#${id} is defined but nothing uses it`);
});

test('icons: every icon is hidden from screen readers (it decorates a name, it is not the name)', () => {
  const svgs = [...html.matchAll(/<svg class="ic"([^>]*)>/g)];
  assert.ok(svgs.length >= uses.length);
  for (const [tag, attrs] of svgs) assert.match(attrs, /aria-hidden="true"/, tag);
});

test('buttons: every button has an accessible name, from its text or an aria-label', () => {
  for (const b of buttons) {
    const text = b.inner.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').replace(/&#?\w+;/g, '').trim();
    assert.ok(text.length > 0 || /aria-label="[^"]+"/.test(b.attrs), `nameless button: <button${b.attrs}>`);
  }
});

test('buttons: icon-only buttons say what they do, and the hold-to-talk button keeps its full name for assistive tech', () => {
  const attach = buttons.find((b) => /id="attachbtn"/.test(b.attrs));
  assert.match(attach.attrs, /aria-label="Attach files"/);
  const mic = buttons.find((b) => /id="mic"/.test(b.attrs));
  assert.match(mic.attrs, /aria-label="Hold to talk \(or hold Space\)"/);
  assert.match(mic.inner, /class="micrec"/, 'the recording caption exists to swap in while held');
});

test('the message box fits its job: a short placeholder, with the shortcuts kept in its name and tooltip', () => {
  const input = html.match(/<input id="msg"([^>]*)>/)[1];
  const placeholder = input.match(/placeholder="([^"]*)"/)[1];
  assert.ok(placeholder.length <= 40, `placeholder is ${placeholder.length} chars and gets cut off beside the icon buttons: "${placeholder}"`);
  assert.match(input, /aria-label="[^"]*Ctrl\+Enter[^"]*"/);
  assert.match(input, /title="[^"]*Ctrl\+Enter[^"]*"/);
});

test('status text that changes by itself is announced politely', () => {
  assert.match(html, /<div id="micstate" role="status" aria-live="polite">/);
});
