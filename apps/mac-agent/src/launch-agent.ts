import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchAgentPath } from './config.js';

const execFileAsync = promisify(execFile);

export async function installLaunchAgent(args: { nodePath: string; cliPath: string; serverUrl: string }): Promise<void> {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.channels.mac-agent</string>
    <key>ProgramArguments</key>
    <array>
      <string>${args.nodePath}</string>
      <string>${args.cliPath}</string>
      <string>run</string>
      <string>--server-url</string>
      <string>${args.serverUrl}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(path.dirname(launchAgentPath), 'channels-agent.out.log')}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(path.dirname(launchAgentPath), 'channels-agent.err.log')}</string>
  </dict>
</plist>
`;
  await writeFile(launchAgentPath, plist, 'utf8');
  await execFileAsync('launchctl', ['unload', launchAgentPath]).catch(() => undefined);
  await execFileAsync('launchctl', ['load', launchAgentPath]);
}
