import { randomUUID } from 'node:crypto';
import { File as NodeFile } from 'node:buffer';
import path from 'node:path';
import OpenAI, { toFile } from 'openai';
import { Telegraf } from 'telegraf';
import type { Context, NarrowedContext, Types } from 'telegraf';
import type { Database, ChatSession, RunRecord, ForumThreadTopic } from './db.js';
import type { AgentHub } from './agent-hub.js';
import { env, features } from './config.js';
import {
  type CachedThread,
  type RuntimeCatalog,
  type ThreadRuntimePreference,
  type ThreadRuntimePreferenceInput,
  type TranscriptTurn,
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
import {
  buildForumTopicTitle,
  formatForumPromptMirror,
  formatForumPreviewImport,
  formatForumTopicIntro,
  formatForumTranscriptEntry,
  selectForumTurnsToImport,
} from './forum-mirror.js';

type TelegramTextContext = NarrowedContext<Context, Types.MountMap['text']>;
type TelegramVoiceContext = NarrowedContext<Context, Types.MountMap['voice']>;
type TelegramAudioContext = NarrowedContext<Context, Types.MountMap['audio']>;
type TelegramPhotoContext = NarrowedContext<Context, Types.MountMap['photo']>;
type TelegramDocumentContext = NarrowedContext<Context, Types.MountMap['document']>;

type TelegramReply = (message: string, extra?: Record<string, unknown>) => Promise<unknown>;

type ThreadAwareContext = {
  chat?: Context['chat'];
  message?: { message_thread_id?: number };
  callbackQuery?: { message?: unknown };
};

type ChatTarget = {
  chatId: string;
  messageThreadId: number | null;
};

type ActiveRunState = {
  runId: string;
  chatId: string;
  messageThreadId: number | null;
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
  mirrorTarget: ChatTarget | null;
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

const INITIAL_FORUM_HISTORY_TURN_LIMIT = 1;
const INCREMENTAL_FORUM_HISTORY_TURN_LIMIT = 4;
const TELEGRAM_RETRY_LIMIT = 5;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function telegramRetryAfterMs(error: unknown): number | null {
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    description?: unknown;
    response?: {
      error_code?: unknown;
      description?: unknown;
      parameters?: { retry_after?: unknown } | null;
    } | null;
    parameters?: { retry_after?: unknown } | null;
  };

  const retryAfterSeconds = Number(
    candidate.response?.parameters?.retry_after
      ?? candidate.parameters?.retry_after
      ?? NaN,
  );

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const status = Number(candidate.response?.error_code ?? candidate.status ?? candidate.code ?? NaN);
  const description = String(candidate.response?.description ?? candidate.description ?? '');
  if (status === 429 || /too many requests/i.test(description)) {
    const retryMatch = description.match(/retry after (\d+)/i);
    if (retryMatch) {
      return Number(retryMatch[1]) * 1000;
    }
    return 1000;
  }

  return null;
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
  private readonly approvalChatByRequest = new Map<string, ChatTarget>();
  private readonly openai = features.hasOpenAI ? new OpenAI({ apiKey: env.OPENAI_API_KEY! }) : null;
  private readonly forumEnsureByThread = new Map<string, Promise<ForumThreadTopic | null>>();
  private readonly forumHistorySyncByThread = new Map<string, Promise<void>>();
  private forumHistoryQueue: Promise<void> = Promise.resolve();
  private forumMirrorSyncInFlight: Promise<void> | null = null;

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

    this.bot.command('forum', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.handleForumCommand(ctx);
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

  async handleForumCommand(ctx: TelegramTextContext): Promise<void> {
    const reply = this.replyFromContext(ctx);
    const target = this.targetFromMessage(ctx.chat.id, ctx.message);
    const forumChatId = await this.getForumMirrorChatId();

    if (ctx.chat.type === 'private') {
      if (forumChatId) {
        await this.replyHtml(reply, `Forum mirror is linked to chat <code>${plainTextToTelegramHtml(forumChatId)}</code>.\n\nAdd the bot to a Telegram supergroup with Topics enabled and send <code>/forum</code> there any time you want to re-link or re-sync.\n\nFor quick freeform replies inside topics, disable the bot privacy setting in BotFather with <code>/setprivacy</code>.`);
      } else {
        await this.replyHtml(reply, 'Forum mirror is not linked yet.\n\nCreate a Telegram supergroup with Topics enabled, add this bot, and send <code>/forum</code> there to connect it.\n\nFor quick freeform replies inside topics, disable the bot privacy setting in BotFather with <code>/setprivacy</code>.');
      }
      return;
    }

    if (ctx.chat.type !== 'supergroup') {
      await this.sendHtmlToTarget(target, 'This only works in a Telegram supergroup.');
      return;
    }

    const linked = await this.db.setForumMirrorChat(String(ctx.chat.id), String(ctx.from!.id));
    await this.db.log('telegram', 'forum_linked', {
      chatId: linked.chatId,
      linkedByTelegramId: linked.linkedByTelegramId,
      title: 'title' in ctx.chat ? ctx.chat.title ?? null : null,
    });

    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.sendHtmlToTarget(target, '<b>Forum mirror linked.</b>\n\nThe Mac agent is offline right now, so I can’t create topics yet. Once it reconnects, send <code>/forum</code> again.');
      return;
    }

    try {
      const threads = await this.hub.listAllThreads(agentId);
      if (threads.length > 0) {
        await this.ensureForumMirrorForThread(agentId, threads[0].threadId);
      } else if (!this.isForumCompatibleChat(ctx.chat)) {
        await this.sendHtmlToTarget(target, 'This group still does not look like a Telegram forum yet. Turn on <b>Topics</b>, save the group settings, then send <code>/forum</code> again.');
        return;
      }
    } catch (error) {
      await this.sendHtmlToTarget(
        target,
        `<b>Forum link saved, but topic creation failed.</b>\n\n${plainTextToTelegramHtml(summarizeContextError(error, 'Telegram rejected topic creation.'))}\n\nPlease confirm this is a supergroup with <b>Topics</b> enabled and that the bot still has <b>Manage topics</b>.`,
      );
      return;
    }

    await this.sendHtmlToTarget(target, '<b>Forum mirror linked.</b>\n\nI’m creating one topic per Codex thread here and will keep future turns synced.\n\nTo allow normal quick messages inside topics, disable the bot privacy setting in BotFather with <code>/setprivacy</code>.');
    void this.syncLinkedForumMirror().catch((error) => {
      console.error('[forum] initial sync failed', JSON.stringify({ chatId: String(ctx.chat.id), error: serializeError(error) }));
    });
  }

  async syncLinkedForumMirror(): Promise<void> {
    const forumChatId = await this.getForumMirrorChatId();
    if (!forumChatId) return;

    if (this.forumMirrorSyncInFlight) {
      await this.forumMirrorSyncInFlight;
      return;
    }

    const task = this.syncForumMirror(forumChatId)
      .catch((error) => {
        console.error('[forum] linked sync failed', JSON.stringify({ chatId: forumChatId, error: serializeError(error) }));
      })
      .finally(() => {
        if (this.forumMirrorSyncInFlight === task) {
          this.forumMirrorSyncInFlight = null;
        }
      });

    this.forumMirrorSyncInFlight = task;
    await task;
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
    const forumContext = await this.resolveForumThreadContext(String(ctx.chat.id), this.messageThreadIdFromMessage(ctx.message));
    if (forumContext) {
      await this.startTurnForResolvedThread({
        reply,
        target: this.targetFromMessage(ctx.chat.id, ctx.message),
        thread: forumContext.thread,
        prompt: ctx.message.text,
        transcribedText: null,
        attachments: [],
        attachmentNames: [],
      });
      return;
    }
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
      const forumContext = await this.resolveForumThreadContext(String(ctx.chat.id), this.messageThreadIdFromMessage(ctx.message));
      if (forumContext) {
        await this.startTurnForResolvedThread({
          reply,
          target: this.targetFromMessage(ctx.chat.id, ctx.message),
          thread: forumContext.thread,
          prompt: transcribedText,
          transcribedText,
          attachments: [],
          attachmentNames: [],
        });
        return;
      }
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
      const forumContext = await this.resolveForumThreadContext(String(ctx.chat.id), this.messageThreadIdFromMessage(ctx.message));
      if (forumContext) {
        await this.startTurnForResolvedThread({
          reply,
          target: this.targetFromMessage(ctx.chat.id, ctx.message),
          thread: forumContext.thread,
          prompt: transcribedText,
          transcribedText,
          attachments: [],
          attachmentNames: [],
        });
        return;
      }
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
      const turnArgs = {
        prompt,
        transcribedText: null,
        attachmentNames: [file.filename],
        attachments: [
          {
            kind: 'image' as const,
            filename: file.filename,
            mediaType: file.mediaType,
            dataBase64: file.buffer.toString('base64'),
          },
        ],
      };
      const forumContext = await this.resolveForumThreadContext(String(ctx.chat.id), this.messageThreadIdFromMessage(ctx.message));
      if (forumContext) {
        await this.startTurnForResolvedThread({
          reply,
          target: this.targetFromMessage(ctx.chat.id, ctx.message),
          thread: forumContext.thread,
          ...turnArgs,
        });
        return;
      }
      await this.startTurn(ctx.chat.id, ctx.from.id, reply, turnArgs);
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
      const turnArgs = {
        prompt,
        transcribedText: null,
        attachmentNames: [file.filename],
        attachments: [
          {
            kind: 'file' as const,
            filename: file.filename,
            mediaType: file.mediaType,
            dataBase64: file.buffer.toString('base64'),
          },
        ],
      };
      const forumContext = await this.resolveForumThreadContext(String(ctx.chat.id), this.messageThreadIdFromMessage(ctx.message));
      if (forumContext) {
        await this.startTurnForResolvedThread({
          reply,
          target: this.targetFromMessage(ctx.chat.id, ctx.message),
          thread: forumContext.thread,
          ...turnArgs,
        });
        return;
      }
      await this.startTurn(ctx.chat.id, ctx.from.id, reply, turnArgs);
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
        await this.sendHtmlToTarget({ chatId: run.chatId, messageThreadId: run.messageThreadId }, chunk);
      }
      if (run.mirrorTarget) {
        const mirrorChunks = formatForumTranscriptEntry({ role: 'assistant', text: finalText });
        for (const chunk of mirrorChunks) {
          await this.sendHtmlToTarget(run.mirrorTarget, chunk);
        }
      }
      await this.markForumTurnMirrored(run.threadId, String(message.turnId));
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
        await this.sendHtmlToTarget({ chatId: run.chatId, messageThreadId: run.messageThreadId }, text);
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
      const target = this.approvalChatByRequest.get(String(message.requestId))
        ?? (() => {
          const run = Array.from(this.runs.values()).find((entry) => entry.requestId === message.requestId);
          return run ? { chatId: run.chatId, messageThreadId: run.messageThreadId } : null;
        })();
      if (!target) return;
      this.approvalChatByRequest.set(String(message.approvalRequestId), target);
      await this.sendHtmlToTarget(target, `<b>${summarizeApprovalKind(message.kind as never)}</b>\n\n${String(message.summary)}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `approval:${String(message.approvalRequestId)}:accept` },
            { text: 'Deny', callback_data: `approval:${String(message.approvalRequestId)}:cancel` },
          ]],
        },
      });
    }
  }

  private isForumCompatibleChat(chat: Context['chat'] | undefined | null): boolean {
    if (!chat || chat.type !== 'supergroup') return false;
    const forumFlag = (chat as Context['chat'] & { is_forum?: boolean }).is_forum;
    return forumFlag !== false;
  }

  private messageThreadIdFromMessage(message: { message_thread_id?: number } | undefined | null): number | null {
    return typeof message?.message_thread_id === 'number' ? message.message_thread_id : null;
  }

  private targetFromMessage(chatId: number | string, message: { message_thread_id?: number } | undefined | null): ChatTarget {
    return {
      chatId: String(chatId),
      messageThreadId: this.messageThreadIdFromMessage(message),
    };
  }

  private sameTarget(a: ChatTarget | null | undefined, b: ChatTarget | null | undefined): boolean {
    return Boolean(a && b && a.chatId === b.chatId && a.messageThreadId === b.messageThreadId);
  }

  private async getForumMirrorChatId(): Promise<string | null> {
    if (env.TELEGRAM_FORUM_CHAT_ID) {
      return env.TELEGRAM_FORUM_CHAT_ID;
    }
    const linked = await this.db.getForumMirrorChat();
    return linked?.chatId ?? null;
  }

  private async syncForumMirror(chatId: string): Promise<void> {
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) return;
    const threads = await this.hub.listAllThreads(agentId);
    const topicsToBackfill: Array<{ thread: CachedThread; topic: ForumThreadTopic }> = [];

    for (const thread of threads) {
      try {
        const topic = await this.ensureForumMirrorForThread(agentId, thread.threadId, {
          queueHistory: false,
          sendIntro: false,
        });
        if (topic) {
          topicsToBackfill.push({ thread, topic });
        }
      } catch (error) {
        console.error('[forum] sync thread failed', JSON.stringify({
          chatId,
          threadId: thread.threadId,
          error: serializeError(error),
        }));
      }
    }

    for (const { thread, topic } of topicsToBackfill) {
      this.queueForumHistorySync(agentId, thread, topic);
    }
  }

  private async resolveForumThreadContext(
    chatId: string,
    messageThreadId: number | null,
  ): Promise<{ agentId: string; thread: CachedThread; topic: ForumThreadTopic } | null> {
    if (!messageThreadId) return null;
    const forumChatId = await this.getForumMirrorChatId();
    if (!forumChatId || forumChatId !== chatId) return null;

    const topic = await this.db.findForumThreadTopic(chatId, messageThreadId);
    if (!topic) return null;

    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) return null;

    const thread = await this.db.getThread(agentId, topic.threadId);
    if (!thread) return null;

    return { agentId, thread, topic };
  }

  private async ensureForumMirrorForThread(
    agentId: string,
    threadId: string,
    options?: { queueHistory?: boolean; sendIntro?: boolean },
  ): Promise<ForumThreadTopic | null> {
    const inFlight = this.forumEnsureByThread.get(threadId);
    if (inFlight) {
      return await inFlight;
    }

    const promise = this.ensureForumMirrorForThreadInner(agentId, threadId, options)
      .finally(() => {
        this.forumEnsureByThread.delete(threadId);
      });

    this.forumEnsureByThread.set(threadId, promise);
    return await promise;
  }

  private async ensureForumMirrorForThreadInner(
    agentId: string,
    threadId: string,
    options?: { queueHistory?: boolean; sendIntro?: boolean },
  ): Promise<ForumThreadTopic | null> {
    if (!this.bot) return null;

    const forumChatId = await this.getForumMirrorChatId();
    if (!forumChatId) return null;

    const thread = await this.db.getThread(agentId, threadId);
    if (!thread) return null;

    const projects = await this.hub.listProjects(agentId);
    const project = thread.projectId ? projects.find((entry) => entry.projectId === thread.projectId) ?? null : null;
    const topicName = buildForumTopicTitle(project?.name ?? null, thread.title);

    let topic = await this.db.getForumThreadTopic(threadId);
    let created = false;
    const shouldQueueHistory = options?.queueHistory ?? true;
    const shouldSendIntro = options?.sendIntro ?? true;

    if (!topic || topic.chatId !== forumChatId) {
      const createdTopic = await this.callTelegramApiWithRetry<{ message_thread_id: number }>('createForumTopic', {
        chat_id: Number(forumChatId),
        name: topicName,
      });

      topic = await this.db.upsertForumThreadTopic({
        threadId,
        chatId: forumChatId,
        topicId: createdTopic.message_thread_id,
        topicName,
        lastMirroredTurnId: null,
      });
      created = true;
    } else if (topic.topicName !== topicName) {
      try {
        await this.callTelegramApiWithRetry('editForumTopic', {
          chat_id: Number(forumChatId),
          message_thread_id: topic.topicId,
          name: topicName,
        });
      } catch (error) {
        console.error('[forum] rename topic failed', JSON.stringify({
          chatId: forumChatId,
          topicId: topic.topicId,
          threadId,
          error: serializeError(error),
        }));
      }

      topic = await this.db.upsertForumThreadTopic({
        ...topic,
        topicName,
      });
    }

    if (created && shouldSendIntro) {
      await this.sendHtmlToTarget(
        { chatId: topic.chatId, messageThreadId: topic.topicId },
        formatForumTopicIntro({
          threadTitle: thread.title,
          projectName: project?.name ?? null,
          legacy: thread.legacy,
        }),
      );
    }

    if (shouldQueueHistory) {
      this.queueForumHistorySync(agentId, thread, topic);
    }

    return topic;
  }

  private queueForumHistorySync(agentId: string, thread: CachedThread, topic: ForumThreadTopic): void {
    const existing = this.forumHistorySyncByThread.get(thread.threadId);
    if (existing) return;

    const task = this.forumHistoryQueue
      .catch(() => undefined)
      .then(async () => {
        await this.syncForumThreadHistory(agentId, thread, topic);
      })
      .catch((error) => {
        console.error('[forum] background history sync failed', JSON.stringify({
          threadId: thread.threadId,
          topicId: topic.topicId,
          error: serializeError(error),
        }));
      })
      .finally(() => {
        this.forumHistorySyncByThread.delete(thread.threadId);
      });

    this.forumHistoryQueue = task.catch(() => undefined);
    this.forumHistorySyncByThread.set(thread.threadId, task);
  }

  private async syncForumThreadHistory(
    agentId: string,
    thread: CachedThread,
    topic: ForumThreadTopic,
  ): Promise<ForumThreadTopic> {
    const target = { chatId: topic.chatId, messageThreadId: topic.topicId };
    const limitTurns = topic.lastMirroredTurnId ? INCREMENTAL_FORUM_HISTORY_TURN_LIMIT : INITIAL_FORUM_HISTORY_TURN_LIMIT;
    let history: { turns: TranscriptTurn[] };
    try {
      history = (await this.hub.sendRequest(agentId, {
        type: 'control.readThread',
        requestId: randomUUID(),
        threadId: thread.threadId,
        limitTurns,
      }, 120_000)) as { turns: TranscriptTurn[] };
    } catch (error) {
      if (topic.lastMirroredTurnId === null) {
        const previewChunks = formatForumPreviewImport(thread.preview);
        if (previewChunks.length > 0) {
          for (const chunk of previewChunks) {
            await this.sendHtmlToTarget(target, chunk);
          }
          return await this.db.upsertForumThreadTopic({
            ...topic,
            lastMirroredTurnId: `preview:${thread.updatedAt}`,
          });
        }
      }
      throw error;
    }

    const pendingTurns = selectForumTurnsToImport(history.turns, topic.lastMirroredTurnId);

    let latestTopic = topic;
    for (const turn of pendingTurns) {
      await this.mirrorTranscriptTurn(target, turn);
      latestTopic = await this.db.upsertForumThreadTopic({
        ...latestTopic,
        lastMirroredTurnId: turn.turnId,
      });
    }

    return latestTopic;
  }

  private async mirrorTranscriptTurn(target: ChatTarget, turn: TranscriptTurn): Promise<void> {
    for (const entry of turn.entries) {
      const chunks = formatForumTranscriptEntry(entry);
      for (const chunk of chunks) {
        await this.sendHtmlToTarget(target, chunk);
      }
    }
  }

  private async markForumTurnMirrored(threadId: string, turnId: string): Promise<void> {
    const topic = await this.db.getForumThreadTopic(threadId);
    if (!topic) return;
    await this.db.upsertForumThreadTopic({
      ...topic,
      lastMirroredTurnId: turnId,
    });
  }

  private async mirrorPromptToForum(
    target: ChatTarget,
    args: {
      prompt: string;
      transcribedText: string | null;
      attachments: TurnAttachment[];
      attachmentNames: string[];
      originLabel: string;
    },
  ): Promise<void> {
    const chunks = formatForumPromptMirror({
      prompt: args.prompt,
      transcribedText: args.transcribedText,
      attachmentNames: args.attachmentNames,
      originLabel: args.originLabel,
    });

    for (const chunk of chunks) {
      await this.sendHtmlToTarget(target, chunk);
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
    void this.ensureForumMirrorForThread(context.agentId, context.thread.threadId).catch((error) => {
      console.error('[forum] ensure mirror failed', JSON.stringify({
        threadId: context.thread.threadId,
        error: serializeError(error),
      }));
    });
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

  private async startTurnForResolvedThread(args: {
    reply: TelegramReply;
    target: ChatTarget;
    thread: CachedThread;
    prompt: string;
    transcribedText: string | null;
    attachments: TurnAttachment[];
    attachmentNames: string[];
  }): Promise<void> {
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await this.replyHtml(args.reply, 'Mac companion is offline. Pair it first with <code>/pair</code>.');
      return;
    }

    await this.dispatchTurn(agentId, args.reply, {
      target: args.target,
      thread: args.thread,
      prompt: args.prompt,
      transcribedText: args.transcribedText,
      attachments: args.attachments,
      attachmentNames: args.attachmentNames,
      mirrorOriginLabel: null,
    });
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
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
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
    const thread = await this.db.getThread(agentId, threadId);
    if (!thread) {
      await this.replyHtml(reply, 'That thread is no longer in the synced cache. Refresh and try again.');
      return;
    }
    await this.dispatchTurn(agentId, reply, {
      target: { chatId: String(chatId), messageThreadId: null },
      thread,
      prompt: args.prompt,
      transcribedText: args.transcribedText,
      attachments: args.attachments,
      attachmentNames: args.attachmentNames,
      mirrorOriginLabel: 'from command center',
    });
  }

  private async dispatchTurn(
    agentId: string,
    reply: TelegramReply,
    args: {
      target: ChatTarget;
      thread: CachedThread;
      prompt: string;
      transcribedText: string | null;
      attachments: TurnAttachment[];
      attachmentNames: string[];
      mirrorOriginLabel: string | null;
    },
  ): Promise<void> {
    const runtimeCatalog = await this.getRuntimeCatalog(agentId);
    const preference = await this.db.getThreadPreference(args.thread.threadId);
    const runtime = effectiveThreadRuntime(runtimeCatalog, preference);
    const threadTitle = args.thread.title ?? `Thread ${args.thread.threadId.slice(0, 8)}`;
    const forumTopic = await this.ensureForumMirrorForThread(agentId, args.thread.threadId);
    const mirrorTarget = forumTopic && !this.sameTarget(args.target, { chatId: forumTopic.chatId, messageThreadId: forumTopic.topicId })
      ? { chatId: forumTopic.chatId, messageThreadId: forumTopic.topicId }
      : null;

    if (mirrorTarget && args.mirrorOriginLabel) {
      await this.mirrorPromptToForum(mirrorTarget, {
        prompt: args.prompt,
        transcribedText: args.transcribedText,
        attachments: args.attachments,
        attachmentNames: args.attachmentNames,
        originLabel: args.mirrorOriginLabel,
      });
    }

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
        chatId: args.target.chatId,
        messageThreadId: args.target.messageThreadId,
        threadId: args.thread.threadId,
        requestId,
        hasTranscription: Boolean(args.transcribedText),
        attachmentCount: args.attachmentNames.length,
        error: serializeError(error),
      }));
      const fallbackText = args.transcribedText
        ? `Transcribed voice note:\n${args.transcribedText}\n\nWorking on it...`
        : 'Working on it...';
      const pending = await this.sendPlainToTarget(args.target, fallbackText, {
        reply_markup: activeRunKeyboard(runId),
      }).catch((fallbackError) => {
        console.error('[turn] failed to send fallback working message', JSON.stringify({
          chatId: args.target.chatId,
          messageThreadId: args.target.messageThreadId,
          threadId: args.thread.threadId,
          requestId,
          error: serializeError(fallbackError),
        }));
        return null;
      });
      pendingMessageId = pending?.message_id ?? null;
    }

    this.approvalChatByRequest.set(requestId, args.target);
    this.runs.set(requestId, {
      runId,
      chatId: args.target.chatId,
      messageThreadId: args.target.messageThreadId,
      threadId: args.thread.threadId,
      requestId,
      turnId: null,
      telegramMessageId: pendingMessageId,
      buffer: '',
      lastEditAt: 0,
      activityLines: [],
      threadTitle,
      transcribedText: args.transcribedText,
      attachmentNames: args.attachmentNames,
      mirrorTarget,
    });

    const runRecord: RunRecord = {
      runId,
      chatId: args.target.chatId,
      threadId: args.thread.threadId,
      requestId,
      turnId: null,
      telegramMessageId: pendingMessageId,
      status: 'running',
    };
    await this.db.upsertRun(runRecord);

    try {
      await this.hub.sendRequest(agentId, {
        type: 'control.runTurn',
        requestId,
        threadId: args.thread.threadId,
        projectId: args.thread.projectId ?? undefined,
        prompt: args.prompt,
        attachments: args.attachments,
        runtime,
        chatId: args.target.chatId,
      });
    } catch (error) {
      this.runs.delete(requestId);
      const message = `<b>Failed to start turn</b>\n\n${plainTextToTelegramHtml(summarizeContextError(error, 'Codex did not accept the turn.'))}`;
      if (pendingMessageId) {
        await this.editHtml(args.target.chatId, pendingMessageId, message).catch(() => undefined);
      } else {
        await this.sendHtml(args.target.chatId, message, args.target.messageThreadId ? { message_thread_id: args.target.messageThreadId } : undefined).catch(() => undefined);
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
      filename: path.basename(fallbackFilename) || path.basename(file.file_path) || 'attachment',
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

  private replyFromContext(ctx: Pick<Context, 'reply'> & ThreadAwareContext): TelegramReply {
    return async (message, extra) => {
      const threadId = this.messageThreadIdFromContext(ctx);
      return await ctx.reply(message, this.messageOptions({
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...extra,
      }));
    };
  }

  private callbackReplyFromContext(ctx: NarrowedContext<Context, Types.MountMap['callback_query']>): TelegramReply {
    return async (message, extra) => {
      try {
        return await ctx.editMessageText(message, this.messageOptions(extra));
      } catch {
        const threadId = this.messageThreadIdFromContext(ctx);
        return await ctx.reply(message, this.messageOptions({
          ...(threadId ? { message_thread_id: threadId } : {}),
          ...extra,
        }));
      }
    };
  }

  private messageThreadIdFromContext(ctx: ThreadAwareContext): number | null {
    const message = ctx.message;
    if (typeof message?.message_thread_id === 'number') {
      return message.message_thread_id;
    }

    const callbackMessage = ctx.callbackQuery?.message;
    if (
      callbackMessage
      && typeof callbackMessage === 'object'
      && 'message_thread_id' in callbackMessage
      && typeof (callbackMessage as { message_thread_id?: unknown }).message_thread_id === 'number'
    ) {
      return (callbackMessage as { message_thread_id: number }).message_thread_id;
    }

    return null;
  }

  private async replyHtml(reply: TelegramReply, message: string, extra?: Record<string, unknown>): Promise<unknown> {
    return await reply(message, extra);
  }

  private async sendHtmlToTarget(target: ChatTarget, message: string, extra?: Record<string, unknown>): Promise<unknown> {
    return await this.sendHtml(target.chatId, message, {
      ...(target.messageThreadId ? { message_thread_id: target.messageThreadId } : {}),
      ...extra,
    });
  }

  private async sendHtml(chatId: string, message: string, extra?: Record<string, unknown>): Promise<unknown> {
    if (!this.bot) return null;
    return await this.withTelegramRetry(`sendMessage:${chatId}`, async () => {
      return await this.bot!.telegram.sendMessage(Number(chatId), message, this.messageOptions(extra));
    });
  }

  private async sendPlainToTarget(target: ChatTarget, message: string, extra?: Record<string, unknown>): Promise<{ message_id: number } | null> {
    return await this.sendPlain(target.chatId, message, {
      ...(target.messageThreadId ? { message_thread_id: target.messageThreadId } : {}),
      ...extra,
    });
  }

  private async sendPlain(chatId: string, message: string, extra?: Record<string, unknown>): Promise<{ message_id: number } | null> {
    if (!this.bot) return null;
    return await this.withTelegramRetry(`sendPlain:${chatId}`, async () => {
      return await this.bot!.telegram.sendMessage(Number(chatId), message, {
        link_preview_options: { is_disabled: true },
        ...extra,
      }) as { message_id: number };
    });
  }

  private async editHtml(chatId: string, messageId: number, message: string, extra?: Record<string, unknown>): Promise<unknown> {
    if (!this.bot) return null;
    return await this.withTelegramRetry(`editMessageText:${chatId}:${messageId}`, async () => {
      return await this.bot!.telegram.editMessageText(Number(chatId), messageId, undefined, message, this.messageOptions(extra));
    });
  }

  private messageOptions(extra?: Record<string, unknown>): Record<string, unknown> {
    return {
      ...TELEGRAM_HTML_OPTIONS,
      ...extra,
    };
  }

  private async callTelegramApiWithRetry<T = unknown>(
    method: Parameters<Telegraf<Context>['telegram']['callApi']>[0],
    payload: Record<string, unknown>,
  ): Promise<T> {
    if (!this.bot) {
      throw new Error(`Telegram bot is unavailable for ${method}`);
    }

    return await this.withTelegramRetry(`callApi:${method}`, async () => {
      return await this.bot!.telegram.callApi(method, payload) as T;
    });
  }

  private async withTelegramRetry<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        attempt += 1;
        const retryAfterMs = telegramRetryAfterMs(error);

        if (!retryAfterMs || attempt >= TELEGRAM_RETRY_LIMIT) {
          throw error;
        }

        const delayMs = Math.min(retryAfterMs + 250, 60_000);
        console.warn('[telegram] rate limited, retrying', JSON.stringify({ label, attempt, delayMs }));
        await sleep(delayMs);
      }
    }
  }
}
