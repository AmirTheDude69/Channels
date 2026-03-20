import { describe, expect, it } from 'vitest';
import {
  assistantTextFromTranscriptTurn,
  chunkTelegramMessage,
  classifyThreadProject,
  commandApprovalIsSafe,
  controlRequestSchema,
  createProjectId,
  effectiveThreadRuntime,
  permissionsAreSafe,
  projectRecordSchema,
  transcriptTurnsFromThread,
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

  it('extracts transcript turns from Codex thread items', () => {
    const turns = transcriptTurnsFromThread([
      {
        id: 'turn_1',
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'First question' }] },
          { type: 'agentMessage', text: 'First answer' },
        ],
      },
    ]);

    expect(turns).toEqual([
      {
        turnId: 'turn_1',
        entries: [
          { role: 'user', text: 'First question' },
          { role: 'assistant', text: 'First answer' },
        ],
      },
    ]);
    expect(assistantTextFromTranscriptTurn(turns[0])).toBe('First answer');
  });

  it('prefers configured reasoning defaults over model defaults', () => {
    expect(
      effectiveThreadRuntime(
        {
          models: [
            {
              id: 'gpt-5.3-codex',
              displayName: 'gpt-5.3-codex',
              supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text', 'image'],
            },
          ],
          collaborationModes: ['default', 'plan'],
          defaults: {
            model: 'gpt-5.3-codex',
            reasoningEffort: 'xhigh',
            planModeReasoningEffort: null,
            speed: 'normal',
          },
        },
        null,
      ),
    ).toMatchObject({
      model: 'gpt-5.3-codex',
      reasoningEffort: 'xhigh',
    });
  });

  it('allows zero readThread limit to request full transcript history', () => {
    expect(
      controlRequestSchema.parse({
        type: 'control.readThread',
        requestId: 'req_1',
        threadId: 'thread_1',
        limitTurns: 0,
      }),
    ).toMatchObject({
      type: 'control.readThread',
      limitTurns: 0,
    });
  });
});
