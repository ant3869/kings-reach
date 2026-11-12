// Royal theme flag: on by default, off only by explicit opt-out, and scoped CSS only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const sandbox = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../public/warroom-royal.js', import.meta.url), 'utf8'), sandbox);
const { enabled } = sandbox.module.exports;
const mem = (v) => { const d = v ? { kr_royal: v } : {}; return { getItem: (k) => d[k] ?? null, setItem: (k, x) => { d[k] = x; } }; };

test('flag is on by default and off only when opted out', () => {
  assert.equal(enabled('', mem()), true, 'a browser that never chose gets the royal look');
  assert.equal(enabled('?royal=0', mem()), false);
  assert.equal(enabled('', mem('0')), false, 'the opt-out is remembered');
  assert.equal(enabled('?royal=1', mem('0')), true, 'and can be undone');
  assert.equal(enabled('', mem('1')), true);
  const blocked = { getItem() { throw new Error('storage blocked'); }, setItem() { throw new Error('storage blocked'); } };
  assert.equal(enabled('', blocked), true, 'blocked storage keeps the default instead of silently dropping the theme');
});
test('every CSS rule is scoped to html[data-royal] (flag off changes nothing)', () => {
  const css = readFileSync(new URL('../public/warroom-royal.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = css.match(/(^|\})\s*([^{}@]+)\{/g) ?? [];
  for (const s of sels) assert.ok(/html\[data-royal\]/.test(s) || /^\}?\s*\d+%$|^\}?\s*(from|to)$/.test(s.trim()), s);
});
