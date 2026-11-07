// tests/mcp-allowlist-roles.test.mjs
// Runtime resolution: getAgentConfig() takes each role's allowlist from the shipped agent.yaml only.
// A temp project root holds a copy of agent.yaml plus per-role config.yml files that say the opposite. Nothing touches store/.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (f) => pathToFileURL(resolve('dist', f)).href;
const root = mkdtempSync(join(tmpdir(), 'kr-roles-root-'));
writeFileSync(join(root, 'agent.yaml'), readFileSync(resolve('agent.yaml'), 'utf8'));
const contradicting = { main: '[]', comms: '[github]', content: '[github]', ops: '[]', research: '[]' };
for (const [id, list] of Object.entries(contradicting)) {
  const dir = id === 'main' ? root : join(root, 'agents', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), `id: "${id}"\nmcp_allowlist: ${list}\n`);
}

const realConfig = await import(`${dist('config.js')}?real`);
mock.module(dist('config.js'), { namedExports: { ...realConfig, PROJECT_ROOT: root, KINGS_REACH_CONFIG: '' } });
const { getAgentConfig } = await import(dist('agent-config.js'));

test('each role resolves its allowlist from agent.yaml, ignoring per-role config.yml', () => {
  for (const id of ['main', 'ops', 'research']) assert.deepEqual(getAgentConfig(id)?.mcpAllowlist, ['github'], id);
  for (const id of ['comms', 'content']) assert.deepEqual(getAgentConfig(id)?.mcpAllowlist, [], id);
});
