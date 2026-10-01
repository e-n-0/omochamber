import { describe, expect, test } from 'bun:test';
import {
  activeBranchSchema, commandEnvelopeSchema, commandResultSchema, dagViewSchema, goalViewSchema,
  nativeEventSchema, pendingInteractionSchema, sessionEventSchema,
  snapshotSchema, taskViewSchema, uiResponseEnvelopeSchema,
} from './contracts';
import type { NativeSnapshot } from './contracts';

const snapshotFixture = (sessionKey = 'session-a', revision = 1, connectionEpoch = 1): NativeSnapshot => ({
  schemaVersion: 1, sessionKey, durableSessionId: `durable-${sessionKey}`,
  connectionEpoch, revision, ownership: 'hosted', connection: 'connected',
  state: {
    directory: '/workspace', name: 'Native', isStreaming: false, isCompacting: false,
    isBashRunning: false, isRetrying: false, retryAttempt: 0, projectTrusted: true,
    model: { provider: 'provider', id: 'model' }, thinkingLevel: 'medium',
    availableModels: [{ provider: 'provider', id: 'model', name: 'Model' }],
    availableThinkingLevels: ['medium'], commands: [{ name: 'goal', source: 'extension' }],
  },
  activeBranch: {
    leafId: 'entry-a',
    entries: [{
      type: 'message', id: 'entry-a', parentId: null, timestamp: '2026-09-30T00:00:00.000Z',
      message: { role: 'user', content: 'hello', timestamp: 1 },
    }],
  },
  goal: { status: 'ready', value: null }, todo: { status: 'ready', value: null },
  tasks: { status: 'ready', value: [] }, dags: { status: 'ready', value: [] },
  pendingInteractions: [],
});

describe('application contracts', () => {
  test('picks sanitized snapshot fields and nested public views', () => {
    const input = snapshotFixture();
    const parsed = snapshotSchema.parse({
      ...input, socketPath: '/private/native.sock', hostHandle: 'private', credentials: { secret: 'private' },
      state: {
        ...input.state, sessionFile: '/private/transcript', environment: { TOKEN: 'private' },
        availableModels: [{ provider: 'provider', id: 'model', apiKey: 'private', baseUrl: 'private' }],
      },
    });
    expect(parsed.state.availableModels).toEqual([{ provider: 'provider', id: 'model' }]);
    expect('socketPath' in parsed).toBe(false);
    expect('hostHandle' in parsed).toBe(false);
    expect('credentials' in parsed).toBe(false);
    expect('sessionFile' in parsed.state).toBe(false);
    expect('environment' in parsed.state).toBe(false);
  });

  test('selects only normal active ancestry from append-order entries', () => {
    const root = snapshotFixture().activeBranch.entries[0];
    const active = { ...root, id: 'active', parentId: root.id };
    const abandoned = { ...root, id: 'abandoned', parentId: root.id };
    expect(activeBranchSchema.parse({
      leafId: active.id, entries: [root, abandoned, active],
    }).entries.map((entry) => entry.id)).toEqual([root.id, active.id]);
    expect(activeBranchSchema.safeParse({ leafId: 'missing', entries: [root] }).success).toBe(false);
    expect(activeBranchSchema.safeParse({ leafId: root.id, entries: [root, root] }).success).toBe(false);
    expect(activeBranchSchema.safeParse({
      leafId: root.id, entries: [{ ...root, parentId: root.id }],
    }).success).toBe(false);
  });

  test('parses dynamic tool JSON only at message and event boundaries', () => {
    const tool = { type: 'toolCall', id: 'call-a', name: 'bash', arguments: { command: 'pwd', nested: [null, 7] } };
    expect(nativeEventSchema.parse({
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: tool },
      sessionId: 'private-routing-handle',
    })).toEqual({
      type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: tool },
    });
    expect(nativeEventSchema.safeParse({
      type: 'tool_execution_start', toolCallId: 'call-a', toolName: 'bash', args: { bad: () => 1 },
    }).success).toBe(false);
    expect(nativeEventSchema.parse({
      type: 'extension_event', name: 'omo.task.updated', data: { execution: { socketPath: 'private' } },
    })).toEqual({ type: 'extension_event', name: 'omo.task.updated' });
  });

  test('keeps native goal counters and enforces blocked evidence', () => {
    const goal = {
      id: 'goal-a', threadId: 'durable-a', objective: 'Ship', tokensUsed: 5,
      timeUsedSeconds: 7, createdAt: 1, updatedAt: 2, status: 'blocked',
      blockedReason: 'Missing input', blockedAt: 2, lastContinuationSignature: 'private',
    };
    expect('lastContinuationSignature' in goalViewSchema.parse(goal)).toBe(false);
    expect(goalViewSchema.safeParse({ ...goal, blockedAt: -1 }).success).toBe(false);
    expect(goalViewSchema.safeParse({ ...goal, blockedReason: '' }).success).toBe(false);
    expect(goalViewSchema.safeParse({ ...goal, tokensUsed: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  test('strips private command result data and ignores additive native events without exposing opaque records', () => {
    expect(commandResultSchema.parse({
      requestId: 'req-a', success: true, data: { handled: true, sessionId: 'handle', socketPath: 'private', credentials: 'private' },
    })).toEqual({ requestId: 'req-a', success: true, data: { handled: true } });
    expect(nativeEventSchema.parse({ type: 'future_native_event', hostHandle: 'private', data: 'private' })).toEqual({
      type: 'unhandled', nativeType: 'future_native_event',
    });
    expect(nativeEventSchema.parse({
      type: 'extension_ui_request', method: 'setWidget', widgetLines: ['private'], id: 'widget-a',
    })).toEqual({ type: 'unhandled', nativeType: 'extension_ui_request.setWidget' });
    expect(nativeEventSchema.safeParse({
      type: 'extension_ui_request', method: 'select', id: 'broken',
    }).success).toBe(false);
  });

  test('round-trips explicit camelCase task and DAG fixtures without private native records', () => {
    expect(taskViewSchema.parse({
      taskId: 'task-a', parentSessionId: 'durable-a', status: 'running',
      residency: 'parked', taskSummary: 'Read fixture', childSessionId: 'durable-child',
      createdAt: '2026-09-30T00:00:00.000Z', source: 'persisted',
      execution: { socketPath: 'private' }, steering: { input: 'private' },
    })).toEqual({
      taskId: 'task-a', parentSessionId: 'durable-a', status: 'running',
      residency: 'parked', taskSummary: 'Read fixture', childSessionId: 'durable-child',
      createdAt: '2026-09-30T00:00:00.000Z', source: 'persisted',
    });
    expect('leases' in dagViewSchema.parse({
      runId: 'run-a', status: 'running', generation: 2, lastSeq: 3,
      nodes: [{ nodeId: 'one', status: 'completed' }, { nodeId: 'two', status: 'running' }],
      edges: [{ from: 'one', to: 'two' }], waves: [['one'], ['two']],
      counts: { pending: 0, blocked: 0, scheduled: 0, running: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0 },
      leases: { owner: 'private' },
    })).toBe(false);
  });

  test('distinguishes failed projections from authoritative empty success', () => {
    const input = snapshotFixture();
    expect(snapshotSchema.parse({
      ...input, tasks: { status: 'unavailable', value: null, reason: 'Read failed' },
    }).tasks).toEqual({ status: 'unavailable', value: null, reason: 'Read failed' });
    expect(snapshotSchema.parse(input).tasks).toEqual({ status: 'ready', value: [] });
    expect(snapshotSchema.safeParse({ ...input, tasks: { status: 'ready', value: null } }).success).toBe(false);
  });

  for (const method of ['select', 'confirm', 'input', 'editor', 'question'] as const) {
    test(`parses native ${method} requests and preserves deadline information`, () => {
      const request = {
        id: 'dialog-a', title: 'Title', method, options: ['Allow', 'Block'], message: 'Confirm',
        placeholder: 'Value', prefill: 'Text', requestId: 'ask-a', waitForAnswer: true,
        questions: [{ id: 'question-a', header: 'Choice', question: 'Choose', options: [{ label: 'A', description: 'First' }] }],
        askedAtMs: 1, deadlineAtMs: 20, remainingMs: 19, socketPath: 'private',
      };
      const parsed = pendingInteractionSchema.parse(request);
      expect(parsed.method).toBe(method);
      expect(parsed.deadlineAtMs).toBe(20);
      expect('socketPath' in parsed).toBe(false);
      expect(nativeEventSchema.parse({ type: 'extension_ui_request', ...request })).toEqual({
        type: 'extension_ui_request', ...parsed,
      });
    });
  }

  test('rejects stale identity envelopes and invalid mutation values', () => {
    const snapshot = snapshotFixture();
    expect(sessionEventSchema.safeParse({
      type: 'snapshot', sessionKey: 'other', connectionEpoch: 1, revision: 1, snapshot,
    }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({
      requestId: 'req-a', connectionEpoch: -1, command: { type: 'prompt', text: 'hello' },
    }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({
      requestId: 'req-a', connectionEpoch: 1, command: { type: 'goalSet', objective: ' pause ' },
    }).success).toBe(false);
    expect(commandEnvelopeSchema.safeParse({
      requestId: 'req-a', connectionEpoch: 1, command: { type: 'taskSend', taskId: 'task-a', message: 'x'.repeat(32_001) },
    }).success).toBe(false);
    expect(uiResponseEnvelopeSchema.safeParse({
      requestId: 'req-a', connectionEpoch: 1, uiRequestId: 'dialog-a', response: { answers: {}, comment: ' ' },
    }).success).toBe(false);
  });
});
