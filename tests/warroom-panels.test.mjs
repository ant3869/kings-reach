// Council Status / Recent Messages helpers: honest formatting, no invented numbers.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
// public/*.js are classic scripts (package is ESM), so evaluate them with a CommonJS shim.
const sandbox = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../public/warroom-panels.js', import.meta.url), 'utf8'), sandbox);
const P = sandbox.module.exports;

test('fmtUptime: days+hours, hours+minutes, minutes, and unavailable for bad input', () => {
  assert.equal(P.fmtUptime(2 * 86400 + 14 * 3600 + 5), '2d 14h');
  assert.equal(P.fmtUptime(3 * 3600 + 120), '3h 2m');
  assert.equal(P.fmtUptime(90), '1m');
  for (const bad of [null, undefined, NaN, -1, 'x']) assert.equal(P.fmtUptime(bad), 'unavailable');
});

test('recentFrom: keeps the last n, flattens whitespace, truncates long text', () => {
  const mk = (who, text) => ({ querySelector: (s) => ({ textContent: s === '.who' ? who : text }) });
  const out = P.recentFrom([mk('a', '1'), mk('b', '2'), mk('c', 'x'.repeat(200) + '\n  y')], 2);
  assert.equal(out.map((o) => o.who).join(), 'b,c');
  assert.ok(out[1].text.endsWith('...') && out[1].text.length <= 93);
});

test('panel CSS is scoped to html[data-royal] and mount is gated on the flag', () => {
  const sels = P.CSS.match(/(^|\})\s*([^{}]+)\{/g) ?? [];
  assert.ok(sels.length > 5);
  for (const s of sels) assert.ok(/html\[data-royal\]/.test(s), s);
  const src = readFileSync(new URL('../public/warroom-panels.js', import.meta.url), 'utf8');
  assert.ok(/hasAttribute\('data-royal'\)/.test(src));
  const html = readFileSync(new URL('../src/warroom-html.ts', import.meta.url), 'utf8');
  assert.ok(html.indexOf('<script src="/warroom/warroom-royal.js') < html.indexOf('<script src="/warroom/warroom-panels.js'));
});

test('shipped panel code carries no placeholder figures from the mockup', () => {
  const src = readFileSync(new URL('../public/warroom-panels.js', import.meta.url), 'utf8') +
    readFileSync(new URL('../src/warroom-status.ts', import.meta.url), 'utf8');
  for (const fake of ['PR-142', '28,471']) assert.ok(!src.includes(fake), fake);
  assert.ok(!/['"]2d 14h['"]/.test(src));
});
