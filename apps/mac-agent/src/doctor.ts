import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, loadProjects } from './store.js';
import { launchAgentPath } from './config.js';
import { pathExists } from './fs.js';
import { resolveCodexUiRefreshSettings } from './ui-refresh.js';

const execFileAsync = promisify(execFile);

export async function runDoctor(): Promise<void> {
  const config = await loadConfig();
  const projects = await loadProjects();
  const uiRefresh = resolveCodexUiRefreshSettings(config);
  const checks = [
    ['Config token', Boolean(config.token)],
    ['Config server URL', Boolean(config.serverUrl)],
    ['Imported projects', projects.length > 0],
    ['LaunchAgent plist', await pathExists(launchAgentPath)],
    ['Codex UI refresh helper', uiRefresh.enabled],
  ] as const;

  for (const [name, passed] of checks) {
    console.log(`${passed ? 'OK' : 'WARN'} ${name}`);
  }

  try {
    const { stdout } = await execFileAsync('codex', ['--version']);
    console.log(`OK Codex CLI: ${stdout.trim()}`);
  } catch {
    console.log('WARN Codex CLI not available in PATH');
  }

  if (uiRefresh.enabled) {
    console.log(`OK Codex UI refresh strategy: ${uiRefresh.strategy}${uiRefresh.openWhenClosed ? ' (launch if closed)' : ' (skip if app is closed)'}`);
  }
}
