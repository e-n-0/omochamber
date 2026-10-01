import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createNativeClient } from './client';
import { createNativeStore, NativeStateError } from './state';
import type { NativeSessionState, NativeStore } from './state';
import { commandEnvelopeSchema, uiResponseEnvelopeSchema } from './contracts';
import type { NativeEvent, NativeSnapshot, SessionEvent } from './contracts';

function gate<T>() {
  let deliver: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { deliver = resolve; });
  return { promise, resolve(value: T) { assert(deliver); deliver(value); } };
}
const snapshotFixture = (sessionKey = 'a', revision = 1, connectionEpoch = 1): NativeSnapshot => ({
  schemaVersion: 1, sessionKey, durableSessionId: `durable-${sessionKey}`, connectionEpoch, revision,
  ownership: 'hosted', connection: 'connected',
  state: {
    directory: `/workspace/${sessionKey}`, name: sessionKey, isStreaming: false, isCompacting: false,
    isBashRunning: false, isRetrying: false, retryAttempt: 0, projectTrusted: true,
    model: { provider: 'provider', id: 'model' }, thinkingLevel: 'medium',
    availableModels: [], availableThinkingLevels: [], commands: [{ name: 'goal', source: 'extension' }],
  },
  activeBranch: {
    leafId: 'root', entries: [{
      type: 'message', id: 'root', parentId: null, timestamp: '2026-09-30T00:00:00.000Z',
      message: { role: 'user', content: 'hello', timestamp: 1 },
    }],
  },
  goal: { status: 'ready', value: null }, todo: { status: 'ready', value: null },
  tasks: { status: 'ready', value: [] }, dags: { status: 'ready', value: [] }, pendingInteractions: [],
});
function session(store: NativeStore, key = 'a'): NativeSessionState {
  const value = store.getState().sessions.get(key);
  assert(value);
  return value;
}
function untilState(store: NativeStore, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(2_000);
    const cleanup = () => { unsubscribe(); signal.removeEventListener('abort', timedOut); };
    const timedOut = () => { cleanup(); reject(new Error('State transition deadline exceeded')); };
    const observe = () => { if (predicate()) { cleanup(); resolve(); } };
    const unsubscribe = store.subscribe(observe);
    signal.addEventListener('abort', timedOut, { once: true });
    observe();
  });
}
type WireStream = {
  readonly key: string;
  readonly controller: ReadableStreamDefaultController<Uint8Array>;
  cancelled: boolean;
  ended: boolean;
};
function wireHarness() {
  const streams: WireStream[] = [];
  const calls: string[] = [];
  const snapshots = new Map<string, NativeSnapshot>();
  let read: ((key: string) => Promise<Response>) | null = null;
  let command: ((path: string, body: string) => Promise<Response>) | null = null;
  const client = createNativeClient({
    fetch: async (path, init) => {
      calls.push(path);
      const match = /^\/api\/omo\/sessions\/([^/]+)\/(events|attach|snapshot|commands|ui-responses)$/.exec(path);
      assert(match, `Unexpected path ${path}`);
      const key = decodeURIComponent(match[1]);
      const action = match[2];
      if (action === 'events') {
        let stream: WireStream | undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) { stream = { key, controller, cancelled: false, ended: false }; streams.push(stream); },
          cancel() { assert(stream); stream.cancelled = true; },
        });
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (action === 'snapshot' && read) return read(key);
      if (action === 'attach' || action === 'snapshot') return Response.json(snapshots.get(key) ?? snapshotFixture(key));
      const body = String(init?.body);
      if (command) return command(path, body);
      const envelope = action === 'commands' ? commandEnvelopeSchema.parse(JSON.parse(body))
        : uiResponseEnvelopeSchema.parse(JSON.parse(body));
      return Response.json({
        requestId: envelope.requestId, connectionEpoch: envelope.connectionEpoch, accepted: true,
      }, { status: 202 });
    },
  });
  const recovery = gate<void>();
  const store = createNativeStore({
    client, waitForReconnect: (_attempt, signal) => new Promise((resolve) => {
      const finish = () => { signal.removeEventListener('abort', finish); resolve(); };
      signal.addEventListener('abort', finish, { once: true });
      void recovery.promise.then(finish);
      if (signal.aborted) finish();
    }),
  });
  const emit = (event: SessionEvent, stream = [...streams].reverse().find((item) => item.key === event.sessionKey && !item.cancelled && !item.ended)) => {
    assert(stream);
    stream.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const native = (revision: number, event: NativeEvent, key = 'a', epoch = 1) =>
    emit({ type: 'native', sessionKey: key, connectionEpoch: epoch, revision, event });
  return {
    store, client, calls, snapshots, streams, recovery, emit, native,
    end(stream: WireStream) { stream.ended = true; stream.controller.close(); },
    setRead(handler: (key: string) => Promise<Response>) { read = handler; },
    setCommand(handler: (path: string, body: string) => Promise<Response>) { command = handler; },
  };
}

describe('native state lifecycle through HTTP/SSE', () => {
  test('subscribes before attachment and snapshot and applies only unrepresented buffered events', async () => {
    const h = wireHarness();
    const requested = gate<void>();
    const answer = gate<Response>();
    h.setRead(async () => { requested.resolve(); return answer.promise; });
    try {
      const selected = h.store.selectSession('a');
      await requested.promise;
      h.native(1, { type: 'agent_start' }); // Already represented by snapshot revision 1.
      h.native(2, { type: 'model_changed', model: { provider: 'new', id: 'new' }, thinkingLevel: 'high' });
      answer.resolve(Response.json(snapshotFixture()));
      const committed = await selected;
      expect(h.calls.slice(0, 3)).toEqual([
        '/api/omo/sessions/a/events', '/api/omo/sessions/a/attach', '/api/omo/sessions/a/snapshot',
      ]);
      const painted = untilState(h.store, () => session(h.store).snapshot?.revision === 2);
      await painted;
      expect(session(h.store).snapshot?.state.isStreaming).toBe(false);
      expect(session(h.store).snapshot?.state.model).toEqual({ provider: 'new', id: 'new' });
      expect(committed?.snapshot?.sessionKey).toBe('a');
    } finally { await h.store.dispose(); }
    expect(h.streams.every((stream) => stream.cancelled)).toBe(true);
  });

  test('rejects late snapshots and late event completions after selected-session changes', async () => {
    const h = wireHarness();
    const requested = gate<void>();
    const answer = gate<Response>();
    h.setRead(async (key) => {
      if (key === 'a') { requested.resolve(); return answer.promise; }
      return Response.json(snapshotFixture(key));
    });
    try {
      const first = h.store.selectSession('a');
      await requested.promise;
      await h.store.selectSession('b');
      answer.resolve(Response.json(snapshotFixture('a', 20, 9)));
      expect(await first).toBeNull();
      expect(h.store.getState().selectedSessionKey).toBe('b');
      expect(session(h.store, 'b').snapshot?.connectionEpoch).toBe(1);
      expect(session(h.store, 'a').snapshot).toBeNull();
      expect(h.streams[0].cancelled).toBe(true);
    } finally { await h.store.dispose(); }
  });

  test('preserves prior snapshot and pending interactions on same-scope read failure', async () => {
    const h = wireHarness();
    const snapshot = snapshotFixture();
    snapshot.pendingInteractions = [{ id: 'dialog-a', method: 'select', title: 'Replace?', options: ['Replace', 'Keep'] }];
    snapshot.tasks = { status: 'ready', value: [{ taskId: 'task-a', parentSessionId: 'durable-a', status: 'running', source: 'persisted' }] };
    h.snapshots.set('a', snapshot);
    try {
      await h.store.selectSession('a');
      const before = session(h.store).snapshot;
      h.setRead(async () => new Response('', { status: 503 }));
      const result = await h.store.refresh();
      expect(result?.status).toBe('unavailable');
      expect(result?.snapshot).toBe(before);
      expect(result?.snapshot?.pendingInteractions.map((pending) => pending.id)).toEqual(['dialog-a']);
      expect(result?.error).toBeInstanceOf(Error);
    } finally { await h.store.dispose(); }
  });

  test('retains prior good projection values and omitted partial entities but accepts ready empty', async () => {
    const h = wireHarness();
    const snapshot = snapshotFixture();
    snapshot.tasks = { status: 'ready', value: [
      { taskId: 'task-a', parentSessionId: 'durable-a', status: 'running', source: 'persisted' },
      { taskId: 'task-b', parentSessionId: 'durable-a', status: 'completed', source: 'persisted' },
    ] };
    h.snapshots.set('a', snapshot);
    try {
      await h.store.selectSession('a');
      const partial = snapshotFixture('a', 2);
      partial.tasks = { status: 'incomplete', value: [
        { taskId: 'task-a', parentSessionId: 'durable-a', status: 'completed', source: 'live' },
      ] };
      h.snapshots.set('a', partial);
      await h.store.refresh();
      expect(session(h.store).snapshot?.tasks.value?.map((task) => [task.taskId, task.status])).toEqual([
        ['task-a', 'completed'], ['task-b', 'completed'],
      ]);
      const failed = snapshotFixture('a', 3);
      failed.tasks = { status: 'unavailable', value: null };
      h.snapshots.set('a', failed);
      await h.store.refresh();
      expect(session(h.store).snapshot?.tasks.value).toHaveLength(2);
      h.snapshots.set('a', snapshotFixture('a', 4));
      await h.store.refresh();
      expect(session(h.store).snapshot?.tasks).toEqual({ status: 'ready', value: [] });
    } finally { await h.store.dispose(); }
  });

  test('resnapshots after stream loss while retaining accepted input uncertainty without replay', async () => {
    const h = wireHarness();
    const snapshot = snapshotFixture();
    snapshot.pendingInteractions = [{
      id: 'question-a', method: 'question', requestId: 'ask-a', waitForAnswer: true,
      questions: [{ id: 'choice', header: 'Choice', question: 'Choose', options: [{ label: 'A', description: 'First' }] }],
    }];
    h.snapshots.set('a', snapshot);
    try {
      await h.store.selectSession('a');
      await h.store.execute({ type: 'prompt', text: 'sent once' }, 'req-a');
      const lost = untilState(h.store, () => session(h.store).status === 'reconnecting');
      h.end(h.streams[0]);
      await lost;
      expect(session(h.store).mutations.get('req-a')?.status).toBe('uncertain');
      expect(session(h.store).snapshot?.pendingInteractions[0].id).toBe('question-a');
      const next = { ...snapshot, revision: 5, connectionEpoch: 2 };
      h.snapshots.set('a', next);
      const recovered = untilState(h.store, () => session(h.store).snapshot?.connectionEpoch === 2 && session(h.store).status === 'ready');
      h.recovery.resolve();
      await recovered;
      expect(h.calls.filter((path) => path.endsWith('/commands'))).toHaveLength(1);
      expect(h.calls.filter((path) => path.endsWith('/snapshot'))).toHaveLength(2);
      expect(session(h.store).mutations.get('req-a')?.status).toBe('uncertain');
      expect(session(h.store).snapshot?.pendingInteractions[0].id).toBe('question-a');
      await assert.rejects(h.store.execute({ type: 'prompt', text: 'duplicate' }, 'req-a'), NativeStateError);
    } finally { await h.store.dispose(); }
    expect(h.streams.every((stream) => stream.cancelled || stream.ended)).toBe(true);
  });

  test('a correlated SSE result wins when it precedes HTTP acceptance and ignores old epochs', async () => {
    const h = wireHarness();
    const commandRequested = gate<void>();
    const acceptance = gate<Response>();
    h.setCommand(async () => { commandRequested.resolve(); return acceptance.promise; });
    try {
      await h.store.selectSession('a');
      const submission = h.store.execute({ type: 'abort' }, 'req-a');
      await commandRequested.promise;
      const completed = untilState(h.store, () => session(h.store).mutations.get('req-a')?.status === 'succeeded');
      h.emit({
        type: 'commandResult', sessionKey: 'a', connectionEpoch: 1, revision: 2,
        result: { requestId: 'req-a', success: true },
      });
      await completed;
      acceptance.resolve(Response.json({ requestId: 'req-a', connectionEpoch: 1, accepted: true }, { status: 202 }));
      expect((await submission).status).toBe('succeeded');
      h.snapshots.set('a', snapshotFixture('a', 3, 2));
      await h.store.reconnect();
      const before = session(h.store);
      h.native(100, { type: 'agent_start' }, 'a', 1);
      const latest = untilState(h.store, () => session(h.store).snapshot?.revision === 4);
      h.native(4, { type: 'model_changed', model: { provider: 'new', id: 'new' }, thinkingLevel: 'high' }, 'a', 2);
      await latest;
      expect(session(h.store).snapshot?.state.isStreaming).toBe(false);
      expect(session(h.store).mutations).toBe(before.mutations);
    } finally { await h.store.dispose(); }
  });

  test('settles buffered results even when the snapshot already represents their revision', async () => {
    const h = wireHarness();
    const requested = gate<void>();
    const answer = gate<Response>();
    try {
      await h.store.selectSession('a');
      await h.store.execute({ type: 'abort' }, 'req-a');
      h.setRead(async () => { requested.resolve(); return answer.promise; });
      const read = h.store.refresh();
      await requested.promise;
      const completed = untilState(h.store, () => session(h.store).mutations.get('req-a')?.status === 'succeeded');
      h.emit({
        type: 'commandResult', sessionKey: 'a', connectionEpoch: 1, revision: 2,
        result: { requestId: 'req-a', success: true },
      });
      answer.resolve(Response.json(snapshotFixture('a', 2)));
      await read;
      await completed;
      expect(session(h.store).mutations.get('req-a')?.status).toBe('succeeded');
      expect(session(h.store).snapshot?.revision).toBe(2);
    } finally { await h.store.dispose(); }
  });

  test('resnapshots on replay gaps rather than applying an out-of-order delta', async () => {
    const h = wireHarness();
    try {
      await h.store.selectSession('a');
      h.snapshots.set('a', snapshotFixture('a', 6));
      const recovered = untilState(h.store, () => session(h.store).snapshot?.revision === 6);
      h.native(5, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'missing prefix' } });
      await recovered;
      expect(session(h.store).liveContent).toEqual([]);
      expect(h.calls.filter((path) => path.endsWith('/snapshot'))).toHaveLength(2);
    } finally { await h.store.dispose(); }
  });

  test('assembles text thinking and tool deltas and uses the persisted active branch without duplicates', async () => {
    const h = wireHarness();
    try {
      await h.store.selectSession('a');
      const streamed = untilState(h.store, () => session(h.store).snapshot?.revision === 6);
      h.native(2, { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } });
      h.native(3, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } });
      h.native(4, { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'Reason' } });
      h.native(5, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call-a', toolName: 'bash' } });
      h.native(6, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{"command":"pwd"}' } });
      await streamed;
      expect(session(h.store).liveContent).toEqual([
        { type: 'text', text: 'Hello' }, { type: 'thinking', thinking: 'Reason' },
        { type: 'toolCall', id: 'call-a', name: 'bash', arguments: {} },
      ]);
      expect(session(h.store).toolArguments.get('call-a')).toBe('{"command":"pwd"}');
      const persisted = untilState(h.store, () => session(h.store).snapshot?.revision === 9);
      h.native(7, { type: 'message_update', assistantMessageEvent: {
        type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'call-a', name: 'bash', arguments: { command: 'pwd' } },
      } });
      h.native(8, { type: 'message_end', message: {
        role: 'assistant', content: [{ type: 'text', text: 'Authoritative' }], timestamp: 2,
      } });
      h.native(9, { type: 'entry_appended', entry: {
        type: 'message', id: 'assistant-a', parentId: 'root', timestamp: '2026-09-30T00:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Authoritative' }], timestamp: 2 },
      } });
      await persisted;
      expect(session(h.store).snapshot?.activeBranch.entries.map((entry) => entry.id)).toEqual(['root', 'assistant-a']);
      expect(session(h.store).liveMessage).toBeNull();
      expect(session(h.store).liveContent).toEqual([]);
      expect(session(h.store).toolArguments.size).toBe(0);
    } finally { await h.store.dispose(); }
  });

  test('does not mark a low-level agent end idle or erase another session’s state', async () => {
    const h = wireHarness();
    try {
      await h.store.selectSession('b');
      const unrelated = session(h.store, 'b');
      await h.store.selectSession('a');
      const running = untilState(h.store, () => session(h.store).snapshot?.revision === 3);
      h.native(2, { type: 'agent_start' });
      h.native(3, { type: 'agent_end', willRetry: true });
      await running;
      expect(session(h.store).snapshot?.state.isStreaming).toBe(true);
      expect(session(h.store, 'b')).toBe(unrelated);
      const settled = untilState(h.store, () => session(h.store).snapshot?.revision === 4);
      h.native(4, { type: 'agent_settled' });
      await settled;
      expect(session(h.store).snapshot?.state.isStreaming).toBe(false);
    } finally { await h.store.dispose(); }
  });

  test('answers interactions once, preserves pending requests until native resolution and refuses stale IDs', async () => {
    const h = wireHarness();
    const snapshot = snapshotFixture();
    snapshot.pendingInteractions = [{ id: 'dialog-a', method: 'select', title: 'Permission', options: ['Allow', 'Block'] }];
    h.snapshots.set('a', snapshot);
    try {
      await h.store.selectSession('a');
      assert.throws(() => h.store.respond('dialog-a', { value: 'Unknown' }), NativeStateError);
      await h.store.respond('dialog-a', { value: 'Allow' }, 'answer-a');
      expect(session(h.store).snapshot?.pendingInteractions).toHaveLength(1);
      assert.throws(() => h.store.respond('dialog-a', { value: 'Allow' }, 'answer-b'), NativeStateError);
      const resolved = untilState(h.store, () => session(h.store).snapshot?.pendingInteractions.length === 0);
      h.native(2, { type: 'interaction_resolved', id: 'dialog-a' });
      await resolved;
      assert.throws(() => h.store.respond('dialog-a', { value: 'Allow' }), NativeStateError);
      expect(h.calls.filter((path) => path.endsWith('/ui-responses'))).toHaveLength(1);
    } finally { await h.store.dispose(); }
  });

  test('enforces terminal ownership and runtime resets without replaying pending work', async () => {
    const h = wireHarness();
    const snapshot = snapshotFixture();
    snapshot.ownership = 'terminal';
    h.snapshots.set('a', snapshot);
    try {
      await h.store.selectSession('a');
      await assert.rejects(h.store.execute({ type: 'abort' }, 'req-a'), NativeStateError);
      h.store.resetRuntime();
      expect(h.store.getState().selectedSessionKey).toBeNull();
      expect(h.store.getState().sessions.size).toBe(0);
      expect(h.calls.filter((path) => path.endsWith('/commands'))).toHaveLength(0);
    } finally { await h.store.dispose(); }
  });
});
