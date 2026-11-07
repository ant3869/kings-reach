// tests/mcp-allowlist-run.test.mjs
// loadMcpServers contract + the run boundary: the SDK is faked and PROJECT_ROOT/HOME point at temp dirs. Nothing here touches store/.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dist = (f) => pathToFileURL(resolve('dist', f)).href;
const root = mkdtempSync(join(tmpdir(), 'kr-mcp-root-'));
const home = mkdtempSync(join(tmpdir(), 'kr-mcp-home-'));
const settings = (dir, mcpServers) => { mkdirSync(join(dir, '.claude'), { recursive: true }); writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ mcpServers })); };
settings(home, { github: { command: 'user-gh' }, userOnly: { command: 'u' }, shared: { command: 'user-shared' } });
settings(root, { shared: { command: 'project-shared' }, projOnly: { command: 'p' } });
process.env.HOME = home;
process.env.USERPROFILE = home;

const state = { queryCalls: [], logs: [], agents: {} };
const realConfig = await import(`${dist('config.js')}?real`);
mock.module(dist('config.js'), { namedExports: { ...realConfig, PROJECT_ROOT: root } });
mock.module(dist('agent-config.js'), { namedExports: { getAgentConfig: (id) => state.agents[id] } });
mock.module(dist('logger.js'), {
  namedExports: { logger: { info: (...a) => state.logs.push(['info', ...a]), warn: (...a) => state.logs.push(['warn', ...a]), error() {}, debug() {} } },
});
mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: (args) => {
      state.queryCalls.push(args);
      return (async function* () { yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: {} }; })();
    },
  },
});
mock.module(dist('claude-auth.js'), { namedExports: { claudeAuth: async () => ({ loggedIn: true, detail: '' }), CLAUDE_LOGGED_OUT: 'out' } });
mock.module(dist('provider-config.js'), {
  namedExports: { routesFor: () => [{ provider: 'claude', model: 'c1' }], loadTierConfig: () => null, providerHasTools: () => true, recordProviderOutcome: () => {} },
});
mock.module(dist('provider-runner.js'), { namedExports: { runExternalProvider: async () => { throw new Error('unexpected external run'); } } });
mock.module(dist('skills.js'), { namedExports: { skillContext: async () => '', agentEnv: () => ({}), claudeSkillOptions: () => ({}) } });
mock.module(dist('db.js'), { namedExports: { logTokenUsage: () => {} } });

const agent = await import(dist('agent.js'));
const names = (o) => Object.keys(o).sort();

test('loadMcpServers: undefined keeps every server, project wins over user on a name clash', () => {
  const all = agent.loadMcpServers(undefined);
  assert.deepEqual(names(all), ['github', 'projOnly', 'shared', 'userOnly']);
  assert.deepEqual(all.shared, { command: 'project-shared' });
});

test('loadMcpServers: [] is none, a nonempty list is exact', () => {
  assert.deepEqual(agent.loadMcpServers([]), {});
  assert.deepEqual(names(agent.loadMcpServers(['github'])), ['github']);
  const two = agent.loadMcpServers(['shared', 'userOnly']);
  assert.deepEqual(names(two), ['shared', 'userOnly']);
  assert.deepEqual(two.shared, { command: 'project-shared' });
});

test('loadMcpServers: an unconfigured name is rejected (dropped and logged), never invented', () => {
  state.logs.length = 0;
  assert.deepEqual(agent.loadMcpServers(['nope']), {});
  assert.deepEqual(names(agent.loadMcpServers(['github', 'nope', '__proto__', 'toString'])), ['github']);
  const warn = state.logs.find(([lvl, ctx]) => lvl === 'warn' && ctx.unknown?.includes('nope'));
  assert.ok(warn, 'unknown name is logged');
});

const lastOptions = () => state.queryCalls[state.queryCalls.length - 1].options;
const runLog = () => state.logs.find(([, , msg]) => msg === 'mcp servers for run')[1];

test('a normal role run gets its configured selection; light wins over it and is logged', async () => {
  state.agents.research = { id: 'research', cwd: root, claudeMdPath: join(root, 'none.md'), mcpAllowlist: ['github'] };
  state.queryCalls.length = 0;
  state.logs.length = 0;
  await agent.runAgent({ agentId: 'research', message: 'q' });
  assert.deepEqual(names(lastOptions().mcpServers), ['github']);
  assert.equal(lastOptions().strictMcpConfig, true);
  assert.deepEqual(runLog(), { agentId: 'research', light: false, mcp: ['github'] });

  state.logs.length = 0;
  await agent.runAgent({ agentId: 'research', message: 'q', light: true });
  assert.deepEqual(lastOptions().mcpServers, {});
  assert.equal(lastOptions().strictMcpConfig, true);
  assert.deepEqual(runLog(), { agentId: 'research', light: true, mcp: [] });
});

test('light also overrides an agent with no allowlist; a legacy agent otherwise sees every server', async () => {
  state.agents.legacy = { id: 'legacy', cwd: root, claudeMdPath: join(root, 'none.md') };
  await agent.runAgent({ agentId: 'legacy', message: 'q' });
  assert.deepEqual(names(lastOptions().mcpServers), ['github', 'projOnly', 'shared', 'userOnly']);
  assert.equal('strictMcpConfig' in lastOptions(), false);
  await agent.runAgent({ agentId: 'legacy', message: 'q', light: true });
  assert.deepEqual(lastOptions().mcpServers, {});
});
