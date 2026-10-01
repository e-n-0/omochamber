import assert from 'node:assert/strict';
import { createNativeClient } from '../client';
import { createNativeStore } from '../state';
import { commandEnvelopeSchema, taskOutputOptionsSchema } from '../contracts';
import type { CommandEnvelope, NativeSnapshot, SessionEvent, TaskOutput, TaskView } from '../contracts';
import type { NativeStore } from '../state';

export const taskFixture: TaskView = {
  taskId: 'task-a', parentSessionId: 'parent-a', status: 'running', source: 'persisted',
  taskSummary: 'Inspect the native state contract', output: 'RECORDED_OUTPUT',
};

export function panelSnapshot(sessionKey = 'session-a'): NativeSnapshot {
  return {
    schemaVersion: 1, sessionKey, durableSessionId: 'parent-a', connectionEpoch: 1, revision: 1,
    ownership: 'hosted', connection: 'connected',
    state: {
      directory: '/workspace', name: 'Panels fixture', isStreaming: false, isCompacting: false,
      isBashRunning: false, isRetrying: false, retryAttempt: 0, projectTrusted: true,
      model: null, thinkingLevel: null, availableModels: [], availableThinkingLevels: [],
      commands: [{ name: 'goal', source: 'extension' }],
    },
    activeBranch: { leafId: null, entries: [] }, pendingInteractions: [],
    goal: { status: 'ready', value: {
      id: 'goal-a', threadId: 'parent-a', objective: 'Verify source-backed work state',
      status: 'active', tokensUsed: 125, timeUsedSeconds: 12, createdAt: 1, updatedAt: 2,
    } },
    todo: { status: 'ready', value: { version: 2, phases: [
      { name: 'Investigation', tasks: [{ content: 'Inspect contracts', status: 'completed' }] },
      { name: 'Verification', tasks: [{ content: 'Exercise native controls', status: 'in_progress' }] },
    ] } },
    tasks: { status: 'ready', value: [taskFixture] },
    dags: { status: 'ready', value: [{
      runId: 'dag-a', name: 'Native panel verification', status: 'running', generation: 1, lastSeq: 4,
      nodes: [
        { nodeId: 'inspect', status: 'completed', taskId: 'task-a', wave: 0 },
        { nodeId: 'verify', status: 'blocked', wave: 1 },
      ],
      edges: [{ from: 'inspect', to: 'verify' }], waves: [['inspect'], ['verify']],
      counts: { pending: 0, blocked: 1, scheduled: 0, running: 0, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
    }] },
  };
}

function untilPanelState(store: NativeStore, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(2_000);
    const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', timedOut); };
    const timedOut = () => { cleanup(); reject(new Error('Panel state deadline exceeded')); };
    const observe = () => { if (predicate()) { cleanup(); resolve(); } };
    const unsubscribe = store.subscribe(observe);
    signal.addEventListener('abort', timedOut, { once: true });
    observe();
  });
}

/** Real client/store at an injected HTTP/SSE boundary. No module replacement. */
export function createPanelFixture(initial = panelSnapshot()) {
  let snapshot = initial;
  const commands: CommandEnvelope[] = [];
  const outputCalls: { path: string; mode?: string; tailLines?: number }[] = [];
  const streams: { controller: ReadableStreamDefaultController<Uint8Array>; cancelled: boolean }[] = [];
  let failRead = false;
  let outputReader: (() => Promise<Response>) | null = null;
  const defaultOutput: TaskOutput = { task: { ...taskFixture, source: 'live' }, output: 'NATIVE_OUTPUT', truncated: true };
  const client = createNativeClient({
    fetch: async (path, options) => {
      if (path.endsWith('/events')) {
        let record: (typeof streams)[number] | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) { record = { controller, cancelled: false }; streams.push(record); },
          cancel() { assert(record); record.cancelled = true; },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path.endsWith('/attach')) return Response.json(snapshot);
      if (path.endsWith('/snapshot')) return failRead ? new Response(null, { status: 503 }) : Response.json(snapshot);
      if (path.endsWith('/commands')) {
        const command = commandEnvelopeSchema.parse(JSON.parse(String(options?.body)));
        commands.push(command);
        return Response.json({ requestId: command.requestId, connectionEpoch: command.connectionEpoch, accepted: true }, { status: 202 });
      }
      if (path.endsWith('/tasks/task-a/output')) {
        const outputOptions = taskOutputOptionsSchema.parse(options?.query);
        outputCalls.push({ path, mode: outputOptions.mode, tailLines: outputOptions.tailLines });
        return outputReader ? outputReader() : Response.json(defaultOutput);
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    },
  });
  const store = createNativeStore({ client });
  const emit = (event: SessionEvent) => {
    const stream = [...streams].reverse().find((candidate) => !candidate.cancelled);
    assert(stream);
    stream.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  return {
    client, store, commands, outputCalls, streams,
    setSnapshot(next: NativeSnapshot) { snapshot = next; },
    setReadFailure(value: boolean) { failRead = value; },
    setOutputReader(reader: () => Promise<Response>) { outputReader = reader; },
    async publish(next: NativeSnapshot) {
      const ready = untilPanelState(store, () => store.getState().sessions.get(next.sessionKey)?.snapshot?.revision === next.revision);
      snapshot = next;
      emit({ type: 'snapshot', sessionKey: next.sessionKey, connectionEpoch: next.connectionEpoch, revision: next.revision, snapshot: next });
      await ready;
    },
    async settle(command: CommandEnvelope, success = true) {
      const ready = untilPanelState(store, () => {
        const status = store.getState().sessions.get(snapshot.sessionKey)?.mutations.get(command.requestId)?.status;
        return status === 'succeeded' || status === 'failed';
      });
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      emit({
        type: 'commandResult', sessionKey: snapshot.sessionKey, connectionEpoch: command.connectionEpoch,
        revision: snapshot.revision,
        result: success ? { requestId: command.requestId, success: true, data: { handled: true } }
          : { requestId: command.requestId, success: false, error: 'FIXTURE_REFUSAL' },
      });
      await ready;
    },
    async delta(revision: number) {
      const ready = untilPanelState(store, () => store.getState().sessions.get(snapshot.sessionKey)?.snapshot?.revision === revision);
      emit({
        type: 'native', sessionKey: snapshot.sessionKey, connectionEpoch: snapshot.connectionEpoch, revision,
        event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'DELTA' } },
      });
      snapshot = { ...snapshot, revision };
      await ready;
    },
    async dispose() { await store.dispose(); assert(streams.every((stream) => stream.cancelled)); },
  };
}
