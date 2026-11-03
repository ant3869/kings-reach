// src/agent-create-cli.ts - CLI wrapper for the agent creation wizard.
// Run as: node dist/agent-create-cli.js create <id> <name> <description> [telegramToken] [model]

import { createAgent, readAgentYaml, agentCount } from './agent-create.js';

function usage(): never {
  console.log('Usage:');
  console.log('  agent-create-cli create <id> <name> <description> [telegramToken] [model]');
  console.log('  agent-create-cli list');
  process.exit(1);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === 'create') {
    const [id, name, description, telegramToken, model] = rest;
    if (!id || !name || !description) usage();
    await createAgent(id, name, description, telegramToken, model);
    console.log(`Agent "${id}" created (agents/${id}/). Total: ${agentCount()}`);
  } else if (cmd === 'list') {
    console.log('main (built-in coordinator)');
    for (const e of readAgentYaml()) console.log(`${e.id} - ${e.name} (${e.model ?? 'default model'})`);
  } else {
    usage();
  }
}

main().catch((err) => {
  console.error(`agent-create failed: ${String(err)}`);
  process.exit(1);
});
