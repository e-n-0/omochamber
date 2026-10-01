import { execFile } from 'node:child_process';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createHostClient } from './host-client.js';
import { discoverHosts } from './discovery.js';
import { selectActiveBranch } from './native-layout.js';
import { createNativeProjectionReader, projectNativeTask } from './projections.js';

const run = promisify(execFile);
const id = z.string().min(1).max(256);
const text = z.string().refine((value) => value.trim().length > 0);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const modelSchema = z.object({ provider: id, id });
const modelViewSchema = modelSchema.extend({
  name: z.string().optional(), reasoning: z.boolean().optional(),
  contextWindow: counter.optional(), maxTokens: counter.optional(),
  input: z.array(z.enum(['text', 'image'])).optional(),
});
const commandsSchema = z.array(z.object({
  name: id, description: z.string().optional(),
  source: z.enum(['extension', 'prompt', 'skill']), syntax: z.enum(['slash', 'dollar']).optional(),
}));
const stateSchema = z.object({
  sessionId: id, sessionFile: z.string().nullable().optional(), cwd: text,
  sessionName: z.string().optional(), model: modelSchema.nullish(),
  thinkingLevel: z.string().optional(), isStreaming: z.boolean(), isCompacting: z.boolean(),
  isBashRunning: z.boolean(), retryAttempt: counter, projectTrusted: z.boolean(),
});
const commandSchema = z.discriminatedUnion('type', [
  ...['prompt', 'steer', 'followUp'].map((type) => z.object({ type: z.literal(type), text })),
  z.object({ type: z.literal('abort') }),
  z.object({ type: z.literal('rename'), name: text.max(1_000) }),
  z.object({ type: z.literal('setModel'), provider: id, id }),
  z.object({ type: z.literal('setThinking'), level: id }),
  z.object({
    type: z.literal('goalSet'),
    objective: text.refine((value) => !['pause', 'resume', 'clear'].includes(value.trim().toLowerCase())),
  }),
  ...['goalPause', 'goalResume', 'goalClear'].map((type) => z.object({ type: z.literal(type) })),
  z.object({ type: z.literal('taskSend'), taskId: id, message: text.max(32_000) }),
  z.object({ type: z.literal('taskCancel'), taskId: id, reason: z.string().max(2_000).optional() }),
].map((schema) => schema.strict()));
const commandEnvelope = z.object({ requestId: id, connectionEpoch: counter, command: commandSchema }).strict();
const answerSchema = z.union([
  z.object({ cancelled: z.literal(true) }).strict(),
  z.object({ value: z.string() }).strict(),
  z.object({ confirmed: z.boolean() }).strict(),
  z.object({
    answers: z.record(id, z.object({ selected: z.array(z.string()), text: z.string().optional() }).strict()),
    comment: z.string().optional(),
  }).strict().refine((answer) => Object.keys(answer.answers).length > 0 || !!answer.comment?.trim()),
]);
const responseEnvelope = z.object({
  requestId: id, connectionEpoch: counter, uiRequestId: id, response: answerSchema,
}).strict();
const questionSchema = z.object({
  id, header: z.string(), question: z.string(),
  options: z.array(z.object({ label: z.string(), description: z.string() })),
  multiSelect: z.boolean().optional(),
});
const interactionFields = {
  id, timeout: counter.optional(), askedAtMs: counter.optional(),
  deadlineAtMs: counter.optional(), remainingMs: counter.optional(),
};
const interactionSchema = z.discriminatedUnion('method', [
  z.object({ ...interactionFields, method: z.literal('select'), title: z.string(), options: z.array(z.string()) }),
  z.object({ ...interactionFields, method: z.literal('confirm'), title: z.string(), message: z.string() }),
  z.object({ ...interactionFields, method: z.literal('input'), title: z.string(), placeholder: z.string().optional() }),
  z.object({ ...interactionFields, method: z.literal('editor'), title: z.string(), prefill: z.string().optional() }),
  z.object({
    ...interactionFields, method: z.literal('question'), requestId: id, toolCallId: id.optional(),
    waitForAnswer: z.boolean(), questions: z.array(questionSchema).min(1),
  }),
]);
const contentSchema = z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('image'), data: z.string(), mimeType: id }),
  z.object({ type: z.literal('toolCall'), id, name: id, arguments: z.json() }),
]));
const messageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.union([z.string(), contentSchema]), timestamp: counter }),
  z.object({
    role: z.literal('assistant'), content: contentSchema, timestamp: counter,
    provider: z.string().optional(), model: z.string().optional(), stopReason: z.string().optional(),
    errorMessage: z.string().optional(),
  }),
  z.object({
    role: z.literal('toolResult'), toolCallId: id, toolName: id, content: contentSchema,
    isError: z.boolean(), timestamp: counter,
  }),
  z.object({
    role: z.literal('bashExecution'), command: z.string(), output: z.string(),
    exitCode: z.number().int().optional(), cancelled: z.boolean(), truncated: z.boolean(), timestamp: counter,
  }),
  z.object({
    role: z.literal('custom'), customType: id, content: z.union([z.string(), contentSchema]),
    display: z.boolean(), timestamp: counter,
  }),
]);
const entryFields = { id, parentId: id.nullable(), timestamp: text };
const entrySchema = z.discriminatedUnion('type', [
  z.object({ ...entryFields, type: z.literal('message'), message: messageSchema }),
  z.object({ ...entryFields, type: z.literal('custom'), customType: id }),
  z.object({
    ...entryFields, type: z.literal('custom_message'), customType: id,
    content: z.union([z.string(), contentSchema]), display: z.boolean(),
  }),
  z.object({ ...entryFields, type: z.literal('compaction'), summary: z.string(), firstKeptEntryId: id, tokensBefore: counter }),
  z.object({ ...entryFields, type: z.literal('branch_summary'), summary: z.string(), fromId: id }),
  z.object({ ...entryFields, type: z.literal('model_change'), provider: id, modelId: id }),
  z.object({ ...entryFields, type: z.literal('model_change_rejected') }),
  z.object({ ...entryFields, type: z.literal('configuration_update'), reasoning: z.object({ effort: id }) }),
  z.object({ ...entryFields, type: z.literal('thinking_level_change'), thinkingLevel: id }),
  z.object({ ...entryFields, type: z.literal('session_info'), name: z.string().optional() }),
  z.object({ ...entryFields, type: z.literal('label'), targetId: id, label: z.string().optional() }),
]);
const resultContent = z.object({ content: contentSchema });
const eventSchemas = {
  agent_start: z.object({ type: z.literal('agent_start') }),
  agent_end: z.object({ type: z.literal('agent_end'), willRetry: z.boolean().optional() }),
  agent_settled: z.object({ type: z.literal('agent_settled') }),
  agent_idle: z.object({ type: z.literal('agent_idle') }),
  message_start: z.object({ type: z.literal('message_start'), message: messageSchema }),
  message_end: z.object({ type: z.literal('message_end'), message: messageSchema }),
  entry_appended: z.object({ type: z.literal('entry_appended'), entry: entrySchema }),
  model_changed: z.object({ type: z.literal('model_changed'), model: modelSchema, thinkingLevel: id }),
  commands_changed: z.object({ type: z.literal('commands_changed'), commands: commandsSchema }),
  compaction_start: z.object({ type: z.literal('compaction_start'), reason: z.string().optional() }),
  compaction_end: z.object({ type: z.literal('compaction_end'), aborted: z.boolean().optional(), errorMessage: z.string().optional() }),
  auto_retry_start: z.object({ type: z.literal('auto_retry_start'), attempt: counter, maxAttempts: counter, delayMs: counter, errorMessage: z.string() }),
  auto_retry_end: z.object({ type: z.literal('auto_retry_end'), success: z.boolean(), attempt: counter, finalError: z.string().optional() }),
  bash_execution_update: z.object({ type: z.literal('bash_execution_update'), id, delta: z.string() }),
  tool_execution_start: z.object({ type: z.literal('tool_execution_start'), toolCallId: id, toolName: id, args: z.json() }),
  tool_execution_update: z.object({ type: z.literal('tool_execution_update'), toolCallId: id, toolName: id, partialResult: resultContent }),
  tool_execution_end: z.object({ type: z.literal('tool_execution_end'), toolCallId: id, toolName: id, result: resultContent, isError: z.boolean() }),
  question_updated: z.object({ type: z.literal('question_updated'), id, deadlineAtMs: counter, remainingMs: counter }),
  question_resolved: z.object({ type: z.literal('question_resolved'), id, outcome: z.enum(['answered', 'comment-submitted', 'timed_out', 'cancelled']) }),
};
const deltaSchema = z.discriminatedUnion('type', [
  ...['text_start', 'thinking_start'].map((type) => z.object({ type: z.literal(type), contentIndex: counter })),
  ...['text_delta', 'thinking_delta', 'toolcall_delta'].map((type) => z.object({ type: z.literal(type), contentIndex: counter, delta: z.string() })),
  ...['text_end', 'thinking_end'].map((type) => z.object({ type: z.literal(type), contentIndex: counter, content: z.string() })),
  z.object({ type: z.literal('toolcall_end'), contentIndex: counter, toolCall: contentSchema.element.options[3] }),
]);
const privateKey = /^(?:socketPath|socket|host_socket|host_session|hostHandle|sessionPath|sessionFile|session_file|agentDir|engineRoot|pluginRoot|stores|stateDir|state_dir|apiKey|api_key|authorization|credentials|token|secret|execution|isolation|steering|environment|env)$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const missing = (error) => error.code === 'ENOENT' || error.code === 'ENOTDIR';

function failure(code, message, statusCode = 503, uncertain = false) {
  return Object.assign(new Error(message), { code, statusCode, uncertain });
}
function validate(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw failure('invalid_request', 'Invalid native request', 400);
  return parsed.data;
}
function nativeData(reply) {
  if (!reply.success) throw failure('native_refused', 'Native host refused the request', 409);
  return reply.data;
}

/** Installed engine only; host ensure with never cannot upgrade or prepare OMO. */
async function ensureAppHost({ runtime, socketPath, cwd, hostCommandRunner }) {
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.pluginRoot), 'package.json'), 'utf8'));
  const plugin = JSON.parse(await fs.readFile(path.join(runtime.pluginRoot, 'package.json'), 'utf8'));
  const packagePaths = await import(pathToFileURL(path.join(path.dirname(runtime.pluginRoot), 'bin/lib/package-paths.js')).href);
  const env = { ...process.env };
  // A web server launched by a task must not inherit its orchestration shard.
  for (const name of Object.keys(env)) {
    if (/^(?:OMO|SENPI|PI)_(?:RPC_|HOST_|TASK_|SESSION_|SENPI_TASK_|WORKPOOL_)/.test(name)) delete env[name];
  }
  delete env.SENPI_CODING_AGENT_SESSION_DIR;
  delete env.OMO_BIN;
  delete env.SENPI_BIN;
  delete env.OMO_PACKAGE_DIR;
  delete env.SENPI_PACKAGE_DIR;
  env.OMO_CODING_AGENT_DIR = env.SENPI_CODING_AGENT_DIR = runtime.agentDir;
  env.OMO_NATIVE = '1';
  env.SENPI_RUNTIME = 'bun';
  env.OMO_BIN = runtime.omoBinary;
  const binDir = packagePaths.nearestNodeBin(runtime.engineRoot);
  if (binDir) {
    const pathKey = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = [binDir, env[pathKey]].filter(Boolean).join(path.delimiter);
    const shim = path.join(binDir, process.platform === 'win32' ? 'senpi.cmd' : 'senpi');
    try { await fs.access(shim); env.SENPI_BIN = shim; } catch (error) { if (!missing(error)) throw error; }
  }
  env.SENPI_BRAND = JSON.stringify({
    name: 'OmO', command: 'omo', displayVersion: manifest.version, configDir: '.omo',
    flatLayout: false, envPrefix: 'OMO', userAgent: 'omo', originator: 'omo',
    changelog: { path: path.join(runtime.pluginRoot, 'CHANGELOG.md'), version: plugin.version },
    update: { packageName: 'omo-ai', distTag: packagePaths.releaseChannel(manifest.version),
      command: packagePaths.updateTarget().command,
      changelogUrl: 'https://github.com/code-yeongyu/oh-my-openagent/releases' },
  });
  await fs.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  try {
    await hostCommandRunner(runtime.bunBinary, [
      runtime.cliPath, 'host', 'ensure', '--launch-spec', runtime.launchSpecPath,
      '--policy', 'never', '--socket', socketPath, '--json',
    ], { cwd, env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch {
    throw failure('host_ensure_failed', 'Installed native host could not be ensured');
  }
}

/**
 * The server owns native bindings. Browser IDs never select sockets or store roots.
 * Reads may resnapshot; accepted mutations are never replayed, including after loss.
 */
export function createSessionService({
  runtime,
  dataDir = process.env.OMOCHAMBER_DATA_DIR ?? path.join(homedir(), '.config', 'omochamber'),
  hostClientFactory = createHostClient, discover = discoverHosts,
  projectionReaderFactory = createNativeProjectionReader, ensureHost = ensureAppHost,
  hostCommandRunner = run,
  goalConfirmationTimeoutMs = 10_000,
}) {
  const sessions = new Map();
  const creates = new Set();
  let hosts = [];
  let closed = false;
  let epoch = randomInt(1, 2 ** 48);
  const appSocket = path.join(path.resolve(dataDir), 'omo.sock');
  const privateRoots = new Set([runtime.agentDir, runtime.engineRoot, runtime.pluginRoot, appSocket].filter(Boolean));

  function sanitize(value) {
    // DTO constructors/schema parsers already establish the fields. Serialize
    // only JSON, omit private keys even in tool JSON, then scrub encoded roots.
    let encoded = JSON.stringify(value, (key, item) => privateKey.test(key) ? undefined : item);
    for (const root of privateRoots) encoded = encoded.replaceAll(JSON.stringify(root).slice(1, -1), '[native private]');
    return JSON.parse(encoded);
  }
  function summary(binding) {
    return sanitize({
      sessionKey: binding.key, durableSessionId: binding.durableId,
      directory: binding.cwd, name: binding.name ?? null, ownership: binding.ownership,
      connection: binding.connection,
    });
  }
  function get(key) {
    if (closed) throw failure('service_closed', 'Native service is closed');
    const binding = sessions.get(key);
    if (!binding) throw failure('session_not_found', 'Native session was not found', 404);
    return binding;
  }
  function publish(binding, type, fields) {
    const event = {
      type, sessionKey: binding.key, connectionEpoch: binding.epoch,
      revision: ++binding.revision, ...sanitize(fields),
    };
    if (type === 'snapshot') event.snapshot.revision = event.revision;
    for (const listener of binding.listeners) listener(structuredClone(event));
    return event;
  }
  function snapshot(binding) {
    if (!binding.state) throw failure('snapshot_unavailable', 'Native snapshot is not available');
    return sanitize({
      schemaVersion: 1, sessionKey: binding.key, durableSessionId: binding.durableId,
      connectionEpoch: binding.epoch, revision: binding.revision, ownership: binding.ownership,
      connection: binding.connection, state: binding.state, activeBranch: binding.branch,
      ...binding.projections, pendingInteractions: [...binding.interactions.values()],
    });
  }
  function register({ durableId, sessionPath, cwd, name, host, handle, ownership }) {
    if (sessionPath) privateRoots.add(sessionPath);
    for (const store of host?.stores ?? []) privateRoots.add(store);
    const key = `s_${hash(`${durableId}\0${sessionPath}`).slice(0, 40)}`;
    let binding = sessions.get(key);
    if (!binding) {
      binding = {
        key, durableId, sessionPath, cwd, name, host, handle, ownership,
        connection: 'unavailable', epoch: epoch++, revision: 0, generation: 0,
        listeners: new Set(), interactions: new Map(), responses: new Set(), requests: new Set(), pendingRequests: new Set(),
        branch: { leafId: null, entries: [] }, nativeEntries: [], branchLeaf: null,
      };
      sessions.set(key, binding);
    } else {
      if (binding.client && (binding.host?.instanceId !== host?.instanceId ||
          binding.host?.socketPath !== host?.socketPath || binding.handle !== handle)) {
        for (const requestId of binding.pendingRequests) publish(binding, 'commandResult', {
          result: { requestId, success: false, code: 'uncertain', error: 'Native owner changed; accepted work will not be retried' },
        });
        binding.pendingRequests.clear();
        binding.generation += 1;
        binding.unsubscribe?.();
        binding.client.disconnect();
        binding.client = undefined;
        binding.unsubscribeProjection?.();
        binding.reader?.stop();
        binding.reader = undefined;
        binding.streamingMessage = undefined;
        binding.interactions.clear();
        binding.connection = 'reconnecting';
        publish(binding, 'connection', { connection: 'reconnecting', reason: 'native_owner_changed' });
      }
      Object.assign(binding, { host, handle, ownership, name: name ?? binding.name });
    }
    return binding;
  }
  async function refreshInventory() {
    hosts = await discover({ runtime, hostClientFactory });
    const seen = new Set();
    for (const host of hosts) {
      if (host.socketPath) privateRoots.add(host.socketPath);
      for (const row of host.sessions ?? []) {
        if (!row.sessionPath || !row.cwd || !row.durableSessionId) {
          // TUI listings name the durable ID directly.
          if (row.ownership !== 'terminal' || !row.sessionPath || !row.cwd) continue;
        }
        const binding = register({
          durableId: row.durableSessionId ?? row.sessionId, sessionPath: row.sessionPath,
          cwd: row.cwd, name: row.name, host, handle: row.sessionId,
          ownership: row.ownership === 'terminal' ? 'terminal' : 'hosted',
        });
        binding.conflict = row.ownership === 'conflict';
        seen.add(binding.key);
      }
    }
    // Native summary-index constructors write. Discover persisted transcripts by
    // reading headers only; never instantiate SessionManager or its stores.
    const sessionsDir = path.join(runtime.agentDir, 'sessions');
    let directories;
    try { directories = await fs.readdir(sessionsDir, { withFileTypes: true }); } catch (error) {
      if (!missing(error)) throw failure('inventory_unavailable', 'Native session inventory could not be read');
      directories = [];
    }
    for (const directory of directories.filter((entry) => entry.isDirectory())) {
      const base = path.join(sessionsDir, directory.name);
      for (const filename of (await fs.readdir(base)).filter((file) => file.endsWith('.jsonl') && file !== '.computer-audit.jsonl')) {
        const sessionPath = path.join(base, filename);
        const content = await fs.readFile(sessionPath, 'utf8');
        const lines = content.slice(0, content.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
        let records;
        try { records = lines.map(JSON.parse); } catch {
          throw failure('inventory_incomplete', 'Native session inventory contains unreadable records');
        }
        const header = records[0];
        if (header?.type !== 'session' || !header.id || !header.cwd) {
          throw failure('inventory_incomplete', 'Native session header is unavailable');
        }
        const key = `s_${hash(`${header.id}\0${sessionPath}`).slice(0, 40)}`;
        if (sessions.has(key)) continue;
        register({
          durableId: header.id, sessionPath, cwd: header.cwd,
          name: records.findLast((record) => record.type === 'session_info')?.name,
          ownership: 'offline',
        });
      }
    }
    // Cached offline bindings remain addressable. Absence does not erase history.
    for (const binding of sessions.values()) {
      if (!seen.has(binding.key) && binding.client) {
        const owner = hosts.find((host) => host.socketPath === binding.host?.socketPath);
        if (owner?.availability !== 'ready') continue;
        for (const requestId of binding.pendingRequests) publish(binding, 'commandResult', {
          result: { requestId, success: false, code: 'uncertain', error: 'Native routing handle disappeared; accepted work will not be retried' },
        });
        binding.pendingRequests.clear();
        binding.generation += 1;
        binding.unsubscribe?.();
        binding.client.disconnect();
        binding.client = undefined;
        binding.unsubscribeProjection?.();
        binding.reader?.stop();
        binding.reader = undefined;
        binding.streamingMessage = undefined;
        binding.interactions.clear();
        binding.ownership = 'offline';
        binding.host = owner;
        binding.connection = 'unavailable';
        publish(binding, 'connection', { connection: 'unavailable', reason: 'native_handle_missing' });
        continue;
      }
      if (!seen.has(binding.key) && !binding.client) {
        binding.ownership = 'offline';
        binding.host = undefined;
      }
    }
    return hosts;
  }
  async function rpc(binding, command, generation = binding.generation) {
    if (generation !== binding.generation || closed) throw failure('request_superseded', 'Native request was superseded', 409, true);
    const client = binding.client;
    const reply = await client.request({ ...command, sessionId: binding.handle });
    if (generation !== binding.generation || client !== binding.client || closed) {
      throw failure('request_superseded', 'Native request was superseded', 409, true);
    }
    return nativeData(reply);
  }
  function viewState(raw, models, levels, commands) {
    const state = validate(stateSchema, raw);
    return {
      directory: state.cwd, name: state.sessionName ?? null,
      isStreaming: state.isStreaming, isCompacting: state.isCompacting, isBashRunning: state.isBashRunning,
      isRetrying: state.retryAttempt > 0, retryAttempt: state.retryAttempt,
      projectTrusted: state.projectTrusted, model: state.model ?? null, thinkingLevel: state.thinkingLevel ?? null,
      availableModels: validate(z.array(modelViewSchema), models),
      availableThinkingLevels: validate(z.array(id), levels), commands: validate(commandsSchema, commands),
    };
  }
  function updateBranch(binding, entries, leafId) {
    const active = selectActiveBranch(entries, leafId);
    if (active.status !== 'ready') throw failure('history_incomplete', 'Native active branch is incomplete');
    const projected = validate(z.array(entrySchema), active.entries);
    binding.nativeEntries = entries;
    binding.branchLeaf = leafId;
    binding.branch = { leafId, entries: projected };
  }
  function applyEvent(binding, raw, emit = true) {
    let event;
    if (raw.type === 'message_start') binding.streamingMessage = validate(messageSchema, raw.message);
    if (raw.type === 'message_update') {
      const partial = messageSchema.safeParse(raw.assistantMessageEvent?.partial);
      if (partial.success) binding.streamingMessage = partial.data;
    }
    if (raw.type === 'message_end') binding.streamingMessage = undefined;
    if (raw.type === 'extension_ui_request') {
      const parsed = interactionSchema.safeParse(raw);
      if (!parsed.success) return; // Native status/widgets are not browser dialogs.
      binding.interactions.set(parsed.data.id, parsed.data);
      event = { type: 'interaction_pending', interaction: parsed.data };
    } else if (raw.type === 'extension_event') {
      event = { type: 'extension_event', name: validate(id, raw.name) };
      void binding.reader?.read({ events: [raw] }).catch(() => {
        publish(binding, 'connection', { connection: binding.connection, reason: 'projection_read_failed' });
      });
    } else if (raw.type === 'message_update') {
      const nativeDelta = raw.assistantMessageEvent;
      let delta;
      if (nativeDelta?.type === 'toolcall_start') {
        const call = nativeDelta.partial?.content?.[nativeDelta.contentIndex];
        if (!call?.id || !call.name) return;
        delta = { type: 'toolcall_start', contentIndex: nativeDelta.contentIndex, id: call.id, toolName: call.name };
      } else {
        const parsed = deltaSchema.safeParse(nativeDelta);
        if (!parsed.success) return;
        delta = parsed.data;
      }
      event = { type: 'message_update', assistantMessageEvent: delta };
    } else {
      const parsed = eventSchemas[raw.type]?.safeParse(raw);
      if (!parsed?.success) return;
      event = parsed.data;
    }
    const state = binding.state;
    if (state) {
      if (event.type === 'agent_start') state.isStreaming = true;
      if (['agent_settled', 'agent_idle'].includes(event.type)) state.isStreaming = false;
      if (event.type === 'compaction_start') state.isCompacting = true;
      if (event.type === 'compaction_end') state.isCompacting = false;
      if (event.type === 'auto_retry_start') {
        state.isRetrying = true;
        state.retryAttempt = event.attempt;
      }
      if (event.type === 'auto_retry_end') {
        state.isRetrying = false;
        state.retryAttempt = 0;
      }
      if (event.type === 'model_changed') Object.assign(state, { model: event.model, thinkingLevel: event.thinkingLevel });
      if (event.type === 'commands_changed') state.commands = event.commands;
    }
    if (event.type === 'question_updated') {
      const pending = binding.interactions.get(event.id);
      if (pending) Object.assign(pending, { deadlineAtMs: event.deadlineAtMs, remainingMs: event.remainingMs });
    }
    if (event.type === 'question_resolved') binding.interactions.delete(event.id);
    if (event.type === 'entry_appended') {
      if (binding.nativeEntries.some((entry) => entry.id === event.entry.id)) return;
      try {
        updateBranch(binding, [...binding.nativeEntries, raw.entry], raw.entry.id);
        void binding.reader?.read({ entries: binding.nativeEntries, leafId: binding.branchLeaf });
      } catch {
        const generation = binding.generation;
        let recovery = binding.historyRecovery;
        if (recovery?.generation === generation) {
          recovery.entries.set(raw.entry.id, raw.entry);
        } else {
          recovery = { generation, entries: new Map([[raw.entry.id, raw.entry]]) };
          binding.historyRecovery = recovery;
          void (async () => {
            try {
              // Native configuration writes need not emit entry_appended.
              // Recover the missing ancestry from the owning host, not guesses.
              const history = await rpc(binding, { type: 'get_entries' });
              if (closed || binding.generation !== recovery.generation) return;
              const known = new Set(history.entries.map((entry) => entry.id));
              const pending = [...recovery.entries.values()].filter((entry) => !known.has(entry.id));
              updateBranch(binding, [...history.entries, ...pending], pending.at(-1)?.id ?? history.leafId);
              void binding.reader?.read({ entries: binding.nativeEntries, leafId: binding.branchLeaf });
              publish(binding, 'snapshot', { snapshot: snapshot(binding) });
            } catch {
              if (!closed && binding.generation === recovery.generation) {
                publish(binding, 'connection', { connection: binding.connection, reason: 'history_incomplete' });
              }
            } finally {
              if (binding.historyRecovery === recovery) binding.historyRecovery = undefined;
            }
          })();
        }
        return;
      }
    }
    if (emit) publish(binding, 'native', { event });
  }
  function listen(binding, client, generation) {
    const buffered = [];
    let hydrating = true;
    const unsubscribe = client.subscribe((raw) => {
      if (binding.generation !== generation || closed) return;
      if (raw.type === 'transport_disconnected') {
        binding.connection = 'reconnecting';
        // Generic dialog IDs belong to a connection, unlike replayable questions.
        for (const [key, interaction] of binding.interactions) {
          if (interaction.method !== 'question') binding.interactions.delete(key);
        }
        publish(binding, 'connection', { connection: 'reconnecting', reason: 'native_disconnected' });
        return;
      }
      if (hydrating) buffered.push(raw);
      else if (raw.sessionId === binding.handle) applyEvent(binding, raw);
    });
    return {
      unsubscribe,
      commit() {
        // Apply attachment replay before publishing the authoritative snapshot.
        for (const raw of buffered) if (raw.sessionId === binding.handle) applyEvent(binding, raw, false);
        hydrating = false;
        publish(binding, 'snapshot', { snapshot: snapshot(binding) });
      },
    };
  }
  async function hydrate(binding, rawState) {
    const terminal = binding.ownership === 'terminal';
    let history;
    let models = [];
    let levels = [];
    let commands = [];
    if (terminal) {
      // Read-only terminal attachment never opens another native writer.
      const content = await fs.readFile(binding.sessionPath, 'utf8');
      const records = content.slice(0, content.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(JSON.parse);
      const entries = records.filter((record) => record.type !== 'session');
      history = { entries, leafId: entries.at(-1)?.id ?? null };
      await rpc(binding, { type: 'subscribe' });
    } else {
      const responses = await Promise.all([
        rpc(binding, { type: 'get_entries' }), rpc(binding, { type: 'get_available_models' }),
        rpc(binding, { type: 'get_available_thinking_levels' }), rpc(binding, { type: 'get_commands' }),
      ]);
      history = responses[0];
      models = responses[1].models;
      levels = responses[2].levels;
      commands = responses[3].commands;
    }
    const state = viewState(rawState, models, levels, commands);
    if (rawState.sessionId !== binding.durableId || state.directory !== binding.cwd) {
      throw failure('session_identity_mismatch', 'Native session identity changed', 409);
    }
    updateBranch(binding, history.entries, history.leafId);
    binding.state = state;
    binding.name = state.name;
    // Only native questions are recoverable from get_state after process loss.
    if (Array.isArray(rawState.pendingQuestions)) {
      for (const [key, pending] of binding.interactions) if (pending.method === 'question') binding.interactions.delete(key);
    }
    for (const raw of rawState.pendingQuestions ?? []) {
      const parsed = interactionSchema.safeParse(raw);
      if (parsed.success) binding.interactions.set(parsed.data.id, parsed.data);
    }
    if (!binding.reader) {
      binding.reader = projectionReaderFactory({
        runtime, sessionPath: binding.sessionPath, durableSessionId: binding.durableId,
        cwd: binding.cwd, stores: binding.host?.stores ?? [],
      });
      binding.unsubscribeProjection = binding.reader.subscribe((projections) => {
        binding.projections = projections;
        if (binding.connection === 'connected') publish(binding, 'native', { event: { type: 'projections', ...projections } });
      });
      await binding.reader.start();
    }
    binding.projections = await binding.reader.read({ entries: binding.nativeEntries, leafId: binding.branchLeaf });
    binding.connection = 'connected';
  }
  async function attach(binding) {
    if (binding.attaching) return binding.attaching;
    if (binding.connection === 'connected') return snapshot(binding);
    binding.attaching = (async () => {
      await refreshInventory();
      if (binding.conflict) throw failure('owner_conflict', 'Native session has conflicting owners', 409);
      if (!binding.host) {
        if (hosts.some((host) => host.availability === 'unavailable')) {
          throw failure('owner_uncertain', 'Native ownership could not be established', 409);
        }
        await ensureHost({ runtime, socketPath: appSocket, cwd: binding.cwd, hostCommandRunner });
        binding.host = { socketPath: appSocket, stores: [] };
      }
      const generation = ++binding.generation;
      binding.unsubscribe?.();
      binding.client?.disconnect();
      binding.epoch = epoch++;
      const client = hostClientFactory({ socketPath: binding.host.socketPath });
      binding.client = client;
      const listener = listen(binding, client, generation);
      binding.unsubscribe = listener.unsubscribe;
      try {
        const protocol = await client.connect();
        if (binding.host.instanceId && protocol.instanceId !== binding.host.instanceId) throw failure('owner_changed', 'Native host owner changed', 409);
        binding.host.instanceId = protocol.instanceId;
        let state;
        if (binding.ownership === 'terminal') {
          state = await rpc(binding, { type: 'get_state' });
        } else {
          if (!protocol.capabilities.includes('retain_on_disconnect')) {
            throw failure('retention_unsupported', 'Native host cannot retain attachments');
          }
          const opened = nativeData(await client.request({
            type: 'open_session', sessionPath: binding.sessionPath, retain_on_disconnect: true,
          }));
          binding.handle = validate(id, opened.sessionId);
          state = opened.state;
          binding.ownership = 'hosted';
        }
        await hydrate(binding, state);
        if (generation !== binding.generation || closed) throw failure('attachment_stale', 'Native attachment was superseded', 409);
        listener.commit();
        return snapshot(binding);
      } catch (error) {
        listener.unsubscribe();
        client.disconnect();
        binding.client = undefined;
        binding.connection = 'unavailable';
        publish(binding, 'connection', { connection: 'unavailable', reason: 'attachment_failed' });
        throw error;
      }
    })();
    try { return await binding.attaching; } finally { binding.attaching = undefined; }
  }
  function requireWritable(binding, input) {
    if (input.connectionEpoch !== binding.epoch) throw failure('stale_epoch', 'Native connection epoch is obsolete', 409);
    if (binding.conflict) throw failure('owner_conflict', 'Native session has conflicting owners', 409);
    if (binding.ownership !== 'hosted') throw failure('read_only_session', 'This native session is read-only', 409);
    if (binding.connection !== 'connected') throw failure('connection_unavailable', 'Native session is not connected', 409);
    if (binding.requests.has(input.requestId)) {
      throw failure('duplicate_request', 'This request was already submitted; it will not be replayed', 409);
    }
  }
  async function taskOutput(binding, taskId, options = {}, generation = binding.generation) {
    const input = { task_id: taskId, mode: options.mode ?? 'status' };
    if (options.tailLines !== undefined) input.tail_lines = options.tailLines;
    const data = await rpc(binding, {
      type: 'extension_request', name: 'omo.task.output', data: input,
    }, generation);
    if (!['status', 'transcript'].includes(data?.kind)) throw failure('task_not_found', 'Native task is unavailable in this parent session', 404);
    if (data.snapshot?.parent_session_id !== binding.durableId || data.snapshot.task_id !== taskId) {
      throw failure('task_owner_mismatch', 'Native task does not belong to this parent session', 409);
    }
    return sanitize({
      task: projectNativeTask(data.snapshot, 'live', binding.durableId),
      output: data.kind === 'transcript' ? data.transcript : data.snapshot.final_response ?? '',
      truncated: data.truncated === true || data.snapshot.final_response_truncated === true,
    });
  }
  function confirmGoal(binding, command) {
    let finish;
    const promise = new Promise((resolve, reject) => { finish = { resolve, reject }; });
    const matches = (projections) => {
      if (projections.goal.status !== 'ready') return false;
      const goal = projections.goal.value;
      if (command.type === 'goalClear') return goal === null;
      if (command.type === 'goalSet') return goal?.objective === command.objective.trim() && goal.status === 'active';
      return goal?.status === (command.type === 'goalPause' ? 'paused' : 'active');
    };
    let acknowledged = false;
    let latest;
    const unsubscribe = binding.reader.subscribe((projections) => {
      latest = projections;
      if (acknowledged && matches(projections)) finish.resolve();
    });
    const timer = setTimeout(() => finish.reject(failure('goal_unconfirmed', 'Native acknowledgment was not confirmed by the goal sidecar', 409, true)), goalConfirmationTimeoutMs);
    // Install before dispatch. Observe native sidecar changes; never poll or write it.
    return {
      promise,
      async acknowledge() {
        acknowledged = true;
        const projections = await binding.reader.read({ entries: binding.nativeEntries, leafId: binding.branchLeaf });
        if (matches(projections) || (latest && matches(latest))) finish.resolve();
      },
      stop() { clearTimeout(timer); unsubscribe(); },
    };
  }
  async function commandRun(binding, command, generation = binding.generation) {
    const request = (frame) => rpc(binding, frame, generation);
    switch (command.type) {
      case 'prompt': return request({ type: 'prompt', message: command.text, expandPromptTemplates: true, unknownCommandAsText: false });
      case 'steer': return request({ type: 'steer', message: command.text });
      case 'followUp': return request({ type: 'follow_up', message: command.text });
      case 'abort': return request({ type: 'abort' });
      case 'rename': {
        await request({ type: 'set_session_name', name: command.name });
        binding.name = binding.state.name = command.name;
        return { name: command.name };
      }
      case 'setModel': {
        const data = await request({ type: 'set_model', provider: command.provider, modelId: command.id });
        binding.state.model = validate(modelSchema, data);
        binding.state.availableThinkingLevels = (await request({ type: 'get_available_thinking_levels' })).levels;
        return { model: binding.state.model };
      }
      case 'setThinking': {
        await request({ type: 'set_thinking_level', level: command.level, scope: 'turn' });
        const state = validate(stateSchema, await request({ type: 'get_state' }));
        binding.state.thinkingLevel = state.thinkingLevel;
        return { thinkingLevel: state.thinkingLevel };
      }
      case 'taskSend':
      case 'taskCancel': {
        await taskOutput(binding, command.taskId, {}, generation);
        const input = command.type === 'taskSend' ? { to: command.taskId, message: command.message } : { task_id: command.taskId };
        if (command.type === 'taskCancel' && command.reason !== undefined) input.reason = command.reason;
        const data = await request({
          type: 'extension_request', name: command.type === 'taskSend' ? 'omo.task.send' : 'omo.task.cancel',
          data: input,
        });
        if (data.kind === 'delivery_uncertain') throw failure('delivery_uncertain', 'Native task delivery is uncertain; it will not be retried', 409, true);
        if (!['steered', 'revived', 'queued', 'cancelled', 'noop'].includes(data.kind)) {
          throw failure('task_refused', 'Native task control was refused', 409);
        }
        return command.type === 'taskSend' ? { sent: data.kind !== 'queued', queued: data.kind === 'queued' }
          : { cancelled: data.kind === 'cancelled' };
      }
      default: {
        if (!binding.state.commands.some((item) => item.name === 'goal' && item.source === 'extension')) {
          throw failure('goal_unsupported', 'The native goal extension command is unavailable', 409);
        }
        const confirmation = confirmGoal(binding, command);
        // Attach rejection handling before the native prompt may open a long-lived dialog.
        const confirmed = confirmation.promise;
        confirmed.catch(() => {});
        try {
          const suffix = command.type === 'goalSet' ? command.objective.trim()
            : { goalPause: 'pause', goalResume: 'resume', goalClear: 'clear' }[command.type];
          const data = await request({
            type: 'prompt', message: `/goal ${suffix}`, expandPromptTemplates: true, unknownCommandAsText: false,
          });
          if (data?.disposition !== 'handled') throw failure('goal_not_handled', 'Native goal command was not handled', 409, true);
          await confirmation.acknowledge();
          await confirmed;
          return { handled: true };
        } finally { confirmation.stop(); }
      }
    }
  }
  function submit(binding, input, action) {
    binding.requests.add(input.requestId);
    binding.pendingRequests.add(input.requestId);
    const generation = binding.generation;
    const acceptedEpoch = binding.epoch;
    void Promise.resolve().then(() => action(generation)).then((data) => {
      if (generation !== binding.generation || closed) return;
      binding.pendingRequests.delete(input.requestId);
      const result = { requestId: input.requestId, success: true };
      if (data) {
        const picked = {};
        for (const key of ['handled', 'queued', 'sent', 'cancelled', 'name', 'model', 'thinkingLevel']) {
          if (data[key] !== undefined) picked[key] = data[key];
        }
        if (data.disposition) picked[data.disposition === 'handled' ? 'handled' : 'queued'] = true;
        result.data = picked;
      }
      publish(binding, 'commandResult', { result });
    }, (error) => {
      if (generation !== binding.generation || closed) return;
      binding.pendingRequests.delete(input.requestId);
      publish(binding, 'commandResult', { result: {
        requestId: input.requestId, success: false,
        code: error.uncertain ? 'uncertain' : error.code ?? 'native_failed',
        error: error.uncertain ? 'Native outcome is uncertain; accepted work will not be retried'
          : 'Native request failed',
      } });
    });
    return { requestId: input.requestId, connectionEpoch: acceptedEpoch, accepted: true };
  }
  return {
    async status() {
      try {
        await refreshInventory();
        const available = hosts.filter((host) => host.availability === 'ready');
        return {
          available: available.length > 0, protocolVersion: available.length ? 1 : null,
          capabilities: [...new Set(available.flatMap((host) => host.capabilities))],
        };
      } catch { return { available: false, protocolVersion: null, capabilities: [], reason: 'discovery_unavailable' }; }
    },
    async listHosts() {
      await refreshInventory();
      return hosts.map((host) => ({
        hostKey: `h_${hash(host.socketPath ?? host.daemonDir).slice(0, 40)}`,
        ownership: host.endpointKind === 'tui' ? 'terminal' : 'hosted',
        available: host.availability === 'ready', protocolVersion: host.protocol?.protocolVersion ?? null,
        capabilities: host.capabilities,
      }));
    },
    async listSessions({ directory } = {}) {
      await refreshInventory();
      return [...sessions.values()].filter((binding) => !directory || binding.cwd === directory).map(summary);
    },
    async createSession(input) {
      const parsed = validate(z.object({ cwd: text, name: text.max(1_000).optional(), requestId: id }).strict(), input);
      if (closed) throw failure('service_closed', 'Native service is closed');
      if (creates.has(parsed.requestId)) throw failure('duplicate_request', 'Session creation was already submitted; it will not be replayed', 409);
      const cwd = await fs.realpath(parsed.cwd);
      if (!(await fs.stat(cwd)).isDirectory()) throw failure('invalid_directory', 'Session directory is not a directory', 400);
      // App-owned intent marker survives adapter loss. No native transcript/store
      // is written here; an uncertain create can never silently become two sessions.
      const intents = path.join(path.resolve(dataDir), 'create-requests');
      await fs.mkdir(intents, { recursive: true, mode: 0o700 });
      try {
        await fs.writeFile(path.join(intents, `${hash(parsed.requestId)}.intent`), '1\n', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') throw failure('creation_uncertain', 'Session creation was previously submitted; inspect sessions before another create', 409, true);
        throw failure('intent_unavailable', 'Session creation intent could not be recorded');
      }
      creates.add(parsed.requestId);
      await ensureHost({ runtime, socketPath: appSocket, cwd, hostCommandRunner });
      const client = hostClientFactory({ socketPath: appSocket });
      // Capture open-time replay before the live routing handle is known.
      const buffered = [];
      const unsubscribe = client.subscribe((event) => buffered.push(event));
      let binding;
      try {
        const protocol = await client.connect();
        if (!['retain_on_disconnect', 'durable_session_id', 'auto_title_per_session'].every((capability) => protocol.capabilities.includes(capability))) {
          throw failure('creation_unsupported', 'Native host lacks durable retained session creation');
        }
        const durableId = randomUUID();
        const input = {
          type: 'open_session', durableSessionId: durableId, cwd, kind: 'interactive',
          auto_title: false, retain_on_disconnect: true,
        };
        if (protocol.capabilities.includes('prompt_surface_chat')) input.promptSurface = 'chat';
        const opened = nativeData(await client.request(input));
        const rawState = validate(stateSchema, opened.state);
        if (!rawState.sessionFile) throw failure('session_path_unavailable', 'Native session path is unavailable');
        binding = register({
          durableId, sessionPath: rawState.sessionFile, cwd, name: parsed.name,
          host: { socketPath: appSocket, instanceId: protocol.instanceId, stores: [], capabilities: protocol.capabilities },
          handle: validate(id, opened.sessionId), ownership: 'hosted',
        });
        binding.client = client;
        const generation = ++binding.generation;
        unsubscribe();
        const listener = listen(binding, client, generation);
        binding.unsubscribe = listener.unsubscribe;
        await hydrate(binding, opened.state);
        for (const event of buffered) if (event.sessionId === binding.handle) applyEvent(binding, event, false);
        if (parsed.name) await commandRun(binding, { type: 'rename', name: parsed.name });
        listener.commit();
        return summary(binding);
      } catch (error) {
        unsubscribe();
        binding?.unsubscribe?.();
        client.disconnect();
        if (binding) {
          binding.client = undefined;
          binding.connection = 'unavailable';
        }
        if (error.uncertain) throw failure('creation_uncertain', 'Native creation is uncertain; it will not be replayed', 409, true);
        throw error;
      }
    },
    attachSession(key) { return attach(get(key)); },
    async getSnapshot(key) {
      const binding = get(key);
      if (!binding.state) return attach(binding);
      if (binding.connection === 'connected') {
        // Reconcile real history on browser reconnect, never from persisted status.
        const generation = binding.generation;
        const revision = binding.revision;
        const state = await rpc(binding, { type: 'get_state' });
        const history = binding.ownership === 'terminal' ? null : await rpc(binding, { type: 'get_entries' });
        if (generation !== binding.generation) throw failure('snapshot_stale', 'Native snapshot was superseded', 409);
        if (revision === binding.revision) {
          if (history) updateBranch(binding, history.entries, history.leafId);
          binding.state = viewState(state, binding.state.availableModels, binding.state.availableThinkingLevels, binding.state.commands);
        }
        binding.projections = await binding.reader.read({ entries: binding.nativeEntries, leafId: binding.branchLeaf });
      }
      const current = snapshot(binding);
      if (binding.streamingMessage) queueMicrotask(() => {
        if (!closed) publish(binding, 'native', { event: { type: 'message_start', message: binding.streamingMessage } });
      });
      return current;
    },
    async execute(key, envelope) {
      const input = validate(commandEnvelope, envelope);
      const binding = get(key);
      requireWritable(binding, input);
      if (input.command.type.startsWith('goal') &&
          !binding.state.commands.some((item) => item.name === 'goal' && item.source === 'extension')) {
        throw failure('goal_unsupported', 'The native goal extension command is unavailable', 409);
      }
      return submit(binding, input, (generation) => commandRun(binding, input.command, generation));
    },
    async respond(key, envelope) {
      const input = validate(responseEnvelope, envelope);
      const binding = get(key);
      requireWritable(binding, input);
      const interaction = binding.interactions.get(input.uiRequestId);
      if (!interaction || binding.responses.has(input.uiRequestId)) throw failure('interaction_resolved', 'Native interaction is no longer answerable', 409);
      const answer = input.response;
      if (!answer.cancelled) {
        if (interaction.method === 'confirm' ? answer.confirmed === undefined
          : interaction.method === 'question' ? answer.answers === undefined : answer.value === undefined) {
          throw failure('invalid_answer', 'Answer does not match the native interaction', 400);
        }
        if (interaction.method === 'select' && !interaction.options.includes(answer.value)) {
          throw failure('invalid_answer', 'Selection is not a native option', 400);
        }
        if (interaction.method === 'question') {
          for (const [key, value] of Object.entries(answer.answers)) {
            const question = interaction.questions.find((item) => item.id === key);
            if (!question || (!question.multiSelect && value.selected.length > 1) ||
                value.selected.some((label) => !question.options.some((option) => option.label === label))) {
              throw failure('invalid_answer', 'Answer does not match a native question', 400);
            }
          }
        }
      }
      binding.responses.add(input.uiRequestId);
      return submit(binding, input, async (generation) => {
        await rpc(binding, { type: 'extension_ui_response', uiRequestId: input.uiRequestId, ...answer }, generation);
        binding.interactions.delete(input.uiRequestId);
        publish(binding, 'native', { event: { type: 'interaction_resolved', id: input.uiRequestId } });
      });
    },
    async getTaskOutput(key, taskId, options = {}) {
      const binding = get(key);
      if (binding.ownership !== 'hosted' || binding.connection !== 'connected') throw failure('read_only_session', 'Native task output needs its connected parent', 409);
      validate(id, taskId);
      const parsed = validate(z.object({
        mode: z.enum(['status', 'tail', 'full']).optional(), tailLines: z.number().int().min(1).max(1_000).optional(),
      }).strict(), options);
      return taskOutput(binding, taskId, parsed);
    },
    async isDirectoryInUse(directory) {
      const canonical = await fs.realpath(directory);
      await refreshInventory();
      if (hosts.some((host) => host.availability === 'unavailable')) {
        throw failure('directory_ownership_uncertain', 'Native directory ownership is unavailable', 409);
      }
      return [...sessions.values()].some((binding) => {
        const relative = path.relative(canonical, binding.cwd);
        const contained = relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
        return contained && (binding.client || binding.host?.availability === 'ready');
      });
    },
    subscribe(key, listener) {
      const binding = get(key);
      binding.listeners.add(listener);
      return () => binding.listeners.delete(listener);
    },
    async close() {
      closed = true;
      for (const binding of sessions.values()) {
        binding.generation += 1;
        binding.unsubscribe?.();
        binding.unsubscribeProjection?.();
        binding.reader?.stop();
        binding.client?.disconnect();
        binding.listeners.clear();
      }
      // Retained native sessions/hosts are not ours to close, signal or unlink.
    },
  };
}
