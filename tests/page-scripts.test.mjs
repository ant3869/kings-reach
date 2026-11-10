// Every inline <script> a page serves must be valid JavaScript. These scripts are built inside TypeScript template literals,
// where an escape like \n silently becomes a real newline inside a JS string and kills the whole page, while tsc, and every
// test that only reads the HTML as text, stay green. (A dashboard whose Stop button script did exactly that was caught only
// by a browser run.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderDashboard } from '../dist/dashboard-html.js';
import { renderWarRoom } from '../dist/warroom-html.js';
import { renderHistory } from '../dist/history-html.js';

const PAGES = {
  dashboard: () => renderDashboard(),
  'war room': () => renderWarRoom(null),
  history: () => renderHistory(''),
};

for (const [name, render] of Object.entries(PAGES)) {
  test(`${name}: every inline script parses`, () => {
    const html = render();
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).filter((s) => s.trim());
    assert.ok(scripts.length > 0, `${name} served no inline script, so this test is not looking at anything`);
    for (const [i, source] of scripts.entries()) {
      assert.doesNotThrow(() => new vm.Script(source), `inline script #${i} of the ${name} page has a syntax error`);
    }
  });
}
