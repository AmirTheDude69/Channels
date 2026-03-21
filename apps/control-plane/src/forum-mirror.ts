import type { TranscriptEntry, TranscriptTurn, TurnAttachment } from '@channels/shared';
import { chunkTelegramHtml, markdownToTelegramBlocks, plainTextToTelegramHtml } from './telegram-format.js';

const TOPIC_NAME_LIMIT = 120;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, limit: number): string {
  const normalized = collapseWhitespace(text);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(1, limit - 1)).trimEnd()}…`;
}

export function buildForumTopicTitle(projectName: string | null | undefined, threadTitle: string): string {
  const project = collapseWhitespace(projectName ?? '');
  const title = collapseWhitespace(threadTitle);
  const combined = project ? `${project} · ${title}` : title;
  return truncate(combined || 'Untitled thread', TOPIC_NAME_LIMIT);
}

export function formatForumTopicIntro(args: { threadTitle: string; projectName?: string | null; legacy?: boolean }): string {
  const blocks = [
    '<b>Channels Thread Mirror</b>',
    `<b>Thread</b>\n${plainTextToTelegramHtml(args.threadTitle)}`,
  ];

  if (args.projectName) {
    blocks.push(`<b>Project</b>\n${plainTextToTelegramHtml(args.projectName)}`);
  }

  if (args.legacy) {
    blocks.push('<i>This thread was imported as a legacy thread.</i>');
  }

  blocks.push('<i>Send a quick message in this topic to continue the linked Codex thread.</i>');
  return blocks.join('\n\n');
}

export function formatForumTranscriptEntry(entry: TranscriptEntry): string[] {
  if (entry.role === 'user') {
    return chunkTelegramHtml([
      '<b>You</b>',
      `<blockquote>${plainTextToTelegramHtml(entry.text)}</blockquote>`,
    ]);
  }

  return chunkTelegramHtml([
    '<b>Codex</b>',
    ...markdownToTelegramBlocks(entry.text),
  ]);
}

export function selectForumTurnsToImport(turns: TranscriptTurn[], lastMirroredTurnId: string | null): TranscriptTurn[] {
  if (turns.length === 0) return [];
  if (!lastMirroredTurnId) return turns;

  const lastMirroredIndex = turns.findIndex((turn) => turn.turnId === lastMirroredTurnId);
  if (lastMirroredIndex >= 0) {
    return turns.slice(lastMirroredIndex + 1);
  }

  const latestTurn = turns.at(-1);
  if (!latestTurn || latestTurn.turnId === lastMirroredTurnId) {
    return [];
  }

  return [latestTurn];
}

export function formatForumPromptMirror(args: {
  prompt: string;
  transcribedText?: string | null;
  attachmentNames?: string[];
  originLabel?: string | null;
}): string[] {
  const blocks = ['<b>You</b>'];

  if (args.originLabel) {
    blocks[0] += ` <i>(${plainTextToTelegramHtml(args.originLabel)})</i>`;
  }

  if (args.transcribedText) {
    blocks.push('<b>Voice note</b>');
    blocks.push(`<blockquote>${plainTextToTelegramHtml(args.transcribedText)}</blockquote>`);
  } else {
    blocks.push(`<blockquote>${plainTextToTelegramHtml(args.prompt)}</blockquote>`);
  }

  if ((args.attachmentNames ?? []).length > 0) {
    blocks.push(`<b>Attachments</b>\n${args.attachmentNames!.map((name) => `• ${plainTextToTelegramHtml(name)}`).join('\n')}`);
  }

  return chunkTelegramHtml(blocks);
}

export function preferredMirrorCaption(args: {
  prompt: string;
  transcribedText?: string | null;
  originLabel?: string | null;
  attachments?: TurnAttachment[];
}): string | null {
  const label = args.originLabel ? ` (${args.originLabel})` : '';
  const text = collapseWhitespace(args.transcribedText ?? args.prompt);
  const attachmentNote = (args.attachments ?? []).length > 1 ? `\nAttachments: ${(args.attachments ?? []).length}` : '';
  const caption = truncate(`<b>You</b>${label}\n${plainTextToTelegramHtml(text)}`.replace(/<[^>]+>/g, ''), 900);
  return caption ? `${plainTextToTelegramHtml(caption)}${attachmentNote ? `\n${plainTextToTelegramHtml(attachmentNote.trim())}` : ''}` : null;
}
