// The hold-to-talk button is a picture (warroom-mic.webp) with real text captions under it, and the message box sticks to the
// bottom of the window. These pin the parts that fail quietly: a missing file, a missing allowlist entry, a stale cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWarRoom, WARROOM_STATIC, WARROOM_CLIENT_VERSION } from '../dist/warroom-html.js';
import { PROJECT_ROOT } from '../dist/config.js';

const html = renderWarRoom(null);
const file = readFileSync(join(PROJECT_ROOT, 'public', 'warroom-mic.webp'));

test('mic art: the file is a real WebP with an alpha channel (transparent corners), 320px square, and small', () => {
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.toString('ascii', 8, 12), 'WEBP');
  assert.equal(file.toString('ascii', 12, 16), 'VP8X', 'an extended WebP, the only kind that can carry alpha');
  assert.ok(file[20] & 0x10, 'the alpha flag is set');
  assert.equal(file.readUIntLE(24, 3) + 1, 320);
  assert.equal(file.readUIntLE(27, 3) + 1, 320);
  assert.ok(file.length < 60 * 1024, `${file.length} bytes: this loads on every War Room visit`);
});

test('mic art: the server may serve it (only allowlisted files are served) and the page asks for it with the client version', () => {
  assert.ok(WARROOM_STATIC.includes('warroom-mic.webp'), 'not in WARROOM_STATIC: the browser would get a 404 and a blank button');
  assert.ok(html.includes(`/warroom/warroom-mic.webp?v=${WARROOM_CLIENT_VERSION}`), 'the version query makes a changed picture reach people who cached the old one');
});

test('mic button: the picture is decoration, the captions are the name, and every state is still styled', () => {
  const mic = html.match(/<button id="mic"([^>]*)>([\s\S]*?)<\/button>/);
  assert.ok(mic);
  assert.match(mic[2], /^<span class="micface" aria-hidden="true"><\/span>/);
  for (const cls of ['miccap', 'michint', 'micrec']) assert.ok(mic[2].includes(`class="${cls}"`), cls);
  assert.match(html, /#mic\.hot \.micface\{[^}]*animation:micpulse/, 'listening is shown on the picture');
  assert.match(html, /prefers-reduced-motion:reduce\)\{#mic\.hot \.micface\{animation:none/, 'and stops pulsing for people who ask for less motion');
  assert.match(html, /#mic:disabled\{opacity:\.45[^}]*\}#mic:disabled \.micface\{filter:grayscale/, 'unavailable mic looks unavailable');
  assert.ok(!html.includes('#ic-horn'), 'the horn icon is gone, so it must not linger in the sprite');
});

test('message box: both composer rows and the attachment tray sit inside one sticky dock, ahead of the plan line', () => {
  const dock = html.match(/<div class="dock">([\s\S]*?)<div id="planbox">/);
  assert.ok(dock, 'dock wrapper missing');
  for (const id of ['attachtray', 'msg', 'send', 'summitbtn', 'buildbtn', 'cancelbtn']) assert.ok(dock[1].includes(`id="${id}"`), `#${id} must be inside the dock`);
  assert.ok(!dock[1].includes('id="log"'), 'the transcript scrolls; only the input rows stick');
  // what was captured starts after the dock's opening tag, so it holds every inner <div> and its closer, plus the dock's own closer
  assert.equal((dock[1].match(/<\/div>/g) || []).length, (dock[1].match(/<div/g) || []).length + 1, 'balanced: the dock closes right before the plan line, not later');
  assert.match(html, /\.dock\{position:sticky;bottom:0;/);
});

test('transcript: wide idle screens get a shorter log, and a run gives the height back', () => {
  // equal specificity: the later rule wins, so the wide-screen rule must come AFTER the base #log rule (the browser check caught this once)
  assert.ok(html.indexOf('#log{height:36vh') > html.indexOf('#log{height:45vh'), 'the wide-screen rule is overridden by the base rule');
  assert.match(html, /@media\(min-width:1500px\) and \(min-height:760px\)\{#log\{height:36vh;min-height:240px\}body\.ran #log\{height:45vh;min-height:310px\}\}/);
});
