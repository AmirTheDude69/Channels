import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

export const sandboxProfileSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export const reasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export const speedModeSchema = z.enum(['normal', '2x']);

export const projectRecordSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  absolutePath: z.string().min(1),
  sandboxProfile: sandboxProfileSchema.default('workspace-write'),
  networkEnabled: z.boolean().default(false),
});

export type ProjectRecord = z.infer<typeof projectRecordSchema>;

export const cachedThreadSchema = z.object({
  threadId: z.string().min(1),
  title: z.string().min(1),
  cwd: z.string().min(1),
  updatedAt: z.number().int(),
  archived: z.boolean().default(false),
  projectId: z.string().nullable().default(null),
  legacy: z.boolean().default(false),
  preview: z.string().default(''),
});

export type CachedThread = z.infer<typeof cachedThreadSchema>;

export const transcriptEntrySchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1),
});

export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

export const transcriptTurnSchema = z.object({
  turnId: z.string(),
  entries: z.array(transcriptEntrySchema),
});

export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

export const threadRuntimePreferenceSchema = z.object({
  threadId: z.string().min(1),
  planMode: z.boolean().default(false),
  model: z.string().nullable().default(null),
  reasoningEffort: reasoningEffortSchema.nullable().default(null),
  speed: speedModeSchema.default('normal'),
  updatedAt: z.string().optional(),
});

export type ThreadRuntimePreference = z.infer<typeof threadRuntimePreferenceSchema>;

export const threadRuntimePreferenceInputSchema = threadRuntimePreferenceSchema.omit({
  threadId: true,
  updatedAt: true,
});

export type ThreadRuntimePreferenceInput = z.infer<typeof threadRuntimePreferenceInputSchema>;

export const runtimeModelSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  supportedReasoningEfforts: z.array(reasoningEffortSchema).default([]),
  defaultReasoningEffort: reasoningEffortSchema.nullable().default(null),
  inputModalities: z.array(z.string()).default([]),
});

export type RuntimeModel = z.infer<typeof runtimeModelSchema>;

export const runtimeCatalogSchema = z.object({
  models: z.array(runtimeModelSchema),
  collaborationModes: z.array(z.string()).default([]),
  defaults: z.object({
    model: z.string().nullable().default(null),
    reasoningEffort: reasoningEffortSchema.nullable().default(null),
    planModeReasoningEffort: reasoningEffortSchema.nullable().default(null),
    speed: speedModeSchema.default('normal'),
  }),
});

export type RuntimeCatalog = z.infer<typeof runtimeCatalogSchema>;

export const turnAttachmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('image'),
    filename: z.string().min(1),
    mediaType: z.string().default('image/jpeg'),
    dataBase64: z.string().min(1),
  }),
  z.object({
    kind: z.literal('file'),
    filename: z.string().min(1),
    mediaType: z.string().default('application/octet-stream'),
    dataBase64: z.string().min(1),
  }),
]);

export type TurnAttachment = z.infer<typeof turnAttachmentSchema>;

export const controlRequestNameSchema = z.enum([
  'control.listThreads',
  'control.readThread',
  'control.getRuntimeCatalog',
  'control.startThread',
  'control.resumeThread',
  'control.forkThread',
  'control.renameThread',
  'control.archiveThread',
  'control.runTurn',
  'control.interruptTurn',
]);

export const controlRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('control.listThreads'), requestId: z.string(), projectId: z.string().nullable().optional() }),
  z.object({ type: z.literal('control.readThread'), requestId: z.string(), threadId: z.string(), limitTurns: z.number().int().positive().max(20).optional() }),
  z.object({ type: z.literal('control.getRuntimeCatalog'), requestId: z.string() }),
  z.object({ type: z.literal('control.startThread'), requestId: z.string(), projectId: z.string() }),
  z.object({ type: z.literal('control.resumeThread'), requestId: z.string(), threadId: z.string(), projectId: z.string().nullable().optional() }),
  z.object({ type: z.literal('control.forkThread'), requestId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal('control.renameThread'), requestId: z.string(), threadId: z.string(), name: z.string().min(1) }),
  z.object({ type: z.literal('control.archiveThread'), requestId: z.string(), threadId: z.string() }),
  z.object({
    type: z.literal('control.runTurn'),
    requestId: z.string(),
    threadId: z.string(),
    projectId: z.string().nullable().optional(),
    prompt: z.string().min(1),
    chatId: z.string().optional(),
    attachments: z.array(turnAttachmentSchema).default([]),
    runtime: threadRuntimePreferenceInputSchema.optional(),
  }),
  z.object({
    type: z.literal('control.interruptTurn'),
    requestId: z.string(),
    threadId: z.string(),
    turnId: z.string(),
  }),
]);

export type ControlRequest = z.infer<typeof controlRequestSchema>;

export const controlResponseSchema = z.object({
  type: z.literal('control.response'),
  requestId: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

export type ControlResponse = z.infer<typeof controlResponseSchema>;

export const agentHelloSchema = z.object({
  type: z.literal('agent.hello'),
  agentVersion: z.string(),
  hostname: z.string(),
  platform: z.string(),
  pairedAt: z.string().optional(),
});

export const agentHeartbeatSchema = z.object({
  type: z.literal('agent.heartbeat'),
  connectedAt: z.string(),
  threadCount: z.number().int().nonnegative(),
  projectCount: z.number().int().nonnegative(),
  activeTurnCount: z.number().int().nonnegative(),
});

export const agentProjectsSyncSchema = z.object({
  type: z.literal('agent.sync.projects'),
  projects: z.array(projectRecordSchema),
});

export const agentThreadsSyncSchema = z.object({
  type: z.literal('agent.sync.threads'),
  threads: z.array(cachedThreadSchema),
});

export const turnStartedSchema = z.object({
  type: z.literal('turn.started'),
  requestId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  title: z.string().optional(),
});

export const turnDeltaSchema = z.object({
  type: z.literal('turn.delta'),
  requestId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  itemId: z.string(),
  text: z.string(),
});

export const turnItemCompletedSchema = z.object({
  type: z.literal('turn.itemCompleted'),
  requestId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  item: z.unknown(),
});

export const turnCompletedSchema = z.object({
  type: z.literal('turn.completed'),
  requestId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  finalText: z.string(),
  usage: z.record(z.string(), z.unknown()).optional(),
});

export const turnFailedSchema = z.object({
  type: z.literal('turn.failed'),
  requestId: z.string(),
  threadId: z.string(),
  turnId: z.string().optional(),
  error: z.string(),
});

export const approvalRequestedSchema = z.object({
  type: z.literal('approval.requested'),
  approvalRequestId: z.string(),
  codexRequestId: z.string(),
  requestId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  kind: z.enum(['command', 'fileChange', 'permissions', 'toolInput']),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const approvalResolvedSchema = z.object({
  type: z.literal('approval.resolved'),
  approvalRequestId: z.string(),
  decision: z.enum(['accept', 'decline', 'cancel', 'granted']),
});

export const agentPairedSchema = z.object({
  type: z.literal('agent.paired'),
  agentId: z.string(),
  token: z.string(),
});

export const agentInboundMessageSchema = z.discriminatedUnion('type', [
  agentHelloSchema,
  agentHeartbeatSchema,
  agentProjectsSyncSchema,
  agentThreadsSyncSchema,
  controlResponseSchema,
  turnStartedSchema,
  turnDeltaSchema,
  turnItemCompletedSchema,
  turnCompletedSchema,
  turnFailedSchema,
  approvalRequestedSchema,
  approvalResolvedSchema,
]);

export type AgentInboundMessage = z.infer<typeof agentInboundMessageSchema>;

export const controlOutboundMessageSchema = z.discriminatedUnion('type', [
  controlRequestSchema,
  z.object({ type: z.literal('control.syncNow') }),
  z.object({ type: z.literal('approval.decision'), approvalRequestId: z.string(), codexRequestId: z.string(), decision: z.enum(['accept', 'decline', 'cancel']) }),
  z.object({ type: z.literal('agent.paired'), agentId: z.string(), token: z.string() }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);

export type ControlOutboundMessage = z.infer<typeof controlOutboundMessageSchema>;

export function createPairCode(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

export function createOpaqueToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function slugifyProjectName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '') || 'project';
}

export function createProjectId(name: string, absolutePath: string): string {
  const slug = slugifyProjectName(name);
  const digest = createHash('sha1').update(path.resolve(absolutePath)).digest('hex').slice(0, 8);
  return `${slug}-${digest}`;
}

export function isPathInside(parent: string, candidate: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  if (resolvedParent === resolvedCandidate) return true;
  const relative = path.relative(resolvedParent, resolvedCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function classifyThreadProject(threadCwd: string, projects: ProjectRecord[]): { projectId: string | null; legacy: boolean } {
  const exact = projects.find((project) => path.resolve(project.absolutePath) === path.resolve(threadCwd));
  if (exact) {
    return { projectId: exact.projectId, legacy: false };
  }
  const nested = projects.find((project) => isPathInside(project.absolutePath, threadCwd));
  if (nested) {
    return { projectId: nested.projectId, legacy: false };
  }
  const broadParent = projects.find((project) => isPathInside(threadCwd, project.absolutePath));
  if (broadParent) {
    return { projectId: null, legacy: true };
  }
  return { projectId: null, legacy: false };
}

export function coerceThreadTitle(title: string, fallback = 'Untitled thread'): string {
  const trimmed = title.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed.slice(0, 120) : fallback;
}

export function chunkTelegramMessage(text: string, limit = 3800): string[] {
  const normalized = text.trim();
  if (!normalized) return [''];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let splitIndex = remaining.lastIndexOf('\n', limit);
    if (splitIndex < limit * 0.4) {
      splitIndex = remaining.lastIndexOf(' ', limit);
    }
    if (splitIndex < limit * 0.4) {
      splitIndex = limit;
    }
    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

type LooseThreadItem = {
  type?: string | null;
  text?: string | null;
  phase?: string | null;
  content?: Array<{ type?: string | null; text?: string | null } | null> | null;
};

type LooseThreadTurn = {
  id?: string | null;
  items?: Array<LooseThreadItem | null> | null;
};

type LooseCommandExecutionItem = {
  type?: string | null;
  command?: string | null;
  exitCode?: number | null;
  status?: string | null;
};

function normalizeTranscriptText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function textFromContent(
  content: Array<{ type?: string | null; text?: string | null } | null> | null | undefined,
): string {
  return (content ?? [])
    .map((entry) => normalizeTranscriptText(entry?.text ?? ''))
    .filter(Boolean)
    .join('\n\n');
}

export function transcriptEntriesFromItems(items: Array<LooseThreadItem | null> | null | undefined): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  for (const item of items ?? []) {
    if (!item) continue;

    const itemType = (item.type ?? '').toLowerCase();
    const text = normalizeTranscriptText(item.text ?? '') || textFromContent(item.content);
    if (!text) continue;

    if (itemType === 'usermessage' || itemType.startsWith('user')) {
      entries.push({ role: 'user', text });
      continue;
    }

    if (itemType === 'agentmessage' || itemType.startsWith('agent')) {
      if ((item.phase ?? '').toLowerCase() === 'commentary') {
        continue;
      }
      entries.push({ role: 'assistant', text });
    }
  }

  return entries;
}

export function transcriptTurnFromTurn(turn: LooseThreadTurn | null | undefined): TranscriptTurn | null {
  if (!turn?.id) return null;
  const entries = transcriptEntriesFromItems(turn.items);
  if (entries.length === 0) return null;
  return { turnId: turn.id, entries };
}

export function transcriptTurnsFromThread(
  turns: Array<LooseThreadTurn | null> | null | undefined,
  limitTurns?: number,
): TranscriptTurn[] {
  const normalized = (turns ?? [])
    .map((turn) => transcriptTurnFromTurn(turn))
    .filter((turn): turn is TranscriptTurn => Boolean(turn));

  if (!limitTurns || limitTurns >= normalized.length) {
    return normalized;
  }

  return normalized.slice(-limitTurns);
}

export function assistantTextFromTranscriptTurn(turn: TranscriptTurn | null | undefined): string {
  return (turn?.entries ?? [])
    .filter((entry) => entry.role === 'assistant')
    .map((entry) => entry.text)
    .join('\n\n')
    .trim();
}

export function summarizeApprovalKind(kind: 'command' | 'fileChange' | 'permissions' | 'toolInput'): string {
  switch (kind) {
    case 'command':
      return 'Command approval requested';
    case 'fileChange':
      return 'File changes approval requested';
    case 'permissions':
      return 'Additional permissions requested';
    case 'toolInput':
      return 'Tool input requested';
  }
}

export function commandApprovalIsSafe(args: {
  cwd: string | null | undefined;
  project: ProjectRecord | null;
  networkRequested: boolean;
  fileReadRoots?: string[];
  fileWriteRoots?: string[];
}): boolean {
  if (!args.project) return false;
  if (args.cwd && !isPathInside(args.project.absolutePath, args.cwd)) {
    return false;
  }
  if (args.networkRequested && !args.project.networkEnabled) {
    return false;
  }
  for (const root of args.fileReadRoots ?? []) {
    if (!isPathInside(args.project.absolutePath, root)) return false;
  }
  for (const root of args.fileWriteRoots ?? []) {
    if (!isPathInside(args.project.absolutePath, root)) return false;
  }
  return true;
}

export function permissionsAreSafe(project: ProjectRecord | null, permissions: { read?: string[] | null; write?: string[] | null; networkEnabled?: boolean | null }): boolean {
  if (!project) return false;
  if (permissions.networkEnabled && !project.networkEnabled) return false;
  for (const root of permissions.read ?? []) {
    if (!isPathInside(project.absolutePath, root)) return false;
  }
  for (const root of permissions.write ?? []) {
    if (!isPathInside(project.absolutePath, root)) return false;
  }
  return true;
}

export function effectiveThreadRuntime(runtime: RuntimeCatalog, preference?: Partial<ThreadRuntimePreferenceInput> | null): ThreadRuntimePreferenceInput {
  const preferredModel = preference?.model ?? runtime.defaults.model ?? runtime.models[0]?.id ?? 'gpt-5.4';
  const selectedModel =
    runtime.models.find((entry) => entry.id === preferredModel) ??
    runtime.models.find((entry) => entry.id === runtime.defaults.model) ??
    runtime.models[0] ??
    null;
  const model = selectedModel?.id ?? preferredModel;
  const fallbackReasoning = preference?.planMode
    ? runtime.defaults.planModeReasoningEffort ?? selectedModel?.defaultReasoningEffort ?? runtime.defaults.reasoningEffort ?? 'medium'
    : selectedModel?.defaultReasoningEffort ?? runtime.defaults.reasoningEffort ?? 'medium';
  const reasoningEffort = selectedModel?.supportedReasoningEfforts.includes(preference?.reasoningEffort ?? 'medium')
    ? (preference?.reasoningEffort ?? 'medium')
    : fallbackReasoning;

  return {
    planMode: preference?.planMode ?? false,
    model,
    reasoningEffort,
    speed: preference?.speed ?? runtime.defaults.speed,
  };
}

function truncateForActivity(text: string, limit = 84): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function summarizeCodexItem(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const typed = item as Record<string, unknown>;
  const itemType = String(typed.type ?? '').toLowerCase();

  if (itemType === 'commandexecution') {
    const commandItem = item as LooseCommandExecutionItem;
    const command = truncateForActivity(commandItem.command ?? 'command');
    return `Ran ${command}`;
  }

  if (itemType === 'plan') {
    return 'Updated the plan';
  }

  if (itemType === 'contextcompaction') {
    return 'Compressed working context';
  }

  return null;
}
