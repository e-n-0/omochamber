import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act, Profiler } from 'react';
import { EditorView } from '@codemirror/view';
import { browser, click, draftValue, mount, nativeSnapshot, type } from './chat/chatTestFixture';
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
  browser.localStorage.clear();
  browser.happyDOM.setWindowSize({ width: 1_280, height: 800 });
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
  const workspaceReads: string[] = [];
  const attached: string[] = [];
  const inventoryReads: string[] = [];
  const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
  const snapshots = new Map<string, ReturnType<typeof nativeSnapshot>>();
  const createStarted = deferred<void>();
  const creation = deferred<Response>();
  let deferCreation = false;
  let projectStatus = 200;
  let sessionStatus = 200;
  let revision = 1;
  const fetchNative = async (route: string, options?: RuntimeFetchOptions, query = new URLSearchParams()): Promise<Response> => {
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
      inventoryReads.push('projects');
      return Response.json(projects, { status: projectStatus });
    }
    if (route.startsWith('/api/omo/projects/')) {
      const project = projects.find((item) => item.id === route.split('/').at(-1));
      assert(project);
      Object.assign(project, projectUpdateSchema.parse(JSON.parse(String(options?.body))));
      return Response.json(project);
    }
    if (route === '/api/omo/sessions') {
      if (options?.method !== 'POST') {
        inventoryReads.push('sessions');
        return Response.json(sessions, { status: sessionStatus });
      }
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
    if (route === '/api/fs/list') {
      const directory = options?.directory ?? query.get('directory') ?? '/workspace';
      workspaceReads.push(directory);
      return Response.json({ path: directory, entries: [{
        name: 'draft.ts', path: `${directory}/draft.ts`, isDirectory: false, isFile: true, isSymbolicLink: false,
      }] });
    }
    if (route === '/api/fs/stat') return Response.json({
      path: query.get('path'), isFile: true, size: 32, mtimeMs: 1,
    });
    if (route === '/api/fs/read') return new Response('export const initial = true;');
    return Response.json({ code: 'fixture_unavailable' }, { status: 503 });
  };
  const client = createNativeClient({ fetch: fetchNative });
  const store = createNativeStore({ client, waitForReconnect: (_attempt, signal) => new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  }) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    return fetchNative(url.pathname, options, url.searchParams);
  };
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
    client, store, projects, sessions, creates, commands, workspaceReads, attached, inventoryReads, createStarted, creation,
    deferCreation: () => { deferCreation = true; },
    failProjects: () => { projectStatus = 503; },
    failSessions: () => { sessionStatus = 503; },
    native: (key: string, event: NativeEvent) => emit({ type: 'native', sessionKey: key, connectionEpoch: 1, revision: ++revision, event }),
    cleanup: async () => {
      await store.dispose(); globalThis.fetch = originalFetch; browser.localStorage.clear(); expect(streams.size).toBe(0);
    },
  };
}

async function press(selector: string, key: string) {
  const control = document.querySelector(selector);
  assert(control instanceof HTMLElement);
  await act(async () => { control.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
}

async function measureChatArea(view: Awaited<ReturnType<typeof mount>>, client: ReturnType<typeof createNativeClient>, store: ReturnType<typeof createNativeStore>) {
  const area = view.host.querySelector('[data-chat-area]');
  assert(area instanceof HTMLElement);
  // happy-dom has no layout engine; supply the observed parent width to the
  // real resize handler rather than replacing the handler or controllers.
  Object.defineProperty(area, 'clientWidth', { configurable: true, value: 1_000 });
  await view.render(<OmoApp client={client} store={store} />);
}

test('explicit New session creates once in the registered worktree and selects native chat', async () => {
  // Given a loaded native shell without a selected session.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    expect(h.creates).toHaveLength(0);
    await click('[data-directory-path="/worktree"]');
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

for (const { selector, projectId, directory } of [
  { selector: '[data-native-project="project-b"] button[aria-label="New session"]', projectId: 'project-b', directory: '/other' },
  { selector: '[data-native-project="project-a"] button[aria-label="New session in worktree"]', projectId: 'project-a', directory: '/worktree' },
]) test(`original scoped create button targets ${directory} rather than the selected scope`, async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    await click(selector);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0].projectId).toBe(projectId);
    expect(h.creates[0].worktreePath).toBe(directory === '/worktree' ? directory : undefined);
    expect(h.store.getState().selectedSessionKey).toBe('new-session');
    expect(h.sessions.find((session) => session.sessionKey === 'new-session')?.directory).toBe(directory);
    expect(view.host.querySelector('[data-testid="omo-composer"]')).not.toBeNull();
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('directory selection clears chat without rewriting an existing native session cwd', async () => {
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    await click('[data-native-project="project-b"] button');
    expect(view.host.querySelector('[data-testid="omo-chat-empty"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="omo-composer"]')).toBeNull();
    expect(h.commands).toHaveLength(0);
    expect(h.creates).toHaveLength(0);
    expect(h.sessions[0].directory).toBe('/workspace');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('late scoped creation completion stays in its captured directory after the user changes projects', async () => {
  const h = fixture();
  h.deferCreation();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    const createSelector = '[data-native-project="project-a"] button[aria-label="New session in worktree"]';
    await click(createSelector);
    await h.createStarted.promise;
    await click(createSelector);
    await click('[data-native-project="project-b"] button');
    await act(async () => { h.creation.resolve(Response.json({
      sessionKey: 'late', durableSessionId: 'late-durable', directory: '/worktree',
      name: null, ownership: 'hosted', connection: 'connected',
    })); });
    expect(view.host.querySelector('[data-testid="omo-chat-empty"]')).not.toBeNull();
    expect(h.attached).toHaveLength(0);
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0].worktreePath).toBe('/worktree');
    expect(view.host.querySelector('[data-native-project="project-b"]')?.getAttribute('data-selected')).toBe('true');
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

test('tool navigation keeps chat visible and the selected native session unchanged', async () => {
  // Given a selected native chat and its mounted composer.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    const composer = view.host.querySelector('[data-testid="omo-composer"]');
    const chat = view.host.querySelector('[data-testid="omo-chat-column"]');
    assert(chat instanceof HTMLElement);
    // When Files opens beside the chat.
    await click('[data-testid="omo-tab-files"]');
    // Then neither chat nor native selection is replaced by the context tool.
    expect(view.host.querySelector('[data-testid="omo-composer"]')).toBe(composer);
    expect(chat.closest('[hidden]')).toBeNull();
    expect(view.host.querySelector('[data-context-panel]')?.hasAttribute('inert')).toBe(false);
    expect(view.host.querySelector('#omo-panels aside')?.hasAttribute('inert')).toBe(true);
    expect(h.store.getState().selectedSessionKey).toBe('chat-a');
    expect(h.attached).toEqual(['chat-a']);
    expect(h.commands).toHaveLength(0);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('selecting the active rail collapses context without replacing its workbench', async () => {
  // Given an open Files context with a retained workbench.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    await click('[data-testid="omo-tab-files"]');
    const workbench = view.host.querySelector('[data-testid="omo-workbench"]');
    const reads = h.workspaceReads.length;
    // When the same rail control is selected again.
    await click('[data-testid="omo-tab-files"]');
    // Then the panel collapses and yields to native work status.
    expect(view.host.querySelector('[data-testid="omo-workbench"]')).toBe(workbench);
    expect(view.host.querySelector('[data-context-panel]')?.hasAttribute('inert')).toBe(true);
    expect(view.host.querySelector('[data-testid="omo-tab-files"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(view.host.querySelector('#omo-panels aside')?.hasAttribute('inert')).toBe(false);
    expect(h.workspaceReads).toHaveLength(reads);
    expect(h.store.getState().selectedSessionKey).toBe('chat-a');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('composer and pending dialog drafts survive context resize expand and collapse', async () => {
  // Given native composer and input-dialog drafts.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-session-key="chat-a"]');
    await type('[data-testid="omo-composer"]', 'COMPOSER_DRAFT');
    await h.native('chat-a', { type: 'interaction_pending', interaction: {
      id: 'request-draft', method: 'input', title: 'NATIVE_INPUT',
    } });
    await type('[data-testid="omo-dialog-input"]', 'DIALOG_DRAFT');
    const composer = view.host.querySelector('[data-testid="omo-composer"]');
    const dialog = document.querySelector('[data-testid="omo-pending-dialog"]');
    // When context tools change size, expand, switch and collapse.
    await click('[data-testid="omo-tab-files"]');
    await measureChatArea(view, h.client, h.store);
    await press('[data-testid="omo-context-resize"]', 'ArrowLeft');
    await click('[data-testid="omo-context-expand"]');
    await click('[data-testid="omo-tab-changes"]');
    await click('[data-testid="omo-context-close"]');
    // Then the mounted drafts and outstanding native request are unchanged.
    expect(view.host.querySelector('[data-testid="omo-composer"]')).toBe(composer);
    expect(document.querySelector('[data-testid="omo-pending-dialog"]')).toBe(dialog);
    expect(draftValue('[data-testid="omo-composer"]')).toBe('COMPOSER_DRAFT');
    expect(document.querySelector<HTMLInputElement>('[data-testid="omo-dialog-input"]')?.value).toBe('DIALOG_DRAFT');
    expect(h.store.getState().sessions.get('chat-a')?.snapshot?.pendingInteractions[0]?.id).toBe('request-draft');
    expect(h.commands).toHaveLength(0);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('file editor drafts and controller identity survive tools collapse and directory revisits', async () => {
  // Given an edited file in the registered directory.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-testid="omo-tab-files"]');
    await click('[data-context-panel] [title="/workspace/draft.ts"]');
    const editorElement = view.host.querySelector('.cm-editor');
    assert(editorElement instanceof HTMLElement);
    const editor = EditorView.findFromDOM(editorElement);
    assert(editor);
    await act(async () => { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'UNSAVED_EDITOR_DRAFT' } }); });
    // When the pane changes tools and presentation, then leaves and revisits its directory.
    await click('[data-testid="omo-context-expand"]');
    await click('[data-testid="omo-tab-changes"]');
    await click('[data-testid="omo-tab-terminal"]');
    await click('[data-testid="omo-context-close"]');
    await click('[data-native-project="project-b"] button');
    await click('[data-testid="omo-tab-files"]');
    await click('[data-native-project="project-a"] button');
    await click('[data-testid="omo-tab-files"]');
    // Then the same editor still owns its unsaved content.
    expect(view.host.querySelector('.cm-editor')).toBe(editorElement);
    expect(editorElement.closest('[hidden]')).toBeNull();
    expect(EditorView.findFromDOM(editorElement)).toBe(editor);
    expect(editor.state.doc.toString()).toBe('UNSAVED_EDITOR_DRAFT');
    expect(view.host.querySelector('[data-testid="omo-file-save"]')?.hasAttribute('disabled')).toBe(false);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('sidebar resizing is bounded and persistent controls stay mounted when it collapses', async () => {
  // Given the original default sidebar width and persistent titlebar controls.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    const shell = view.host.querySelector('[data-testid="omo-app"]');
    const toggle = view.host.querySelector('[data-testid="omo-navigation-toggle"]');
    const create = view.host.querySelector('[data-testid="omo-new-session"]');
    const controls = toggle?.parentElement;
    expect(shell?.getAttribute('data-navigation-width')).toBe('280');
    // When resizing reaches both bounds and navigation collapses.
    await press('[data-testid="omo-navigation-resize"]', 'Home');
    expect(shell?.getAttribute('data-navigation-width')).toBe('264');
    await press('[data-testid="omo-navigation-resize"]', 'ArrowLeft');
    expect(shell?.getAttribute('data-navigation-width')).toBe('264');
    await press('[data-testid="omo-navigation-resize"]', 'End');
    await press('[data-testid="omo-navigation-resize"]', 'ArrowRight');
    await click('[data-testid="omo-navigation-toggle"]');
    // Then the maximum and collapsed state are reflected without moving controls.
    expect(shell?.getAttribute('data-navigation-width')).toBe('500');
    expect(shell?.getAttribute('data-navigation-open')).toBe('false');
    expect(view.host.querySelector('[data-testid="omo-navigation-toggle"]')).toBe(toggle);
    const collapsedCreate = view.host.querySelector('[data-testid="omo-new-session"]');
    expect(collapsedCreate?.parentElement).toBe(controls);
    expect(collapsedCreate?.closest('#omo-navigation')).toBeNull();
    expect(create?.closest('#omo-navigation')).toBeNull();
    await click('[data-testid="omo-new-session"]');
    expect(h.creates).toHaveLength(1);
    expect(h.creates[0].projectId).toBe('project-a');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('context width survives right-anchored expansion and uses each tool preference', async () => {
  // Given a measured Files context.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    await click('[data-testid="omo-tab-files"]');
    await measureChatArea(view, h.client, h.store);
    const shell = view.host.querySelector('[data-testid="omo-app"]');
    const pane = view.host.querySelector('[data-context-panel]');
    const area = view.host.querySelector('[data-chat-area]');
    assert(area instanceof HTMLElement);
    // The actual available width changes after render, as on sidebar collapse.
    Object.defineProperty(area, 'clientWidth', { configurable: true, value: 800 });
    // When Files is resized and expansion toggles before switching tools.
    await press('[data-testid="omo-context-resize"]', 'ArrowLeft');
    expect(shell?.getAttribute('data-context-width')).toBe('0.52');
    await click('[data-testid="omo-context-expand"]');
    expect(pane?.getAttribute('data-expanded')).toBe('true');
    await click('[data-testid="omo-context-expand"]');
    await click('[data-testid="omo-tab-changes"]');
    expect(shell?.getAttribute('data-context-width')).toBe('0.5');
    await click('[data-testid="omo-tab-files"]');
    // Then normal width is restored on the same context node.
    expect(view.host.querySelector('[data-context-panel]')).toBe(pane);
    expect(pane?.getAttribute('data-expanded')).toBe('false');
    expect(shell?.getAttribute('data-context-width')).toBe('0.52');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('pointer resize persists on release and cancellation restores its captured width', async () => {
  // Given the default sidebar and no persisted layout.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    const handle = view.host.querySelector('[data-testid="omo-navigation-resize"]');
    assert(handle instanceof HTMLElement);
    const shell = view.host.querySelector('[data-testid="omo-app"]');
    // When a drag previews a width, releases it, then a second drag is canceled.
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, button: 0, clientX: 280, bubbles: true }));
    });
    await act(async () => handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 400, bubbles: true })));
    expect(handle.closest('aside')?.style.width).toBe('400px');
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworkspace')).toBeNull();
    await act(async () => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, clientX: 400, bubbles: true })); });
    const committed = browser.localStorage.getItem('omochamber.layout:%2Fworkspace');
    assert(committed);
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, button: 0, clientX: 400, bubbles: true }));
    });
    await act(async () => handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 8, clientX: 500, bubbles: true })));
    await act(async () => handle.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 8, bubbles: true })));
    // Then the last committed width remains authoritative and listeners are gone.
    expect(shell?.getAttribute('data-navigation-width')).toBe('400');
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworkspace')).toBe(committed);
    await act(async () => { handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 8, clientX: 450, bubbles: true })); });
    expect(shell?.getAttribute('data-navigation-width')).toBe('400');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('compact navigation stays reachable without changing the desktop layout preference', async () => {
  // Given a canonical directory with default desktop preferences.
  const h = fixture();
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    // When the viewport becomes compact and native navigation is opened.
    await act(async () => { browser.happyDOM.setWindowSize({ width: 390, height: 844 }); });
    const shell = view.host.querySelector('[data-testid="omo-app"]');
    expect(shell?.getAttribute('data-navigation-open')).toBe('false');
    await click('[data-testid="omo-navigation-toggle"]');
    expect(shell?.getAttribute('data-navigation-open')).toBe('true');
    await click('[data-session-key="chat-a"]');
    // Then selecting native chat closes the overlay without losing tools or writing a desktop preference.
    expect(shell?.getAttribute('data-navigation-open')).toBe('false');
    expect(view.host.querySelector('[data-testid="omo-tab-files"]')?.hasAttribute('disabled')).toBe(false);
    expect(view.host.querySelector('[data-testid="omo-new-session"]')?.hasAttribute('disabled')).toBe(false);
    expect(h.store.getState().selectedSessionKey).toBe('chat-a');
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworkspace')).toBeNull();
    await act(async () => { browser.happyDOM.setWindowSize({ width: 1_280, height: 800 }); });
    expect(shell?.getAttribute('data-navigation-open')).toBe('true');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('layout preferences restore by canonical directory without hydration writes', async () => {
  // Given explicit layout choices in a project directory.
  const h = fixture();
  let view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworkspace')).toBeNull();
    await press('[data-testid="omo-navigation-resize"]', 'End');
    await click('[data-testid="omo-tab-files"]');
    await click('[data-testid="omo-context-expand"]');
    await click('[data-testid="omo-navigation-toggle"]');
    const saved = browser.localStorage.getItem('omochamber.layout:%2Fworkspace');
    assert(saved);
    // When another canonical directory is selected, then the original is revisited and remounted.
    await click('[data-directory-path="/worktree"]');
    expect(view.host.querySelector('[data-testid="omo-app"]')?.getAttribute('data-navigation-width')).toBe('280');
    expect(view.host.querySelector('[data-testid="omo-app"]')?.getAttribute('data-context-open')).toBe('false');
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworktree')).toBeNull();
    await click('[data-native-project="project-a"] button');
    await view.cleanup();
    view = await mount(<OmoApp client={h.client} store={h.store} />);
    // Then the original preferences hydrate without rewriting either namespace or selecting native work.
    const shell = view.host.querySelector('[data-testid="omo-app"]');
    expect(shell?.getAttribute('data-navigation-width')).toBe('500');
    expect(shell?.getAttribute('data-navigation-open')).toBe('false');
    expect(shell?.getAttribute('data-context-open')).toBe('true');
    expect(shell?.getAttribute('data-context-expanded')).toBe('true');
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworkspace')).toBe(saved);
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworktree')).toBeNull();
    expect(h.store.getState().selectedSessionKey).toBeNull();
    expect(h.commands).toHaveLength(0);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('malformed layout preferences do not replace inventory or write defaults', async () => {
  // Given a malformed browser-only layout preference.
  const h = fixture();
  browser.localStorage.setItem('omochamber.layout:%2Fworkspace', '{"version":1,"navigationWidth":9999}');
  // When the native shell hydrates its registered directory.
  const view = await mount(<OmoApp client={h.client} store={h.store} />);
  try {
    // Then native inventory and default geometry remain usable without granting authority to the malformed value.
    expect(view.host.querySelector('[data-testid="omo-app"]')?.getAttribute('data-navigation-width')).toBe('280');
    expect(view.host.querySelectorAll('[data-native-project]')).toHaveLength(2);
    expect(view.host.querySelectorAll('[data-session-key]')).toHaveLength(3);
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(browser.localStorage.getItem('omochamber.layout:%2Fworkspace')).toBe('{"version":1,"navigationWidth":9999}');
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
    expect(view.host.querySelector('[data-testid="omo-composer"] .cm-content')?.getAttribute('contenteditable')).toBe('false');
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
    const reads = h.inventoryReads.length;
    h.failProjects();
    h.failSessions();
    await click('[data-testid="omo-project-sidebar"] button[aria-label="Refresh"]');
    expect(h.inventoryReads.slice(reads).sort()).toEqual(['projects', 'sessions']);
    expect(view.host.querySelectorAll('[data-native-project]')).toHaveLength(2);
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
    expect(view.host.querySelector('[data-native-project="added"]')).not.toBeNull();
    const menu = view.host.querySelector('[data-native-project="added"] [data-slot="dropdown-menu-trigger"]');
    assert(menu instanceof HTMLElement);
    await act(async () => {
      menu.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
      menu.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
      menu.click();
    });
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await click('[data-project-rename="added"]');
    await type('[data-testid="omo-project-name"]', 'RENAMED_PROJECT');
    await click('[data-testid="omo-project-save"]');
    expect(h.projects.at(-1)?.name).toBe('RENAMED_PROJECT');
    expect(h.projects.at(-1)?.path).toBe('/added');
    expect(h.sessions[0].directory).toBe('/workspace');
  } finally { await view.cleanup(); await h.cleanup(); }
});
