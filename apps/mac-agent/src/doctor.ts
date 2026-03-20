import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, loadProjects } from './store.js';
import { launchAgentPath } from './config.js';
import { pathExists } from './fs.js';

const execFileAsync = promisify(execFile);

export async function runDoctor(): Promise<void> {
  const config = await loadConfig();
  const projects = await loadProjects();
  const checks = [
    ['Config token', Boolean(config.token)],
    ['Config server URL', Boolean(config.serverUrl)],
    ['Imported projects', projects.length > 0],
    ['LaunchAgent plist', await pathExists(launchAgentPath)],
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
}
