// Royal theme flag: off by default, on only by explicit opt-in, and scoped CSS only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const sandbox = { module: { exports: {} } };
vm.runInNewContext(readFileSync(new URL('../public/warroom-royal.js', import.meta.url), 'utf8'), sandbox);
const { enabled } = sandbox.module.exports;
const mem = (v) => { const d = v ? { kr_royal: v } : {}; return { getItem: (k) => d[k] ?? null, setItem: (k, x) => { d[k] = x; } }; };

test('flag is off by default and on only when opted in', () => {
  assert.equal(enabled('', mem()), false);
  assert.equal(enabled('?royal=1', mem()), true);
  assert.equal(enabled('', mem('1')), true);
  assert.equal(enabled('?royal=0', mem('1')), false);
});
test('every CSS rule is scoped to html[data-royal] (flag off changes nothing)', () => {
  const css = readFileSync(new URL('../public/warroom-royal.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = css.match(/(^|\})\s*([^{}@]+)\{/g) ?? [];
  for (const s of sels) assert.ok(/html\[data-royal\]/.test(s) || /^\}?\s*\d+%$|^\}?\s*(from|to)$/.test(s.trim()), s);
});
