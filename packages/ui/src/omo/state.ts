import { createNativeClient, NativeClientError } from './client';
import type { NativeClient, NativeSubscription } from './client';
import type {
  AssistantDelta, CommandResult, ContentBlock, InteractionAnswer, NativeCommand,
  NativeEvent, NativeMessage, NativeSnapshot, PendingInteraction, SessionEvent,
} from './contracts';

export class NativeStateError extends Error {
  readonly name = 'NativeStateError';
  constructor(readonly kind: 'not-ready' | 'read-only' | 'duplicate-request' | 'stale-interaction' | 'invalid-answer') {
    super(`Native operation refused: ${kind}`);
  }
}
export type NativeMutation = {
  readonly requestId: string;
  readonly connectionEpoch: number;
  readonly interactionId?: string;
} & (
  | { readonly status: 'submitting' | 'accepted' }
  | { readonly status: 'succeeded'; readonly result: CommandResult }
  | { readonly status: 'failed' | 'uncertain'; readonly error: Error }
);
export type NativeToolExecution = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: 'running' | 'completed' | 'error';
  readonly content: readonly ContentBlock[];
};
export type NativeSessionState = {
  readonly status: 'hydrating' | 'ready' | 'reconnecting' | 'unavailable';
  readonly snapshot: NativeSnapshot | null;
  readonly error: Error | null;
  readonly liveMessage: NativeMessage | null;
  readonly liveContent: readonly ContentBlock[];
  readonly toolArguments: ReadonlyMap<string, string>;
  readonly tools: ReadonlyMap<string, NativeToolExecution>;
  readonly mutations: ReadonlyMap<string, NativeMutation>;
};
export type NativeStoreState = {
  readonly runtimeKey: string;
  readonly selectedSessionKey: string | null;
  readonly sessions: ReadonlyMap<string, NativeSessionState>;
};
export interface NativeStoreOptions {
  readonly client?: NativeClient;
  readonly requestId?: () => string;
  /** Testable recovery pacing, not a mutation retry hook. Aborting must release it. */
  readonly waitForReconnect?: (attempt: number, signal: AbortSignal, error: Error) => Promise<void>;
}

const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error('Native lifecycle failed', { cause });
const initialSession = (): NativeSessionState => ({
  status: 'hydrating', snapshot: null, error: null, liveMessage: null,
  liveContent: [], toolArguments: new Map(), tools: new Map(), mutations: new Map(),
});
function preserveProjections(previous: NativeSnapshot | null, next: NativeSnapshot): NativeSnapshot {
  if (!previous) return next;
  const goal = next.goal.status !== 'ready' && next.goal.value === null
    ? { ...next.goal, value: previous.goal.value } : next.goal;
  const todo = next.todo.status !== 'ready' && next.todo.value === null
    ? { ...next.todo, value: previous.todo.value } : next.todo;
  const tasks = next.tasks.status === 'ready' ? next.tasks : {
    ...next.tasks,
    value: next.tasks.value === null ? previous.tasks.value
      : [...new Map([
        ...(previous.tasks.value ?? []).map((task) => [task.taskId, task] as const),
        ...next.tasks.value.map((task) => [task.taskId, task] as const),
      ]).values()],
  };
  const dags = next.dags.status === 'ready' ? next.dags : {
    ...next.dags,
    value: next.dags.value === null ? previous.dags.value
      : [...new Map([
        ...(previous.dags.value ?? []).map((dag) => [dag.runId, dag] as const),
        ...next.dags.value.map((dag) => [dag.runId, dag] as const),
      ]).values()],
  };
  return { ...next, goal, todo, tasks, dags };
}
function applyDelta(session: NativeSessionState, delta: AssistantDelta): NativeSessionState {
  const content = [...session.liveContent];
  const block = content[delta.contentIndex];
  let argumentsById = session.toolArguments;
  switch (delta.type) {
    case 'text_start': content[delta.contentIndex] = { type: 'text', text: '' }; break;
    case 'text_delta': content[delta.contentIndex] = {
      type: 'text', text: (block?.type === 'text' ? block.text : '') + delta.delta,
    }; break;
    case 'text_end': content[delta.contentIndex] = { type: 'text', text: delta.content }; break;
    case 'thinking_start': content[delta.contentIndex] = { type: 'thinking', thinking: '' }; break;
    case 'thinking_delta': content[delta.contentIndex] = {
      type: 'thinking', thinking: (block?.type === 'thinking' ? block.thinking : '') + delta.delta,
    }; break;
    case 'thinking_end': content[delta.contentIndex] = { type: 'thinking', thinking: delta.content }; break;
    case 'toolcall_start':
      content[delta.contentIndex] = { type: 'toolCall', id: delta.id, name: delta.toolName, arguments: {} };
      argumentsById = new Map(argumentsById).set(delta.id, '');
      break;
    case 'toolcall_delta':
      if (block?.type === 'toolCall') {
        argumentsById = new Map(argumentsById).set(block.id, (argumentsById.get(block.id) ?? '') + delta.delta);
      }
      break;
    case 'toolcall_end': {
      content[delta.contentIndex] = delta.toolCall;
      const completedArguments = new Map(argumentsById);
      completedArguments.delete(delta.toolCall.id);
      argumentsById = completedArguments;
      break;
    }
    default: delta satisfies never;
  }
  return { ...session, liveContent: content, toolArguments: argumentsById };
}
function messageContent(message: NativeMessage): ContentBlock[] {
  switch (message.role) {
    case 'bashExecution': return [{ type: 'text', text: message.output }];
    case 'assistant':
    case 'toolResult': return message.content;
    case 'user':
    case 'custom': return Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    default: message satisfies never; return [];
  }
}
function updateInteraction(
  interactions: readonly PendingInteraction[], interaction: PendingInteraction,
): PendingInteraction[] {
  const index = interactions.findIndex((pending) => pending.id === interaction.id);
  if (index === -1) return [...interactions, interaction];
  const next = [...interactions];
  next[index] = interaction;
  return next;
}
function reduceNative(session: NativeSessionState, event: NativeEvent): NativeSessionState {
  const snapshot = session.snapshot;
  if (!snapshot) return session;
  switch (event.type) {
    case 'agent_start': return { ...session, snapshot: { ...snapshot, state: { ...snapshot.state, isStreaming: true } } };
    case 'agent_end': return session; // Native settled, not low-level end, owns idle.
    case 'agent_settled':
    case 'agent_idle': return {
      ...session, snapshot: { ...snapshot, state: { ...snapshot.state, isStreaming: false, isRetrying: false } },
    };
    case 'message_start': return {
      ...session, liveMessage: event.message, liveContent: messageContent(event.message), toolArguments: new Map(),
    };
    case 'message_update': return applyDelta(session, event.assistantMessageEvent);
    case 'message_end': return {
      ...session, liveMessage: event.message, liveContent: messageContent(event.message), toolArguments: new Map(),
    };
    case 'entry_appended': {
      if (snapshot.activeBranch.entries.some((entry) => entry.id === event.entry.id)) return session;
      if (event.entry.parentId !== snapshot.activeBranch.leafId) return session;
      const persistedLive = event.entry.type === 'message' &&
        session.liveMessage?.timestamp === event.entry.message.timestamp &&
        session.liveMessage.role === event.entry.message.role;
      return {
        ...session,
        liveMessage: persistedLive ? null : session.liveMessage,
        liveContent: persistedLive ? [] : session.liveContent,
        snapshot: {
          ...snapshot, activeBranch: {
            leafId: event.entry.id, entries: [...snapshot.activeBranch.entries, event.entry],
          },
        },
      };
    }
    case 'model_changed': return { ...session, snapshot: {
      ...snapshot, state: { ...snapshot.state, model: event.model, thinkingLevel: event.thinkingLevel },
    } };
    case 'commands_changed': return { ...session, snapshot: { ...snapshot, state: { ...snapshot.state, commands: event.commands } } };
    case 'compaction_start':
    case 'compaction_end': return { ...session, snapshot: {
      ...snapshot, state: { ...snapshot.state, isCompacting: event.type === 'compaction_start' },
    } };
    case 'auto_retry_start':
    case 'auto_retry_end': return { ...session, snapshot: {
      ...snapshot, state: { ...snapshot.state, isRetrying: event.type === 'auto_retry_start', retryAttempt: event.attempt },
    } };
    case 'extension_ui_request': return {
      ...session, snapshot: { ...snapshot, pendingInteractions: updateInteraction(snapshot.pendingInteractions, event) },
    };
    case 'interaction_pending': return {
      ...session, snapshot: { ...snapshot, pendingInteractions: updateInteraction(snapshot.pendingInteractions, event.interaction) },
    };
    case 'question_updated': return { ...session, snapshot: {
      ...snapshot, pendingInteractions: snapshot.pendingInteractions.map((pending) => pending.id === event.id
        ? { ...pending, deadlineAtMs: event.deadlineAtMs, remainingMs: event.remainingMs } : pending),
    } };
    case 'question_resolved':
    case 'interaction_resolved': return { ...session, snapshot: {
      ...snapshot, pendingInteractions: snapshot.pendingInteractions.filter((pending) => pending.id !== event.id),
    } };
    case 'projections': return { ...session, snapshot: preserveProjections(snapshot, {
      ...snapshot, goal: event.goal, todo: event.todo, tasks: event.tasks, dags: event.dags,
    }) };
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_execution_end': return { ...session, tools: new Map(session.tools).set(event.toolCallId, {
      toolCallId: event.toolCallId, toolName: event.toolName,
      status: event.type === 'tool_execution_end' ? (event.isError ? 'error' : 'completed') : 'running',
      content: event.type === 'tool_execution_start' ? [] :
        event.type === 'tool_execution_update' ? event.partialResult.content : event.result.content,
    }) };
    case 'bash_execution_update':
    case 'unhandled':
    case 'extension_event': return session; // Extension inventory changes resnapshot, never opaque data.
    default: event satisfies never; return session;
  }
}
function waitForReconnect(attempt: number, signal: AbortSignal, error: Error): Promise<void> {
  const permanent = error instanceof NativeClientError && error.status !== null &&
    error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
  const background = globalThis.navigator?.onLine === false ||
    globalThis.document?.visibilityState === 'hidden';
  const delay = permanent || background ? 60_000 : Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000);
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      globalThis.removeEventListener?.('online', finish);
      globalThis.document?.removeEventListener('visibilitychange', visible);
      resolve();
    };
    const visible = () => { if (globalThis.document?.visibilityState === 'visible') finish(); };
    const timer = setTimeout(finish, delay);
    signal.addEventListener('abort', finish, { once: true });
    globalThis.addEventListener?.('online', finish, { once: true });
    globalThis.document?.addEventListener('visibilitychange', visible);
    if (signal.aborted) finish();
  });
}
type Attachment = {
  readonly key: string;
  readonly runtimeKey: string;
  readonly generation: number;
  readonly abort: AbortController;
  subscription: NativeSubscription | null;
  hydrating: boolean;
  recovering: boolean;
  buffer: SessionEvent[];
  refresh: Promise<NativeSessionState | null> | null;
};

/**
 * Framework-free external store/controller. Subscribe, then read getState().
 * selectSession/reconnect resolve the committed state, never a stale HTTP value.
 * resetRuntime is required on runtime switches (including A -> B -> A).
 */
export function createNativeStore(options: NativeStoreOptions = {}) {
  const client = options.client ?? createNativeClient();
  const newRequestId = options.requestId ?? (() => crypto.randomUUID());
  const recoveryWait = options.waitForReconnect ?? waitForReconnect;
  const listeners = new Set<() => void>();
  let state: NativeStoreState = { runtimeKey: client.runtimeKey(), selectedSessionKey: null, sessions: new Map() };
  let generation = 0;
  let attachment: Attachment | null = null;
  let disposed = false;
  let failures = 0;

  const current = (owner: Attachment) => !disposed && attachment === owner &&
    owner.generation === generation && state.selectedSessionKey === owner.key &&
    state.runtimeKey === owner.runtimeKey && client.runtimeKey() === owner.runtimeKey && !owner.abort.signal.aborted;
  function publish(key: string, session: NativeSessionState) {
    state = { ...state, sessions: new Map(state.sessions).set(key, session) };
    for (const listener of listeners) listener();
  }
  function uncertain(key: string, error: Error) {
    const session = state.sessions.get(key);
    if (!session) return;
    let changed = false;
    const mutations = new Map(session.mutations);
    for (const [requestId, mutation] of mutations) {
      if (mutation.status === 'submitting' || mutation.status === 'accepted') {
        changed = true;
        mutations.set(requestId, { ...mutation, status: 'uncertain', error });
      }
    }
    if (changed) publish(key, { ...session, mutations });
  }
  function detach() {
    const owner = attachment;
    attachment = null;
    generation += 1;
    if (!owner) return;
    owner.abort.abort();
    owner.subscription?.close();
    uncertain(owner.key, new NativeClientError('transport', 'Native connection changed before a correlated result'));
  }
  function commitSnapshot(owner: Attachment, snapshot: NativeSnapshot) {
    if (!current(owner) || owner.recovering) return;
    if (snapshot.sessionKey !== owner.key) throw new NativeClientError('correlation', 'Snapshot session mismatch');
    const session = state.sessions.get(owner.key) ?? initialSession();
    const previous = session.snapshot;
    if (previous && (snapshot.connectionEpoch < previous.connectionEpoch ||
      (snapshot.connectionEpoch === previous.connectionEpoch && snapshot.revision < previous.revision))) return;
    if (previous && snapshot.connectionEpoch !== previous.connectionEpoch) uncertain(owner.key, new NativeClientError('transport', 'Native epoch changed'));
    let next: NativeSessionState = {
      ...(state.sessions.get(owner.key) ?? session), status: snapshot.connection === 'connected' ? 'ready' : snapshot.connection,
      error: null, snapshot: preserveProjections(previous, snapshot),
    };
    if (previous?.connectionEpoch !== snapshot.connectionEpoch || !snapshot.state.isStreaming) {
      next = { ...next, liveMessage: null, liveContent: [], toolArguments: new Map() };
    }
    publish(owner.key, next);
  }
  function accept(owner: Attachment, event: SessionEvent) {
    if (!current(owner) || owner.recovering || event.sessionKey !== owner.key) return;
    if (owner.hydrating) { owner.buffer.push(event); return; }
    if (event.type === 'snapshot') { commitSnapshot(owner, event.snapshot); return; }
    let session = state.sessions.get(owner.key);
    if (!session?.snapshot || event.connectionEpoch < session.snapshot.connectionEpoch) return;
    if (event.connectionEpoch > session.snapshot.connectionEpoch) {
      void refresh(owner); // Only snapshots may establish a new epoch.
      return;
    }
    if (event.type === 'commandResult') {
      const mutation = session.mutations.get(event.result.requestId);
      if (mutation && mutation.connectionEpoch === event.connectionEpoch &&
        mutation.status !== 'succeeded' && mutation.status !== 'failed') {
        publish(owner.key, { ...session, mutations: new Map(session.mutations).set(event.result.requestId,
          event.result.success ? { ...mutation, status: 'succeeded', result: event.result }
            : { ...mutation, status: 'failed', error: new NativeClientError('http', event.result.error) }),
        });
      }
      // Result correlation is independent of snapshot revision: snapshots don't
      // contain the submission ledger, so represented results still settle it.
      session = state.sessions.get(owner.key);
      if (!session?.snapshot || event.revision <= session.snapshot.revision) return;
    }
    if (event.revision <= session.snapshot.revision) return;
    if (event.revision !== session.snapshot.revision + 1) {
      void refresh(owner); // A replay gap is not an invitation to guess a delta.
      return;
    }
    const reconnected = event.type === 'connection' && event.connection === 'connected' &&
      session.snapshot.connection !== 'connected';
    switch (event.type) {
      case 'native': session = reduceNative(session, event.event); break;
      case 'connection':
        if (event.connection !== 'connected') uncertain(owner.key, new NativeClientError('transport', 'Native connection unavailable'));
        session = {
          ...(state.sessions.get(owner.key) ?? session),
          status: event.connection === 'connected' ? (reconnected ? 'reconnecting' : 'ready') : event.connection,
        };
        break;
      case 'commandResult': break;
      default: event satisfies never;
    }
    if (!session.snapshot) return;
    publish(owner.key, { ...session, snapshot: {
      ...session.snapshot, revision: event.revision,
      connection: event.type === 'connection' ? event.connection : session.snapshot.connection,
    } });
    if (reconnected || (event.type === 'native' && (event.event.type === 'extension_event' ||
      (event.event.type === 'entry_appended' && event.event.entry.id !== session.snapshot.activeBranch.leafId)))) {
      void refresh(owner);
    }
  }
  async function refresh(owner: Attachment): Promise<NativeSessionState | null> {
    if (!current(owner) || owner.recovering) return null;
    if (owner.refresh) return owner.refresh;
    owner.hydrating = true;
    owner.refresh = (async () => {
      try {
        const snapshot = await client.getSnapshot(owner.key, owner.abort.signal);
        commitSnapshot(owner, snapshot);
      } catch (cause) {
        if (current(owner) && !owner.recovering) {
          const session = state.sessions.get(owner.key) ?? initialSession();
          publish(owner.key, { ...session, status: 'unavailable', error: asError(cause) });
        }
      } finally {
        owner.hydrating = false;
        owner.refresh = null;
        const events = owner.buffer;
        owner.buffer = [];
        for (const event of events) accept(owner, event);
      }
      return current(owner) ? state.sessions.get(owner.key) ?? null : null;
    })();
    return owner.refresh;
  }
  function recover(owner: Attachment, cause: unknown) {
    if (!current(owner) || owner.recovering) return;
    owner.recovering = true;
    const error = asError(cause);
    uncertain(owner.key, error);
    const session = state.sessions.get(owner.key) ?? initialSession();
    publish(owner.key, { ...session, status: 'reconnecting', error });
    owner.subscription?.close();
    void recoveryWait(failures++, owner.abort.signal, error).then(() => {
      if (current(owner)) void connect(owner.key);
    });
  }
  async function connect(key: string): Promise<NativeSessionState | null> {
    detach();
    if (disposed) return null;
    if (state.runtimeKey !== client.runtimeKey()) {
      state = { runtimeKey: client.runtimeKey(), selectedSessionKey: null, sessions: new Map() };
    }
    state = { ...state, selectedSessionKey: key };
    const cached = state.sessions.get(key) ?? initialSession();
    publish(key, { ...cached, status: cached.snapshot ? 'reconnecting' : 'hydrating', error: null });
    const owner: Attachment = {
      key, runtimeKey: state.runtimeKey, generation, abort: new AbortController(),
      subscription: null, hydrating: true, recovering: false, buffer: [], refresh: null,
    };
    attachment = owner;
    owner.subscription = client.subscribe(key, (event) => accept(owner, event), owner.abort.signal);
    void owner.subscription.done.then(
      () => { if (current(owner)) recover(owner, new NativeClientError('stream-ended', 'Native event stream ended')); },
      (cause) => recover(owner, cause),
    );
    try {
      await owner.subscription.ready;
      if (!current(owner) || owner.recovering) return null;
      const attached = await client.attachSession(key, owner.abort.signal);
      if (!current(owner) || owner.recovering) return null;
      if (attached.sessionKey !== key) throw new NativeClientError('correlation', 'Attached session mismatch');
      await refresh(owner);
      if (current(owner) && state.sessions.get(key)?.status === 'ready') failures = 0;
      else if (current(owner)) recover(owner, state.sessions.get(key)?.error ?? new NativeStateError('not-ready'));
    } catch (cause) {
      recover(owner, cause);
    }
    return current(owner) ? state.sessions.get(key) ?? null : null;
  }
  function selected() {
    const owner = attachment;
    const session = owner && state.sessions.get(owner.key);
    if (!owner || !current(owner) || !session?.snapshot || session.status !== 'ready' ||
      session.snapshot.connection !== 'connected') throw new NativeStateError('not-ready');
    if (session.snapshot.ownership !== 'hosted') throw new NativeStateError('read-only');
    return { owner, session, snapshot: session.snapshot };
  }
  async function mutate(command: NativeCommand | null, interaction: { id: string; answer: InteractionAnswer } | null, requestId: string) {
    const { owner, session, snapshot } = selected();
    if (session.mutations.has(requestId)) throw new NativeStateError('duplicate-request');
    const pending: NativeMutation = { requestId, connectionEpoch: snapshot.connectionEpoch, status: 'submitting' };
    const mutation: NativeMutation = interaction ? { ...pending, interactionId: interaction.id } : pending;
    publish(owner.key, { ...session, mutations: new Map(session.mutations).set(requestId, mutation) });
    try {
      const envelope = { requestId, connectionEpoch: snapshot.connectionEpoch };
      if (interaction) await client.respond(owner.key, { ...envelope, uiRequestId: interaction.id, response: interaction.answer }, owner.abort.signal);
      else if (command) await client.execute(owner.key, { ...envelope, command }, owner.abort.signal);
      if (current(owner)) {
        const latest = state.sessions.get(owner.key);
        const pending = latest?.mutations.get(requestId);
        if (latest && pending?.status === 'submitting') publish(owner.key, {
          ...latest, mutations: new Map(latest.mutations).set(requestId, { ...pending, status: 'accepted' }),
        });
      }
    } catch (cause) {
      if (current(owner)) {
        const latest = state.sessions.get(owner.key);
        const pending = latest?.mutations.get(requestId);
        if (latest && pending && (pending.status === 'submitting' || pending.status === 'accepted')) {
          const error = asError(cause);
          const status = error instanceof NativeClientError && (error.kind !== 'http' || (error.status ?? 500) >= 500)
            ? 'uncertain' : 'failed';
          publish(owner.key, { ...latest, mutations: new Map(latest.mutations).set(requestId, { ...pending, status, error }) });
        }
      }
    }
    return state.sessions.get(owner.key)?.mutations.get(requestId) ?? mutation;
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    selectSession(key: string) { failures = 0; return connect(key); },
    reconnect() { return state.selectedSessionKey ? connect(state.selectedSessionKey) : Promise.resolve(null); },
    refresh() { return attachment ? refresh(attachment) : Promise.resolve(null); },
    execute(command: NativeCommand, requestId = newRequestId()) { return mutate(command, null, requestId); },
    respond(uiRequestId: string, answer: InteractionAnswer, requestId = newRequestId()) {
      const { session, snapshot } = selected();
      const interaction = snapshot.pendingInteractions.find((pending) => pending.id === uiRequestId);
      if (!interaction) throw new NativeStateError('stale-interaction');
      for (const mutation of session.mutations.values()) {
        if (mutation.interactionId === uiRequestId && mutation.status !== 'failed') throw new NativeStateError('duplicate-request');
      }
      if (!('cancelled' in answer)) {
        switch (interaction.method) {
          case 'select':
            if (!('value' in answer) || !interaction.options.includes(answer.value)) throw new NativeStateError('invalid-answer');
            break;
          case 'confirm': if (!('confirmed' in answer)) throw new NativeStateError('invalid-answer'); break;
          case 'input':
          case 'editor': if (!('value' in answer)) throw new NativeStateError('invalid-answer'); break;
          case 'question': if (!('answers' in answer)) throw new NativeStateError('invalid-answer'); break;
          default: interaction satisfies never;
        }
      }
      return mutate(null, { id: uiRequestId, answer }, requestId);
    },
    resetRuntime() {
      detach();
      failures = 0;
      state = { runtimeKey: client.runtimeKey(), selectedSessionKey: null, sessions: new Map() };
      for (const listener of listeners) listener();
    },
    async dispose() {
      const finished = attachment?.subscription?.done;
      detach();
      disposed = true;
      listeners.clear();
      // Stream errors already belong to recovery/state. Disposal only waits for
      // reader cleanup, including a stream that had failed before disposal.
      await finished?.then(() => undefined, () => undefined);
    },
  };
}
export type NativeStore = ReturnType<typeof createNativeStore>;
