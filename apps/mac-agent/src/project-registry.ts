import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createProjectId, type ProjectRecord } from '@channels/shared';
import { saveProjects } from './store.js';

async function looksLikeProject(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath);
  return entries.includes('.git') || entries.includes('package.json') || entries.includes('pnpm-workspace.yaml');
}

export async function scanProjects(root: string): Promise<Array<{ name: string; absolutePath: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const projects: Array<{ name: string; absolutePath: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const absolutePath = path.join(root, entry.name);
    if (await looksLikeProject(absolutePath)) {
      projects.push({ name: entry.name, absolutePath });
    }
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

export async function importProjects(root: string): Promise<ProjectRecord[]> {
  const candidates = await scanProjects(root);
  if (candidates.length === 0) {
    throw new Error(`No project candidates found in ${root}`);
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  stdout.write('Detected project folders:\n');
  candidates.forEach((candidate, index) => {
    stdout.write(`${index + 1}. ${candidate.name} - ${candidate.absolutePath}\n`);
  });
  const answer = await rl.question('Import which numbers? (comma-separated or all): ');
  rl.close();

  const selectedIndexes = answer.trim().toLowerCase() === 'all'
    ? new Set(candidates.map((_, index) => index))
    : new Set(
        answer
          .split(',')
          .map((token) => Number(token.trim()) - 1)
          .filter((value) => Number.isInteger(value) && value >= 0 && value < candidates.length),
      );

  const projects = candidates
    .filter((_, index) => selectedIndexes.has(index))
    .map<ProjectRecord>((candidate) => ({
      projectId: createProjectId(candidate.name, candidate.absolutePath),
      name: candidate.name,
      absolutePath: candidate.absolutePath,
      sandboxProfile: 'workspace-write',
      networkEnabled: false,
    }));

  await saveProjects(projects);
  return projects;
}
