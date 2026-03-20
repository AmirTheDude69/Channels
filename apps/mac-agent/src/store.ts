import { z } from 'zod';
import { configPath, projectsPath } from './config.js';
import { readJsonFile, writeJsonFile } from './fs.js';
import { projectRecordSchema, type ProjectRecord } from '@channels/shared';
import { codexUiRefreshStrategySchema } from './ui-refresh.js';

const configSchema = z.object({
  agentId: z.string().optional(),
  token: z.string().optional(),
  serverUrl: z.string().optional(),
  pairedAt: z.string().optional(),
  codexUiRefreshEnabled: z.boolean().optional(),
  codexUiRefreshStrategy: codexUiRefreshStrategySchema.optional(),
  codexUiRefreshOpenWhenClosed: z.boolean().optional(),
});

export type AgentConfig = z.infer<typeof configSchema>;

export async function loadConfig(): Promise<AgentConfig> {
  return configSchema.parse(await readJsonFile(configPath, {}));
}

export async function saveConfig(config: AgentConfig): Promise<void> {
  await writeJsonFile(configPath, config);
}

export async function loadProjects(): Promise<ProjectRecord[]> {
  const raw = await readJsonFile(projectsPath, []);
  return z.array(projectRecordSchema).parse(raw);
}

export async function saveProjects(projects: ProjectRecord[]): Promise<void> {
  await writeJsonFile(projectsPath, projects);
}
