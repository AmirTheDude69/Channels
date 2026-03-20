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
import { codexUiRefreshStrategySchema, codexUiRefreshStrategyValues, refreshCodexDesktopThread, resolveCodexUiRefreshSettings } from './ui-refresh.js';

const program = new Command();
program.name('channels-agent').description('Channels macOS companion');

program
  .command('pair')
  .requiredOption('--server-url <url>')
  .requiredOption('--pair-code <code>')
  .action(async (options) => {
    const existingConfig = await loadConfig();
    const client = new ControlPlaneClient(options.serverUrl);
    let paired = false;
    client.onMessage(async (message) => {
      if (message.type === 'control.syncNow') return;
      if ((message as { type: string }).type === 'agent.paired') {
        const typed = message as unknown as { type: 'agent.paired'; agentId: string; token: string };
        await saveConfig({ ...existingConfig, agentId: typed.agentId, token: typed.token, serverUrl: options.serverUrl, pairedAt: new Date().toISOString() });
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
  .option('--ui-refresh', 'Refresh the Codex desktop UI when Telegram turns start and complete')
  .option('--ui-refresh-strategy <strategy>', `macOS refresh strategy: ${codexUiRefreshStrategyValues.join(', ')}`)
  .option('--open-codex-when-closed', 'Launch Codex even if the desktop app is currently closed')
  .action(async (options) => {
    const cliPath = fileURLToPath(import.meta.url);
    await installLaunchAgent({ nodePath: process.execPath, cliPath, serverUrl: options.serverUrl });
    const config = await loadConfig();
    const requestedStrategy = options.uiRefreshStrategy ? codexUiRefreshStrategySchema.parse(options.uiRefreshStrategy) : undefined;
    const enableUiRefresh = Boolean(options.uiRefresh || requestedStrategy || options.openCodexWhenClosed);
    const nextConfig = {
      ...config,
      serverUrl: options.serverUrl,
      codexUiRefreshEnabled: enableUiRefresh ? true : config.codexUiRefreshEnabled,
      codexUiRefreshStrategy: requestedStrategy ?? config.codexUiRefreshStrategy,
      codexUiRefreshOpenWhenClosed: options.openCodexWhenClosed ? true : config.codexUiRefreshOpenWhenClosed,
    };
    await saveConfig(nextConfig);
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
  .command('refresh-ui')
  .requiredOption('--thread-id <id>')
  .option('--strategy <strategy>', `macOS refresh strategy: ${codexUiRefreshStrategyValues.join(', ')}`)
  .option('--open-when-closed', 'Launch Codex even if the desktop app is currently closed')
  .action(async (options) => {
    const config = await loadConfig();
    const requestedStrategy = options.strategy ? codexUiRefreshStrategySchema.parse(options.strategy) : undefined;
    const settings = resolveCodexUiRefreshSettings({
      ...config,
      codexUiRefreshEnabled: true,
      codexUiRefreshStrategy: requestedStrategy ?? config.codexUiRefreshStrategy,
      codexUiRefreshOpenWhenClosed: options.openWhenClosed ? true : config.codexUiRefreshOpenWhenClosed,
    });
    const outcome = await refreshCodexDesktopThread(options.threadId, settings);
    console.log(`UI refresh outcome: ${outcome}`);
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
    const agent = new ChannelsAgent(serverUrl, { uiRefresh: resolveCodexUiRefreshSettings(config) });
    while (true) {
      try {
        await agent.connect({ token: config.token, agentId: config.agentId ?? '' });
        console.log('Channels agent connected. Press Ctrl+C to stop.');
        await agent.waitUntilDisconnected();
        console.error('Channels agent disconnected. Reconnecting in 3 seconds...');
      } catch (error) {
        console.error(`Channels agent connection failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
