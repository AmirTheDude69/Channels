import type { CachedThread, TranscriptTurn } from '@channels/shared';

export function rootKeyboard(): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
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

export function threadKeyboard(thread: CachedThread): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
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
        { text: 'Switch', callback_data: `thread:switch:${thread.threadId}` },
      ],
    ],
  };
}

export function activeRunKeyboard(runId: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
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
  const lines = ['Channels is ready.'];
  lines.push(`Control plane: ${args.hasTelegram ? 'online' : 'degraded until Telegram vars are set'}`);
  lines.push(`Mac companion: ${args.connectedAgent ? 'connected' : 'offline'}`);
  lines.push(`Active project: ${args.activeProjectName ?? 'none selected'}`);
  lines.push(`Active thread: ${args.activeThreadTitle ?? 'none selected'}`);
  lines.push('');
  lines.push('Send a normal message to continue the active Codex thread.');
  return lines.join('\n');
}

export function formatProjectsList(projects: Array<{ projectId: string; name: string; sandboxProfile: string; networkEnabled: boolean }>, activeProjectId?: string | null) {
  const lines = ['Projects'];
  for (const project of projects) {
    const marker = project.projectId === activeProjectId ? '◀' : ' '; 
    lines.push(`${marker} ${project.name} (${project.sandboxProfile}${project.networkEnabled ? ', net' : ''})`);
  }
  return lines.join('\n');
}

export function projectsKeyboard(projects: Array<{ projectId: string; name: string }>): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: projects.map((project) => [{ text: project.name, callback_data: `project:select:${project.projectId}` }]),
  };
}

export function formatThreadList(threads: CachedThread[], activeThreadId?: string | null): string {
  if (threads.length === 0) {
    return 'No synced threads yet for this project.';
  }
  const lines = ['Recent Threads'];
  for (const thread of threads) {
    const marker = thread.threadId === activeThreadId ? '◀' : ' '; 
    const legacy = thread.legacy ? ' [Legacy]' : '';
    lines.push(`${marker} ${thread.title}${legacy}`);
  }
  return lines.join('\n');
}

export function formatThreadHistory(title: string, turns: TranscriptTurn[]): string {
  if (turns.length === 0) {
    return `No saved history yet for ${title}.`;
  }

  const lines = [`Recent history for ${title}`];
  for (const turn of turns) {
    lines.push('');
    for (const entry of turn.entries) {
      lines.push(entry.role === 'user' ? 'User:' : 'Codex:');
      lines.push(entry.text);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

export function threadsKeyboard(threads: CachedThread[]): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: threads.map((thread) => [{ text: thread.legacy ? `${thread.title} [Legacy]` : thread.title, callback_data: `thread:switch:${thread.threadId}` }]),
  };
}
