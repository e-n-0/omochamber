import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act, Profiler } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { createPanelFixture, panelSnapshot, taskFixture } from './panel-fixture';

let NativePanels: typeof import('./NativePanels').NativePanels;
let createRoot: typeof import('react-dom/client').createRoot;

describe('native work-state panels', () => {
  let win: Window;
  let root: Root;
  let container: HTMLDivElement;
  let restoreGlobals: () => void;
  let fixture: ReturnType<typeof createPanelFixture>;
  let commits: string[];
  const dictionary = useI18nStore.getState().dictionary;

  const query = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const button = (id: string) => {
    const element = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    assert(element);
    return element;
  };
  const click = async (id: string) => { await act(async () => button(id).click()); };
  const fill = async (id: string, value: string) => {
    const input = container.querySelector<HTMLTextAreaElement>(`[data-testid="${id}"]`);
    assert(input);
    const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set;
    assert(setter);
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const render = async (sessionKey: string | null = 'session-a') => {
    await act(async () => root.render(
      <I18nProvider>
        <Profiler id="panels" onRender={(id) => commits.push(id)}>
          <NativePanels client={fixture.client} store={fixture.store} sessionKey={sessionKey} />
        </Profiler>
      </I18nProvider>,
    ));
  };
  const attach = async (snapshot = panelSnapshot()) => {
    fixture.setSnapshot(snapshot);
    await act(async () => { await fixture.store.selectSession(snapshot.sessionKey); });
    await render(snapshot.sessionKey);
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLTextAreaElement: win.HTMLTextAreaElement,
      HTMLIFrameElement: win.HTMLIFrameElement, SVGElement: win.SVGElement,
      Event: win.Event, MouseEvent: win.MouseEvent, CustomEvent: win.CustomEvent,
      MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
      getComputedStyle: win.getComputedStyle.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    // React DOM's input-event support is detected at module initialization.
    // Install the real DOM before importing the event implementation.
    ({ createRoot } = await import('react-dom/client'));
    ({ NativePanels } = await import('./NativePanels'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fixture = createPanelFixture();
    commits = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await fixture.dispose();
    useI18nStore.setState({ dictionary });
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('distinguishes no selected session and loading from authoritative empty', async () => {
    await render(null);
    expect(query('omo-panels-no-session')).not.toBeNull();
    await render();
    expect(container.querySelectorAll('[data-projection="loading"]').length).toBe(4);
    expect(query('omo-goal-empty')).toBeNull();
  });

  test('renders ready empty snapshots without inventing work', async () => {
    const snapshot = panelSnapshot();
    await attach({ ...snapshot, goal: { status: 'ready', value: null }, todo: { status: 'ready', value: null },
      tasks: { status: 'ready', value: [] }, dags: { status: 'ready', value: [] } });
    for (const id of ['omo-goal-empty', 'omo-tasks-empty', 'omo-todo-empty', 'omo-dags-empty']) expect(query(id)).not.toBeNull();
    expect(container.querySelector('[data-recorded-status]')).toBeNull();
  });

  test('hydrates recorded inventories in source order with read-only todo and DAG', async () => {
    await attach();
    expect(query('omo-goal-value')?.textContent).toContain(panelSnapshot().goal.value?.objective);
    expect(container.querySelector('[data-task-source]')?.getAttribute('data-task-source')).toBe('persisted');
    expect([...container.querySelectorAll('[data-todo-phase] [data-recorded-status]')].map((el) => el.getAttribute('data-recorded-status')))
      .toEqual(['completed', 'in_progress']);
    expect([...container.querySelectorAll('[data-node-id]')].map((el) => el.getAttribute('data-node-id'))).toEqual(['inspect', 'verify']);
    expect(query('omo-todo-panel')?.querySelector('button,input,textarea')).toBeNull();
    expect(query('omo-dags-panel')?.querySelector('button,input,textarea')).toBeNull();
  });

  for (const status of ['incomplete', 'unavailable'] as const) {
  test(`retains known values for ${status} projections without claiming empty`, async () => {
    await attach();
    const snapshot = panelSnapshot();
    await act(async () => { await fixture.publish({ ...snapshot, revision: 2,
      goal: { status, value: null }, todo: { status, value: null },
      tasks: { status, value: null }, dags: { status, value: null } }); });
    expect(container.querySelectorAll(`[data-projection="${status}"]`).length).toBe(4);
    expect(container.querySelectorAll('[data-testid="omo-retained-projection"]').length).toBe(4);
    expect(query('omo-goal-value')).not.toBeNull();
    expect(container.querySelector('[data-task-id="task-a"]')).not.toBeNull();
    expect(query('omo-goal-empty')).toBeNull();
    expect(button('omo-goal-pause').disabled).toBe(true);
  });
  }

  test('unavailable unknown projections never render successful emptiness', async () => {
    const snapshot = panelSnapshot();
    await attach({ ...snapshot, goal: { status: 'unavailable', value: null }, todo: { status: 'incomplete', value: null },
      tasks: { status: 'unavailable', value: null }, dags: { status: 'incomplete', value: null } });
    expect(container.querySelectorAll('[data-projection]').length).toBe(4);
    for (const id of ['omo-goal-empty', 'omo-tasks-empty', 'omo-todo-empty', 'omo-dags-empty']) expect(query(id)).toBeNull();
  });

  test('failed snapshot refresh keeps prior data and disables native controls', async () => {
    await attach();
    fixture.setReadFailure(true);
    await act(async () => { await fixture.store.refresh(); });
    expect(query('omo-goal-value')).not.toBeNull();
    expect(query('omo-session-retained')).not.toBeNull();
    expect(container.querySelector('[data-session-state="unavailable"]')).not.toBeNull();
    expect(button('omo-task-output-full').disabled).toBe(true);
    expect(button('omo-goal-pause').disabled).toBe(true);
  });

  for (const ownership of ['terminal', 'offline'] as const) {
  test(`keeps ${ownership} sessions read-only including task output`, async () => {
    await attach({ ...panelSnapshot(), ownership });
    expect(query('omo-panels-readonly')).not.toBeNull();
    for (const id of ['omo-goal-pause', 'omo-goal-clear', 'omo-task-cancel', 'omo-task-output-tail']) expect(button(id).disabled).toBe(true);
    await click('omo-task-output-tail');
    expect(fixture.outputCalls).toHaveLength(0);
    expect(fixture.commands).toHaveLength(0);
  });
  }

  for (const { status, control, type } of [
    { status: 'active', control: 'omo-goal-pause', type: 'goalPause' },
    { status: 'paused', control: 'omo-goal-resume', type: 'goalResume' },
    { status: 'complete', control: 'omo-goal-clear', type: 'goalClear' },
  ] as const) {
  test(`routes ${type} through the native store without optimistic goal changes`, async () => {
    const snapshot = panelSnapshot();
    assert(snapshot.goal.value);
    await attach({ ...snapshot, goal: { status: 'ready', value: { ...snapshot.goal.value, status } } });
    await click(control);
    expect(fixture.commands.map((envelope) => envelope.command)).toEqual([{ type }]);
    expect(fixture.commands[0].connectionEpoch).toBe(1);
    expect(button(control).disabled).toBe(true);
    expect(query('omo-goal-value')?.querySelector('[data-recorded-status]')?.getAttribute('data-recorded-status')).toBe(status);
    await act(async () => { await fixture.settle(fixture.commands[0]); });
    expect(query('omo-goal-value')?.querySelector('[data-recorded-status]')?.getAttribute('data-recorded-status')).toBe(status);
  });
  }

  test('validates reserved goal objectives and routes replacement once', async () => {
    await attach();
    await fill('omo-goal-objective', ' pause ');
    expect(button('omo-goal-set').disabled).toBe(true);
    await fill('omo-goal-objective', 'New native objective');
    expect(button('omo-goal-set').disabled).toBe(false);
    await click('omo-goal-set');
    await click('omo-goal-set');
    expect(fixture.commands.map((envelope) => envelope.command)).toEqual([{ type: 'goalSet', objective: 'New native objective' }]);
    expect(query('omo-goal-value')?.textContent).toContain(panelSnapshot().goal.value?.objective);
  });

  test('does not expose goal mutation for a prompt named goal', async () => {
    const snapshot = panelSnapshot();
    await attach({ ...snapshot, state: { ...snapshot.state, commands: [{ name: 'goal', source: 'prompt' }] } });
    expect(button('omo-goal-pause').disabled).toBe(true);
    expect(button('omo-goal-clear').disabled).toBe(true);
  });

  test('renders blocked reason and never offers manual complete or blocked actions', async () => {
    const snapshot = panelSnapshot();
    assert(snapshot.goal.value);
    await attach({ ...snapshot, goal: { status: 'ready', value: { ...snapshot.goal.value, status: 'blocked', blockedReason: 'SOURCE_BLOCKER', blockedAt: 2 } } });
    expect(query('omo-goal-value')?.textContent).toContain('SOURCE_BLOCKER');
    expect(button('omo-goal-resume').disabled).toBe(false);
    expect(container.querySelector('[data-testid="omo-goal-complete"],[data-testid="omo-goal-block"]')).toBeNull();
  });

  test('filters foreign-parent tasks before exposing any native controls', async () => {
    await attach({ ...panelSnapshot(), tasks: { status: 'ready', value: [{ ...taskFixture, parentSessionId: 'foreign' }] } });
    expect(container.querySelector('[data-task-id]')).toBeNull();
    expect(query('omo-tasks-empty')).not.toBeNull();
  });

  test('routes task send once and retains recorded state until a native projection arrives', async () => {
    await attach();
    await fill('omo-task-message', ' ');
    expect(button('omo-task-send').disabled).toBe(true);
    await fill('omo-task-message', 'Inspect the last output');
    await click('omo-task-send');
    expect(fixture.commands.map((envelope) => envelope.command)).toEqual([{ type: 'taskSend', taskId: 'task-a', message: 'Inspect the last output' }]);
    expect(container.querySelector('[data-task-id] [data-recorded-status]')?.getAttribute('data-recorded-status')).toBe('running');
  });

  test('routes task cancellation without replacing the recorded task status', async () => {
    await attach();
    await click('omo-task-cancel');
    expect(fixture.commands.map((envelope) => envelope.command)).toEqual([{ type: 'taskCancel', taskId: 'task-a' }]);
    expect(container.querySelector('[data-task-id] [data-recorded-status]')?.getAttribute('data-recorded-status')).toBe('running');
  });

  for (const { id, mode, tailLines } of [
    { id: 'omo-task-output-status', mode: 'status', tailLines: undefined },
    { id: 'omo-task-output-tail', mode: 'tail', tailLines: 60 },
    { id: 'omo-task-output-full', mode: 'full', tailLines: undefined },
  ]) {
  test(`reads ${mode} output through the parent-scoped client and marks truncation`, async () => {
    await attach();
    await click(id);
    expect(fixture.outputCalls).toEqual([{ path: '/api/omo/sessions/session-a/tasks/task-a/output', mode, tailLines }]);
    expect(query('omo-task-output')?.textContent).toContain('NATIVE_OUTPUT');
    expect(query('omo-task-output-truncated')).not.toBeNull();
  });
  }

  test('retains previously read task output on a subsequent read failure', async () => {
    await attach();
    await click('omo-task-output-tail');
    fixture.setOutputReader(async () => new Response(null, { status: 503 }));
    await click('omo-task-output-full');
    expect(query('omo-task-output')?.textContent).toContain('NATIVE_OUTPUT');
    expect(query('omo-task-output-retained')).not.toBeNull();
    expect(query('omo-task-output-error')).not.toBeNull();
  });

  test('correlated command failure remains visible without replay or fake success', async () => {
    await attach();
    await click('omo-goal-pause');
    await act(async () => { await fixture.settle(fixture.commands[0], false); });
    expect(container.querySelector('[data-action-state="failed"]')).not.toBeNull();
    expect(fixture.commands).toHaveLength(1);
    expect(query('omo-goal-value')?.querySelector('[data-recorded-status]')?.getAttribute('data-recorded-status')).toBe('active');
  });

  test('epoch loss marks a submitted action uncertain without replay', async () => {
    await attach();
    await click('omo-goal-pause');
    await act(async () => { await fixture.publish({ ...panelSnapshot(), revision: 2, connectionEpoch: 2 }); });
    expect(container.querySelector('[data-action-state="uncertain"]')).not.toBeNull();
    expect(fixture.commands).toHaveLength(1);
  });

  test('session switching discards task output and drafts owned by the old panel', async () => {
    await attach();
    await fill('omo-goal-objective', 'OLD_DRAFT');
    await click('omo-task-output-full');
    await render(null);
    await render();
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="omo-goal-objective"]')?.value).toBe('');
    expect(query('omo-task-output')).toBeNull();
  });

  test('unrelated text deltas do not commit any panel render', async () => {
    await attach();
    commits.length = 0;
    await act(async () => { await fixture.delta(2); });
    expect(commits).toEqual([]);
  });

  test('reactive locale updates preserve the goal draft and selected session', async () => {
    await attach();
    await fill('omo-goal-objective', 'PRESERVED_DRAFT');
    await act(async () => useI18nStore.setState({ dictionary: { ...dictionary, 'common.loading': 'LOCALE_SENTINEL' } }));
    expect(commits.length).toBeGreaterThan(1);
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="omo-goal-objective"]')?.value).toBe('PRESERVED_DRAFT');
    expect(fixture.store.getState().selectedSessionKey).toBe('session-a');
  });

  test('a task read completing after unmount cannot leak into the newly selected panel', async () => {
    await attach();
    let deliver: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { deliver = resolve; });
    fixture.setOutputReader(() => pending);
    await click('omo-task-output-full');
    await render(null);
    await render();
    assert(deliver);
    const deliverResult = deliver;
    await act(async () => deliverResult(Response.json({ task: taskFixture, output: 'STALE_RESULT', truncated: false })));
    expect(query('omo-task-output')).toBeNull();
  });
});
