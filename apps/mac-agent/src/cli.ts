#!/usr/bin/env node
import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import { env } from './config.js';
import { ChannelsAgent } from './agent.js';
import { installLaunchAgent } from './launch-agent.js';
import { importProjects } from './project-registry.js';
import { runDoctor } from './doctor.js';
import { loadConfig, saveConfig } from './store.js';
import { ControlPlaneClient } from './control-plane-client.js';

const program = new Command();
program.name('channels-agent').description('Channels macOS companion');

program
  .command('pair')
  .requiredOption('--server-url <url>')
  .requiredOption('--pair-code <code>')
  .action(async (options) => {
    const client = new ControlPlaneClient(options.serverUrl);
    let paired = false;
    client.onMessage(async (message) => {
      if (message.type === 'control.syncNow') return;
      if ((message as { type: string }).type === 'agent.paired') {
        const typed = message as unknown as { type: 'agent.paired'; agentId: string; token: string };
        await saveConfig({ agentId: typed.agentId, token: typed.token, serverUrl: options.serverUrl, pairedAt: new Date().toISOString() });
        paired = true;
        console.log(`Paired successfully. Agent ID: ${typed.agentId}`);
        client.close();
      }
    });
    await client.connect({ pairCode: options.pairCode });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    if (!paired) {
      throw new Error('Pairing did not complete. Make sure the pair code is still valid.');
    }
  });

program
  .command('install')
  .requiredOption('--server-url <url>')
  .action(async (options) => {
    const cliPath = fileURLToPath(import.meta.url);
    await installLaunchAgent({ nodePath: process.execPath, cliPath, serverUrl: options.serverUrl });
    const config = await loadConfig();
    await saveConfig({ ...config, serverUrl: options.serverUrl });
    console.log('LaunchAgent installed and loaded.');
  });

program
  .command('import-projects')
  .requiredOption('--root <path>')
  .action(async (options) => {
    const projects = await importProjects(path.resolve(options.root));
    console.log(`Imported ${projects.length} project(s).`);
  });

program
  .command('doctor')
  .action(async () => {
    await runDoctor();
  });

program
  .command('run')
  .option('--server-url <url>')
  .action(async (options) => {
    const config = await loadConfig();
    const serverUrl = options.serverUrl ?? config.serverUrl ?? env.CHANNELS_SERVER_URL;
    if (!serverUrl) {
      throw new Error('Missing server URL. Pair first or pass --server-url.');
    }
    if (!config.token) {
      throw new Error('Missing agent token. Run channels-agent pair first.');
    }
    const agent = new ChannelsAgent(serverUrl);
    await agent.connect({ token: config.token, agentId: config.agentId ?? '' });
    console.log('Channels agent connected. Press Ctrl+C to stop.');
    await new Promise(() => undefined);
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
