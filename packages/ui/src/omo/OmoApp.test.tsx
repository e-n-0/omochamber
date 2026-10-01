import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act, Profiler } from 'react';
import { browser, click, mount, nativeSnapshot, type } from './chat/chatTestFixture';
import { createNativeClient } from './client';
import { createNativeStore } from './state';
import { commandEnvelopeSchema, createSessionSchema, projectInputSchema, projectUpdateSchema } from './contracts';
import type { CommandEnvelope, CreateSession, NativeEvent, NativeProject, SessionSummary, SessionEvent } from './contracts';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';

const { OmoApp } = await import('./OmoApp');
const { SessionSidebar } = await import('./SessionSidebar');

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred value not initialized'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  const projects: NativeProject[] = [
    { id: 'project-a', path: '/workspace', name: 'PROJECT_A', worktreePaths: ['/worktree'] },
    { id: 'project-b', path: '/other', name: 'PROJECT_B' },
  ];
  const sessions: SessionSummary[] = [
    { sessionKey: 'chat-a', durableSessionId: 'durable-a', directory: '/workspace', name: 'SESSION_A', ownership: 'hosted', connection: 'connected' },
    { sessionKey: 'offline', durableSessionId: 'durable-offline', directory: '/workspace', name: 'OFFLINE', ownership: 'offline', connection: 'unavailable' },
    { sessionKey: 'terminal', durableSessionId: 'durable-terminal', directory: '/workspace', name: 'TERMINAL', ownership: 'terminal', connection: 'connected' },
  ];
  const creates: CreateSession[] = [];
  const commands: CommandEnvelope[] = [];
  const attached: string[] = [];
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const snapshots = new Map<string, ReturnType<typeof nativeSnapshot>>();
  const createStarted = deferred<void>();
  const creation = deferred<Response>();
  let deferCreation = false;
  let projectStatus = 200;
  let sessionStatus = 200;
  let revision = 1;
  const fetchNative = async (route: string, options?: RuntimeFetchOptions): Promise<Response> => {
    if (route === '/auth/session') return Response.json({ authenticated: true, disabled: true });
    if (route === '/api/omo/settings') return Response.json({ schemaVersion: 1, theme: 'openchamber-light', ...(
      options?.method === 'PATCH' ? JSON.parse(String(options.body)) : null
    ) });
    if (route === '/api/omo/status') return Response.json({ available: true, protocolVersion: 1, capabilities: ['multi_session'] });
    if (route === '/api/omo/projects') {
      if (options?.method === 'POST') {
        const input = projectInputSchema.parse(JSON.parse(String(options.body)));
        const project = { id: 'added', path: input.path, name: input.name ?? 'ADDED_PROJECT' };
        projects.push(project);
        return Response.json(project);
      }
      return Response.json(projects, { status: projectStatus });
    }
    if (route.startsWith('/api/omo/projects/')) {
      const project = projects.find((item) => item.id === route.split('/').at(-1));
      assert(project);
      Object.assign(project, projectUpdateSchema.parse(JSON.parse(String(options?.body))));
      return Response.json(project);
    }
    if (route === '/api/omo/sessions') {
      if (options?.method !== 'POST') return Response.json(sessions, { status: sessionStatus });
      const input = createSessionSchema.parse(JSON.parse(String(options.body)));
      creates.push(input);
      if (deferCreation) { createStarted.resolve(); return creation.promise; }
      const project = projects.find((item) => item.id === input.projectId);
      assert(project);
      const session: SessionSummary = {
        sessionKey: 'new-session', durableSessionId: 'new-durable', directory: input.worktreePath ?? project.path,
        name: null, ownership: 'hosted', connection: 'connected',
      };
      sessions.push(session);
      return Response.json(session);
    }
    const key = route.split('/')[4];
    if (route.endsWith('/events')) return new Response(new ReadableStream<Uint8Array>({
      start(controller) { streams.set(key, controller); },
      cancel() { streams.delete(key); },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (route.endsWith('/snapshot') || route.endsWith('/attach')) {
      if (route.endsWith('/attach')) attached.push(key);
      let snapshot = snapshots.get(key);
      if (!snapshot) {
        const session = sessions.find((item) => item.sessionKey === key);
        assert(session);
        snapshot = nativeSnapshot();
        snapshot.sessionKey = key;
        snapshot.durableSessionId = session.durableSessionId;
        snapshot.state.directory = session.directory;
        snapshot.state.name = session.name;
        snapshot.ownership = session.ownership === 'offline' ? 'hosted' : session.ownership;
        snapshots.set(key, snapshot);
      }
      return Response.json(snapshot);
    }
    if (route.endsWith('/commands')) {
      const command = commandEnvelopeSchema.parse(JSON.parse(String(options?.body)));
      commands.push(command);
      return Response.json({ requestId: command.requestId, connectionEpoch: command.connectionEpoch, accepted: true }, { status: 202 });
    }
    if (route === '/api/fs/list') return Response.json([]);
    return Response.json({ code: 'fixture_unavailable' }, { status: 503 });
  };
  const client = createNativeClient({ fetch: fetchNative });
  const store = createNativeStore({ client, waitForReconnect: (_attempt, signal) => new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => fetchNative(new URL(input instanceof Request ? input.url : String(input), browser.location.href).pathname, options);
  async function emit(event: SessionEvent) {
    const stream = streams.get(event.sessionKey);
    assert(stream);
    const received = new Promise<void>((resolve, reject) => {
      const timeout = AbortSignal.timeout(2_000);
      const done = () => {
        if (store.getState().sessions.get(event.sessionKey)?.snapshot?.revision === event.revision) {
          unsubscribe(); timeout.removeEventListener('abort', expired); resolve();
        }
      };
      const expired = () => { unsubscribe(); reject(new Error('Fixture event timed out')); };
      const unsubscribe = store.subscribe(done);
      timeout.addEventListener('abort', expired, { once: true });
    });
    await act(async () => { stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); await received; });
  }
  return {
    client, store, projects, sessions, creates, commands, attached, createStarted, creation,
    deferCreation: () => { deferCreation = true; },
    failProjects: () => { projectStatus = 503; },
    failSessions: () => { sessionStatus = 503; },
    native: (key: string, event: NativeEvent) => emit({ type: 'native', sessionKey: key, connectionEpoch: 1, revision: ++revision, event }),
    cleanup: async () => { await store.dispose(); globalThis.fetch = originalFetch; expect(streams.size).toBe(0); },
  };
}

test('explicit New session creates once in the registered worktree and selects native chat', async () => {
  // Given a loaded native shell without a selected session.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    expect(h.creates).toHaveLength(0);
    await click('[data-worktree-path="/worktree"]');
    // When the user explicitly requests a new worktree session.
    await click('[data-testid="omo-new-session"]');
    // Then the actual native creation receives the registered identity once.
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0].projectId).toBe('project-a');
    expect(h.creates[0].worktreePath).toBe('/worktree');
    expect(h.store.getState().selectedSessionKey).toBe('new-session');
    expect(view.host.querySelector('[data-testid="omo-composer"]')).not.toBeNull();
    expect(h.sessions[0].directory).toBe('/workspace');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('directory selection clears chat without rewriting an existing native session cwd', async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    await click('[data-project-id="project-b"]');
    expect(view.host.querySelector('[data-testid="omo-chat-empty"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="omo-composer"]')).toBeNull();
    expect(h.commands).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
    expect(h.sessions[0].directory).toBe('/workspace');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('late creation completion stays in its captured directory after the user changes projects', async () => {
  const h = fixture();
  h.deferCreation();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-testid="omo-new-session"]');
    await h.createStarted.promise;
    await click('[data-project-id="project-b"]');
    await act(async () => { h.creation.resolve(Response.json({
      sessionKey: 'late', durableSessionId: 'late-durable', directory: '/workspace',
      name: null, ownership: 'hosted', connection: 'connected',
    })); });
    expect(view.host.querySelector('[data-testid="omo-chat-empty"]')).not.toBeNull();
    expect(h.attached).toHaveLength(0);
    expect(h.creates).toHaveLength(1);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('keeps pending native dialogs mounted while Files navigation is active', async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    await click('[data-testid="omo-tab-files"]');
    await h.native('chat-a', { type: 'interaction_pending', interaction: {
      id: 'request-a', method: 'input', title: 'NATIVE_INPUT',
    } });
    expect(document.querySelector('[data-testid="omo-pending-dialog"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="omo-tab-files"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(view.host.querySelector('[data-testid="omo-workbench"]')).not.toBeNull();
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('reopens offline sessions and disables rename for terminal-owned sessions', async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="offline"]');
    expect(h.attached).toEqual(['offline']);
    expect(h.store.getState().sessions.get('offline')?.snapshot?.ownership).toBe('hosted');
    expect(view.host.querySelector('[data-session-key="offline"]')?.closest('li')?.querySelector('[data-session-ownership]')).toBeNull();
    await click('[data-session-key="terminal"]');
    expect(view.host.querySelector('[data-testid="omo-session-rename"]')?.getAttribute('disabled')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="omo-composer"]')?.getAttribute('disabled')).not.toBeNull();
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('native rename submits a command and does not treat acceptance as completion', async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    await click('[data-testid="omo-session-rename"]');
    await type('[data-testid="omo-session-name"]', 'RENAMED_FIXTURE');
    await click('[data-testid="omo-session-save"]');
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].command).toEqual({ type: 'rename', name: 'RENAMED_FIXTURE' });
    expect(view.host.querySelector('[data-rename-status="accepted"]')).not.toBeNull();
    expect(view.host.querySelector('[data-session-key="chat-a"]')?.textContent).toContain('SESSION_A');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('failed inventory reads preserve project and session rows instead of authoritative empty success', async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    h.failProjects();
    h.failSessions();
    const projectRefresh = view.host.querySelector('[data-testid="omo-project-sidebar"] button');
    assert(projectRefresh instanceof HTMLElement);
    await act(async () => { projectRefresh.click(); });
    const refresh = view.host.querySelector('[data-testid="omo-session-sidebar"] button');
    assert(refresh instanceof HTMLElement);
    await act(async () => refresh.click());
    expect(view.host.querySelectorAll('[data-project-id]')).toHaveLength(2);
    expect(view.host.querySelectorAll('[data-session-key]')).toHaveLength(3);
    expect(view.host.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('session sidebar is not committed again on native assistant text deltas', async () => {
  const h = fixture();
  await h.store.selectSession('chat-a');
  let commits = 0;
  const view = await mount(<Profiler id="sessions" onRender={() => { commits += 1; }}>
    <SessionSidebar sessions={h.sessions} store={h.store} sessionKey="chat-a" loading={false} error={null}
      creating={false} canCreate onCreate={() => {}} onSelect={() => {}} onRefresh={() => {}} />
  </Profiler>);
  try {
    const before = commits;
    await h.native('chat-a', { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } });
    await h.native('chat-a', { type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'DELTA_FIXTURE' } });
    expect(commits).toBe(before);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('project add and rename preserve canonical registration and do not mutate session directories', async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-testid="omo-add-project"]');
    await type('[data-testid="omo-project-path"]', '/added');
    await type('[data-testid="omo-project-name"]', 'ADDED_FIXTURE');
    await click('[data-testid="omo-project-save"]');
    expect(view.host.querySelector('[data-project-id="added"]')).not.toBeNull();
    await click('[data-project-rename="added"]');
    await type('[data-testid="omo-project-name"]', 'RENAMED_PROJECT');
    await click('[data-testid="omo-project-save"]');
    expect(h.projects.at(-1)?.name).toBe('RENAMED_PROJECT');
    expect(h.projects.at(-1)?.path).toBe('/added');
    expect(h.sessions[0].directory).toBe('/workspace');
  } finally { await view.cleanup(); await h.cleanup(); }
});
