import { randomUUID } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import path from 'node:path';
import OpenAI, { toFile } from 'openai';
import { Telegraf } from 'telegraf';
import type { Context, NarrowedContext, Types } from 'telegraf';
import type { Database, ChatSession, RunRecord } from './db.js';
import type { AgentHub } from './agent-hub.js';
import { env, features } from './config.js';
import {
  type CachedThread,
  type RuntimeCatalog,
  type ThreadRuntimePreference,
  type ThreadRuntimePreferenceInput,
  type TurnAttachment,
  createPairCode,
  effectiveThreadRuntime,
  summarizeApprovalKind,
  summarizeCodexItem,
} from '@channels/shared';
import {
  activeRunKeyboard,
  formatModelSettings,
  formatProjectsList,
  formatReasoningSettings,
  formatRunWorkingState,
  formatStartMessage,
  formatThreadHeader,
  formatThreadHistory,
  formatThreadList,
  formatThreadSettings,
  formatTurnCompleted,
  modelSettingsKeyboard,
  projectsKeyboard,
  reasoningSettingsKeyboard,
  rootKeyboard,
  settingsKeyboard,
  threadKeyboard,
  threadsKeyboard,
} from './telegram-ui.js';
import { plainTextToTelegramHtml } from './telegram-format.js';

type TelegramTextContext = NarrowedContext<Context, Types.MountMap['text']>;
type TelegramVoiceContext = NarrowedContext<Context, Types.MountMap['voice']>;
type TelegramAudioContext = NarrowedContext<Context, Types.MountMap['audio']>;
type TelegramPhotoContext = NarrowedContext<Context, Types.MountMap['photo']>;
type TelegramDocumentContext = NarrowedContext<Context, Types.MountMap['document']>;

type TelegramReply = (message: string, extra?: Record<string, unknown>) => Promise<unknown>;

type ActiveRunState = {
  runId: string;
  chatId: string;
  threadId: string;
  requestId: string;
  turnId: string | null;
  telegramMessageId: number | null;
  buffer: string;
  lastEditAt: number;
  activityLines: string[];
  threadTitle: string;
  transcribedText: string | null;
  attachmentNames: string[];
};

type DownloadedTelegramFile = {
  filename: string;
  mediaType: string;
  buffer: Buffer;
};

type ActiveThreadContext = {
  session: ChatSession;
  agentId: string;
  thread: CachedThread;
  runtimeCatalog: RuntimeCatalog;
  preference: ThreadRuntimePreference | null;
  runtime: ThreadRuntimePreferenceInput;
};

const TELEGRAM_HTML_OPTIONS = {
  parse_mode: 'HTML' as const,
  link_preview_options: { is_disabled: true },
};

if (typeof globalThis.File === 'undefined') {
  globalThis.File = NodeFile as unknown as typeof globalThis.File;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown; status?: unknown; code?: unknown; type?: unknown; description?: unknown; response?: unknown };
    return {
      name: withCause.name,
      message: withCause.message,
      stack: withCause.stack ?? null,
      cause: withCause.cause instanceof Error
        ? { name: withCause.cause.name, message: withCause.cause.message, stack: withCause.cause.stack ?? null }
        : withCause.cause ?? null,
      status: withCause.status ?? null,
      code: withCause.code ?? null,
      type: withCause.type ?? null,
      description: withCause.description ?? null,
      response: withCause.response ?? null,
    };
  }

  return { value: error };
}

function summarizeContextError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return fallback;
}

export function applyThreadSelection(session: Pick<ChatSession, 'activeProjectId' | 'activeThreadId'>, thread: CachedThread | null, threadId: string): void {
  session.activeThreadId = threadId;
  session.activeProjectId = thread?.projectId ?? null;
}

export function canRunTurn(session: Pick<ChatSession, 'activeProjectId' | 'activeThreadId'>): boolean {
  return Boolean(session.activeThreadId || session.activeProjectId);
}

export class BotController {
  readonly bot: Telegraf<Context> | null;
  private readonly runs = new Map<string, ActiveRunState>();
  private readonly approvalChatByRequest = new Map<string, string>();
  private readonly openai = features.hasOpenAI ? new OpenAI({ apiKey: env.OPENAI_API_KEY! }) : null;

  constructor(private readonly db: Database, private readonly hub: AgentHub) {
    this.bot = features.hasTelegram ? new Telegraf<Context>(env.TELEGRAM_BOT_TOKEN!) : null;
    if (!this.bot) return;

    this.bot.catch(async (error, ctx) => {
      console.error('[telegram-update-error]', JSON.stringify({
        error: serializeError(error),
        updateType: ctx.updateType,
        chatId: ctx.chat?.id ?? null,
        fromId: ctx.from?.id ?? null,
        callbackData: 'callbackQuery' in ctx && 'data' in (ctx.callbackQuery ?? {}) ? (ctx.callbackQuery as { data?: string }).data ?? null : null,
        messageId: 'message' in ctx && (ctx.message as { message_id?: number } | undefined)?.message_id ? (ctx.message as { message_id?: number }).message_id : null,
      }));

      if (ctx.chat?.id && this.bot) {
        await this.sendPlain(String(ctx.chat.id), 'Something went wrong while processing that Telegram action. Please try again.');
      }
    });

    this.bot.command('start', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.ensureSession(ctx.chat.id, ctx.from.id);
      await this.renderHome(ctx.chat.id, ctx.from.id, this.replyFromContext(ctx));
    });

    this.bot.command('pair', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.issuePairCode(ctx.chat.id, ctx.from.id, this.replyFromContext(ctx));
    });

    this.bot.command('help', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.replyHtml(this.replyFromContext(ctx), 'Use <code>/start</code> to open the Channels dashboard. Send a normal message, a voice note, a photo, or a file to continue the active Codex thread.');
    });

    this.bot.on('callback_query', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      const data = 'data' in ctx.callbackQuery ? ctx.callbackQuery.data : '';
      await this.handleCallback(ctx, data);
    });

    this.bot.on('text', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      if (ctx.message.text.startsWith('/')) return;
      await this.handleText(ctx);
    });

    this.bot.on('voice', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.handleVoice(ctx);
    });

    this.bot.on('audio', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.handleAudio(ctx);
    });

    this.bot.on('photo', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.handlePhoto(ctx);
    });

    this.bot.on('document', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.handleDocument(ctx);
    });
  }

  async ensureOwner(ctx: Context): Promise<boolean> {
    if (!ctx.from) return false;
    if (!features.hasTelegram) {
      await ctx.reply('Telegram is not configured on this deployment yet. Set TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID first.');
      return false;
    }
    if (String(ctx.from.id) !== String(env.TELEGRAM_OWNER_ID)) {
      await ctx.reply('This bot is private.');
      return false;
    }
    return true;
  }

  async ensureSession(chatId: number | string, telegramUserId: number | string): Promise<ChatSession> {
    const existing = await this.db.getChatSession(String(chatId));
    if (existing) return existing;
    const session: ChatSession = {
      chatId: String(chatId),
      telegramUserId: String(telegramUserId),
      activeProjectId: null,
      activeThreadId: null,
      pendingAction: null,
      pendingPayload: null,
    };
    await this.db.upsertChatSession(session);
    return session;
  }

  async issuePairCode(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<void> {
    const code = createPairCode();
    await this.ensureSession(chatId, telegramUserId);
    await this.db.createPairCode({ code, chatId: String(chatId), ownerTelegramId: String(telegramUserId) }, env.PAIR_CODE_TTL_SECONDS);
    await this.db.log('telegram', 'pair_code_created', { chatId, code });
    await this.replyHtml(reply, `Pair code: <code>${code}</code>\n\nRun this on your Mac companion:\n<code>channels-agent pair --server-url &lt;wss-url&gt; --pair-code ${code}</code>`);
  }

  async renderHome(chatId: number | string, telegramUserId: number | string, reply: TelegramReply): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    const activeProject = agentId && session.activeProjectId ? (await this.hub.listProjects(agentId)).find((project) => project.projectId === session.activeProjectId) : null;
    const activeThread = agentId && session.activeThreadId ? await this.db.getThread(agentId, session.activeThreadId) : null;
    await this.replyHtml(
      reply,
      formatStartMessage({
        hasTelegram: features.hasTelegram,
        connectedAgent: Boolean(agentId),
        activeProjectName: activeProject?.name ?? null,
        activeThreadTitle: activeThread?.title ?? null,
      }),
      { reply_markup: rootKeyboard() },
    );
  }

  async showProjects(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<void> {
    await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline. Pair it first with <code>/pair</code>.');
      return;
    }
    const session = await this.ensureSession(chatId, telegramUserId);
    const projects = await this.hub.listProjects(agentId);
    await this.replyHtml(reply, formatProjectsList(projects, session.activeProjectId), { reply_markup: projectsKeyboard(projects) });
  }

  async showThreads(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    const threads = await this.hub.listThreads(agentId, session.activeProjectId);
    await this.replyHtml(reply, formatThreadList(threads, session.activeThreadId), { reply_markup: threadsKeyboard(threads) });
  }

  async handleCallback(ctx: NarrowedContext<Context, Types.MountMap['callback_query']>, data: string): Promise<void> {
    if (!ctx.from) return;
    const reply = this.replyFromContext(ctx);
    const editReply = this.callbackReplyFromContext(ctx);
    await this.ensureSession(ctx.chat!.id, ctx.from.id);

    if (data === 'ui:projects') {
      await this.showProjects(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data === 'ui:threads') {
      await this.showThreads(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data === 'ui:new-thread') {
      await this.createNewThread(ctx.chat!.id, ctx.from.id, editReply, { announce: true });
    } else if (data === 'ui:refresh') {
      await this.renderHome(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data === 'ui:pair') {
      await this.issuePairCode(ctx.chat!.id, ctx.from.id, reply);
    } else if (data.startsWith('project:select:')) {
      const projectId = data.split(':')[2];
      const session = await this.ensureSession(ctx.chat!.id, ctx.from.id);
      session.activeProjectId = projectId;
      session.activeThreadId = null;
      await this.db.upsertChatSession(session);
      await this.showThreads(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data.startsWith('thread:switch:')) {
      const threadId = data.split(':')[2];
      await this.setActiveThreadSession(ctx.chat!.id, ctx.from.id, threadId, editReply);
      await this.showActiveThread(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data.startsWith('thread:settings:')) {
      const threadId = data.split(':')[2];
      await this.setActiveThreadSession(ctx.chat!.id, ctx.from.id, threadId, editReply);
      await this.showThreadSettings(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data.startsWith('thread:resume:')) {
      const threadId = data.split(':')[2];
      await this.resumeThread(ctx.chat!.id, ctx.from.id, threadId, editReply);
    } else if (data.startsWith('thread:history:')) {
      const threadId = data.split(':')[2];
      await this.showThreadHistory(ctx.chat!.id, ctx.from.id, threadId, reply);
    } else if (data.startsWith('thread:fork:')) {
      const threadId = data.split(':')[2];
      await this.forkThread(ctx.chat!.id, ctx.from.id, threadId, reply);
    } else if (data.startsWith('thread:rename:')) {
      const threadId = data.split(':')[2];
      await this.db.setPendingAction(String(ctx.chat!.id), 'rename_thread', { threadId });
      await this.replyHtml(reply, 'Send the new thread name as your next message.');
    } else if (data.startsWith('thread:archive:')) {
      const threadId = data.split(':')[2];
      await this.archiveThread(ctx.chat!.id, ctx.from.id, threadId, editReply);
    } else if (data === 'settings:open') {
      await this.showThreadSettings(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data === 'settings:back') {
      await this.showActiveThread(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data === 'settings:toggle-plan') {
      await this.updateActiveThreadPreference(ctx.chat!.id, ctx.from.id, editReply, (current) => ({
        ...current,
        planMode: !current.planMode,
      }));
    } else if (data === 'settings:toggle-speed') {
      await this.updateActiveThreadPreference(ctx.chat!.id, ctx.from.id, editReply, (current) => ({
        ...current,
        speed: current.speed === '2x' ? 'normal' : '2x',
      }));
    } else if (data === 'settings:model-menu') {
      await this.showModelSettings(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data.startsWith('settings:model:')) {
      const model = data.slice('settings:model:'.length);
      await this.updateActiveThreadPreference(ctx.chat!.id, ctx.from.id, editReply, (current) => ({
        ...current,
        model,
      }));
    } else if (data === 'settings:reasoning-menu') {
      await this.showReasoningSettings(ctx.chat!.id, ctx.from.id, editReply);
    } else if (data.startsWith('settings:reasoning:')) {
      const reasoningEffort = data.slice('settings:reasoning:'.length) as ThreadRuntimePreferenceInput['reasoningEffort'];
      await this.updateActiveThreadPreference(ctx.chat!.id, ctx.from.id, editReply, (current) => ({
        ...current,
        reasoningEffort,
      }));
    } else if (data.startsWith('turn:stop:')) {
      const runId = data.split(':')[2];
      const run = Array.from(this.runs.values()).find((entry) => entry.runId === runId);
      if (!run?.turnId) {
        await this.replyHtml(reply, 'This run is no longer active.');
      } else {
        await this.stopTurn(ctx.chat!.id, ctx.from.id, run.threadId, run.turnId, reply);
      }
    } else if (data.startsWith('approval:')) {
      const [, approvalRequestId, decision] = data.split(':');
      await this.resolveApproval(approvalRequestId, decision as 'accept' | 'decline' | 'cancel', reply);
    }
    await ctx.answerCbQuery();
  }

  async handleText(ctx: TelegramTextContext): Promise<void> {
    if (!ctx.from) return;
    const reply = this.replyFromContext(ctx);
    const session = await this.ensureSession(ctx.chat.id, ctx.from.id);
    if (session.pendingAction === 'rename_thread' && session.pendingPayload?.threadId) {
      await this.renameThread(ctx.chat.id, ctx.from.id, String(session.pendingPayload.threadId), ctx.message.text, reply);
      await this.db.setPendingAction(String(ctx.chat.id), null, null);
      return;
    }

    await this.startTurn(ctx.chat.id, ctx.from.id, reply, {
      prompt: ctx.message.text,
      transcribedText: null,
      attachments: [],
      attachmentNames: [],
    });
  }

  async handleVoice(ctx: TelegramVoiceContext): Promise<void> {
    if (!ctx.from) return;
    const reply = this.replyFromContext(ctx);
    if (!this.openai) {
      await this.replyHtml(reply, 'Voice transcription is not configured yet. Set <code>OPENAI_API_KEY</code> on Railway first.');
      return;
    }
    console.info('[voice] received', JSON.stringify({
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      fileSize: ctx.message.voice.file_size ?? null,
      duration: ctx.message.voice.duration,
    }));
    try {
      const file = await this.downloadTelegramFile(ctx.message.voice.file_id, `voice-${ctx.message.voice.file_unique_id}.ogg`);
      console.info('[voice] downloaded', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        bytes: file.buffer.length,
        mediaType: file.mediaType,
        filename: file.filename,
      }));
      const transcribedText = await this.transcribeAudio(file);
      console.info('[voice] transcribed', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        transcriptLength: transcribedText.length,
      }));
      await this.startTurn(ctx.chat.id, ctx.from.id, reply, {
        prompt: transcribedText,
        transcribedText,
        attachments: [],
        attachmentNames: [],
      });
    } catch (error) {
      console.error('[voice] failed', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        error: serializeError(error),
      }));
      await this.replyHtml(
        reply,
        `<b>Voice note failed</b>\n\n${plainTextToTelegramHtml(summarizeContextError(error, 'Transcription failed before Codex could start.'))}`,
      );
    }
  }

  async handleAudio(ctx: TelegramAudioContext): Promise<void> {
    if (!ctx.from) return;
    const reply = this.replyFromContext(ctx);
    if (!this.openai) {
      await this.replyHtml(reply, 'Audio transcription is not configured yet. Set <code>OPENAI_API_KEY</code> on Railway first.');
      return;
    }
    console.info('[audio] received', JSON.stringify({
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      fileSize: ctx.message.audio.file_size ?? null,
      duration: ctx.message.audio.duration ?? null,
      filename: ctx.message.audio.file_name ?? null,
    }));
    try {
      const file = await this.downloadTelegramFile(ctx.message.audio.file_id, ctx.message.audio.file_name ?? `audio-${ctx.message.audio.file_unique_id}.m4a`);
      console.info('[audio] downloaded', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        bytes: file.buffer.length,
        mediaType: file.mediaType,
        filename: file.filename,
      }));
      const transcribedText = await this.transcribeAudio(file);
      console.info('[audio] transcribed', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        transcriptLength: transcribedText.length,
      }));
      await this.startTurn(ctx.chat.id, ctx.from.id, reply, {
        prompt: transcribedText,
        transcribedText,
        attachments: [],
        attachmentNames: [],
      });
    } catch (error) {
      console.error('[audio] failed', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        error: serializeError(error),
      }));
      await this.replyHtml(
        reply,
        `<b>Audio file failed</b>\n\n${plainTextToTelegramHtml(summarizeContextError(error, 'Transcription failed before Codex could start.'))}`,
      );
    }
  }

  async handlePhoto(ctx: TelegramPhotoContext): Promise<void> {
    if (!ctx.from) return;
    const reply = this.replyFromContext(ctx);
    const photo = ctx.message.photo.at(-1);
    if (!photo) {
      await this.replyHtml(reply, 'Telegram did not include a photo payload.');
      return;
    }
    try {
      const file = await this.downloadTelegramFile(photo.file_id, `photo-${photo.file_unique_id}.jpg`);
      const prompt = (ctx.message.caption ?? '').trim() || 'Please inspect the attached image and help with it.';
      await this.startTurn(ctx.chat.id, ctx.from.id, reply, {
        prompt,
        transcribedText: null,
        attachmentNames: [file.filename],
        attachments: [
          {
            kind: 'image',
            filename: file.filename,
            mediaType: file.mediaType,
            dataBase64: file.buffer.toString('base64'),
          },
        ],
      });
    } catch (error) {
      console.error('[photo] failed', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        error: serializeError(error),
      }));
      await this.replyHtml(
        reply,
        `<b>Photo upload failed</b>\n\n${plainTextToTelegramHtml(summarizeContextError(error, 'The image could not be prepared for Codex.'))}`,
      );
    }
  }

  async handleDocument(ctx: TelegramDocumentContext): Promise<void> {
    if (!ctx.from) return;
    const reply = this.replyFromContext(ctx);
    try {
      const file = await this.downloadTelegramFile(ctx.message.document.file_id, ctx.message.document.file_name ?? `file-${ctx.message.document.file_unique_id}`);
      const prompt = (ctx.message.caption ?? '').trim() || `Please inspect the attached file ${file.filename} and help with it.`;
      await this.startTurn(ctx.chat.id, ctx.from.id, reply, {
        prompt,
        transcribedText: null,
        attachmentNames: [file.filename],
        attachments: [
          {
            kind: 'file',
            filename: file.filename,
            mediaType: file.mediaType,
            dataBase64: file.buffer.toString('base64'),
          },
        ],
      });
    } catch (error) {
      console.error('[document] failed', JSON.stringify({
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        error: serializeError(error),
      }));
      await this.replyHtml(
        reply,
        `<b>File upload failed</b>\n\n${plainTextToTelegramHtml(summarizeContextError(error, 'The file could not be prepared for Codex.'))}`,
      );
    }
  }

  async createNewThread(
    chatId: number,
    telegramUserId: number,
    reply: TelegramReply,
    options: { announce?: boolean } = {},
  ): Promise<string | null> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return null;
    }
    if (!session.activeProjectId) {
      await this.replyHtml(reply, 'Pick a project first.');
      return null;
    }
    const requestId = randomUUID();
    const data = (await this.hub.sendRequest(agentId, {
      type: 'control.startThread',
      requestId,
      projectId: session.activeProjectId,
    })) as { threadId: string; title: string };
    const thread = await this.db.getThread(agentId, data.threadId);
    applyThreadSelection(session, thread, data.threadId);
    await this.db.upsertChatSession(session);
    if (options.announce) {
      await this.showActiveThread(chatId, telegramUserId, reply);
    }
    return data.threadId;
  }

  async resumeThread(chatId: number, telegramUserId: number, threadId: string, reply: TelegramReply): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.resumeThread', requestId: randomUUID(), threadId, projectId: session.activeProjectId });
    await this.setActiveThreadSession(chatId, telegramUserId, threadId, reply);
    await this.showActiveThread(chatId, telegramUserId, reply);
  }

  async forkThread(chatId: number, telegramUserId: number, threadId: string, reply: TelegramReply): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    const data = (await this.hub.sendRequest(agentId, { type: 'control.forkThread', requestId: randomUUID(), threadId })) as { threadId: string; title: string };
    const thread = await this.db.getThread(agentId, data.threadId);
    applyThreadSelection(session, thread, data.threadId);
    await this.db.upsertChatSession(session);
    await this.showActiveThread(chatId, telegramUserId, reply);
  }

  async renameThread(chatId: number, telegramUserId: number, threadId: string, name: string, reply: TelegramReply): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.renameThread', requestId: randomUUID(), threadId, name });
    const thread = await this.db.getThread(agentId, threadId);
    applyThreadSelection(session, thread, threadId);
    await this.db.upsertChatSession(session);
    await this.showActiveThread(chatId, telegramUserId, reply);
  }

  async archiveThread(chatId: number, telegramUserId: number, threadId: string, reply: TelegramReply): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.archiveThread', requestId: randomUUID(), threadId });
    if (session.activeThreadId === threadId) {
      session.activeThreadId = null;
      await this.db.upsertChatSession(session);
    }
    await this.replyHtml(reply, '<b>Thread archived.</b>');
  }

  async stopTurn(chatId: number, telegramUserId: number, threadId: string, turnId: string, reply: TelegramReply): Promise<void> {
    await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.interruptTurn', requestId: randomUUID(), threadId, turnId });
    await this.replyHtml(reply, '<b>Turn interrupted.</b>');
  }

  async resolveApproval(approvalRequestId: string, decision: 'accept' | 'decline' | 'cancel', reply: TelegramReply): Promise<void> {
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    this.hub.send(agentId, { type: 'approval.decision', approvalRequestId, codexRequestId: approvalRequestId, decision });
    await this.replyHtml(reply, `Approval decision sent: <b>${decision}</b>`);
  }

  async showThreadHistory(
    chatId: number,
    telegramUserId: number,
    threadId: string,
    reply: TelegramReply,
    limitTurns = 3,
  ): Promise<void> {
    await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }

    const thread = await this.db.getThread(agentId, threadId);
    const data = (await this.hub.sendRequest(agentId, {
      type: 'control.readThread',
      requestId: randomUUID(),
      threadId,
      limitTurns,
    })) as { threadId: string; title: string; turns: Array<{ turnId: string; entries: Array<{ role: 'user' | 'assistant'; text: string }> }> };

    for (const chunk of formatThreadHistory(data.title ?? thread?.title ?? threadId, data.turns)) {
      await this.replyHtml(reply, chunk);
    }
  }

  async onAgentMessage(agentId: string, message: { type: string; [key: string]: unknown }): Promise<void> {
    if (!this.bot) return;
    if (message.type === 'turn.started') {
      const run = this.runs.get(String(message.requestId));
      if (!run) return;
      run.turnId = String(message.turnId);
      await this.db.upsertRun({
        runId: run.runId,
        chatId: run.chatId,
        threadId: run.threadId,
        requestId: run.requestId,
        turnId: run.turnId,
        telegramMessageId: run.telegramMessageId,
        status: 'running',
      });
      if (run.telegramMessageId) {
        await this.editHtml(run.chatId, run.telegramMessageId, this.renderRunMessage(run), {
          reply_markup: activeRunKeyboard(run.runId),
        }).catch(() => undefined);
      }
      return;
    }

    if (message.type === 'turn.delta') {
      const run = this.runs.get(String(message.requestId));
      if (!run) return;
      run.buffer += String(message.text);
      return;
    }

    if (message.type === 'turn.itemCompleted') {
      const run = this.runs.get(String(message.requestId));
      if (!run) return;
      const summary = summarizeCodexItem(message.item);
      if (!summary || run.activityLines.at(-1) === summary) return;
      run.activityLines.push(summary);
      if (Date.now() - run.lastEditAt > 700 && run.telegramMessageId) {
        run.lastEditAt = Date.now();
        await this.editHtml(run.chatId, run.telegramMessageId, this.renderRunMessage(run), {
          reply_markup: run.turnId ? activeRunKeyboard(run.runId) : undefined,
        }).catch(() => undefined);
      }
      return;
    }

    if (message.type === 'turn.completed') {
      const run = this.runs.get(String(message.requestId));
      if (!run) return;
      const finalText = String(message.finalText || run.buffer || 'Completed.');
      const chunks = formatTurnCompleted(run.activityLines, finalText);
      if (run.telegramMessageId && chunks[0]) {
        await this.editHtml(run.chatId, run.telegramMessageId, chunks[0]).catch(() => undefined);
      }
      for (const chunk of chunks.slice(run.telegramMessageId ? 1 : 0)) {
        await this.sendHtml(run.chatId, chunk);
      }
      await this.db.upsertRun({
        runId: run.runId,
        chatId: run.chatId,
        threadId: run.threadId,
        requestId: run.requestId,
        turnId: String(message.turnId),
        telegramMessageId: run.telegramMessageId,
        status: 'completed',
      });
      this.runs.delete(String(message.requestId));
      return;
    }

    if (message.type === 'turn.failed') {
      const run = this.runs.get(String(message.requestId));
      if (!run) return;
      const text = `<b>Turn failed</b>\n\n${String(message.error)}`;
      if (run.telegramMessageId) {
        await this.editHtml(run.chatId, run.telegramMessageId, text).catch(() => undefined);
      } else {
        await this.sendHtml(run.chatId, text);
      }
      await this.db.upsertRun({
        runId: run.runId,
        chatId: run.chatId,
        threadId: run.threadId,
        requestId: run.requestId,
        turnId: run.turnId,
        telegramMessageId: run.telegramMessageId,
        status: 'failed',
      });
      this.runs.delete(String(message.requestId));
      return;
    }

    if (message.type === 'approval.requested') {
      const chatId = this.approvalChatByRequest.get(String(message.requestId)) ?? Array.from(this.runs.values()).find((run) => run.requestId === message.requestId)?.chatId;
      if (!chatId) return;
      this.approvalChatByRequest.set(String(message.approvalRequestId), chatId);
      await this.sendHtml(chatId, `<b>${summarizeApprovalKind(message.kind as never)}</b>\n\n${String(message.summary)}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `approval:${String(message.approvalRequestId)}:accept` },
            { text: 'Deny', callback_data: `approval:${String(message.approvalRequestId)}:cancel` },
          ]],
        },
      });
    }
  }

  private async setActiveThreadSession(chatId: number, telegramUserId: number, threadId: string, reply: TelegramReply): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return;
    }
    const thread = await this.db.getThread(agentId, threadId);
    applyThreadSelection(session, thread, threadId);
    await this.db.upsertChatSession(session);
  }

  private async showActiveThread(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<void> {
    const context = await this.loadActiveThreadContext(chatId, telegramUserId, reply);
    if (!context) return;
    await this.replyHtml(
      reply,
      formatThreadHeader(context.thread.title, context.runtimeCatalog, context.preference),
      { reply_markup: threadKeyboard(context.thread) },
    );
  }

  private async showThreadSettings(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<void> {
    const context = await this.loadActiveThreadContext(chatId, telegramUserId, reply);
    if (!context) return;
    await this.replyHtml(
      reply,
      formatThreadSettings(context.thread.title, context.runtimeCatalog, context.preference),
      { reply_markup: settingsKeyboard(context.runtime) },
    );
  }

  private async showModelSettings(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<void> {
    const context = await this.loadActiveThreadContext(chatId, telegramUserId, reply);
    if (!context) return;
    await this.replyHtml(
      reply,
      formatModelSettings(context.thread.title, context.runtimeCatalog, context.preference),
      { reply_markup: modelSettingsKeyboard(context.runtimeCatalog.models, context.runtime.model) },
    );
  }

  private async showReasoningSettings(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<void> {
    const context = await this.loadActiveThreadContext(chatId, telegramUserId, reply);
    if (!context) return;
    const model = context.runtimeCatalog.models.find((entry) => entry.id === context.runtime.model);
    const reasoningEfforts = model?.supportedReasoningEfforts ?? ['medium'];
    await this.replyHtml(
      reply,
      formatReasoningSettings(context.thread.title, context.runtimeCatalog, context.preference),
      { reply_markup: reasoningSettingsKeyboard(reasoningEfforts, context.runtime.reasoningEffort) },
    );
  }

  private async updateActiveThreadPreference(
    chatId: number,
    telegramUserId: number,
    reply: TelegramReply,
    mutate: (current: ThreadRuntimePreferenceInput, runtimeCatalog: RuntimeCatalog) => ThreadRuntimePreferenceInput,
  ): Promise<void> {
    const context = await this.loadActiveThreadContext(chatId, telegramUserId, reply);
    if (!context) return;
    const next = effectiveThreadRuntime(context.runtimeCatalog, mutate(context.runtime, context.runtimeCatalog));
    const saved = await this.db.upsertThreadPreference({
      threadId: context.thread.threadId,
      planMode: next.planMode,
      model: next.model,
      reasoningEffort: next.reasoningEffort,
      speed: next.speed,
    });
    await this.replyHtml(
      reply,
      formatThreadSettings(context.thread.title, context.runtimeCatalog, saved),
      { reply_markup: settingsKeyboard(effectiveThreadRuntime(context.runtimeCatalog, saved)) },
    );
  }

  private async startTurn(
    chatId: number,
    telegramUserId: number,
    reply: TelegramReply,
    args: {
      prompt: string;
      transcribedText: string | null;
      attachments: TurnAttachment[];
      attachmentNames: string[];
    },
  ): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);

    if (!this.hub.getConnectedAgentId()) {
      await this.replyHtml(reply, 'Mac companion is offline. Pair it first with <code>/pair</code>.');
      return;
    }

    let threadId = session.activeThreadId;
    if (!canRunTurn(session)) {
      await this.replyHtml(reply, 'Pick a project first from <code>/start</code>.');
      return;
    }
    if (!threadId) {
      threadId = await this.createNewThread(chatId, telegramUserId, reply, { announce: false });
      if (!threadId) return;
      session.activeThreadId = threadId;
    }

    const agentId = this.hub.getConnectedAgentId()!;
    const runtimeCatalog = await this.getRuntimeCatalog(agentId);
    const preference = await this.db.getThreadPreference(threadId);
    const runtime = effectiveThreadRuntime(runtimeCatalog, preference);
    const thread = await this.db.getThread(agentId, threadId);
    const threadTitle = thread?.title ?? `Thread ${threadId.slice(0, 8)}`;

    const requestId = randomUUID();
    const runId = randomUUID();
    let pendingMessageId: number | null = null;
    try {
      const pending = (await this.replyHtml(reply, formatRunWorkingState({
        threadTitle,
        activityLines: [],
        transcribedText: args.transcribedText,
        attachmentNames: args.attachmentNames,
      }), { reply_markup: activeRunKeyboard(runId) })) as { message_id?: number } | undefined;
      pendingMessageId = typeof pending?.message_id === 'number' ? pending.message_id : null;
    } catch (error) {
      console.error('[turn] failed to send working message', JSON.stringify({
        chatId,
        threadId,
        requestId,
        hasTranscription: Boolean(args.transcribedText),
        attachmentCount: args.attachmentNames.length,
        error: serializeError(error),
      }));
      const fallbackText = args.transcribedText
        ? `Transcribed voice note:\n${args.transcribedText}\n\nWorking on it...`
        : 'Working on it...';
      const pending = await this.sendPlain(String(chatId), fallbackText, { reply_markup: activeRunKeyboard(runId) }).catch((fallbackError) => {
        console.error('[turn] failed to send fallback working message', JSON.stringify({
          chatId,
          threadId,
          requestId,
          error: serializeError(fallbackError),
        }));
        return null;
      });
      pendingMessageId = pending?.message_id ?? null;
    }

    this.approvalChatByRequest.set(requestId, String(chatId));
    this.runs.set(requestId, {
      runId,
      chatId: String(chatId),
      threadId,
      requestId,
      turnId: null,
      telegramMessageId: pendingMessageId,
      buffer: '',
      lastEditAt: 0,
      activityLines: [],
      threadTitle,
      transcribedText: args.transcribedText,
      attachmentNames: args.attachmentNames,
    });

    const runRecord: RunRecord = {
      runId,
      chatId: String(chatId),
      threadId,
      requestId,
      turnId: null,
      telegramMessageId: pendingMessageId,
      status: 'running',
    };
    await this.db.upsertRun(runRecord);

    try {
      await this.hub.sendRequest(this.hub.getConnectedAgentId()!, {
        type: 'control.runTurn',
        requestId,
        threadId,
        projectId: session.activeProjectId ?? undefined,
        prompt: args.prompt,
        attachments: args.attachments,
        runtime,
        chatId: String(chatId),
      });
    } catch (error) {
      this.runs.delete(requestId);
      const message = `<b>Failed to start turn</b>\n\n${plainTextToTelegramHtml(summarizeContextError(error, 'Codex did not accept the turn.'))}`;
      if (pendingMessageId) {
        await this.editHtml(String(chatId), pendingMessageId, message).catch(() => undefined);
      } else {
        await this.sendHtml(String(chatId), message).catch(() => undefined);
      }
    }
  }

  private async loadActiveThreadContext(chatId: number, telegramUserId: number, reply: TelegramReply): Promise<ActiveThreadContext | null> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(reply, 'Mac companion is offline.');
      return null;
    }
    if (!session.activeThreadId) {
      await this.replyHtml(reply, 'Pick a thread first from <code>/start</code>.');
      return null;
    }
    const thread = await this.db.getThread(agentId, session.activeThreadId);
    if (!thread) {
      await this.replyHtml(reply, 'That thread is no longer in the synced cache. Refresh and try again.');
      return null;
    }
    const runtimeCatalog = await this.getRuntimeCatalog(agentId);
    const preference = await this.db.getThreadPreference(thread.threadId);
    const runtime = effectiveThreadRuntime(runtimeCatalog, preference);
    return { session, agentId, thread, runtimeCatalog, preference, runtime };
  }

  private async getRuntimeCatalog(agentId: string): Promise<RuntimeCatalog> {
    return (await this.hub.sendRequest(agentId, {
      type: 'control.getRuntimeCatalog',
      requestId: randomUUID(),
    })) as RuntimeCatalog;
  }

  private async downloadTelegramFile(fileId: string, fallbackFilename: string): Promise<DownloadedTelegramFile> {
    if (!this.bot) {
      throw new Error('Telegram is not configured');
    }
    const file = await this.bot.telegram.getFile(fileId);
    if (!file.file_path) {
      throw new Error('Telegram did not return a file path');
    }
    if ((file.file_size ?? 0) > env.TELEGRAM_MAX_ATTACHMENT_BYTES) {
      throw new Error(`This file is too large for Channels right now. Max supported size is ${Math.floor(env.TELEGRAM_MAX_ATTACHMENT_BYTES / 1_000_000)} MB.`);
    }
    const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      filename: path.basename(file.file_path) || fallbackFilename,
      mediaType: response.headers.get('content-type') ?? 'application/octet-stream',
      buffer: Buffer.from(arrayBuffer),
    };
  }

  private async transcribeAudio(file: DownloadedTelegramFile): Promise<string> {
    if (!this.openai) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    const transcription = await this.openai.audio.transcriptions.create({
      model: 'gpt-4o-transcribe',
      file: await toFile(file.buffer, file.filename, { type: file.mediaType }),
    });
    const text = transcription.text.trim();
    if (!text) {
      throw new Error('OpenAI returned an empty transcription');
    }
    return text;
  }

  private renderRunMessage(run: ActiveRunState): string {
    return formatRunWorkingState({
      threadTitle: run.threadTitle,
      activityLines: run.activityLines,
      transcribedText: run.transcribedText,
      attachmentNames: run.attachmentNames,
    });
  }

  private replyFromContext(ctx: Pick<Context, 'reply'>): TelegramReply {
    return async (message, extra) => await ctx.reply(message, this.messageOptions(extra));
  }

  private callbackReplyFromContext(ctx: NarrowedContext<Context, Types.MountMap['callback_query']>): TelegramReply {
    return async (message, extra) => {
      try {
        return await ctx.editMessageText(message, this.messageOptions(extra));
      } catch {
        return await ctx.reply(message, this.messageOptions(extra));
      }
    };
  }

  private async replyHtml(reply: TelegramReply, message: string, extra?: Record<string, unknown>): Promise<unknown> {
    return await reply(message, extra);
  }

  private async sendHtml(chatId: string, message: string, extra?: Record<string, unknown>): Promise<unknown> {
    if (!this.bot) return null;
    return await this.bot.telegram.sendMessage(Number(chatId), message, this.messageOptions(extra));
  }

  private async sendPlain(chatId: string, message: string, extra?: Record<string, unknown>): Promise<{ message_id: number } | null> {
    if (!this.bot) return null;
    return await this.bot.telegram.sendMessage(Number(chatId), message, {
      link_preview_options: { is_disabled: true },
      ...extra,
    }) as { message_id: number };
  }

  private async editHtml(chatId: string, messageId: number, message: string, extra?: Record<string, unknown>): Promise<unknown> {
    if (!this.bot) return null;
    return await this.bot.telegram.editMessageText(Number(chatId), messageId, undefined, message, this.messageOptions(extra));
  }

  private messageOptions(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...TELEGRAM_HTML_OPTIONS,
      ...extra,
    };
  }
}
