// The council cards: big enough on a wide screen, and compact only once a run has actually started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderWarRoom } from '../dist/warroom-html.js';
import { PROJECT_ROOT } from '../dist/config.js';

const html = renderWarRoom(null);
const app = readFileSync(join(PROJECT_ROOT, 'public', 'warroom-app.js'), 'utf8');
const ROW_AT_1X = 5 * 184 + 4 * 9; // five cards and four gaps, in px
const WRAP = 1400; // .wrap max-width

test('cards: the compact size keys on a class the page sets for a run, never on the stage chips (the idle page draws those)', () => {
  assert.ok(!/body:has\(#stages/.test(html), 'the idle page already has stage chips, so this shrinks the cards permanently');
  assert.match(html, /body\.ran #council\{zoom:\.62/);
});

test('cards: the page marks a run when the first stage arrives, and clears it before a replay', () => {
  assert.match(app, /function setStage\([^)]*\) \{\s*document\.body\.classList\.add\('ran'\)/);
  assert.match(app, /m\.type === 'resume'[^\n]*document\.body\.classList\.remove\('ran'\)/);
});

test('cards: every screen-size step is a valid media query (and( with no space is a function token and silently never applies)', () => {
  const queries = [...html.matchAll(/@media\(min-width:\d+px\)[^{]*\{/g)].map((m) => m[0]);
  assert.ok(queries.length >= 3, `expected the big-screen steps, found ${queries}`);
  for (const q of queries) assert.match(q, /^@media\(min-width:\d+px\) and \(min-height:\d+px\)\{$/, q);
});

test('cards: each big-screen zoom keeps the whole row inside the page width, and the run size is smaller than the idle size', () => {
  const steps = [...html.matchAll(/@media\(min-width:(\d+)px\) and \(min-height:\d+px\)\{#council\{zoom:([\d.]+)\}body\.ran #council\{zoom:([\d.]+)\}\}/g)];
  assert.equal(steps.length, 3);
  let previous = 1;
  for (const [, width, idle, ran] of steps) {
    assert.ok(Number(idle) > previous, `zoom must grow with the screen (${idle} after ${previous})`);
    assert.ok(ROW_AT_1X * Number(idle) <= WRAP, `x${idle} makes the row ${Math.round(ROW_AT_1X * idle)}px, wider than the ${WRAP}px page, so it would wrap onto two lines`);
    assert.ok(Number(ran) < Number(idle) && Number(ran) >= 0.62, `compact size ${ran} at ${width}px`);
    previous = Number(idle);
  }
});
