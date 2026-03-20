import { Pool } from 'pg';
import type { ProjectRecord, CachedThread, ThreadRuntimePreference } from '@channels/shared';
import { hashToken } from '@channels/shared';
import { env, features } from './config.js';

export type PairCodeRecord = {
  code: string;
  chatId: string;
  ownerTelegramId: string;
};

export type AgentRecord = {
  agentId: string;
  tokenHash: string;
  pairedChatId: string;
};

export type ChatSession = {
  chatId: string;
  telegramUserId: string;
  activeProjectId: string | null;
  activeThreadId: string | null;
  pendingAction: string | null;
  pendingPayload: Record<string, unknown> | null;
};

export type RunRecord = {
  runId: string;
  chatId: string;
  threadId: string;
  requestId: string;
  turnId: string | null;
  telegramMessageId: number | null;
  status: string;
};

type ThreadPreferenceRow = {
  thread_id: string;
  plan_mode: boolean;
  model: string | null;
  reasoning_effort: ThreadRuntimePreference['reasoningEffort'];
  speed: ThreadRuntimePreference['speed'];
  updated_at: string;
};

type ProjectCacheRow = {
  project_id: string;
  name: string;
  sandbox_profile: ProjectRecord['sandboxProfile'];
  network_enabled: boolean;
};

type ThreadCacheRow = {
  thread_id: string;
  title: string;
  cwd: string;
  updated_at: string | number;
  archived: boolean;
  project_id: string | null;
  legacy: boolean;
  preview: string;
};

const createStatements = [
  `create table if not exists pair_codes (
    code text primary key,
    chat_id text not null,
    owner_telegram_id text not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists agents (
    agent_id text primary key,
    token_hash text not null unique,
    paired_chat_id text not null,
    hostname text,
    platform text,
    connected_at timestamptz,
    last_heartbeat_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists chat_sessions (
    chat_id text primary key,
    telegram_user_id text not null,
    active_project_id text,
    active_thread_id text,
    pending_action text,
    pending_payload jsonb,
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists project_cache (
    agent_id text not null,
    project_id text not null,
    name text not null,
    sandbox_profile text not null,
    network_enabled boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key (agent_id, project_id)
  )`,
  `create table if not exists thread_cache (
    agent_id text not null,
    thread_id text not null,
    title text not null,
    cwd text not null,
    updated_at bigint not null,
    archived boolean not null default false,
    project_id text,
    legacy boolean not null default false,
    preview text not null default '',
    primary key (agent_id, thread_id)
  )`,
  `create table if not exists thread_preferences (
    thread_id text primary key,
    plan_mode boolean not null default false,
    model text,
    reasoning_effort text,
    speed text not null default 'normal',
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists runs (
    run_id text primary key,
    chat_id text not null,
    thread_id text not null,
    request_id text not null,
    turn_id text,
    telegram_message_id integer,
    status text not null,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
  )`,
  `create table if not exists audit_log (
    id bigserial primary key,
    actor text not null,
    action text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  )`,
];

export class Database {
  private pool: Pool | null = features.hasDatabase ? new Pool({ connectionString: env.DATABASE_URL }) : null;
  private readonly memoryPairCodes = new Map<string, PairCodeRecord & { expiresAt: number; usedAt?: number }>();
  private readonly memoryAgents = new Map<string, AgentRecord & { hostname?: string; platform?: string; connectedAt?: number; heartbeatAt?: number }>();
  private readonly memorySessions = new Map<string, ChatSession>();
  private readonly memoryProjects = new Map<string, Array<Omit<ProjectRecord, 'absolutePath'>>>();
  private readonly memoryThreads = new Map<string, CachedThread[]>();
  private readonly memoryThreadPreferences = new Map<string, ThreadRuntimePreference>();
  private readonly memoryRuns = new Map<string, RunRecord>();
  private readonly memoryAudit: Array<{ actor: string; action: string; metadata: Record<string, unknown> }> = [];

  get enabled(): boolean {
    return this.pool !== null;
  }

  async init(): Promise<void> {
    if (!this.pool) return;
    for (const statement of createStatements) {
      await this.pool.query(statement);
    }
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  async createPairCode(record: PairCodeRecord, ttlSeconds: number): Promise<void> {
    if (!this.pool) {
      this.memoryPairCodes.set(record.code, { ...record, expiresAt: Date.now() + ttlSeconds * 1000 });
      return;
    }
    await this.pool.query(
      `insert into pair_codes (code, chat_id, owner_telegram_id, expires_at) values ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       on conflict (code) do update set chat_id = excluded.chat_id, owner_telegram_id = excluded.owner_telegram_id, expires_at = excluded.expires_at, used_at = null`,
      [record.code, record.chatId, record.ownerTelegramId, ttlSeconds],
    );
  }

  async consumePairCode(code: string): Promise<PairCodeRecord | null> {
    if (!this.pool) {
      const pairCode = this.memoryPairCodes.get(code);
      if (!pairCode || pairCode.usedAt || pairCode.expiresAt <= Date.now()) {
        return null;
      }
      pairCode.usedAt = Date.now();
      return { code: pairCode.code, chatId: pairCode.chatId, ownerTelegramId: pairCode.ownerTelegramId };
    }
    const result = await this.pool.query(
      `update pair_codes set used_at = now()
       where code = $1 and used_at is null and expires_at > now()
       returning code, chat_id, owner_telegram_id`,
      [code],
    );
    return result.rows[0]
      ? {
          code: result.rows[0].code,
          chatId: result.rows[0].chat_id,
          ownerTelegramId: result.rows[0].owner_telegram_id,
        }
      : null;
  }

  async upsertAgent(args: { agentId: string; token: string; pairedChatId: string; hostname?: string; platform?: string }): Promise<AgentRecord> {
    if (!this.pool) {
      const agent = { agentId: args.agentId, tokenHash: hashToken(args.token), pairedChatId: args.pairedChatId, hostname: args.hostname, platform: args.platform, connectedAt: Date.now() };
      this.memoryAgents.set(args.agentId, agent);
      return agent;
    }
    const tokenHash = hashToken(args.token);
    await this.pool.query(
      `insert into agents (agent_id, token_hash, paired_chat_id, hostname, platform, connected_at, updated_at)
       values ($1, $2, $3, $4, $5, now(), now())
       on conflict (agent_id) do update set token_hash = excluded.token_hash, paired_chat_id = excluded.paired_chat_id, hostname = excluded.hostname, platform = excluded.platform, connected_at = now(), updated_at = now()`,
      [args.agentId, tokenHash, args.pairedChatId, args.hostname ?? null, args.platform ?? null],
    );
    return { agentId: args.agentId, tokenHash, pairedChatId: args.pairedChatId };
  }

  async findAgentByToken(token: string): Promise<AgentRecord | null> {
    if (!this.pool) {
      const tokenHash = hashToken(token);
      for (const agent of this.memoryAgents.values()) {
        if (agent.tokenHash === tokenHash) {
          return { agentId: agent.agentId, tokenHash: agent.tokenHash, pairedChatId: agent.pairedChatId };
        }
      }
      return null;
    }
    const result = await this.pool.query(`select agent_id, token_hash, paired_chat_id from agents where token_hash = $1`, [hashToken(token)]);
    return result.rows[0]
      ? { agentId: result.rows[0].agent_id, tokenHash: result.rows[0].token_hash, pairedChatId: result.rows[0].paired_chat_id }
      : null;
  }

  async touchAgentHeartbeat(agentId: string, hostname?: string, platform?: string): Promise<void> {
    if (!this.pool) {
      const agent = this.memoryAgents.get(agentId);
      if (agent) {
        agent.hostname = hostname ?? agent.hostname;
        agent.platform = platform ?? agent.platform;
        agent.heartbeatAt = Date.now();
      }
      return;
    }
    await this.pool.query(`update agents set last_heartbeat_at = now(), hostname = coalesce($2, hostname), platform = coalesce($3, platform), updated_at = now() where agent_id = $1`, [agentId, hostname ?? null, platform ?? null]);
  }

  async getChatSession(chatId: string): Promise<ChatSession | null> {
    if (!this.pool) {
      return this.memorySessions.get(chatId) ?? null;
    }
    const result = await this.pool.query(`select * from chat_sessions where chat_id = $1`, [chatId]);
    return result.rows[0]
      ? {
          chatId: result.rows[0].chat_id,
          telegramUserId: result.rows[0].telegram_user_id,
          activeProjectId: result.rows[0].active_project_id,
          activeThreadId: result.rows[0].active_thread_id,
          pendingAction: result.rows[0].pending_action,
          pendingPayload: result.rows[0].pending_payload,
        }
      : null;
  }

  async upsertChatSession(session: ChatSession): Promise<void> {
    if (!this.pool) {
      this.memorySessions.set(session.chatId, structuredClone(session));
      return;
    }
    await this.pool.query(
      `insert into chat_sessions (chat_id, telegram_user_id, active_project_id, active_thread_id, pending_action, pending_payload, updated_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, now())
       on conflict (chat_id) do update set telegram_user_id = excluded.telegram_user_id, active_project_id = excluded.active_project_id, active_thread_id = excluded.active_thread_id, pending_action = excluded.pending_action, pending_payload = excluded.pending_payload, updated_at = now()`,
      [session.chatId, session.telegramUserId, session.activeProjectId, session.activeThreadId, session.pendingAction, JSON.stringify(session.pendingPayload ?? null)],
    );
  }

  async setPendingAction(chatId: string, action: string | null, payload: Record<string, unknown> | null): Promise<void> {
    if (!this.pool) {
      const session = this.memorySessions.get(chatId);
      if (session) {
        session.pendingAction = action;
        session.pendingPayload = payload;
      }
      return;
    }
    await this.pool.query(`update chat_sessions set pending_action = $2, pending_payload = $3::jsonb, updated_at = now() where chat_id = $1`, [chatId, action, JSON.stringify(payload)]);
  }

  async replaceProjects(agentId: string, projects: ProjectRecord[]): Promise<void> {
    if (!this.pool) {
      this.memoryProjects.set(
        agentId,
        projects.map((project) => ({
          projectId: project.projectId,
          name: project.name,
          sandboxProfile: project.sandboxProfile,
          networkEnabled: project.networkEnabled,
        })),
      );
      return;
    }
    await this.pool.query('delete from project_cache where agent_id = $1', [agentId]);
    for (const project of projects) {
      await this.pool.query(
        `insert into project_cache (agent_id, project_id, name, sandbox_profile, network_enabled)
         values ($1, $2, $3, $4, $5)
         on conflict (agent_id, project_id) do update
         set name = excluded.name,
             sandbox_profile = excluded.sandbox_profile,
             network_enabled = excluded.network_enabled,
             updated_at = now()`,
        [agentId, project.projectId, project.name, project.sandboxProfile, project.networkEnabled],
      );
    }
  }

  async listProjects(agentId: string): Promise<Array<Omit<ProjectRecord, 'absolutePath'>>> {
    if (!this.pool) return this.memoryProjects.get(agentId) ?? [];
    const result = await this.pool.query<ProjectCacheRow>(`select project_id, name, sandbox_profile, network_enabled from project_cache where agent_id = $1 order by name asc`, [agentId]);
    return result.rows.map((row) => ({
      projectId: row.project_id,
      name: row.name,
      sandboxProfile: row.sandbox_profile,
      networkEnabled: row.network_enabled,
    }));
  }

  async replaceThreads(agentId: string, threads: CachedThread[]): Promise<void> {
    if (!this.pool) {
      this.memoryThreads.set(agentId, structuredClone(threads));
      return;
    }
    await this.pool.query('delete from thread_cache where agent_id = $1', [agentId]);
    for (const thread of threads) {
      await this.pool.query(
        `insert into thread_cache (agent_id, thread_id, title, cwd, updated_at, archived, project_id, legacy, preview)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (agent_id, thread_id) do update
         set title = excluded.title,
             cwd = excluded.cwd,
             updated_at = excluded.updated_at,
             archived = excluded.archived,
             project_id = excluded.project_id,
             legacy = excluded.legacy,
             preview = excluded.preview`,
        [agentId, thread.threadId, thread.title, thread.cwd, thread.updatedAt, thread.archived, thread.projectId, thread.legacy, thread.preview],
      );
    }
  }

  async listThreads(agentId: string, projectId: string | null): Promise<CachedThread[]> {
    if (!this.pool) {
      const threads = this.memoryThreads.get(agentId) ?? [];
      return projectId ? threads.filter((thread) => thread.projectId === projectId || thread.legacy).slice(0, 25) : threads.slice(0, 25);
    }
    const result = projectId
      ? await this.pool.query<ThreadCacheRow>(`select * from thread_cache where agent_id = $1 and (project_id = $2 or legacy = true) order by updated_at desc limit 25`, [agentId, projectId])
      : await this.pool.query<ThreadCacheRow>(`select * from thread_cache where agent_id = $1 order by updated_at desc limit 25`, [agentId]);
    return result.rows.map((row) => ({
      threadId: row.thread_id,
      title: row.title,
      cwd: row.cwd,
      updatedAt: Number(row.updated_at),
      archived: row.archived,
      projectId: row.project_id,
      legacy: row.legacy,
      preview: row.preview,
    }));
  }

  async getThread(agentId: string, threadId: string): Promise<CachedThread | null> {
    if (!this.pool) {
      return (this.memoryThreads.get(agentId) ?? []).find((thread) => thread.threadId === threadId) ?? null;
    }
    const result = await this.pool.query(`select * from thread_cache where agent_id = $1 and thread_id = $2`, [agentId, threadId]);
    const row = result.rows[0];
    return row
      ? {
          threadId: row.thread_id,
          title: row.title,
          cwd: row.cwd,
          updatedAt: Number(row.updated_at),
          archived: row.archived,
          projectId: row.project_id,
          legacy: row.legacy,
          preview: row.preview,
        }
      : null;
  }

  async getThreadPreference(threadId: string): Promise<ThreadRuntimePreference | null> {
    if (!this.pool) {
      return this.memoryThreadPreferences.get(threadId) ?? null;
    }

    const result = await this.pool.query<ThreadPreferenceRow>(`select * from thread_preferences where thread_id = $1`, [threadId]);
    const row = result.rows[0];
    return row
      ? {
          threadId: row.thread_id,
          planMode: row.plan_mode,
          model: row.model,
          reasoningEffort: row.reasoning_effort,
          speed: row.speed,
          updatedAt: row.updated_at,
        }
      : null;
  }

  async upsertThreadPreference(preference: ThreadRuntimePreference): Promise<ThreadRuntimePreference> {
    const saved: ThreadRuntimePreference = {
      ...preference,
      updatedAt: preference.updatedAt ?? new Date().toISOString(),
    };

    if (!this.pool) {
      this.memoryThreadPreferences.set(preference.threadId, structuredClone(saved));
      return saved;
    }

    const result = await this.pool.query<ThreadPreferenceRow>(
      `insert into thread_preferences (thread_id, plan_mode, model, reasoning_effort, speed, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (thread_id) do update
       set plan_mode = excluded.plan_mode,
           model = excluded.model,
           reasoning_effort = excluded.reasoning_effort,
           speed = excluded.speed,
           updated_at = now()
       returning *`,
      [preference.threadId, preference.planMode, preference.model, preference.reasoningEffort, preference.speed],
    );

    const row = result.rows[0];
    return {
      threadId: row.thread_id,
      planMode: row.plan_mode,
      model: row.model,
      reasoningEffort: row.reasoning_effort,
      speed: row.speed,
      updatedAt: row.updated_at,
    };
  }

  async upsertRun(run: RunRecord): Promise<void> {
    if (!this.pool) {
      this.memoryRuns.set(run.runId, structuredClone(run));
      return;
    }
    await this.pool.query(
      `insert into runs (run_id, chat_id, thread_id, request_id, turn_id, telegram_message_id, status, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (run_id) do update set turn_id = excluded.turn_id, telegram_message_id = excluded.telegram_message_id, status = excluded.status, updated_at = now()`,
      [run.runId, run.chatId, run.threadId, run.requestId, run.turnId, run.telegramMessageId, run.status],
    );
  }

  async log(actor: string, action: string, metadata: Record<string, unknown> = {}): Promise<void> {
    if (!this.pool) {
      this.memoryAudit.push({ actor, action, metadata });
      return;
    }
    await this.pool.query(`insert into audit_log (actor, action, metadata) values ($1, $2, $3::jsonb)`, [actor, action, JSON.stringify(metadata)]);
  }
}
