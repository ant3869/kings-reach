// tests/mcp-allowlist-parse.test.mjs
// agent.yaml `mcp_allowlist` parsing: absent = legacy (undefined), [] = none, names = exactly those, malformed = fail closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const { parseAgentYaml, parseMcpAllowlist } = await import(pathToFileURL(resolve('dist', 'agent-config.js')).href);
const byId = (yaml) => Object.fromEntries(parseAgentYaml(yaml).map((a) => [a.id, a]));

test('inline list, block list, explicit empty and omitted are told apart', () => {
  const a = byId([
    'agents:',
    '  - id: one',
    '    mcp_allowlist: [github, "other-server"]',
    '  - id: two',
    '    mcp_allowlist:',
    '      - github # comment',
    '      - \'x_y\'',
    '  - id: three',
    '    mcp_allowlist: []',
    '  - id: four',
    '    name: Four',
  ].join('\n'));
  assert.deepEqual(a.one.mcpAllowlist, ['github', 'other-server']);
  assert.deepEqual(a.two.mcpAllowlist, ['github', 'x_y']);
  assert.deepEqual(a.three.mcpAllowlist, []);
  assert.equal(a.four.mcpAllowlist, undefined);
  assert.equal('mcpAllowlist' in a.four, false);
});

test('block lists written by js-yaml (agent-create) parse, including CRLF files', () => {
  const a = byId('agents:\r\n  - id: made\r\n    name: Made\r\n    mcp_allowlist:\r\n      - github\r\n  - id: next\r\n    name: Next\r\n');
  assert.deepEqual(a.made.mcpAllowlist, ['github']);
  assert.equal(a.next.mcpAllowlist, undefined);
});

test('malformed allowlists throw from the parser and fail closed ([]) in the agent config', () => {
  for (const bad of ['mcp_allowlist: github', 'mcp_allowlist: [a, [b]]', 'mcp_allowlist: [a,, b]', 'mcp_allowlist: {a: 1}',
    'mcp_allowlist:', 'mcp_allowlist: [a: 1]']) {
    assert.throws(() => parseMcpAllowlist(`x\n    ${bad}\n`), /mcp_allowlist/, bad);
    assert.deepEqual(byId(`agents:\n  - id: bad\n    ${bad}\n`).bad.mcpAllowlist, [], bad);
  }
});

test('a main entry carries its allowlist', () => {
  const a = byId('agents:\n  - id: main\n    name: Main\n    mcp_allowlist: [github]\n');
  assert.deepEqual(a.main.mcpAllowlist, ['github']);
});

test('the shipped agent.yaml: main/ops/research get github, comms/content get none', () => {
  const a = byId(readFileSync(resolve('agent.yaml'), 'utf8'));
  for (const id of ['main', 'ops', 'research']) assert.deepEqual(a[id].mcpAllowlist, ['github'], id);
  for (const id of ['comms', 'content']) assert.deepEqual(a[id].mcpAllowlist, [], id);
});
