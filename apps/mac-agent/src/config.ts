import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  CHANNELS_SERVER_URL: z.string().url().optional(),
  CHANNELS_CODEX_APP_SERVER_URL: z.string().default('ws://127.0.0.1:8765'),
  CHANNELS_CODEX_APP_SERVER_PORT: z.coerce.number().int().positive().default(8765),
});

export const env = envSchema.parse(process.env);
export const channelsHome = path.join(os.homedir(), '.channels');
export const configPath = path.join(channelsHome, 'config.json');
export const projectsPath = path.join(channelsHome, 'projects.json');
export const launchAgentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.channels.mac-agent.plist');
