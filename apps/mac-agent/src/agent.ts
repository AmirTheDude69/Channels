import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type CachedThread,
  effectiveThreadRuntime,
  type RuntimeCatalog,
  type ThreadRuntimePreferenceInput,
  type TurnAttachment,
  type TranscriptTurn,
  assistantTextFromTranscriptTurn,
  classifyThreadProject,
  coerceThreadTitle,
  commandApprovalIsSafe,
  permissionsAreSafe,
  type ProjectRecord,
  transcriptTurnsFromThread,
} from '@channels/shared';
import { env } from './config.js';
import { CodexAppServerClient, defaultHostname, enrichThreadTitle, normalizeThreadCwd, type JsonRpcMessage } from './codex-app-server.js';
import { ControlPlaneClient } from './control-plane-client.js';
import { loadProjects } from './store.js';
import { type CodexUiRefreshSettings, refreshCodexDesktopThread } from './ui-refresh.js';

const execFileAsync = promisify(execFile);

type ActiveTurn = {
  requestId: string;
  threadId: string;
  projectId: string | null;
  turnId: string | null;
};

type PendingApproval = {
  codexRequestId: string | number;
  requestId: string;
  threadId: string;
  turnId: string;
  kind: 'command' | 'fileChange' | 'permissions';
  permissions?: { fileSystem?: { read?: string[]; write?: string[] }; network?: { enabled?: boolean } };
};

export class ChannelsAgent {
  private readonly codex: CodexAppServerClient;
  private readonly controlPlane: ControlPlaneClient;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private projects: ProjectRecord[] = [];
  private initialized = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly uiRefresh: CodexUiRefreshSettings;

  constructor(private readonly serverUrl: string, options?: { uiRefresh?: CodexUiRefreshSettings }) {
    this.codex = new CodexAppServerClient(env.CHANNELS_CODEX_APP_SERVER_URL, env.CHANNELS_CODEX_APP_SERVER_PORT);
    this.controlPlane = new ControlPlaneClient(serverUrl);
    this.uiRefresh = options?.uiRefresh ?? {
      enabled: false,
      strategy: 'deeplink-activate',
      openWhenClosed: false,
    };
    this.controlPlane.onMessage(async (message) => {
      await this.handleControlMessage(message);
    });
  }

  async connect(query: Record<string, string>): Promise<void> {
    this.projects = await loadProjects();
    if (!this.initialized) {
      await this.codex.connect();
      this.codex.onNotification(async (message) => {
        await this.handleCodexNotification(message);
      });
      this.initialized = true;
    }
    await this.controlPlane.connect(query);
    this.controlPlane.send({
      type: 'agent.hello',
      agentVersion: '0.1.0',
      hostname: defaultHostname(),
      platform: process.platform,
      pairedAt: new Date().toISOString(),
    });
    await this.syncAll();
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.controlPlane.send({
          type: 'agent.heartbeat',
          connectedAt: new Date().toISOString(),
          threadCount: 0,
          projectCount: this.projects.length,
          activeTurnCount: this.activeTurns.size,
        });
      }, 30_000);
      this.heartbeatTimer.unref();
    }
  }

  async waitUntilDisconnected(): Promise<void> {
    await this.controlPlane.waitUntilClosed();
  }

  private async syncAll(): Promise<void> {
    this.projects = await loadProjects();
    this.controlPlane.send({ type: 'agent.sync.projects', projects: this.projects });
    const threads = await this.listThreads();
    this.controlPlane.send({ type: 'agent.sync.threads', threads });
  }

  private async listThreads(): Promise<CachedThread[]> {
    const sessionIndex = await this.readSessionIndex();
    const response = (await this.codex.request('thread/list', { limit: 100, archived: false, sortKey: 'updated_at' })) as { data?: Array<Record<string, unknown>> };
    const data = response.data ?? [];
    return data.map((thread) => {
      const threadId = String(thread.id ?? thread.threadId);
      const cwd = normalizeThreadCwd(thread as { cwd?: string | null });
      const classification = classifyThreadProject(cwd, this.projects);
      const title = coerceThreadTitle(sessionIndex.get(threadId) ?? enrichThreadTitle(thread as { title?: string | null; firstUserMessage?: string | null }, `Thread ${threadId.slice(0, 8)}`));
      return {
        threadId,
        title,
        cwd,
        updatedAt: Number(thread.updatedAt ?? thread.updated_at ?? Date.now()),
        archived: Boolean(thread.archived ?? false),
        projectId: classification.projectId,
        legacy: classification.legacy,
        preview: String(thread.preview ?? ''),
      } satisfies CachedThread;
    });
  }

  private async readSessionIndex(): Promise<Map<string, string>> {
    const indexPath = `${process.env.HOME}/.codex/session_index.jsonl`;
    try {
      const { stdout } = await execFileAsync('sh', ['-lc', `cat ${JSON.stringify(indexPath)} 2>/dev/null || true`]);
      const map = new Map<string, string>();
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as { id: string; thread_name?: string };
        if (parsed.id && parsed.thread_name) {
          map.set(parsed.id, parsed.thread_name);
        }
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async handleControlMessage(message: { type: string; [key: string]: unknown }): Promise<void> {
    if (message.type === 'control.syncNow') {
      await this.syncAll();
      return;
    }

    if (message.type === 'approval.decision') {
      const pending = this.pendingApprovals.get(String(message.approvalRequestId));
      if (!pending) return;
      const decision = String(message.decision);
      if (pending.kind === 'permissions') {
        this.codex.sendResponse(pending.codexRequestId, {
          permissions: decision === 'accept' ? pending.permissions ?? {} : {},
          scope: 'turn',
        });
      } else {
        this.codex.sendResponse(pending.codexRequestId, { decision });
      }
      this.controlPlane.send({ type: 'approval.resolved', approvalRequestId: String(message.approvalRequestId), decision: decision === 'accept' ? 'accept' : decision === 'decline' ? 'decline' : 'cancel' });
      this.pendingApprovals.delete(String(message.approvalRequestId));
      return;
    }

    const request = message as { type: string; requestId: string };
    try {
      switch (message.type) {
        case 'control.listThreads': {
          const threads = await this.listThreads();
          const projectId = String(message.projectId ?? '') || null;
          this.controlPlane.sendResponse(request.requestId, true, {
            threads: projectId ? threads.filter((thread) => thread.projectId === projectId || thread.legacy) : threads,
          });
          break;
        }
        case 'control.readThread': {
          const history = await this.readThreadHistory(String(message.threadId), Number(message.limitTurns ?? 4));
          this.controlPlane.sendResponse(request.requestId, true, history);
          break;
        }
        case 'control.getRuntimeCatalog': {
          const runtimeCatalog = await this.readRuntimeCatalog();
          this.controlPlane.sendResponse(request.requestId, true, runtimeCatalog);
          break;
        }
        case 'control.startThread': {
          const project = this.requireProject(String(message.projectId));
          const runtimeCatalog = await this.readRuntimeCatalog();
          const result = (await this.codex.request('thread/start', {
            cwd: project.absolutePath,
            approvalPolicy: 'on-request',
            sandbox: project.sandboxProfile,
            personality: 'friendly',
            model: runtimeCatalog.defaults.model ?? 'gpt-5.4',
            serviceName: 'channels-mac-agent',
            persistExtendedHistory: true,
          })) as { thread: { id: string; title?: string | null } };
          await this.syncAll();
          this.controlPlane.sendResponse(request.requestId, true, {
            threadId: result.thread.id,
            title: coerceThreadTitle(result.thread.title ?? project.name),
          });
          break;
        }
        case 'control.resumeThread': {
          const result = (await this.codex.request('thread/resume', {
            threadId: String(message.threadId),
            personality: 'friendly',
            persistExtendedHistory: true,
          })) as { thread: { id: string; title?: string | null } };
          await this.syncAll();
          this.controlPlane.sendResponse(request.requestId, true, { threadId: result.thread.id, title: coerceThreadTitle(result.thread.title ?? 'Thread') });
          break;
        }
        case 'control.forkThread': {
          const result = (await this.codex.request('thread/fork', {
            threadId: String(message.threadId),
            approvalPolicy: 'on-request',
            persistExtendedHistory: true,
          })) as { thread: { id: string; title?: string | null } };
          await this.syncAll();
          this.controlPlane.sendResponse(request.requestId, true, { threadId: result.thread.id, title: coerceThreadTitle(result.thread.title ?? 'Forked thread') });
          break;
        }
        case 'control.renameThread': {
          await this.codex.request('thread/name/set', { threadId: String(message.threadId), name: String(message.name) });
          await this.syncAll();
          this.controlPlane.sendResponse(request.requestId, true, { threadId: String(message.threadId), title: String(message.name) });
          break;
        }
        case 'control.archiveThread': {
          await this.codex.request('thread/archive', { threadId: String(message.threadId) });
          await this.syncAll();
          this.controlPlane.sendResponse(request.requestId, true, { threadId: String(message.threadId) });
          break;
        }
        case 'control.runTurn': {
          const threadId = String(message.threadId);
          const project = message.projectId ? this.projects.find((item) => item.projectId === String(message.projectId)) ?? null : null;
          const runtimeCatalog = await this.readRuntimeCatalog();
          const runtime = effectiveThreadRuntime(runtimeCatalog, (message.runtime as Partial<ThreadRuntimePreferenceInput> | undefined) ?? null);
          await this.applyFastMode(runtime.speed === '2x');
          const input = await this.buildTurnInput(
            threadId,
            String(message.prompt),
            Array.isArray(message.attachments) ? (message.attachments as TurnAttachment[]) : [],
            project,
          );
          await this.codex.request('thread/resume', { threadId, personality: 'friendly', persistExtendedHistory: true }).catch(() => undefined);
          this.activeTurns.set(threadId, { requestId: request.requestId, threadId, projectId: project?.projectId ?? null, turnId: null });
          const turnRequest: Record<string, unknown> = {
            threadId,
            cwd: project?.absolutePath ?? null,
            approvalsReviewer: 'user',
            approvalPolicy: 'on-request',
            personality: 'friendly',
            input,
          };
          if (runtime.planMode) {
            turnRequest.collaborationMode = {
              mode: 'plan',
              settings: {
                model: runtime.model,
                reasoning_effort: runtime.reasoningEffort ?? runtimeCatalog.defaults.planModeReasoningEffort ?? 'medium',
                developer_instructions: null,
              },
            };
          } else {
            turnRequest.model = runtime.model;
            turnRequest.reasoningEffort = runtime.reasoningEffort;
          }
          await this.codex.request('turn/start', turnRequest);
          this.controlPlane.sendResponse(request.requestId, true, { accepted: true });
          void this.maybeRefreshCodexDesktopThread(threadId, 'turn started');
          break;
        }
        case 'control.interruptTurn': {
          await this.codex.request('turn/interrupt', { threadId: String(message.threadId), turnId: String(message.turnId) });
          this.controlPlane.sendResponse(request.requestId, true, { interrupted: true });
          break;
        }
        default:
          this.controlPlane.sendResponse(request.requestId, false, undefined, `Unsupported control message: ${message.type}`);
      }
    } catch (error) {
      this.controlPlane.sendResponse(request.requestId, false, undefined, (error as Error).message);
    }
  }

  private async handleCodexNotification(message: JsonRpcMessage): Promise<void> {
    if (!message.method) return;
    if (message.method === 'turn/started') {
      const params = message.params as { threadId: string; turn: { id: string } };
      const active = this.activeTurns.get(params.threadId);
      if (!active) return;
      active.turnId = params.turn.id;
      this.controlPlane.send({ type: 'turn.started', requestId: active.requestId, threadId: params.threadId, turnId: params.turn.id });
      return;
    }
    if (message.method === 'item/agentMessage/delta') {
      const params = message.params as { threadId: string; turnId: string; itemId: string; delta: string };
      const active = this.activeTurns.get(params.threadId);
      if (!active) return;
      this.controlPlane.send({ type: 'turn.delta', requestId: active.requestId, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, text: params.delta });
      return;
    }
    if (message.method === 'item/completed') {
      const params = message.params as { threadId: string; turnId: string; item: unknown };
      const active = this.activeTurns.get(params.threadId);
      if (!active) return;
      this.controlPlane.send({ type: 'turn.itemCompleted', requestId: active.requestId, threadId: params.threadId, turnId: params.turnId, item: params.item });
      return;
    }
    if (message.method === 'turn/completed') {
      const params = message.params as { threadId: string; turn: { id: string } };
      const active = this.activeTurns.get(params.threadId);
      if (!active) return;
      const history = await this.readThreadHistory(params.threadId, 1, params.turn.id).catch(() => null);
      const finalText = assistantTextFromTranscriptTurn(history?.turns.at(-1)) || 'Completed.';
      this.controlPlane.send({ type: 'turn.completed', requestId: active.requestId, threadId: params.threadId, turnId: params.turn.id, finalText });
      this.activeTurns.delete(params.threadId);
      void this.maybeRefreshCodexDesktopThread(params.threadId, 'turn completed');
      await this.syncAll();
      return;
    }
    if (message.method === 'error') {
      const activeTurns = Array.from(this.activeTurns.values());
      for (const active of activeTurns) {
        this.controlPlane.send({ type: 'turn.failed', requestId: active.requestId, threadId: active.threadId, turnId: active.turnId ?? undefined, error: JSON.stringify(message.params ?? {}) });
      }
      return;
    }
    if (message.method === 'item/commandExecution/requestApproval') {
      const params = message.params as { threadId: string; turnId: string; cwd?: string | null; reason?: string | null; command?: string | null; networkApprovalContext?: unknown; proposedNetworkPolicyAmendments?: unknown; id?: string };
      await this.handleCommandApproval(message.id!, params);
      return;
    }
    if (message.method === 'item/fileChange/requestApproval') {
      const params = message.params as { threadId: string; turnId: string; reason?: string | null };
      await this.handleFileChangeApproval(message.id!, params);
      return;
    }
    if (message.method === 'item/permissions/requestApproval') {
      const params = message.params as { threadId: string; turnId: string; permissions?: { fileSystem?: { read?: string[]; write?: string[] }; network?: { enabled?: boolean } }; reason?: string | null };
      await this.handlePermissionsApproval(message.id!, params);
      return;
    }
  }

  private async handleCommandApproval(codexRequestId: string | number, params: { threadId: string; turnId: string; cwd?: string | null; reason?: string | null; command?: string | null; networkApprovalContext?: unknown }): Promise<void> {
    const active = this.activeTurns.get(params.threadId);
    const project = active?.projectId ? this.projects.find((item) => item.projectId === active.projectId) ?? null : null;
    const safe = commandApprovalIsSafe({
      cwd: params.cwd,
      project,
      networkRequested: Boolean(params.networkApprovalContext),
    });
    if (safe) {
      this.codex.sendResponse(codexRequestId, { decision: 'accept' });
      return;
    }
    const approvalRequestId = randomUUID();
    this.pendingApprovals.set(approvalRequestId, {
      codexRequestId,
      requestId: active?.requestId ?? approvalRequestId,
      threadId: params.threadId,
      turnId: params.turnId,
      kind: 'command',
    });
    this.controlPlane.send({
      type: 'approval.requested',
      approvalRequestId,
      codexRequestId: String(codexRequestId),
      requestId: active?.requestId ?? approvalRequestId,
      threadId: params.threadId,
      turnId: params.turnId,
      kind: 'command',
      summary: `${params.reason ?? 'Codex requested approval'}\n${params.command ?? ''}`.trim(),
      details: { cwd: params.cwd ?? null },
    });
  }

  private async handleFileChangeApproval(codexRequestId: string | number, params: { threadId: string; turnId: string; reason?: string | null }): Promise<void> {
    const active = this.activeTurns.get(params.threadId);
    const project = active?.projectId ? this.projects.find((item) => item.projectId === active.projectId) ?? null : null;
    if (project) {
      this.codex.sendResponse(codexRequestId, { decision: 'accept' });
      return;
    }
    const approvalRequestId = randomUUID();
    this.pendingApprovals.set(approvalRequestId, {
      codexRequestId,
      requestId: active?.requestId ?? approvalRequestId,
      threadId: params.threadId,
      turnId: params.turnId,
      kind: 'fileChange',
    });
    this.controlPlane.send({
      type: 'approval.requested',
      approvalRequestId,
      codexRequestId: String(codexRequestId),
      requestId: active?.requestId ?? approvalRequestId,
      threadId: params.threadId,
      turnId: params.turnId,
      kind: 'fileChange',
      summary: params.reason ?? 'Codex wants to apply file changes',
      details: {},
    });
  }

  private async handlePermissionsApproval(codexRequestId: string | number, params: { threadId: string; turnId: string; permissions?: { fileSystem?: { read?: string[]; write?: string[] }; network?: { enabled?: boolean } }; reason?: string | null }): Promise<void> {
    const active = this.activeTurns.get(params.threadId);
    const project = active?.projectId ? this.projects.find((item) => item.projectId === active.projectId) ?? null : null;
    const safe = permissionsAreSafe(project, {
      read: params.permissions?.fileSystem?.read,
      write: params.permissions?.fileSystem?.write,
      networkEnabled: params.permissions?.network?.enabled,
    });
    if (safe) {
      this.codex.sendResponse(codexRequestId, { permissions: params.permissions ?? {}, scope: 'turn' });
      return;
    }
    const approvalRequestId = randomUUID();
    this.pendingApprovals.set(approvalRequestId, {
      codexRequestId,
      requestId: active?.requestId ?? approvalRequestId,
      threadId: params.threadId,
      turnId: params.turnId,
      kind: 'permissions',
      permissions: params.permissions,
    });
    this.controlPlane.send({
      type: 'approval.requested',
      approvalRequestId,
      codexRequestId: String(codexRequestId),
      requestId: active?.requestId ?? approvalRequestId,
      threadId: params.threadId,
      turnId: params.turnId,
      kind: 'permissions',
      summary: params.reason ?? 'Codex requested more permissions',
      details: params.permissions ?? {},
    });
  }

  private async readRuntimeCatalog(): Promise<RuntimeCatalog> {
    const [modelResponse, collaborationModesResponse, configResponse, fastModeEnabled] = await Promise.all([
      this.codex.request('model/list', {}) as Promise<{
        data?: Array<{
          id?: string;
          model?: string;
          displayName?: string | null;
          hidden?: boolean;
          supportedReasoningEfforts?: Array<{ reasoningEffort?: ThreadRuntimePreferenceInput['reasoningEffort'] | null }>;
          defaultReasoningEffort?: ThreadRuntimePreferenceInput['reasoningEffort'] | null;
          inputModalities?: string[];
        }>;
      }>,
      this.codex.request('collaborationMode/list', {}) as Promise<{
        data?: Array<{ mode?: string | null }>;
      }>,
      this.codex.request('config/read', {}) as Promise<{
        config?: {
          model?: string | null;
          model_reasoning_effort?: ThreadRuntimePreferenceInput['reasoningEffort'] | null;
          plan_mode_reasoning_effort?: ThreadRuntimePreferenceInput['reasoningEffort'] | null;
        };
      }>,
      this.readFastModeFromConfig(),
    ]);

    return {
      models: (modelResponse.data ?? [])
        .filter((model) => !model.hidden)
        .map((model) => ({
          id: String(model.id ?? model.model ?? 'unknown-model'),
          displayName: String(model.displayName ?? model.id ?? model.model ?? 'Unknown model'),
          supportedReasoningEfforts: (model.supportedReasoningEfforts ?? [])
            .map((entry) => entry.reasoningEffort)
            .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
          defaultReasoningEffort: model.defaultReasoningEffort ?? null,
          inputModalities: model.inputModalities ?? [],
        })),
      collaborationModes: (collaborationModesResponse.data ?? [])
        .map((entry) => entry.mode ?? null)
        .filter((entry): entry is string => Boolean(entry)),
      defaults: {
        model: configResponse.config?.model ?? null,
        reasoningEffort: configResponse.config?.model_reasoning_effort ?? null,
        planModeReasoningEffort: configResponse.config?.plan_mode_reasoning_effort ?? null,
        speed: fastModeEnabled ? '2x' : 'normal',
      },
    };
  }

  private async readFastModeFromConfig(): Promise<boolean> {
    try {
      const configPath = path.join(os.homedir(), '.codex', 'config.toml');
      const text = await readFile(configPath, 'utf8');
      const match = text.match(/^\s*fast_mode\s*=\s*(true|false)\s*$/m);
      return match?.[1] === 'true';
    } catch {
      return false;
    }
  }

  private async applyFastMode(enabled: boolean): Promise<void> {
    await this.codex.request('config/value/write', {
      keyPath: 'fast_mode',
      value: enabled,
      mergeStrategy: 'replace',
    });
  }

  private async buildTurnInput(
    threadId: string,
    prompt: string,
    attachments: TurnAttachment[],
    project: ProjectRecord | null,
  ): Promise<Array<Record<string, unknown>>> {
    const materialized = await this.materializeAttachments(threadId, attachments, project);
    const filePaths = materialized.filter((entry) => entry.kind === 'file').map((entry) => entry.savedPath);
    const imagePaths = materialized.filter((entry) => entry.kind === 'image').map((entry) => entry.savedPath);

    let combinedPrompt = prompt.trim();
    if (filePaths.length > 0) {
      combinedPrompt = `${combinedPrompt}\n\nAttached file${filePaths.length > 1 ? 's' : ''} saved on disk:\n${filePaths.map((filePath) => `- ${filePath}`).join('\n')}\nPlease inspect ${filePaths.length > 1 ? 'them' : 'it'} as part of this request.`.trim();
    }
    if (!combinedPrompt) {
      combinedPrompt = imagePaths.length > 0 ? 'Please inspect the attached image and help with it.' : 'Please inspect the attached files and help with them.';
    }

    return [
      { type: 'text', text: combinedPrompt },
      ...imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
    ];
  }

  private async materializeAttachments(
    threadId: string,
    attachments: TurnAttachment[],
    project: ProjectRecord | null,
  ): Promise<Array<{ kind: TurnAttachment['kind']; filename: string; savedPath: string }>> {
    if (attachments.length === 0) {
      return [];
    }

    const uploadDir = await this.resolveUploadDirectory(threadId, project);
    const saved: Array<{ kind: TurnAttachment['kind']; filename: string; savedPath: string }> = [];

    for (const attachment of attachments) {
      const filename = this.sanitizeFilename(attachment.filename);
      const savedPath = path.join(uploadDir, filename);
      await writeFile(savedPath, Buffer.from(attachment.dataBase64, 'base64'));
      saved.push({ kind: attachment.kind, filename, savedPath });
    }

    return saved;
  }

  private async resolveUploadDirectory(threadId: string, project: ProjectRecord | null): Promise<string> {
    const baseRoot = project?.absolutePath ?? await this.lookupThreadCwd(threadId) ?? os.homedir();
    const gitDir = path.join(baseRoot, '.git');
    const insideGitDir = await this.isDirectory(gitDir);
    const uploadRoot = insideGitDir ? path.join(gitDir, 'channels-uploads') : path.join(baseRoot, '.channels', 'uploads');
    const uploadDir = path.join(uploadRoot, this.sanitizeFilename(threadId));
    await mkdir(uploadDir, { recursive: true });
    return uploadDir;
  }

  private async lookupThreadCwd(threadId: string): Promise<string | null> {
    const threads = await this.listThreads();
    return threads.find((thread) => thread.threadId === threadId)?.cwd ?? null;
  }

  private sanitizeFilename(filename: string): string {
    return path.basename(filename).replace(/[^a-zA-Z0-9._-]+/g, '-');
  }

  private async isDirectory(candidatePath: string): Promise<boolean> {
    try {
      await access(candidatePath);
      return true;
    } catch {
      return false;
    }
  }

  private requireProject(projectId: string): ProjectRecord {
    const project = this.projects.find((item) => item.projectId === projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    return project;
  }

  private async readThreadHistory(threadId: string, limitTurns = 4, preferredTurnId?: string): Promise<{ threadId: string; title: string; turns: TranscriptTurn[] }> {
    const response = (await this.codex.request('thread/read', {
      threadId,
      includeTurns: true,
    })) as {
      thread: {
        id: string;
        name?: string | null;
        title?: string | null;
        preview?: string | null;
        turns?: Array<{ id?: string | null; items?: Array<{ type?: string | null; text?: string | null; phase?: string | null; content?: Array<{ type?: string | null; text?: string | null } | null> | null } | null> | null } | null>;
      };
    };

    const allTurns = transcriptTurnsFromThread(response.thread.turns ?? []);
    const selectedTurns = preferredTurnId
      ? allTurns.filter((turn) => turn.turnId === preferredTurnId)
      : [];
    const turns = selectedTurns.length > 0 ? selectedTurns : (limitTurns > 0 ? allTurns.slice(-limitTurns) : allTurns);

    return {
      threadId: response.thread.id,
      title: coerceThreadTitle(response.thread.name ?? response.thread.title ?? response.thread.preview ?? `Thread ${threadId.slice(0, 8)}`),
      turns,
    };
  }

  private async maybeRefreshCodexDesktopThread(threadId: string, reason: string): Promise<void> {
    if (!this.uiRefresh.enabled) return;
    try {
      await refreshCodexDesktopThread(threadId, this.uiRefresh);
    } catch (error) {
      console.warn(`Codex desktop UI refresh helper failed after ${reason}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
