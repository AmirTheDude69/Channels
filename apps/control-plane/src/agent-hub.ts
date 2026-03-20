import { randomUUID } from 'node:crypto';
import type WebSocket from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from './db.js';
import {
  type AgentInboundMessage,
  type CachedThread,
  type ControlRequest,
  type ControlResponse,
  type ProjectRecord,
  agentInboundMessageSchema,
  controlOutboundMessageSchema,
} from '@channels/shared';

type ConnectedAgent = {
  agentId: string;
  socket: WebSocket;
  connectedAt: number;
  hostname?: string;
  platform?: string;
};

type HubEvents = {
  onMessage?: (agentId: string, message: AgentInboundMessage) => Promise<void> | void;
};

export class AgentHub {
  private readonly agents = new Map<string, ConnectedAgent>();
  private readonly pending = new Map<string, { resolve: (value: ControlResponse['data']) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly db: Database,
    private readonly events: HubEvents,
  ) {}

  register(agentId: string, socket: WebSocket): void {
    this.agents.set(agentId, { agentId, socket, connectedAt: Date.now() });
    socket.on('message', async (payload) => {
      try {
        const parsed = agentInboundMessageSchema.parse(JSON.parse(String(payload)));
        if (parsed.type === 'control.response') {
          const pending = this.pending.get(parsed.requestId);
          if (pending) {
            clearTimeout(pending.timeout);
            this.pending.delete(parsed.requestId);
            if (parsed.ok) {
              pending.resolve(parsed.data);
            } else {
              pending.reject(new Error(parsed.error ?? 'Unknown agent error'));
            }
          }
        }
        if (parsed.type === 'agent.hello' || parsed.type === 'agent.heartbeat') {
          const agent = this.agents.get(agentId);
          if (agent && parsed.type === 'agent.hello') {
            agent.hostname = parsed.hostname;
            agent.platform = parsed.platform;
          }
          await this.db.touchAgentHeartbeat(agentId, agent?.hostname, agent?.platform);
        }
        if (parsed.type === 'agent.sync.projects') {
          await this.db.replaceProjects(agentId, parsed.projects);
        }
        if (parsed.type === 'agent.sync.threads') {
          await this.db.replaceThreads(agentId, parsed.threads);
        }
        await this.events.onMessage?.(agentId, parsed);
      } catch (error) {
        this.logger.error({ error }, 'Failed to process agent message');
      }
    });
    socket.on('close', () => {
      this.agents.delete(agentId);
    });
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
  }

  isConnected(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  getConnectedAgentId(): string | null {
    return this.agents.keys().next().value ?? null;
  }

  async sendRequest<T = unknown>(agentId: string, message: ControlRequest, timeoutMs = 30_000): Promise<T> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Mac agent is offline');
    controlOutboundMessageSchema.parse(message);
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(message.requestId);
        reject(new Error(`Timed out waiting for ${message.type}`));
      }, timeoutMs);
      this.pending.set(message.requestId, { resolve: resolve as (value: ControlResponse['data']) => void, reject, timeout });
      agent.socket.send(JSON.stringify(message));
    });
  }

  send(agentId: string, payload: unknown): void {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Mac agent is offline');
    controlOutboundMessageSchema.parse(payload);
    agent.socket.send(JSON.stringify(payload));
  }

  nextRequestId(): string {
    return randomUUID();
  }

  async listProjects(agentId: string): Promise<Array<Omit<ProjectRecord, 'absolutePath'>>> {
    return await this.db.listProjects(agentId);
  }

  async listThreads(agentId: string, projectId: string | null): Promise<CachedThread[]> {
    return await this.db.listThreads(agentId, projectId);
  }
}
