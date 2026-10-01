import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessionService } from './session-service.js';
import { resolveInstalledRuntime } from './installed-runtime.js';

const protocol = {
  protocolVersion: 1, mode: 'multi', instanceId: 'foundation-wire-host',
  capabilities: ['multi_session', 'extension_events', 'session_context', 'session_kind',
    'retain_on_disconnect', 'durable_session_id', 'auto_title_per_session', 'prompt_surface_chat'],
};
export const instant = '2026-10-01T00:00:00.000Z';
export const entry = (id, parentId, content) => ({
  id, parentId, timestamp: instant, type: 'message',
  message: { role: 'user', content, timestamp: 1 },
});
const nativeTask = (parent = 'durable-parent', id = 'st_01234567') => ({
  task_id: id, parent_session_id: parent, root_session_id: parent, depth: 1,
  status: 'running', residency_state: 'resident', model: 'wire-model',
  created_at: instant, updated_at: instant, task_summary: 'Foundation task',
  notification: { run_epoch: 0, notified_epoch: -1 }, final_response: 'task output',
  host_session: { socket: '/private/task.sock', session_id: 'private-handle' },
  execution: { token: 'SECRET' }, isolation: { root: '/private/root' },
});

/**
 * Real JSONL socket plus actual installed pure projection readers. Every file and
 * listener is unique to this fixture; no native manager or live host is touched.
 */
export async function createFoundationFixture({ terminal = false, ...serviceOptions } = {}) {
  const resourceRoot = await mkdtemp(path.join(tmpdir(), 'ocf-'));
  const root = await realpath(resourceRoot);
  const installed = await resolveInstalledRuntime();
  const project = path.join(root, 'project');
  const agentDir = path.join(root, 'agent');
  const store = path.join(root, 'task-store');
  const sessionsDir = path.join(agentDir, 'sessions', 'project');
  const sessionPath = path.join(sessionsDir, 'parent.jsonl');
  const socketPath = path.join(root, terminal ? 't-0123456789abcdef.sock' : 'omo.sock');
  await Promise.all([project, sessionsDir, path.join(store, 'tasks'), path.join(store, 'dag/runs'),
    path.join(store, 'dag/events')].map((directory) => mkdir(directory, { recursive: true })));
  if (terminal) await writeFile(`${socketPath}.secret`, Buffer.alloc(32, 9));
  const info = terminal ? { ...protocol, mode: 'tui', capabilities: ['tui_control'] } : structuredClone(protocol);
  const runtime = { ...installed, agentDir, taskStateDir: store };
  const frames = [];
  const sockets = new Set();
  const signal = new EventEmitter();
  const inventory = [{
    sessionId: 'routing-parent', durableSessionId: 'durable-parent', sessionPath,
    cwd: project, name: 'Parent', ownership: terminal ? 'terminal' : 'hosted',
  }];
  const state = {
    sessionId: 'durable-parent', sessionFile: sessionPath, cwd: project, sessionName: 'Parent',
    model: { provider: 'wire', id: 'model', apiKey: 'SECRET', baseUrl: '/private/provider' },
    thinkingLevel: 'low', isStreaming: false, isCompacting: false, isBashRunning: false,
    retryAttempt: 0, projectTrusted: true, pendingQuestions: [],
    credentials: 'SECRET', usageTotals: { private: 'SECRET' },
  };
  const history = {
    entries: [entry('a', null, 'first'), entry('abandoned', 'a', 'abandoned'), entry('b', 'a', 'active')],
    leafId: 'b',
  };
  const commands = [{ name: 'goal', source: 'extension', description: 'Native goal', path: '/private/extension' }];
  const goalFile = path.join(sessionsDir, 'extensions/goal', 'durable-parent.json');
  const task = nativeTask();
  let discoverFailure;
  let ensureCalls = 0;
  let override;
  let openEvents = [];
  let goalAcknowledgedWithoutMutation = false;
  const send = (socket, value) => socket.write(`${JSON.stringify(value)}\n`);
  const reply = (socket, frame, data, success = true) => {
    const response = { type: 'response', id: frame.id, command: frame.type, success, data };
    if (!success) response.error = 'PRIVATE /native/root SECRET';
    send(socket, response);
  };
  const event = (value) => {
    for (const socket of sockets) send(socket, { sessionId: inventory[0]?.sessionId ?? 'routing-parent', ...value });
  };
  async function persistHistory() {
    await writeFile(sessionPath, [
      { type: 'session', version: 3, id: state.sessionId, cwd: project, timestamp: instant },
      ...history.entries,
    ].map(JSON.stringify).join('\n') + '\n');
  }
  async function setGoal(goal) {
    await mkdir(path.dirname(goalFile), { recursive: true });
    const temporary = `${goalFile}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, goal }));
    await rename(temporary, goalFile);
  }
  const goal = (objective = 'Foundation goal', status = 'active') => ({
    id: 'goal-id', threadId: 'durable-parent', objective, status,
    tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
  });
  await persistHistory();
  await writeFile(path.join(store, 'tasks', `${task.task_id}.json`), JSON.stringify(task));
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    let authenticated = !terminal;
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, chunk]);
      if (!authenticated) {
        if (input.length < 32) return;
        input = input.subarray(32);
        authenticated = true;
      }
      let newline;
      while ((newline = input.indexOf(10)) !== -1) {
        const frame = JSON.parse(input.subarray(0, newline).toString());
        input = input.subarray(newline + 1);
        frames.push(frame);
        signal.emit('frame', { socket, frame });
        void handle(socket, frame).catch((error) => signal.emit('fixtureError', error));
      }
    });
  });
  async function handle(socket, frame) {
    if (override && await override({ socket, frame, reply, send })) return;
    switch (frame.type) {
      case 'get_protocol_info': return reply(socket, frame, info);
      case 'set_client_info': return reply(socket, frame);
      case 'list_sessions': return reply(socket, frame, { sessions: inventory });
      case 'open_session':
        if (frame.durableSessionId) {
          state.sessionId = frame.durableSessionId;
          inventory[0].durableSessionId = frame.durableSessionId;
          history.entries = [];
          history.leafId = null;
          await persistHistory();
        }
        for (const value of openEvents) send(socket, { sessionId: inventory[0]?.sessionId ?? 'routing-parent', ...value });
        return reply(socket, frame, { sessionId: inventory[0]?.sessionId ?? 'routing-parent', state: structuredClone(state), attached: true });
      case 'get_state': return reply(socket, frame, structuredClone(state));
      case 'get_entries': return reply(socket, frame, structuredClone(history));
      case 'get_available_models': return reply(socket, frame, { models: [state.model] });
      case 'get_available_thinking_levels': return reply(socket, frame, { levels: ['off', 'low', 'high'] });
      case 'get_commands': return reply(socket, frame, { commands });
      case 'subscribe': return reply(socket, frame, { cursor: 0 });
      case 'prompt': {
        if (frame.message.startsWith('/goal ')) {
          const suffix = frame.message.slice(6);
          if (!goalAcknowledgedWithoutMutation) {
            let current;
            try { current = JSON.parse(await readFile(goalFile, 'utf8')).goal; } catch { current = null; }
            await setGoal(suffix === 'clear' ? null : ['pause', 'resume'].includes(suffix)
              ? { ...current, status: suffix === 'pause' ? 'paused' : 'active' } : goal(suffix));
          }
          return reply(socket, frame, { disposition: 'handled', credentials: 'SECRET' });
        }
        return reply(socket, frame, { disposition: 'started' });
      }
      case 'steer':
      case 'follow_up':
      case 'abort': return reply(socket, frame);
      case 'set_session_name':
        state.sessionName = frame.name;
        return reply(socket, frame);
      case 'set_model':
        state.model = { provider: frame.provider, id: frame.modelId };
        return reply(socket, frame, state.model);
      case 'set_thinking_level':
        state.thinkingLevel = frame.level;
        return reply(socket, frame); // Actual native response has no data.
      case 'extension_ui_response': return reply(socket, frame);
      case 'extension_request':
        if (frame.name === 'omo.task.output') {
          return reply(socket, frame, frame.data.task_id === task.task_id
            ? { kind: frame.data.mode === 'status' ? 'status' : 'transcript',
              snapshot: task, transcript: 'native transcript', truncated: false }
            : { kind: 'not_found', reason: 'PRIVATE SECRET' });
        }
        return reply(socket, frame, { kind: frame.name === 'omo.task.cancel' ? 'cancelled' : 'steered', task_id: task.task_id });
      default: return reply(socket, frame, undefined, false);
    }
  }
  const listening = once(server, 'listening');
  server.listen(socketPath);
  await listening;
  const service = createSessionService({
    runtime, dataDir: root,
    discover: async () => {
      if (discoverFailure) throw discoverFailure;
      return [{
        socketPath, daemonDir: path.join(agentDir, 'rpc-host-daemon'), instanceId: info.instanceId,
        endpointKind: terminal ? 'tui' : 'rpc_host', availability: 'ready', protocol: info,
        capabilities: info.capabilities, stores: [store], sessions: structuredClone(inventory),
      }];
    },
    ensureHost: async () => { ensureCalls += 1; },
    ...serviceOptions,
  });
  return {
    root, runtime, project, agentDir, store, socketPath, sessionPath, service,
    state, history, inventory, info, commands, task, frames, sockets, signal, event, reply, send, goal,
    setGoal, persistHistory, get ensureCalls() { return ensureCalls; },
    set override(value) { override = value; }, set openEvents(value) { openEvents = value; },
    set discoverFailure(value) { discoverFailure = value; },
    set goalAcknowledgedWithoutMutation(value) { goalAcknowledgedWithoutMutation = value; },
    async attach() {
      const [session] = await service.listSessions({});
      return service.attachSession(session.sessionKey);
    },
    async cleanup() {
      await service.close();
      const closed = once(server, 'close');
      for (const socket of sockets) socket.destroy();
      server.close();
      await closed;
      await rm(root, { recursive: true, force: true });
      return { removed: root, sockets: sockets.size, serverClosed: !server.listening };
    },
  };
}

/** Exact event subscription before trigger, with a bounded deadline, no polling. */
export function nextSessionEvent(service, key, predicate, timeoutMs = 5_000) {
  let unsubscribe;
  let timer;
  return new Promise((resolve, reject) => {
    unsubscribe = service.subscribe(key, (event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
    timer = setTimeout(() => { unsubscribe(); reject(new Error('Expected native event did not arrive')); }, timeoutMs);
  });
}
