import { randomUUID } from 'node:crypto';
import { Telegraf } from 'telegraf';
import type { Context, NarrowedContext, Types } from 'telegraf';
import type { Database, ChatSession, RunRecord } from './db.js';
import type { AgentHub } from './agent-hub.js';
import { env, features } from './config.js';
import {
  type CachedThread,
  chunkTelegramMessage,
  createPairCode,
  summarizeApprovalKind,
} from '@channels/shared';
import {
  activeRunKeyboard,
  formatProjectsList,
  formatStartMessage,
  formatThreadList,
  projectsKeyboard,
  rootKeyboard,
  threadKeyboard,
  threadsKeyboard,
} from './telegram-ui.js';

type TelegramTextContext = NarrowedContext<Context, Types.MountMap['text']>;

type ActiveRunState = {
  runId: string;
  chatId: string;
  threadId: string;
  requestId: string;
  turnId: string | null;
  telegramMessageId: number | null;
  buffer: string;
  lastEditAt: number;
};

export class BotController {
  readonly bot: Telegraf<Context> | null;
  private readonly runs = new Map<string, ActiveRunState>();
  private readonly approvalChatByRequest = new Map<string, string>();

  constructor(private readonly db: Database, private readonly hub: AgentHub) {
    this.bot = features.hasTelegram ? new Telegraf<Context>(env.TELEGRAM_BOT_TOKEN!) : null;
    if (!this.bot) return;

    this.bot.command('start', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.ensureSession(ctx.chat.id, ctx.from.id);
      await this.renderHome(ctx.chat.id, ctx.from.id, ctx);
    });

    this.bot.command('pair', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await this.issuePairCode(ctx.chat.id, ctx.from.id, ctx.reply.bind(ctx));
    });

    this.bot.command('help', async (ctx) => {
      if (!(await this.ensureOwner(ctx))) return;
      await ctx.reply('Use /start to open the Channels dashboard. Send a normal message to continue the active Codex thread.');
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

  async issuePairCode(chatId: number, telegramUserId: number, reply: (message: string) => Promise<unknown>): Promise<void> {
    const code = createPairCode();
    await this.ensureSession(chatId, telegramUserId);
    await this.db.createPairCode({ code, chatId: String(chatId), ownerTelegramId: String(telegramUserId) }, env.PAIR_CODE_TTL_SECONDS);
    await this.db.log('telegram', 'pair_code_created', { chatId, code });
    await reply(`Pair code: ${code}\n\nRun this on your Mac companion:\nchannels-agent pair --server-url <wss-url> --pair-code ${code}`);
  }

  async renderHome(chatId: number | string, telegramUserId: number | string, ctx: Pick<Context, 'reply'>): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    const activeProject = agentId && session.activeProjectId ? (await this.hub.listProjects(agentId)).find((project) => project.projectId === session.activeProjectId) : null;
    const activeThread = agentId && session.activeThreadId ? await this.db.getThread(agentId, session.activeThreadId) : null;
    await ctx.reply(
      formatStartMessage({
        hasTelegram: features.hasTelegram,
        connectedAgent: Boolean(agentId),
        activeProjectName: activeProject?.name ?? null,
        activeThreadTitle: activeThread?.title ?? null,
      }),
      { reply_markup: rootKeyboard() },
    );
  }

  async showProjects(chatId: number, telegramUserId: number, reply: (message: string, extra?: Record<string, unknown>) => Promise<unknown>): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline. Pair it first with /pair.');
      return;
    }
    const projects = await this.hub.listProjects(agentId);
    await reply(formatProjectsList(projects, session.activeProjectId), { reply_markup: projectsKeyboard(projects) });
  }

  async showThreads(chatId: number, telegramUserId: number, reply: (message: string, extra?: Record<string, unknown>) => Promise<unknown>): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return;
    }
    const threads = await this.hub.listThreads(agentId, session.activeProjectId);
    await reply(formatThreadList(threads, session.activeThreadId), { reply_markup: threadsKeyboard(threads) });
  }

  async handleCallback(ctx: NarrowedContext<Context, Types.MountMap['callback_query']>, data: string): Promise<void> {
    if (!ctx.from) return;
    await this.ensureSession(ctx.chat!.id, ctx.from.id);

    if (data === 'ui:projects') {
      await this.showProjects(ctx.chat!.id, ctx.from.id, ctx.reply.bind(ctx));
    } else if (data === 'ui:threads') {
      await this.showThreads(ctx.chat!.id, ctx.from.id, ctx.reply.bind(ctx));
    } else if (data === 'ui:new-thread') {
      await this.createNewThread(ctx.chat!.id, ctx.from.id, ctx.reply.bind(ctx));
    } else if (data === 'ui:refresh') {
      await this.renderHome(ctx.chat!.id, ctx.from.id, ctx);
    } else if (data === 'ui:pair') {
      await this.issuePairCode(ctx.chat!.id, ctx.from.id, ctx.reply.bind(ctx));
    } else if (data.startsWith('project:select:')) {
      const projectId = data.split(':')[2];
      const session = await this.ensureSession(ctx.chat!.id, ctx.from.id);
      session.activeProjectId = projectId;
      session.activeThreadId = null;
      await this.db.upsertChatSession(session);
      await ctx.reply('Active project updated.');
      await this.showThreads(ctx.chat!.id, ctx.from.id, ctx.reply.bind(ctx));
    } else if (data.startsWith('thread:switch:')) {
      const threadId = data.split(':')[2];
      const session = await this.ensureSession(ctx.chat!.id, ctx.from.id);
      session.activeThreadId = threadId;
      await this.db.upsertChatSession(session);
      const agentId = this.hub.getConnectedAgentId();
      const thread = agentId ? await this.db.getThread(agentId, threadId) : null;
      await ctx.reply(`Active thread: ${thread?.title ?? threadId}`, thread ? { reply_markup: threadKeyboard(thread) } : undefined);
    } else if (data.startsWith('thread:resume:')) {
      const threadId = data.split(':')[2];
      await this.resumeThread(ctx.chat!.id, ctx.from.id, threadId, ctx.reply.bind(ctx));
    } else if (data.startsWith('thread:fork:')) {
      const threadId = data.split(':')[2];
      await this.forkThread(ctx.chat!.id, ctx.from.id, threadId, ctx.reply.bind(ctx));
    } else if (data.startsWith('thread:rename:')) {
      const threadId = data.split(':')[2];
      await this.db.setPendingAction(String(ctx.chat!.id), 'rename_thread', { threadId });
      await ctx.reply('Send the new thread name as your next message.');
    } else if (data.startsWith('thread:archive:')) {
      const threadId = data.split(':')[2];
      await this.archiveThread(ctx.chat!.id, ctx.from.id, threadId, ctx.reply.bind(ctx));
    } else if (data.startsWith('turn:stop:')) {
      const [, , threadId, turnId] = data.split(':');
      await this.stopTurn(ctx.chat!.id, ctx.from.id, threadId, turnId, ctx.reply.bind(ctx));
    } else if (data.startsWith('approval:')) {
      const [, approvalRequestId, decision] = data.split(':');
      await this.resolveApproval(approvalRequestId, decision as 'accept' | 'decline' | 'cancel', ctx.reply.bind(ctx));
    }
    await ctx.answerCbQuery();
  }

  async handleText(ctx: TelegramTextContext): Promise<void> {
    if (!ctx.from) return;
    const session = await this.ensureSession(ctx.chat.id, ctx.from.id);
    if (session.pendingAction === 'rename_thread' && session.pendingPayload?.threadId) {
      await this.renameThread(ctx.chat.id, ctx.from.id, String(session.pendingPayload.threadId), ctx.message.text, ctx.reply.bind(ctx));
      await this.db.setPendingAction(String(ctx.chat.id), null, null);
      return;
    }

    if (!this.hub.getConnectedAgentId()) {
      await ctx.reply('Mac companion is offline. Pair it first with /pair.');
      return;
    }

    let threadId = session.activeThreadId;
    if (!session.activeProjectId) {
      await ctx.reply('Pick a project first from /start.');
      return;
    }
    if (!threadId) {
      threadId = await this.createNewThread(ctx.chat.id, ctx.from.id, ctx.reply.bind(ctx));
      if (!threadId) return;
    }

    const requestId = randomUUID();
    const pending = await ctx.reply('Working on it...');
    const runId = randomUUID();
    this.runs.set(requestId, {
      runId,
      chatId: String(ctx.chat.id),
      threadId,
      requestId,
      turnId: null,
      telegramMessageId: pending.message_id,
      buffer: '',
      lastEditAt: 0,
    });
    const runRecord: RunRecord = {
      runId,
      chatId: String(ctx.chat.id),
      threadId,
      requestId,
      turnId: null,
      telegramMessageId: pending.message_id,
      status: 'running',
    };
    await this.db.upsertRun(runRecord);
    try {
      await this.hub.sendRequest(this.hub.getConnectedAgentId()!, {
        type: 'control.runTurn',
        requestId,
        threadId,
        projectId: session.activeProjectId,
        prompt: ctx.message.text,
        chatId: String(ctx.chat.id),
      });
    } catch (error) {
      this.runs.delete(requestId);
      await ctx.reply(`Failed to start turn: ${(error as Error).message}`);
    }
  }

  async createNewThread(chatId: number, telegramUserId: number, reply: (message: string, extra?: Record<string, unknown>) => Promise<unknown>): Promise<string | null> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return null;
    }
    if (!session.activeProjectId) {
      await reply('Pick a project first.');
      return null;
    }
    const requestId = randomUUID();
    const data = (await this.hub.sendRequest(agentId, {
      type: 'control.startThread',
      requestId,
      projectId: session.activeProjectId,
    })) as { threadId: string; title: string };
    session.activeThreadId = data.threadId;
    await this.db.upsertChatSession(session);
    await reply(`Started a new thread: ${data.title}`);
    return data.threadId;
  }

  async resumeThread(chatId: number, telegramUserId: number, threadId: string, reply: (message: string) => Promise<unknown>): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.resumeThread', requestId: randomUUID(), threadId, projectId: session.activeProjectId });
    session.activeThreadId = threadId;
    await this.db.upsertChatSession(session);
    const thread = await this.db.getThread(agentId, threadId);
    await reply(`Resumed ${thread?.title ?? threadId}`);
  }

  async forkThread(chatId: number, telegramUserId: number, threadId: string, reply: (message: string) => Promise<unknown>): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return;
    }
    const data = (await this.hub.sendRequest(agentId, { type: 'control.forkThread', requestId: randomUUID(), threadId })) as { threadId: string; title: string };
    session.activeThreadId = data.threadId;
    await this.db.upsertChatSession(session);
    await reply(`Forked into ${data.title}`);
  }

  async renameThread(chatId: number, telegramUserId: number, threadId: string, name: string, reply: (message: string) => Promise<unknown>): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.renameThread', requestId: randomUUID(), threadId, name });
    session.activeThreadId = threadId;
    await this.db.upsertChatSession(session);
    await reply(`Renamed thread to ${name}`);
  }

  async archiveThread(chatId: number, telegramUserId: number, threadId: string, reply: (message: string) => Promise<unknown>): Promise<void> {
    const session = await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.archiveThread', requestId: randomUUID(), threadId });
    if (session.activeThreadId === threadId) {
      session.activeThreadId = null;
      await this.db.upsertChatSession(session);
    }
    await reply('Thread archived.');
  }

  async stopTurn(chatId: number, telegramUserId: number, threadId: string, turnId: string, reply: (message: string) => Promise<unknown>): Promise<void> {
    await this.ensureSession(chatId, telegramUserId);
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return;
    }
    await this.hub.sendRequest(agentId, { type: 'control.interruptTurn', requestId: randomUUID(), threadId, turnId });
    await reply('Turn interrupted.');
  }

  async resolveApproval(approvalRequestId: string, decision: 'accept' | 'decline' | 'cancel', reply: (message: string) => Promise<unknown>): Promise<void> {
    const agentId = this.hub.getConnectedAgentId();
    if (!agentId) {
      await reply('Mac companion is offline.');
      return;
    }
    this.hub.send(agentId, { type: 'approval.decision', approvalRequestId, codexRequestId: approvalRequestId, decision });
    await reply(`Approval decision sent: ${decision}`);
  }

  async onAgentMessage(agentId: string, message: { type: string; [key: string]: unknown }): Promise<void> {
    if (!this.bot) return;
    if (message.type === 'turn.started') {
      const run = this.runs.get(String(message.requestId));
      if (run) {
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
          await this.bot.telegram.editMessageText(Number(run.chatId), run.telegramMessageId, undefined, 'Working on it...', {
            reply_markup: activeRunKeyboard(run.threadId, run.turnId),
          });
        }
      }
      return;
    }

    if (message.type === 'turn.delta') {
      const run = this.runs.get(String(message.requestId));
      if (!run) return;
      run.buffer += String(message.text);
      if (Date.now() - run.lastEditAt > 1000 && run.telegramMessageId) {
        run.lastEditAt = Date.now();
        const preview = chunkTelegramMessage(run.buffer, 3500)[0] || 'Working...';
        await this.bot.telegram.editMessageText(Number(run.chatId), run.telegramMessageId, undefined, preview, {
          reply_markup: run.turnId ? activeRunKeyboard(run.threadId, run.turnId) : undefined,
        }).catch(() => undefined);
      }
      return;
    }

    if (message.type === 'turn.completed') {
      const run = this.runs.get(String(message.requestId));
      if (!run) return;
      const finalText = String(message.finalText || run.buffer || 'Completed.');
      const chunks = chunkTelegramMessage(finalText);
      if (run.telegramMessageId && chunks[0]) {
        await this.bot.telegram.editMessageText(Number(run.chatId), run.telegramMessageId, undefined, chunks[0]).catch(() => undefined);
      }
      for (const chunk of chunks.slice(run.telegramMessageId ? 1 : 0)) {
        await this.bot.telegram.sendMessage(Number(run.chatId), chunk);
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
      const text = `Turn failed: ${String(message.error)}`;
      if (run.telegramMessageId) {
        await this.bot.telegram.editMessageText(Number(run.chatId), run.telegramMessageId, undefined, text).catch(() => undefined);
      } else {
        await this.bot.telegram.sendMessage(Number(run.chatId), text);
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
      await this.bot.telegram.sendMessage(Number(chatId), `${summarizeApprovalKind(message.kind as never)}\n\n${String(message.summary)}`, {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Approve', callback_data: `approval:${String(message.approvalRequestId)}:accept` },
            { text: 'Deny', callback_data: `approval:${String(message.approvalRequestId)}:cancel` },
          ]],
        },
      });
    }

    if (message.type === 'control.response') {
      return;
    }
  }
}
