// tests/core.test.mjs - `npm test` (builds first). Pure-logic tests against dist/, zero deps.
// Every case here is a bug that actually happened; keep it that way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvValue } from '../dist/env.js';
import { redactSecrets } from '../dist/exfil-guard.js';
import { refusalReason, tokenMatches } from '../dist/http-guard.js';
import { md, esc, CLIENT_MD_JS } from '../dist/client-md.js';
import { psLiteral } from '../dist/voice.js';
import { defaultProviderRouting, providerHasTools, saveProviderRouting } from '../dist/provider-config.js';
import { renderProviderSettings } from '../dist/provider-html.js';

test('env: inline comments, empty-with-comment, quotes', () => {
  assert.equal(parseEnvValue('7860          # War Room websocket port'), '7860');
  assert.equal(parseEnvValue('   # Override path (optional)'), ''); // was: the comment became the path
  assert.equal(parseEnvValue('"has # inside"  # trailing'), 'has # inside');
  assert.equal(parseEnvValue("'single'"), 'single');
  assert.equal(parseEnvValue('abc#notacomment'), 'abc#notacomment');
  assert.equal(parseEnvValue(''), '');
});

test('exfil: redacts .env secret values and known credential shapes', () => {
  const env = { GROQ_API_KEY: 'super-secret-value-123', DASHBOARD_PORT: '3141', NOTE: 'not-secret-but-long' };
  const tg = '123456789:' + 'A'.repeat(35);
  const { text, redactions } = redactSecrets(`key super-secret-value-123 bot ${tg} port 3141 note not-secret-but-long`, env);
  assert.ok(!text.includes('super-secret-value-123'));
  assert.ok(!text.includes(tg));
  assert.ok(text.includes('3141') && text.includes('not-secret-but-long'));
  assert.deepEqual(redactions.sort(), ['GROQ_API_KEY', 'telegram-bot-token']);
});

test('exfil: clean text passes through untouched', () => {
  assert.deepEqual(redactSecrets('hello **world**', {}), { text: 'hello **world**', redactions: [] });
});

const local = { token: '', loopbackOnly: true };
test('guard: DNS-rebinding hosts refused, loopback allowed', () => {
  assert.equal(refusalReason({ method: 'GET', host: 'evil.example:3141' }, local), 'host not allowed');
  for (const host of ['127.0.0.1:3141', 'localhost:3141', '[::1]:3141']) {
    assert.equal(refusalReason({ method: 'GET', host }, local), null, host);
  }
});

test('guard: cross-site writes refused, same-origin + non-browser allowed', () => {
  const host = '127.0.0.1:3141';
  assert.equal(refusalReason({ method: 'POST', host, origin: 'http://evil.example' }, local), 'cross-origin request');
  assert.equal(refusalReason({ method: 'POST', host, fetchSite: 'cross-site' }, local), 'cross-site request');
  assert.equal(refusalReason({ method: 'POST', host, origin: 'http://127.0.0.1:3141', fetchSite: 'same-origin' }, local), null);
  assert.equal(refusalReason({ method: 'POST', host }, local), null); // curl / build.py
  assert.equal(refusalReason({ method: 'GET', host, origin: 'http://evil.example' }, local), null); // reads: Host check covers
});

test('guard: token enforced when configured, constant-time compare', () => {
  const opts = { token: 's3cret', loopbackOnly: true };
  assert.equal(refusalReason({ method: 'GET', host: 'localhost' }, opts), 'unauthorized');
  assert.equal(refusalReason({ method: 'GET', host: 'localhost', token: 's3cret' }, opts), null);
  assert.equal(tokenMatches('s3cre', 's3cret'), false);
  assert.equal(tokenMatches(undefined, ''), true);
});

test('md: renders the markdown agents actually emit', () => {
  assert.equal(md('**bold** and `code`'), '<p><strong>bold</strong> and <code>code</code></p>');
  assert.equal(md('- a\n- b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
  assert.equal(md('## Title\ntext'), '<h3>Title</h3><p>text</p>');
  assert.equal(md('```\nconst x = 1;\n```'), '<pre><code>const x = 1;</code></pre>');
  assert.equal(md('[site](https://example.com)'), '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">site</a></p>');
  assert.equal(md('`**not bold**`'), '<p><code>**not bold**</code></p>');
});

test('md: escapes HTML, attribute breakouts, and non-http links', () => {
  assert.ok(!md('<img src=x onerror=alert(1)>').includes('<img'));
  assert.ok(!md('[x](https://a.b/"onmouseover="alert(1))').includes('"onmouseover'));
  assert.ok(!md('[x](javascript:alert(1))').includes('<a'));
  assert.equal(esc(`<"'&>`), '&lt;&quot;&#39;&amp;&gt;');
});

test('md: browser bundle is self-contained and identical to the tested code', () => {
  const sandbox = {};
  new Function('sandbox', `${CLIENT_MD_JS}; sandbox.md = md;`)(sandbox);
  assert.equal(sandbox.md('**x**\n\n- y'), md('**x**\n\n- y'));
  assert.ok(!CLIENT_MD_JS.includes('${')); // no unresolved template holes leaked into the page
});

test('providers: defaults have diverse fallbacks and capability gates', () => {
  const cfg = defaultProviderRouting();
  assert.equal(cfg.agents.main[0].provider, 'claude');
  assert.ok(cfg.agents.main.some((r) => r.provider === 'codex'));
  assert.ok(cfg.agents.main.some((r) => r.provider === 'meta'));
  assert.ok(cfg.agents.research.some((r) => r.provider === 'gemini'));
  assert.equal(providerHasTools('claude'), true);
  assert.equal(providerHasTools('codex'), true);
  assert.equal(providerHasTools('gemini'), false);
  assert.equal(providerHasTools('meta'), false);
  assert.equal(providerHasTools('9router'), false);
  assert.throws(() => saveProviderRouting({ agents: { ops: [{ provider: 'gemini', model: '' }] } }), /needs at least one/);
});

test('providers: settings page never embeds credentials', () => {
  const html = renderProviderSettings('test-dashboard-token');
  assert.ok(html.includes('Provider Network') && html.includes('Capability-aware fallback'));
  assert.ok(!html.includes('OPENAI_API_KEY='));
  assert.ok(!html.includes('GOOGLE_API_KEY='));
});

test('voice: PowerShell literal cannot expand $() or break out', () => {
  assert.equal(psLiteral('hi $(Remove-Item C:\\x) `n'), "'hi $(Remove-Item C:\\x) `n'");
  assert.equal(psLiteral("it's"), "'it''s'");
  assert.equal(psLiteral('curly \u2019 quote'), "'curly '' quote'");
});
