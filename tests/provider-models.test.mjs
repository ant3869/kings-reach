// The Settings page must only offer real (provider, model) pairs, and the server must refuse anything else.
// Born from a real misconfiguration: Main's Claude route held "cx/gpt-5.6-Sol" and its ChatGPT route "claude-sonnet-5-5".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModelChoices, invalidRoutes, readiness } from '../dist/provider-models.js';
import { renderProviderSettings } from '../dist/provider-html.js';

const models = [
  { id: 'cx/gpt-5.6-sol', capabilities: { reasoning: true, contextWindow: 400000 } },
  { id: 'cx/gpt-5.6-terra' },
  { id: 'meta/muse-spark-1.3' },
  { id: 'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  { id: 'cc/claude-sonnet-5-5' },
  { id: 'cc/claude-opus-5' },
  { id: 'gh/gpt-4o' },
];
const health = [
  { id: 'claude', available: false, configured: true, detail: 'last call failed' }, // a bad model once must NOT lock Claude out
  { id: 'codex', available: true, configured: true, detail: 'ok' },
  { id: 'chatgpt', available: true, configured: true, detail: 'ok' },
  { id: 'meta', available: true, configured: true, detail: 'ok' },
  { id: 'ollama', available: false, configured: false, detail: 'no models', models: [] },
  { id: 'openrouter', available: false, configured: false, detail: 'OPENROUTER_API_KEY missing' },
];
const choices = buildModelChoices(models, health);
const ready = readiness(health);
const ids = (p) => choices[p].map((m) => m.id);

test('each provider is offered only its own models', () => {
  assert.deepEqual(ids('chatgpt'), ['cx/gpt-5.6-sol', 'cx/gpt-5.6-terra']);
  assert.deepEqual(ids('meta'), ['meta/muse-spark-1.3', 'cf/@cf/meta/llama-3.3-70b-instruct-fp8-fast']);
  assert.ok(ids('claude').includes('claude-sonnet-5-5') && ids('claude').includes('claude-opus-5'), 'Claude gets the cc/ lane, prefix stripped');
  assert.ok(ids('claude').includes('claude-sonnet-4-6'), 'plus the known-good built-in ids');
  assert.ok(!ids('claude').some((m) => m.startsWith('cx/')), 'no ChatGPT model under Claude');
  assert.ok(!ids('chatgpt').some((m) => m.startsWith('claude')), 'no Claude model under ChatGPT');
  assert.deepEqual(choices.ollama, [], 'nothing installed means nothing to pick');
});

test('model notes come from the catalog capabilities', () => {
  assert.equal(choices.chatgpt[0].note, 'reasoning · 400k ctx');
  assert.equal(choices.chatgpt[1].note, undefined);
});

test('readiness means configured, not "the last call worked"', () => {
  assert.equal(ready.claude, true);
  assert.equal(ready.ollama, false);
  assert.equal(ready.openrouter, false);
});

test('the exact mistake that was saved is now refused, with a readable reason', () => {
  const bad = { agents: { main: [{ provider: 'claude', model: 'cx/gpt-5.6-Sol' }, { provider: 'chatgpt', model: 'claude-sonnet-5-5' }] } };
  const problems = invalidRoutes(bad, choices, ready);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /main: "cx\/gpt-5\.6-Sol" is not a claude model/);
  assert.match(problems[1], /"claude-sonnet-5-5" is not a chatgpt model/);
});

test('the corrected pairing, plus unconfigured providers and empty models, are judged correctly', () => {
  const ok = { agents: { main: [{ provider: 'claude', model: 'claude-sonnet-5-5' }, { provider: 'chatgpt', model: 'cx/gpt-5.6-sol' }, { provider: 'codex', model: 'default' }] } };
  assert.deepEqual(invalidRoutes(ok, choices, ready), []);
  assert.match(invalidRoutes({ agents: { ops: [{ provider: 'openrouter', model: 'qwen/qwen3-235b-a22b' }] } }, choices, ready)[0], /not available right now/);
  assert.equal(invalidRoutes({ agents: { ops: [{ provider: 'claude', model: '' }] } }, choices, ready).length, 1);
  assert.equal(invalidRoutes({ agents: { ops: [{ provider: 'nonsense', model: 'x' }] } }, choices, ready).length, 1);
  assert.deepEqual(invalidRoutes({}, choices, ready), []);
  assert.deepEqual(invalidRoutes(null, choices, ready), []);
});

test('the page renders dropdowns, not free-text model boxes, and still embeds no credentials', () => {
  const html = renderProviderSettings('tok');
  assert.match(html, /select class="model/);
  assert.ok(!/<input/.test(html), 'no free-text inputs left on the page');
  assert.ok(!/datalist/.test(html));
});
