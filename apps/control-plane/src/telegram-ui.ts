import type { CachedThread, RuntimeCatalog, RuntimeModel, ThreadRuntimePreferenceInput, TranscriptTurn } from '@channels/shared';
import { effectiveThreadRuntime } from '@channels/shared';
import { chunkTelegramHtml, markdownToTelegramBlocks, plainTextToTelegramHtml } from './telegram-format.js';

type InlineKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

export function rootKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Projects', callback_data: 'ui:projects' },
        { text: 'Recent Threads', callback_data: 'ui:threads' },
      ],
      [
        { text: 'New Thread', callback_data: 'ui:new-thread' },
        { text: 'Refresh', callback_data: 'ui:refresh' },
      ],
      [{ text: 'Pair Mac Agent', callback_data: 'ui:pair' }],
    ],
  };
}

export function threadKeyboard(thread: CachedThread): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: 'Resume', callback_data: `thread:resume:${thread.threadId}` },
        { text: 'Fork', callback_data: `thread:fork:${thread.threadId}` },
      ],
      [
        { text: 'Rename', callback_data: `thread:rename:${thread.threadId}` },
        { text: 'Archive', callback_data: `thread:archive:${thread.threadId}` },
      ],
      [
        { text: 'History', callback_data: `thread:history:${thread.threadId}` },
        { text: 'Settings', callback_data: `thread:settings:${thread.threadId}` },
      ],
      [{ text: 'Switch', callback_data: `thread:switch:${thread.threadId}` }],
    ],
  };
}

export function settingsKeyboard(settings: ThreadRuntimePreferenceInput): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: settings.planMode ? 'Plan: On' : 'Plan: Off', callback_data: 'settings:toggle-plan' },
        { text: settings.speed === '2x' ? 'Speed: 2x' : 'Speed: Normal', callback_data: 'settings:toggle-speed' },
      ],
      [
        { text: 'Choose Model', callback_data: 'settings:model-menu' },
        { text: 'Reasoning', callback_data: 'settings:reasoning-menu' },
      ],
      [{ text: 'Back to Thread', callback_data: 'settings:back' }],
    ],
  };
}

export function modelSettingsKeyboard(models: RuntimeModel[], selectedModel: string | null): InlineKeyboard {
  return {
    inline_keyboard: [
      ...models.map((model) => [
        {
          text: model.id === selectedModel ? `• ${model.displayName}` : model.displayName,
          callback_data: `settings:model:${model.id}`,
        },
      ]),
      [{ text: 'Back', callback_data: 'settings:open' }],
    ],
  };
}

export function reasoningSettingsKeyboard(reasoningEfforts: string[], selectedReasoning: string | null): InlineKeyboard {
  return {
    inline_keyboard: [
      ...reasoningEfforts.map((reasoningEffort) => [
        {
          text: reasoningEffort === selectedReasoning ? `• ${reasoningLabel(reasoningEffort)}` : reasoningLabel(reasoningEffort),
          callback_data: `settings:reasoning:${reasoningEffort}`,
        },
      ]),
      [{ text: 'Back', callback_data: 'settings:open' }],
    ],
  };
}

export function activeRunKeyboard(runId: string): InlineKeyboard {
  return {
    inline_keyboard: [[{ text: 'Stop', callback_data: `turn:stop:${runId}` }]],
  };
}

export function formatStartMessage(args: {
  hasTelegram: boolean;
  connectedAgent: boolean;
  activeProjectName?: string | null;
  activeThreadTitle?: string | null;
}): string {
  return [
    '<b>Channels</b>',
    '',
    `Control plane: <b>${args.hasTelegram ? 'Online' : 'Needs Telegram env vars'}</b>`,
    `Mac companion: <b>${args.connectedAgent ? 'Connected' : 'Offline'}</b>`,
    `Active project: <b>${plainTextToTelegramHtml(args.activeProjectName ?? 'None selected')}</b>`,
    `Active thread: <b>${plainTextToTelegramHtml(args.activeThreadTitle ?? 'None selected')}</b>`,
    '',
    'Send a normal message to continue the active Codex thread.',
  ].join('\n');
}

export function formatProjectsList(projects: Array<{ projectId: string; name: string; sandboxProfile: string; networkEnabled: boolean }>, activeProjectId?: string | null): string {
  if (projects.length === 0) {
    return '<b>Projects</b>\n\nNo synced projects yet.';
  }

  const lines = ['<b>Projects</b>'];
  for (const project of projects) {
    const marker = project.projectId === activeProjectId ? '•' : '○';
    lines.push(
      `${marker} <b>${plainTextToTelegramHtml(project.name)}</b>`,
      `&nbsp;&nbsp;&nbsp;<i>${plainTextToTelegramHtml(project.sandboxProfile)}${project.networkEnabled ? ' + network' : ''}</i>`,
    );
  }
  return lines.join('\n');
}

export function projectsKeyboard(projects: Array<{ projectId: string; name: string }>): InlineKeyboard {
  return {
    inline_keyboard: projects.map((project) => [{ text: project.name, callback_data: `project:select:${project.projectId}` }]),
  };
}

export function formatThreadList(threads: CachedThread[], activeThreadId?: string | null): string {
  if (threads.length === 0) {
    return '<b>Recent Threads</b>\n\nNo synced threads yet for this project.';
  }

  const lines = ['<b>Recent Threads</b>'];
  for (const thread of threads) {
    const marker = thread.threadId === activeThreadId ? '•' : '○';
    const legacy = thread.legacy ? ' <i>[Legacy]</i>' : '';
    lines.push(`${marker} <b>${plainTextToTelegramHtml(thread.title)}</b>${legacy}`);
  }
  return lines.join('\n');
}

export function formatThreadHeader(title: string, runtimeCatalog: RuntimeCatalog, preference?: Partial<ThreadRuntimePreferenceInput> | null): string {
  const runtime = effectiveThreadRuntime(runtimeCatalog, preference);
  return [
    `<b>Active Thread</b>`,
    plainTextToTelegramHtml(title),
    '',
    '<b>Current Settings</b>',
    `• Plan mode: <b>${runtime.planMode ? 'On' : 'Off'}</b>`,
    `• Speed: <b>${runtime.speed}</b>`,
    `• Model: <b>${plainTextToTelegramHtml(modelLabel(runtimeCatalog, runtime.model))}</b>`,
    `• Reasoning: <b>${plainTextToTelegramHtml(reasoningLabel(runtime.reasoningEffort))}</b>`,
  ].join('\n');
}

export function formatThreadSettings(title: string, runtimeCatalog: RuntimeCatalog, preference?: Partial<ThreadRuntimePreferenceInput> | null): string {
  const runtime = effectiveThreadRuntime(runtimeCatalog, preference);
  return [
    '<b>Thread Settings</b>',
    plainTextToTelegramHtml(title),
    '',
    `Plan mode: <b>${runtime.planMode ? 'On' : 'Off'}</b>`,
    `Speed: <b>${runtime.speed}</b>`,
    `Model: <b>${plainTextToTelegramHtml(modelLabel(runtimeCatalog, runtime.model))}</b>`,
    `Reasoning effort: <b>${plainTextToTelegramHtml(reasoningLabel(runtime.reasoningEffort))}</b>`,
    '',
    '<i>Use the buttons below to change the active thread runtime.</i>',
  ].join('\n');
}

export function formatReasoningSettings(title: string, runtimeCatalog: RuntimeCatalog, preference?: Partial<ThreadRuntimePreferenceInput> | null): string {
  const runtime = effectiveThreadRuntime(runtimeCatalog, preference);
  const model = runtimeCatalog.models.find((entry) => entry.id === runtime.model) ?? null;
  const efforts = (model?.supportedReasoningEfforts ?? []).map((effort) => `• ${reasoningLabel(effort)}`).join('\n') || '• Medium';

  return [
    '<b>Select Reasoning Effort</b>',
    plainTextToTelegramHtml(title),
    '',
    `Current model: <b>${plainTextToTelegramHtml(modelLabel(runtimeCatalog, runtime.model))}</b>`,
    `Current reasoning: <b>${plainTextToTelegramHtml(reasoningLabel(runtime.reasoningEffort))}</b>`,
    '',
    efforts,
  ].join('\n');
}

export function formatModelSettings(title: string, runtimeCatalog: RuntimeCatalog, preference?: Partial<ThreadRuntimePreferenceInput> | null): string {
  const runtime = effectiveThreadRuntime(runtimeCatalog, preference);
  return [
    '<b>Select Model</b>',
    plainTextToTelegramHtml(title),
    '',
    `Current model: <b>${plainTextToTelegramHtml(modelLabel(runtimeCatalog, runtime.model))}</b>`,
    '',
    '<i>Choose the model to use for the next Telegram turns on this thread.</i>',
  ].join('\n');
}

export function formatThreadHistory(title: string, turns: TranscriptTurn[]): string[] {
  if (turns.length === 0) {
    return ['<b>Recent History</b>\n\nNo saved history yet for this thread.'];
  }

  const blocks: string[] = [`<b>Recent History</b>`, `<i>${plainTextToTelegramHtml(title)}</i>`];
  for (const turn of turns) {
    blocks.push(`<b>Turn ${plainTextToTelegramHtml(turn.turnId.slice(0, 8))}</b>`);
    for (const entry of turn.entries) {
      if (entry.role === 'user') {
        blocks.push(`<b>You</b>\n<blockquote>${plainTextToTelegramHtml(entry.text)}</blockquote>`);
      } else {
        const assistantBlocks = markdownToTelegramBlocks(entry.text);
        blocks.push(`<b>Codex</b>`);
        blocks.push(...assistantBlocks);
      }
    }
  }

  return chunkTelegramHtml(blocks);
}

export function formatRunWorkingState(args: {
  threadTitle: string;
  activityLines: string[];
  transcribedText?: string | null;
  attachmentNames?: string[];
}): string {
  const blocks = [
    '<b>Codex</b>',
    `<i>Working in ${plainTextToTelegramHtml(args.threadTitle)}…</i>`,
  ];

  if (args.transcribedText) {
    blocks.push(`<blockquote>${plainTextToTelegramHtml(args.transcribedText)}</blockquote>`);
  }

  if ((args.attachmentNames ?? []).length > 0) {
    blocks.push(`<b>Attachments</b>\n${args.attachmentNames!.map((name) => `• ${plainTextToTelegramHtml(name)}`).join('\n')}`);
  }

  if (args.activityLines.length > 0) {
    blocks.push(`<b>Actions</b>\n${args.activityLines.map((line) => `• ${plainTextToTelegramHtml(line)}`).join('\n')}`);
  }

  return blocks.join('\n\n');
}

export function formatTurnCompleted(activityLines: string[], finalText: string): string[] {
  const blocks: string[] = [];
  if (activityLines.length > 0) {
    blocks.push(`<b>Actions</b>`);
    for (const line of activityLines) {
      blocks.push(`• ${plainTextToTelegramHtml(line)}`);
    }
  }
  blocks.push(...markdownToTelegramBlocks(finalText));
  return chunkTelegramHtml(blocks);
}

export function threadsKeyboard(threads: CachedThread[]): InlineKeyboard {
  return {
    inline_keyboard: threads.map((thread) => [{ text: thread.legacy ? `${thread.title} [Legacy]` : thread.title, callback_data: `thread:switch:${thread.threadId}` }]),
  };
}

function modelLabel(runtimeCatalog: RuntimeCatalog, modelId: string | null): string {
  if (!modelId) return 'Default';
  return runtimeCatalog.models.find((model) => model.id === modelId)?.displayName ?? modelId;
}

function reasoningLabel(reasoning: string | null): string {
  if (!reasoning) return 'Default';
  return reasoning === 'xhigh' ? 'Extra High' : reasoning.charAt(0).toUpperCase() + reasoning.slice(1);
}
