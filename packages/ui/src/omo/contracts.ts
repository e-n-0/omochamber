import { z } from 'zod';

// Application wire codec. Objects deliberately pick public fields; native routing
// handles, socket/store paths, credentials and provider internals are not DTOs.
const id = z.string().min(1);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonblank = z.string().refine((value) => value.trim().length > 0);
export const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;
export const connectionSchema = z.enum(['connected', 'reconnecting', 'unavailable']);
export type NativeConnection = z.infer<typeof connectionSchema>;
export const ownershipSchema = z.enum(['hosted', 'terminal', 'offline']);
export type NativeOwnership = z.infer<typeof ownershipSchema>;

export const modelSelectionSchema = z.object({ provider: id, id });
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export const modelViewSchema = modelSelectionSchema.extend({
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  contextWindow: counter.optional(),
  maxTokens: counter.optional(),
  input: z.array(z.enum(['text', 'image'])).optional(),
});
export type ModelView = z.infer<typeof modelViewSchema>;
export const commandViewSchema = z.object({
  name: id,
  description: z.string().optional(),
  source: z.enum(['extension', 'prompt', 'skill']),
  syntax: z.enum(['slash', 'dollar']).optional(),
});
export type CommandView = z.infer<typeof commandViewSchema>;
export const nativeSessionViewSchema = z.object({
  directory: id,
  name: z.string().nullable(),
  isStreaming: z.boolean(),
  isCompacting: z.boolean(),
  isBashRunning: z.boolean(),
  isRetrying: z.boolean(),
  retryAttempt: counter,
  projectTrusted: z.boolean(),
  model: modelSelectionSchema.nullable(),
  thinkingLevel: z.string().nullable(),
  availableModels: z.array(modelViewSchema),
  availableThinkingLevels: z.array(id),
  commands: z.array(commandViewSchema),
});
export type NativeSessionView = z.infer<typeof nativeSessionViewSchema>;

export const toolCallSchema = z.object({
  type: z.literal('toolCall'), id, name: id,
  // Only tool arguments/results are dynamic, and only JSON crosses this boundary.
  arguments: jsonValueSchema,
});
export type ToolCall = z.infer<typeof toolCallSchema>;
export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: id }),
  toolCallSchema,
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;
export const messageSchema = z.discriminatedUnion('role', [
  z.object({
    role: z.literal('user'),
    content: z.union([z.string(), z.array(contentBlockSchema)]),
    timestamp: counter,
  }),
  z.object({
    role: z.literal('assistant'), content: z.array(contentBlockSchema),
    timestamp: counter, provider: z.string().optional(), model: z.string().optional(),
    stopReason: z.string().optional(), errorMessage: z.string().optional(),
  }),
  z.object({
    role: z.literal('toolResult'), toolCallId: id, toolName: id,
    content: z.array(contentBlockSchema), isError: z.boolean(), timestamp: counter,
    details: jsonValueSchema.optional(),
  }),
  z.object({
    role: z.literal('bashExecution'), command: z.string(), output: z.string(),
    exitCode: z.number().int().optional(), cancelled: z.boolean(),
    truncated: z.boolean(), timestamp: counter,
  }),
  z.object({
    role: z.literal('custom'), customType: id, content: z.union([z.string(), z.array(contentBlockSchema)]),
    display: z.boolean(), timestamp: counter,
  }),
]);
export type NativeMessage = z.infer<typeof messageSchema>;
const entryFields = { id, parentId: id.nullable(), timestamp: id };
export const entrySchema = z.discriminatedUnion('type', [
  z.object({ ...entryFields, type: z.literal('message'), message: messageSchema }),
  z.object({
    ...entryFields, type: z.literal('compaction'), summary: z.string(),
    firstKeptEntryId: id, tokensBefore: counter,
  }),
  z.object({ ...entryFields, type: z.literal('branch_summary'), summary: z.string(), fromId: id }),
  z.object({
    ...entryFields, type: z.literal('custom_message'), customType: id,
    content: z.union([z.string(), z.array(contentBlockSchema)]), display: z.boolean(),
  }),
  // Custom persistence payloads are projected into goal/todo/task/DAG DTOs,
  // not forwarded wholesale as native metadata.
  z.object({ ...entryFields, type: z.literal('custom'), customType: id }),
  z.object({ ...entryFields, type: z.literal('model_change'), provider: id, modelId: id }),
  z.object({ ...entryFields, type: z.literal('model_change_rejected') }),
  z.object({ ...entryFields, type: z.literal('configuration_update'), reasoning: z.object({ effort: id }) }),
  z.object({ ...entryFields, type: z.literal('thinking_level_change'), thinkingLevel: id }),
  z.object({ ...entryFields, type: z.literal('session_info'), name: z.string().optional() }),
  z.object({ ...entryFields, type: z.literal('label'), targetId: id, label: z.string().optional() }),
]);
export type NativeEntry = z.infer<typeof entrySchema>;
export const activeBranchSchema = z.object({
  leafId: id.nullable(), entries: z.array(entrySchema),
}).superRefine((branch, context) => {
  const entries = new Map(branch.entries.map((entry) => [entry.id, entry]));
  if (entries.size !== branch.entries.length) {
    context.addIssue({ code: 'custom', message: 'Duplicate entry identity' });
  }
  const visited = new Set<string>();
  let cursor = branch.leafId;
  while (cursor !== null) {
    const entry = entries.get(cursor);
    if (!entry || visited.has(cursor)) {
      context.addIssue({ code: 'custom', message: 'Incomplete or cyclic active branch' });
      return;
    }
    visited.add(cursor);
    cursor = entry.parentId;
  }
}).transform((branch) => {
  const entries = new Map(branch.entries.map((entry) => [entry.id, entry]));
  const active: NativeEntry[] = [];
  let cursor = branch.leafId;
  while (cursor !== null) {
    const entry = entries.get(cursor);
    if (!entry) break; // superRefine has already refused missing ancestry.
    active.push(entry);
    cursor = entry.parentId;
  }
  return { leafId: branch.leafId, entries: active.reverse() };
});
export type ActiveBranch = z.infer<typeof activeBranchSchema>;

const goalFields = {
  id, threadId: id, objective: nonblank, tokensUsed: counter,
  timeUsedSeconds: counter, createdAt: counter, updatedAt: counter,
  lastStartedAt: counter.optional(), completedAt: counter.optional(),
  consecutiveContinuations: counter.optional(), unattendedContinuations: counter.optional(),
};
export const goalViewSchema = z.discriminatedUnion('status', [
  z.object({ ...goalFields, status: z.literal('active') }),
  z.object({ ...goalFields, status: z.literal('paused') }),
  z.object({ ...goalFields, status: z.literal('complete') }),
  z.object({ ...goalFields, status: z.literal('blocked'), blockedReason: nonblank, blockedAt: counter }),
]);
export type GoalView = z.infer<typeof goalViewSchema>;
export const todoTaskSchema = z.object({
  content: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'abandoned']),
});
export type TodoTask = z.infer<typeof todoTaskSchema>;
export const todoViewSchema = z.object({
  version: z.literal(2),
  phases: z.array(z.object({ name: z.string(), tasks: z.array(todoTaskSchema) })),
  ask: z.string().optional(),
});
export type TodoView = z.infer<typeof todoViewSchema>;
export const taskViewSchema = z.object({
  taskId: id, parentSessionId: id, rootSessionId: id.optional(), depth: counter.optional(),
  status: z.enum(['pending', 'running', 'completed', 'error', 'cancelled', 'interrupted', 'lost']),
  residency: z.string().optional(), model: z.string().optional(), name: z.string().optional(),
  taskSummary: z.string().optional(), description: z.string().optional(), category: z.string().optional(),
  agent: z.string().optional(), childSessionId: id.optional(),
  createdAt: z.iso.datetime({ offset: true }).optional(),
  startedAt: z.iso.datetime({ offset: true }).optional(),
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  completedAt: z.iso.datetime({ offset: true }).optional(),
  notificationEpoch: counter.optional(), output: z.string().optional(), error: z.string().optional(),
  source: z.enum(['persisted', 'live']),
});
export type TaskView = z.infer<typeof taskViewSchema>;
export const dagNodeViewSchema = z.object({
  nodeId: id, name: z.string().optional(), taskId: id.optional(),
  status: z.enum(['pending', 'blocked', 'scheduled', 'running', 'completed', 'failed', 'cancelled', 'skipped']),
  wave: counter.optional(), error: z.string().optional(),
});
export type DagNodeView = z.infer<typeof dagNodeViewSchema>;
export const dagViewSchema = z.object({
  runId: id, name: z.string().optional(),
  status: z.enum(['pending', 'running', 'paused', 'completed', 'failed', 'cancelled']),
  generation: counter, lastSeq: counter,
  nodes: z.array(dagNodeViewSchema),
  edges: z.array(z.object({ from: id, to: id })),
  waves: z.array(z.array(id)),
  counts: z.object({
    pending: counter, blocked: counter, scheduled: counter, running: counter,
    completed: counter, failed: counter, cancelled: counter, skipped: counter,
  }),
});
export type DagView = z.infer<typeof dagViewSchema>;

/** Failed/partial projections may carry their last valid value; null means unknown. */
export const projectionSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), value }),
  z.object({ status: z.literal('incomplete'), value: value.nullable(), reason: z.string().optional() }),
  z.object({ status: z.literal('unavailable'), value: value.nullable(), reason: z.string().optional() }),
]);
export const goalProjectionSchema = projectionSchema(goalViewSchema.nullable());
export const todoProjectionSchema = projectionSchema(todoViewSchema.nullable());
export const taskProjectionSchema = projectionSchema(z.array(taskViewSchema));
export const dagProjectionSchema = projectionSchema(z.array(dagViewSchema));
const projectionFields = {
  goal: goalProjectionSchema, todo: todoProjectionSchema,
  tasks: taskProjectionSchema, dags: dagProjectionSchema,
};
export const projectionsSchema = z.object(projectionFields);
export type NativeProjections = z.infer<typeof projectionsSchema>;
export type GoalProjection = z.infer<typeof goalProjectionSchema>;
export type TodoProjection = z.infer<typeof todoProjectionSchema>;
export type TaskProjection = z.infer<typeof taskProjectionSchema>;
export type DagProjection = z.infer<typeof dagProjectionSchema>;

export const questionSchema = z.object({
  id, header: z.string(), question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
  multiSelect: z.boolean().optional(),
});
export type NativeQuestion = z.infer<typeof questionSchema>;
const interactionFields = {
  id, title: z.string().optional(), timeout: counter.optional(),
  askedAtMs: counter.optional(), deadlineAtMs: counter.optional(), remainingMs: counter.optional(),
};
export const pendingInteractionSchema = z.discriminatedUnion('method', [
  z.object({ ...interactionFields, method: z.literal('select'), title: z.string(), options: z.array(z.string()) }),
  z.object({ ...interactionFields, method: z.literal('confirm'), title: z.string(), message: z.string() }),
  z.object({ ...interactionFields, method: z.literal('input'), title: z.string(), placeholder: z.string().optional() }),
  z.object({ ...interactionFields, method: z.literal('editor'), title: z.string(), prefill: z.string().optional() }),
  z.object({
    ...interactionFields, method: z.literal('question'), requestId: id,
    toolCallId: id.optional(), waitForAnswer: z.boolean(), questions: z.array(questionSchema).min(1),
  }),
]);
export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

export const snapshotSchema = z.object({
  schemaVersion: z.literal(1), sessionKey: id, durableSessionId: id,
  connectionEpoch: counter, revision: counter, ownership: ownershipSchema,
  connection: connectionSchema, state: nativeSessionViewSchema, activeBranch: activeBranchSchema,
  ...projectionFields, pendingInteractions: z.array(pendingInteractionSchema),
});
export type NativeSnapshot = z.infer<typeof snapshotSchema>;

const textCommand = { text: nonblank };
export const nativeCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('prompt'), ...textCommand }),
  z.object({ type: z.literal('steer'), ...textCommand }),
  z.object({ type: z.literal('followUp'), ...textCommand }),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('rename'), name: nonblank }),
  z.object({ type: z.literal('setModel'), provider: id, id }),
  z.object({ type: z.literal('setThinking'), level: id }),
  z.object({
    type: z.literal('goalSet'),
    objective: nonblank.refine((value) => !['pause', 'resume', 'clear'].includes(value.trim().toLowerCase())),
  }),
  z.object({ type: z.literal('goalPause') }),
  z.object({ type: z.literal('goalResume') }),
  z.object({ type: z.literal('goalClear') }),
  z.object({ type: z.literal('taskSend'), taskId: id, message: nonblank.max(32_000) }),
  z.object({ type: z.literal('taskCancel'), taskId: id, reason: z.string().max(2_000).optional() }),
]);
export type NativeCommand = z.infer<typeof nativeCommandSchema>;
export const commandEnvelopeSchema = z.object({
  requestId: id, connectionEpoch: counter, command: nativeCommandSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export const interactionAnswerSchema = z.union([
  z.object({ cancelled: z.literal(true) }),
  z.object({ value: z.string() }),
  z.object({ confirmed: z.boolean() }),
  z.object({
    answers: z.record(id, z.object({ selected: z.array(z.string()), text: z.string().optional() })),
    comment: z.string().optional(),
  }).refine((answer) => Object.keys(answer.answers).length > 0 || (answer.comment?.trim().length ?? 0) > 0),
]);
export type InteractionAnswer = z.infer<typeof interactionAnswerSchema>;
export const uiResponseEnvelopeSchema = z.object({
  requestId: id, connectionEpoch: counter, uiRequestId: id, response: interactionAnswerSchema,
});
export type UiResponseEnvelope = z.infer<typeof uiResponseEnvelopeSchema>;
export const commandAcceptedSchema = z.object({
  requestId: id, connectionEpoch: counter, accepted: z.literal(true),
});
export type CommandAccepted = z.infer<typeof commandAcceptedSchema>;
export const commandResultDataSchema = z.object({
  handled: z.boolean().optional(), queued: z.boolean().optional(), sent: z.boolean().optional(),
  cancelled: z.boolean().optional(), name: z.string().optional(),
  model: modelSelectionSchema.optional(), thinkingLevel: z.string().optional(),
  task: taskViewSchema.optional(), output: z.string().optional(),
});
export type CommandResultData = z.infer<typeof commandResultDataSchema>;
export const commandResultSchema = z.discriminatedUnion('success', [
  z.object({ requestId: id, success: z.literal(true), data: commandResultDataSchema.optional() }),
  z.object({ requestId: id, success: z.literal(false), error: z.string(), code: z.string().optional() }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const assistantDeltaSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_start'), contentIndex: counter }),
  z.object({ type: z.literal('text_delta'), contentIndex: counter, delta: z.string() }),
  z.object({ type: z.literal('text_end'), contentIndex: counter, content: z.string() }),
  z.object({ type: z.literal('thinking_start'), contentIndex: counter }),
  z.object({ type: z.literal('thinking_delta'), contentIndex: counter, delta: z.string() }),
  z.object({ type: z.literal('thinking_end'), contentIndex: counter, content: z.string() }),
  z.object({ type: z.literal('toolcall_start'), contentIndex: counter, id, toolName: id }),
  z.object({ type: z.literal('toolcall_delta'), contentIndex: counter, delta: z.string() }),
  z.object({ type: z.literal('toolcall_end'), contentIndex: counter, toolCall: toolCallSchema }),
]);
export type AssistantDelta = z.infer<typeof assistantDeltaSchema>;
const toolResultFields = { content: z.array(contentBlockSchema), details: jsonValueSchema.optional() };
const nativeEventVariants = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agent_start') }),
  z.object({ type: z.literal('agent_end'), willRetry: z.boolean().optional(), messages: z.array(messageSchema).optional() }),
  z.object({ type: z.literal('agent_settled') }),
  z.object({ type: z.literal('agent_idle') }),
  z.object({ type: z.literal('message_start'), message: messageSchema }),
  z.object({ type: z.literal('message_update'), assistantMessageEvent: assistantDeltaSchema }),
  z.object({ type: z.literal('message_end'), message: messageSchema }),
  z.object({ type: z.literal('entry_appended'), entry: entrySchema }),
  z.object({ type: z.literal('model_changed'), model: modelSelectionSchema, thinkingLevel: id }),
  z.object({ type: z.literal('commands_changed'), commands: z.array(commandViewSchema) }),
  z.object({ type: z.literal('compaction_start'), reason: z.string().optional() }),
  z.object({ type: z.literal('compaction_end'), aborted: z.boolean().optional(), errorMessage: z.string().optional() }),
  z.object({ type: z.literal('auto_retry_start'), attempt: counter, maxAttempts: counter, delayMs: counter, errorMessage: z.string() }),
  z.object({ type: z.literal('auto_retry_end'), success: z.boolean(), attempt: counter, finalError: z.string().optional() }),
  z.object({ type: z.literal('bash_execution_update'), id, delta: z.string() }),
  z.object({ type: z.literal('tool_execution_start'), toolCallId: id, toolName: id, args: jsonValueSchema }),
  z.object({ type: z.literal('tool_execution_update'), toolCallId: id, toolName: id, partialResult: z.object(toolResultFields) }),
  z.object({ type: z.literal('tool_execution_end'), toolCallId: id, toolName: id, result: z.object(toolResultFields), isError: z.boolean() }),
  z.object({ type: z.literal('interaction_pending'), interaction: pendingInteractionSchema }),
  z.object({ type: z.literal('question_updated'), id, deadlineAtMs: counter, remainingMs: counter }),
  z.object({ type: z.literal('question_resolved'), id, outcome: z.enum(['answered', 'comment-submitted', 'timed_out', 'cancelled']) }),
  z.object({ type: z.literal('interaction_resolved'), id }),
  z.object({ type: z.literal('projections'), ...projectionFields }),
  // Native extension payloads are invalidations. Backend projects public views;
  // opaque extension data must not become browser DTOs.
  z.object({ type: z.literal('extension_event'), name: id }),
]);
const knownNativeEvents = new Set<string>([
  'agent_start', 'agent_end', 'agent_settled', 'agent_idle',
  'message_start', 'message_update', 'message_end', 'entry_appended',
  'model_changed', 'commands_changed', 'compaction_start', 'compaction_end',
  'auto_retry_start', 'auto_retry_end', 'bash_execution_update',
  'tool_execution_start', 'tool_execution_update', 'tool_execution_end',
  'interaction_pending', 'question_updated', 'question_resolved',
  'interaction_resolved', 'projections', 'extension_event', 'extension_ui_request', 'unhandled',
]);
const nativeEventTagSchema = z.object({ type: id, method: id.optional() });
const dialogMethods = new Set(['select', 'confirm', 'input', 'editor', 'question']);
export const nativeEventSchema = z.preprocess((input) => {
  const tag = nativeEventTagSchema.safeParse(input);
  if (!tag.success) return input;
  if (tag.data.type === 'extension_ui_request' && tag.data.method && !dialogMethods.has(tag.data.method)) {
    return { type: 'unhandled', nativeType: `extension_ui_request.${tag.data.method}` };
  }
  if (knownNativeEvents.has(tag.data.type)) return input;
  return { type: 'unhandled', nativeType: tag.data.type };
}, z.union([
  nativeEventVariants,
  pendingInteractionSchema.and(z.object({ type: z.literal('extension_ui_request') })),
  z.object({ type: z.literal('unhandled'), nativeType: id }),
]));
export type NativeEvent = z.infer<typeof nativeEventSchema>;
const eventFields = { sessionKey: id, connectionEpoch: counter, revision: counter };
export const sessionEventSchema = z.discriminatedUnion('type', [
  z.object({ ...eventFields, type: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.object({ ...eventFields, type: z.literal('native'), event: nativeEventSchema }),
  z.object({ ...eventFields, type: z.literal('commandResult'), result: commandResultSchema }),
  z.object({ ...eventFields, type: z.literal('connection'), connection: connectionSchema, reason: z.string().optional() }),
]).superRefine((event, context) => {
  if (event.type === 'snapshot' && (
    event.snapshot.sessionKey !== event.sessionKey ||
    event.snapshot.connectionEpoch !== event.connectionEpoch ||
    event.snapshot.revision !== event.revision
  )) context.addIssue({ code: 'custom', message: 'Snapshot envelope identity mismatch' });
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const statusSchema = z.object({
  available: z.boolean(), protocolVersion: counter.nullable(), capabilities: z.array(id),
  reason: z.string().optional(),
});
export type NativeStatus = z.infer<typeof statusSchema>;
export const hostViewSchema = z.object({
  hostKey: id, ownership: ownershipSchema, available: z.boolean(),
  protocolVersion: counter.nullable(), capabilities: z.array(id),
});
export type HostView = z.infer<typeof hostViewSchema>;
export const projectSchema = z.object({ id, path: id, name: z.string(), worktreePaths: z.array(id).optional() });
export type NativeProject = z.infer<typeof projectSchema>;
export const projectInputSchema = z.object({ path: nonblank, name: nonblank.optional() });
export type ProjectInput = z.infer<typeof projectInputSchema>;
export const projectUpdateSchema = projectInputSchema.partial();
export type ProjectUpdate = z.infer<typeof projectUpdateSchema>;
export const sessionSummarySchema = z.object({
  sessionKey: id, durableSessionId: id, directory: id, name: z.string().nullable(),
  ownership: ownershipSchema, connection: connectionSchema,
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export const createSessionSchema = z.object({
  requestId: id, projectId: id, worktreePath: id.optional(), name: nonblank.optional(),
});
export type CreateSession = z.infer<typeof createSessionSchema>;
export const nativeSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  theme: z.string().optional(), fontSize: z.number().positive().optional(),
  fontFamily: z.string().optional(), layout: z.enum(['comfortable', 'compact']).optional(),
});
export type NativeSettings = z.infer<typeof nativeSettingsSchema>;
export const settingsUpdateSchema = nativeSettingsSchema.omit({ schemaVersion: true }).partial();
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export const taskOutputOptionsSchema = z.object({
  mode: z.enum(['status', 'tail', 'full']).optional(),
  tailLines: z.number().int().min(1).max(1_000).optional(),
});
export type TaskOutputOptions = z.infer<typeof taskOutputOptionsSchema>;
export const taskOutputSchema = z.object({ task: taskViewSchema, output: z.string(), truncated: z.boolean() });
export type TaskOutput = z.infer<typeof taskOutputSchema>;
