import { afterEach, describe, expect, test, vi } from 'vitest';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  commandAcceptedSchema, commandResultSchema, hostViewSchema, sessionEventSchema,
  sessionSummarySchema, snapshotSchema, statusSchema, taskOutputSchema,
} from '../../../../ui/src/omo/contracts.ts';
import { createFoundationFixture, entry, nextSessionEvent } from './session-service.fixtures.js';
import { createSessionService } from './session-service.js';

const resources = [];
const fixture = async (options) => {
  const value = await createFoundationFixture(options);
  resources.push(value);
  return value;
};
afterEach(async () => {
  vi.useRealTimers();
  for (const resource of resources.splice(0)) {
    const receipt = await resource.cleanup();
    expect(receipt.serverClosed).toBe(true);
    expect(receipt.sockets).toBe(0);
  }
});
const roundtrip = (schema, value) => expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
async function execute(f, snapshot, command, requestId = command.type) {
  const result = nextSessionEvent(f.service, snapshot.sessionKey,
    (event) => event.type === 'commandResult' && event.result.requestId === requestId);
  const accepted = await f.service.execute(snapshot.sessionKey, {
    requestId, connectionEpoch: snapshot.connectionEpoch, command,
  });
  roundtrip(commandAcceptedSchema, accepted);
  const event = await result;
  roundtrip(sessionEventSchema, event);
  return event.result;
}

describe('native session ownership and hydration', () => {
  test('computer audit sidecars do not block live or persisted conversation inventory', async () => {
    const f = await fixture();
    const sessions = await f.service.listSessions({});
    const auditPath = path.join(path.dirname(f.sessionPath), '.computer-audit.jsonl');
    const audit = `${JSON.stringify({ timestamp: '2026-10-01T18:52:11Z', action: 'screenshot', status: 'ok' })}\n`;
    await writeFile(auditPath, audit);
    expect(await f.service.listSessions({})).toEqual(sessions);
    expect((await f.service.status()).available).toBe(true);
    expect(await readFile(auditPath, 'utf8')).toBe(audit);
  });

  test('non-audit files with missing session headers remain failed inventory reads', async () => {
    const f = await fixture();
    await writeFile(path.join(path.dirname(f.sessionPath), 'not-a-session.jsonl'), '{"action":"screenshot"}\n');
    await expect(f.service.listSessions({})).rejects.toMatchObject({ code: 'inventory_incomplete' });
  });

  test('malformed conversation records remain failed inventory reads', async () => {
    const f = await fixture();
    await writeFile(f.sessionPath, `${await readFile(f.sessionPath, 'utf8')}{broken\n`);
    await expect(f.service.listSessions({})).rejects.toMatchObject({ code: 'inventory_incomplete' });
  });

  test('inactive registrations do not block persisted history or unrelated directory ownership', async () => {
    const f = await fixture({
      discover: async () => [{
        socketPath: '/missing/old-host.sock', availability: 'inactive',
        reason: 'rpc_endpoint_absent', sessions: null,
      }],
    });
    const [offline] = await f.service.listSessions({});
    expect(offline.ownership).toBe('offline');
    expect(await f.service.isDirectoryInUse(f.project)).toBe(false);
    const restored = await f.service.attachSession(offline.sessionKey);
    expect(restored.ownership).toBe('hosted');
    expect(f.frames.filter((frame) => frame.type === 'prompt')).toHaveLength(0);
  });

  test('offline persisted sessions reopen only after ownership is established', async () => {
    const f = await fixture();
    const [hosted] = await f.service.listSessions({});
    f.inventory.length = 0;
    const [offline] = await f.service.listSessions({});
    expect(offline.sessionKey).toBe(hosted.sessionKey);
    expect(offline.ownership).toBe('offline');
    const snapshot = await f.service.attachSession(offline.sessionKey);
    expect(snapshot.ownership).toBe('hosted');
    expect(f.ensureCalls).toBe(1);
    expect(f.frames.find((frame) => frame.type === 'open_session')).toMatchObject({ sessionPath: f.sessionPath, retain_on_disconnect: true });
  });

  test('connected sessions reopen after their ready owner no longer lists the routing handle', async () => {
    const f = await fixture();
    const [session] = await f.service.listSessions({});
    const initial = await f.service.attachSession(session.sessionKey);
    f.inventory.length = 0;
    const [offline] = await f.service.listSessions({});
    expect(offline.ownership).toBe('offline');
    const restored = await f.service.attachSession(session.sessionKey);
    expect(restored.sessionKey).toBe(initial.sessionKey);
    expect(restored.connectionEpoch).not.toBe(initial.connectionEpoch);
    expect(restored.ownership).toBe('hosted');
    expect(f.frames.filter((frame) => frame.type === 'prompt')).toHaveLength(0);
  });

  test('create intent and opaque identity survive adapter loss without replay', async () => {
    const f = await fixture();
    const created = await f.service.createSession({ requestId: 'persisted-intent', cwd: f.project });
    const old = await f.service.getSnapshot(created.sessionKey);
    await f.service.close();
    const service = createSessionService({
      runtime: f.runtime, dataDir: f.root,
      discover: async () => [],
      ensureHost: async () => {},
    });
    try {
      const [session] = await service.listSessions({});
      expect(session.sessionKey).toBe(created.sessionKey);
      const snapshot = await service.attachSession(session.sessionKey);
      expect(snapshot.connectionEpoch).not.toBe(old.connectionEpoch);
      await expect(service.execute(session.sessionKey, {
        requestId: 'old-process', connectionEpoch: old.connectionEpoch, command: { type: 'abort' },
      })).rejects.toMatchObject({ code: 'stale_epoch' });
      await expect(service.createSession({ requestId: 'persisted-intent', cwd: f.project })).rejects.toMatchObject({ code: 'creation_uncertain', uncertain: true });
      expect(f.frames.filter((frame) => frame.durableSessionId !== undefined)).toHaveLength(1);
    } finally { await service.close(); }
  });

  test('default create invokes installed CLI host ensure with unchanged spec and never policy', async () => {
    const invocations = [];
    const f = await fixture({
      ensureHost: undefined,
      hostCommandRunner: async (...args) => { invocations.push(args); return { stdout: '{}' }; },
    });
    const original = await readFile(f.runtime.launchSpecPath);
    await f.service.createSession({ requestId: 'default-ensure', cwd: f.project });
    expect(invocations).toHaveLength(1);
    expect(invocations[0][0]).toBe(f.runtime.bunBinary);
    expect(invocations[0][1]).toEqual([
      f.runtime.cliPath, 'host', 'ensure', '--launch-spec', f.runtime.launchSpecPath,
      '--policy', 'never', '--socket', f.socketPath, '--json',
    ]);
    expect(invocations[0][2].env.OMO_CODING_AGENT_DIR).toBe(f.agentDir);
    expect(invocations[0][2].env.OMO_RPC_SHARD_ROOT).toBeUndefined();
    expect(invocations[0][2].env.PI_SESSION_FILE).toBeUndefined();
    expect(await readFile(f.runtime.launchSpecPath)).toEqual(original);
  });

  test('attaches to actual owner with stable browser ID, active branch and private DTO picking', async () => {
    const f = await fixture();
    f.openEvents = [{ type: 'extension_ui_request', method: 'select', id: 'replacement', title: 'Replace?', options: ['Yes', 'No'], credentials: 'SECRET' }];
    const [summary] = await f.service.listSessions({});
    roundtrip(sessionSummarySchema, summary);
    const snapshot = await f.service.attachSession(summary.sessionKey);
    roundtrip(snapshotSchema, snapshot);
    expect(snapshot.activeBranch.entries.map((item) => item.id)).toEqual(['a', 'b']);
    expect(snapshot.pendingInteractions).toEqual([{ method: 'select', id: 'replacement', title: 'Replace?', options: ['Yes', 'No'] }]);
    expect(snapshot.goal).toEqual({ status: 'ready', value: null });
    expect(snapshot.tasks.status).toBe('ready');
    expect(snapshot.tasks.value[0].taskId).toBe('st_01234567');
    expect(snapshot.tasks.value[0].source).toBe('persisted');
    expect(snapshot.tasks.value[0].notificationEpoch).toBe(0);
    const serialized = JSON.stringify(snapshot);
    for (const privateValue of ['SECRET', f.socketPath, f.sessionPath, f.store, f.runtime.engineRoot, 'routing-parent', 'host_session']) {
      expect(serialized).not.toContain(privateValue);
    }
    const open = f.frames.find((frame) => frame.type === 'open_session');
    expect(open).toMatchObject({ sessionPath: f.sessionPath, retain_on_disconnect: true });
    expect(open).not.toHaveProperty('promptSurface');
    expect(f.ensureCalls).toBe(0);
    expect(await f.service.isDirectoryInUse(f.project)).toBe(true);
    expect((await f.service.listSessions({ directory: f.project }))[0].sessionKey).toBe(summary.sessionKey);
    expect(await f.service.listSessions({ directory: '/not-the-project' })).toEqual([]);
    roundtrip(statusSchema, await f.service.status());
    for (const host of await f.service.listHosts()) roundtrip(hostViewSchema, host);
  });

  test('negotiates inline media so image-bearing native history remains readable', async () => {
    const f = await fixture();
    const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' };
    const reference = {
      type: 'image_ref', mimeType: image.mimeType, byteLength: 5,
      ref: { toolCallId: 'media-call', contentIndex: 0 },
    };
    f.override = ({ socket, frame, reply }) => {
      if (frame.type !== 'get_entries') return false;
      const negotiated = f.frames.find((item) => item.type === 'set_client_info')?.capabilities ?? [];
      const content = negotiated.includes('media_placeholders') ? reference : image;
      reply(socket, frame, {
        leafId: 'media-entry',
        entries: [{
          id: 'media-entry', parentId: null, timestamp: '2026-10-01T00:00:00.000Z', type: 'message',
          message: {
            role: 'toolResult', toolCallId: 'media-call', toolName: 'read',
            content: [content], isError: false, timestamp: 1,
          },
        }],
      });
      return true;
    };

    const snapshot = await f.attach();

    roundtrip(snapshotSchema, snapshot);
    expect(snapshot.activeBranch.entries[0].message.content).toEqual([image]);
    expect(f.frames.find((frame) => frame.type === 'set_client_info').capabilities).not.toContain('media_placeholders');
  });

  test('creates durable retained interactive sessions on only the dedicated app endpoint', async () => {
    const f = await fixture();
    const result = await f.service.createSession({ requestId: 'create', cwd: f.project, name: 'Created' });
    roundtrip(sessionSummarySchema, result);
    expect(result.name).toBe('Created');
    expect(result.durableSessionId).not.toBe('routing-parent');
    const open = f.frames.find((frame) => frame.type === 'open_session');
    expect(open).toMatchObject({
      durableSessionId: result.durableSessionId, kind: 'interactive', auto_title: false,
      retain_on_disconnect: true, cwd: f.project, promptSurface: 'chat',
    });
    expect(open).not.toHaveProperty('sessionPath');
    expect(f.ensureCalls).toBe(1);
    const snapshot = await f.service.getSnapshot(result.sessionKey);
    roundtrip(snapshotSchema, snapshot);
    expect(snapshot.activeBranch).toEqual({ leafId: null, entries: [] });
    await expect(f.service.createSession({ requestId: 'create', cwd: f.project })).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(f.frames.filter((frame) => frame.type === 'open_session')).toHaveLength(1);
  });

  test('buffers attach-time events before snapshot and applies later entries exactly once', async () => {
    const f = await fixture();
    f.openEvents = [{ type: 'agent_start' }];
    const snapshot = await f.attach();
    expect(snapshot.state.isStreaming).toBe(true);
    const seen = nextSessionEvent(f.service, snapshot.sessionKey, (event) => event.type === 'native' && event.event.type === 'entry_appended');
    const appended = entry('c', 'b', 'live');
    f.history.entries.push(appended);
    f.history.leafId = 'c';
    f.event({ type: 'entry_appended', entry: appended });
    roundtrip(sessionEventSchema, await seen);
    const current = await f.service.getSnapshot(snapshot.sessionKey);
    expect(current.activeBranch.entries.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    f.event({ type: 'entry_appended', entry: appended });
    const barrier = await f.service.getSnapshot(snapshot.sessionKey);
    expect(barrier.activeBranch.entries.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  test('retains work on disconnect, rejects obsolete epochs and never replays accepted mutation', async () => {
    const f = await fixture();
    const snapshot = await f.attach();
    f.override = ({ frame, socket }) => {
      if (frame.type !== 'prompt') return false;
      socket.destroy();
      return true;
    };
    const result = await execute(f, snapshot, { type: 'prompt', text: 'wire only' }, 'accepted-once');
    expect(result).toMatchObject({ success: false, code: 'uncertain' });
    expect((await f.service.getSnapshot(snapshot.sessionKey)).connection).toBe('reconnecting');
    f.override = undefined;
    const reattached = await f.service.attachSession(snapshot.sessionKey);
    expect(reattached.connectionEpoch).not.toBe(snapshot.connectionEpoch);
    await expect(f.service.execute(snapshot.sessionKey, {
      requestId: 'old', connectionEpoch: snapshot.connectionEpoch, command: { type: 'abort' },
    })).rejects.toMatchObject({ code: 'stale_epoch' });
    await expect(f.service.execute(snapshot.sessionKey, {
      requestId: 'accepted-once', connectionEpoch: reattached.connectionEpoch, command: { type: 'prompt', text: 'wire only' },
    })).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(f.frames.filter((frame) => frame.type === 'prompt')).toHaveLength(1);
    await f.service.close();
    expect(f.frames.some((frame) => ['close_session', 'shutdown', 'release_session'].includes(frame.type))).toBe(false);
    expect(f.inventory).toHaveLength(1);
  });

  test('failed history read is failure and leaves prior history intact', async () => {
    const f = await fixture();
    const snapshot = await f.attach();
    f.override = ({ socket, frame, reply }) => {
      if (frame.type !== 'get_entries') return false;
      reply(socket, frame, undefined, false);
      return true;
    };
    await expect(f.service.getSnapshot(snapshot.sessionKey)).rejects.toMatchObject({ code: 'native_refused' });
    f.override = undefined;
    expect((await f.service.getSnapshot(snapshot.sessionKey)).activeBranch).toEqual(snapshot.activeBranch);
    f.history.leafId = 'missing';
    await expect(f.service.getSnapshot(snapshot.sessionKey)).rejects.toMatchObject({ code: 'history_incomplete' });
    f.history.leafId = 'b';
    expect((await f.service.getSnapshot(snapshot.sessionKey)).activeBranch).toEqual(snapshot.activeBranch);
  });

  test('owner replacement retires accepted work and cannot reroute it to the successor', async () => {
    const f = await fixture();
    const snapshot = await f.attach();
    const request = once(f.signal, 'frame');
    f.override = ({ frame }) => frame.type === 'prompt';
    const uncertain = nextSessionEvent(f.service, snapshot.sessionKey, (event) => event.type === 'commandResult');
    await f.service.execute(snapshot.sessionKey, {
      requestId: 'owner-change', connectionEpoch: snapshot.connectionEpoch, command: { type: 'prompt', text: 'Accepted once' },
    });
    await request;
    f.info.instanceId = 'successor-instance';
    f.inventory[0].sessionId = 'successor-handle';
    await f.service.status();
    expect((await uncertain).result).toMatchObject({ success: false, code: 'uncertain' });
    expect((await f.service.getSnapshot(snapshot.sessionKey)).connection).toBe('reconnecting');
    const reattached = await f.service.attachSession(snapshot.sessionKey);
    expect(reattached.connectionEpoch).not.toBe(snapshot.connectionEpoch);
    await expect(f.service.execute(snapshot.sessionKey, {
      requestId: 'owner-change', connectionEpoch: reattached.connectionEpoch, command: { type: 'prompt', text: 'No replay' },
    })).rejects.toMatchObject({ code: 'duplicate_request' });
    expect(f.frames.filter((frame) => frame.type === 'prompt')).toHaveLength(1);
    f.inventory[0].ownership = 'conflict';
    await f.service.status();
    await expect(f.service.execute(snapshot.sessionKey, {
      requestId: 'conflicting', connectionEpoch: reattached.connectionEpoch, command: { type: 'abort' },
    })).rejects.toMatchObject({ code: 'owner_conflict' });
  });

  test('terminal sessions remain read-only and never acquire a second writer', async () => {
    const f = await fixture({ terminal: true });
    f.inventory[0].sessionId = f.inventory[0].durableSessionId;
    const original = await readFile(f.sessionPath);
    const snapshot = await f.attach();
    expect(snapshot.ownership).toBe('terminal');
    roundtrip(snapshotSchema, snapshot);
    await expect(f.service.execute(snapshot.sessionKey, {
      requestId: 'terminal', connectionEpoch: snapshot.connectionEpoch, command: { type: 'abort' },
    })).rejects.toMatchObject({ code: 'read_only_session' });
    expect(f.frames.some((frame) => ['open_session', 'prompt', 'close_session'].includes(frame.type))).toBe(false);
    expect(await readFile(f.sessionPath)).toEqual(original);
  });

  test('owner conflict and changed instance fail before opening a writer', async () => {
    const f = await fixture();
    f.inventory[0].ownership = 'conflict';
    const [session] = await f.service.listSessions({});
    await expect(f.service.attachSession(session.sessionKey)).rejects.toMatchObject({ code: 'owner_conflict' });
    expect(f.frames).toHaveLength(0);
    f.inventory[0].ownership = 'hosted';
    f.override = ({ socket, frame, reply }) => {
      if (frame.type !== 'get_protocol_info') return false;
      reply(socket, frame, { ...f.info, instanceId: 'foreign-instance' });
      return true;
    };
    await expect(f.service.attachSession(session.sessionKey)).rejects.toMatchObject({ code: 'owner_changed' });
    expect(f.frames.some((frame) => frame.type === 'open_session')).toBe(false);
  });
});

describe('native commands, goals and interactions', () => {
  test.each([
    [{ type: 'prompt', text: 'wire input' }, 'prompt'],
    [{ type: 'steer', text: 'wire steer' }, 'steer'],
    [{ type: 'followUp', text: 'wire followup' }, 'follow_up'],
    [{ type: 'abort' }, 'abort'],
    [{ type: 'rename', name: 'Renamed' }, 'set_session_name'],
    [{ type: 'setModel', provider: 'wire', id: 'selected' }, 'set_model'],
    [{ type: 'setThinking', level: 'high' }, 'set_thinking_level'],
  ])('maps %s to the actual native command %s', async (command, nativeType) => {
    const f = await fixture();
    const snapshot = await f.attach();
    const result = await execute(f, snapshot, command);
    roundtrip(commandResultSchema, result);
    expect(result.success).toBe(true);
    expect(f.frames.filter((frame) => frame.type === nativeType)).toHaveLength(1);
    if (nativeType === 'set_thinking_level') {
      expect(result.data.thinkingLevel).toBe('high');
      expect(f.frames.find((frame) => frame.type === nativeType).scope).toBe('turn');
    }
  });

  test('goal set/pause/resume/clear are native prompts confirmed by real sidecar reads', async () => {
    const f = await fixture();
    const snapshot = await f.attach();
    for (const command of [
      { type: 'goalSet', objective: 'Native objective' }, { type: 'goalPause' },
      { type: 'goalResume' }, { type: 'goalClear' },
    ]) {
      expect(await execute(f, snapshot, command)).toMatchObject({ success: true, data: { handled: true } });
    }
    const frames = f.frames.filter((frame) => frame.type === 'prompt');
    expect(frames.map((frame) => frame.message)).toEqual(['/goal Native objective', '/goal pause', '/goal resume', '/goal clear']);
    expect(frames.every((frame) => frame.expandPromptTemplates && frame.unknownCommandAsText === false)).toBe(true);
    expect(f.frames.some((frame) => frame.type === 'abort')).toBe(false);
    expect(JSON.parse(await readFile(f.sessionPath.replace('/parent.jsonl', '/extensions/goal/durable-parent.json'), 'utf8')).goal).toBe(null);
  });

  test('handled acknowledgment without sidecar mutation fails explicitly at deadline', async () => {
    const f = await fixture({ goalConfirmationTimeoutMs: 1_000 });
    const snapshot = await f.attach();
    f.goalAcknowledgedWithoutMutation = true;
    const seen = once(f.signal, 'frame');
    const result = nextSessionEvent(f.service, snapshot.sessionKey, (event) => event.type === 'commandResult');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await f.service.execute(snapshot.sessionKey, {
      requestId: 'no-mutation', connectionEpoch: snapshot.connectionEpoch,
      command: { type: 'goalSet', objective: 'Not persisted' },
    });
    await seen;
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).result).toMatchObject({ success: false, code: 'uncertain' });
  });

  test('missing extension and manual complete/reserved objectives are refused before forwarding', async () => {
    const f = await fixture();
    f.commands.length = 0;
    const snapshot = await f.attach();
    for (const command of [{ type: 'goalSet', objective: 'clear' }, { type: 'goalComplete' }, { type: 'goalPause' }]) {
      await expect(f.service.execute(snapshot.sessionKey, {
        requestId: 'invalid', connectionEpoch: snapshot.connectionEpoch, command,
      })).rejects.toMatchObject({ statusCode: command.type === 'goalPause' ? 409 : 400 });
    }
    expect(f.frames.some((frame) => frame.type === 'prompt')).toBe(false);
  });

  test.each([
    ['select', { title: 'Select', options: ['Yes', 'No'] }, { value: 'Yes' }],
    ['confirm', { title: 'Confirm', message: 'Proceed?' }, { confirmed: true }],
    ['input', { title: 'Input', placeholder: 'Value' }, { value: 'Answer' }],
    ['editor', { title: 'Editor', prefill: 'Original' }, { value: 'Edited' }],
    ['question', { requestId: 'tool-question', waitForAnswer: true, questions: [{
      id: 'q', header: 'Choice', question: 'Choose', options: [{ label: 'Yes', description: 'Proceed' }],
    }] }, { answers: { q: { selected: ['Yes'] } } }],
  ])('answers native %s once, retaining pending dialogs across browser reads', async (method, fields, response) => {
    const f = await fixture();
    const snapshot = await f.attach();
    const seen = nextSessionEvent(f.service, snapshot.sessionKey, (event) => event.type === 'native' && event.event.type === 'interaction_pending');
    f.event({ type: 'extension_ui_request', method, id: 'dialog', ...fields });
    roundtrip(sessionEventSchema, await seen);
    expect((await f.service.getSnapshot(snapshot.sessionKey)).pendingInteractions).toHaveLength(1);
    const result = nextSessionEvent(f.service, snapshot.sessionKey, (event) => event.type === 'commandResult');
    const envelope = { requestId: 'answer', connectionEpoch: snapshot.connectionEpoch, uiRequestId: 'dialog', response };
    await f.service.respond(snapshot.sessionKey, envelope);
    await expect(f.service.respond(snapshot.sessionKey, { ...envelope, requestId: 'duplicate-answer' })).rejects.toMatchObject({ code: 'interaction_resolved' });
    expect((await result).result.success).toBe(true);
    expect((await f.service.getSnapshot(snapshot.sessionKey)).pendingInteractions).toEqual([]);
    expect(f.frames.find((frame) => frame.type === 'extension_ui_response')).toMatchObject({ uiRequestId: 'dialog', ...response });
  });

  test('native task output/send/cancel never accept cross-parent or uncertain delivery', async () => {
    const f = await fixture();
    const snapshot = await f.attach();
    const output = await f.service.getTaskOutput(snapshot.sessionKey, f.task.task_id, { mode: 'tail', tailLines: 20 });
    roundtrip(taskOutputSchema, output);
    expect(output.output).toBe('native transcript');
    expect(output.task).not.toHaveProperty('notification');
    expect(JSON.stringify(output)).not.toContain('SECRET');
    expect(await execute(f, snapshot, { type: 'taskSend', taskId: f.task.task_id, message: 'Continue' })).toMatchObject({ success: true, data: { sent: true } });
    expect(await execute(f, snapshot, { type: 'taskCancel', taskId: f.task.task_id, reason: 'Finished' })).toMatchObject({ success: true, data: { cancelled: true } });
    f.task.parent_session_id = 'foreign-parent';
    await expect(f.service.getTaskOutput(snapshot.sessionKey, f.task.task_id)).rejects.toMatchObject({ code: 'task_owner_mismatch' });
    expect(await execute(f, snapshot, { type: 'taskSend', taskId: f.task.task_id, message: 'Denied' }, 'foreign')).toMatchObject({ success: false });
    expect(f.frames.filter((frame) => frame.name === 'omo.task.send')).toHaveLength(1);
    f.task.parent_session_id = 'durable-parent';
    f.override = ({ socket, frame, reply }) => {
      if (frame.name !== 'omo.task.send') return false;
      reply(socket, frame, { kind: 'delivery_uncertain', task_id: f.task.task_id, socket: f.socketPath });
      return true;
    };
    expect(await execute(f, snapshot, { type: 'taskSend', taskId: f.task.task_id, message: 'Uncertain' }, 'uncertain')).toMatchObject({ success: false, code: 'uncertain' });
    expect(f.frames.filter((frame) => frame.name === 'omo.task.send')).toHaveLength(2);
  });

  test('late attach recovers projections; invalid sidecar preserves the prior good view', async () => {
    const f = await fixture();
    await f.setGoal(f.goal());
    f.history.entries.push({
      id: 'todo', parentId: 'b', timestamp: '2026-10-01T00:00:00.000Z', type: 'custom', customType: 'senpi.todo-state',
      data: { version: 2, phases: [{ name: 'Foundation', tasks: [{ content: 'Native task', status: 'in_progress' }] }] },
    });
    f.history.leafId = 'todo';
    await f.persistHistory();
    const snapshot = await f.attach();
    roundtrip(snapshotSchema, snapshot);
    expect(snapshot.goal.value.objective).toBe('Foundation goal');
    expect(snapshot.todo.value.phases).toHaveLength(1);
    const failed = nextSessionEvent(f.service, snapshot.sessionKey, (event) => event.type === 'native' && event.event.type === 'projections' && event.event.goal.status === 'unavailable');
    await writeFile(f.sessionPath.replace('/parent.jsonl', '/extensions/goal/durable-parent.json'), '{bad}');
    // The read is the observable action, not a race against OS watch coalescing.
    await f.service.getSnapshot(snapshot.sessionKey);
    expect((await failed).event.goal.value).toEqual(snapshot.goal.value);
  });
});
