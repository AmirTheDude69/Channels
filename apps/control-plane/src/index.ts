import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type { Update } from 'telegraf/types';
import { Database } from './db.js';
import { env, features } from './config.js';
import { AgentHub } from './agent-hub.js';
import { BotController } from './bot.js';
import { createOpaqueToken } from '@channels/shared';

const app = Fastify({ logger: true });
const db = new Database();
let botController: BotController;
let hub: AgentHub;

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown; status?: unknown; code?: unknown; type?: unknown; description?: unknown };
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
    };
  }

  return { value: error };
}

async function main(): Promise<void> {
  await db.init();
  await app.register(websocket);

  hub = new AgentHub(app.log, db, {
    onMessage: async (agentId, message) => {
      await botController.onAgentMessage(agentId, message);
    },
  });
  botController = new BotController(db, hub);

  app.get('/health', async () => ({ ok: true, database: db.enabled, telegram: features.hasTelegram, agentConnected: Boolean(hub.getConnectedAgentId()) }));
  app.get('/ready', async () => ({ ok: true }));

  app.get('/ws/agent', { websocket: true }, async (socket, request) => {
    const query = request.query as { token?: string; pairCode?: string; agentName?: string };
    let agentId: string | null = null;

    if (query.pairCode) {
      const pair = await db.consumePairCode(query.pairCode);
      if (!pair) {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid or expired pair code' }));
        socket.close();
        return;
      }
      agentId = randomUUID();
      const token = createOpaqueToken();
      await db.upsertAgent({ agentId, token, pairedChatId: pair.chatId });
      socket.send(JSON.stringify({ type: 'agent.paired', agentId, token }));
      await db.log('agent', 'paired', { agentId, chatId: pair.chatId });
    } else if (query.token) {
      const agent = await db.findAgentByToken(query.token);
      if (!agent) {
        socket.send(JSON.stringify({ type: 'error', error: 'Invalid agent token' }));
        socket.close();
        return;
      }
      agentId = agent.agentId;
    } else {
      socket.send(JSON.stringify({ type: 'error', error: 'Missing token or pairCode' }));
      socket.close();
      return;
    }

    hub.register(agentId, socket as unknown as import('ws').WebSocket);
    socket.send(JSON.stringify({ type: 'control.syncNow' }));
  });

  if (botController.bot) {
    const webhookPath = `/telegram/webhook/${env.TELEGRAM_WEBHOOK_SECRET}`;
    app.post(webhookPath, async (request, reply) => {
      try {
        await botController.bot!.handleUpdate(request.body as Update);
        await reply.code(200).send({ ok: true });
      } catch (error) {
        request.log.error({ error: serializeError(error) }, 'Telegram webhook failed');
        await reply.code(500).send({ ok: false });
      }
    });
    if (env.PUBLIC_BASE_URL) {
      try {
        await botController.bot.telegram.setWebhook(`${env.PUBLIC_BASE_URL}${webhookPath}`);
        app.log.info('Telegram webhook configured');
      } catch (error) {
        app.log.warn({ error }, 'Failed to set Telegram webhook');
      }
    }
  } else {
    app.log.warn('Telegram integration disabled until TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID are configured');
  }

  const close = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((error) => {
  app.log.error({ error }, 'Control plane failed to start');
  process.exit(1);
});
