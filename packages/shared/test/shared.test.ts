import { describe, expect, it } from 'vitest';
import {
  chunkTelegramMessage,
  classifyThreadProject,
  commandApprovalIsSafe,
  createProjectId,
  permissionsAreSafe,
  projectRecordSchema,
} from '../src/index.js';

describe('shared helpers', () => {
  const project = projectRecordSchema.parse({
    projectId: createProjectId('Channels', '/Users/amir/Downloads/Channels'),
    name: 'Channels',
    absolutePath: '/Users/amir/Downloads/Channels',
    sandboxProfile: 'workspace-write',
    networkEnabled: false,
  });

  it('chunks telegram messages conservatively', () => {
    const chunks = chunkTelegramMessage('a'.repeat(9000), 3000);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.length <= 3000)).toBe(true);
  });

  it('classifies threads nested inside project roots', () => {
    expect(classifyThreadProject('/Users/amir/Downloads/Channels/src', [project])).toEqual({
      projectId: project.projectId,
      legacy: false,
    });
  });

  it('flags broad parent threads as legacy', () => {
    expect(classifyThreadProject('/Users/amir/Downloads', [project])).toEqual({
      projectId: null,
      legacy: true,
    });
  });

  it('accepts safe approvals inside project roots', () => {
    expect(
      commandApprovalIsSafe({
        cwd: '/Users/amir/Downloads/Channels',
        project,
        networkRequested: false,
        fileReadRoots: ['/Users/amir/Downloads/Channels/src'],
      }),
    ).toBe(true);
  });

  it('rejects permissions outside project roots', () => {
    expect(
      permissionsAreSafe(project, {
        read: ['/Users/amir'],
        write: ['/tmp'],
        networkEnabled: false,
      }),
    ).toBe(false);
  });
});
