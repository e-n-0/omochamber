import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { act } from 'react';
import { WorkStatusFrame } from '@/components/chat/work-status/WorkStatusFrame';
import { mount } from '../chat/chatTestFixture';
import { createPanelFixture, panelSnapshot } from './panel-fixture';
import { NativeWorkStatusPanel } from './NativeWorkStatusPanel';

function changed(predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const timeout = AbortSignal.timeout(2000);
    const cleanup = () => { observer.disconnect(); timeout.removeEventListener('abort', expired); };
    const expired = () => { cleanup(); reject(new Error('Work-card transition did not complete')); };
    const observer = new MutationObserver(() => {
      if (predicate()) { cleanup(); resolve(); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timeout.addEventListener('abort', expired, { once: true });
    if (predicate()) { cleanup(); resolve(); }
  });
}

test('renders native section siblings in the original work-card scroller without legacy settings', async () => {
  // Given an authoritative native session and the controlled card.
  const fixture = createPanelFixture();
  await act(async () => { await fixture.store.selectSession('session-a'); });
  const view = await mount(<NativeWorkStatusPanel client={fixture.client} store={fixture.store} sessionKey="session-a" visible />);
  try {
    // When the original card is rendered from native projections.
    const sections = [...view.host.querySelectorAll('section[data-testid$="-panel"]')];
    // Then all four sections are direct siblings in the original ScrollShadow.
    expect(sections.map((section) => section.getAttribute('data-testid'))).toEqual([
      'omo-goal-panel', 'omo-tasks-panel', 'omo-todo-panel', 'omo-dags-panel',
    ]);
    const scroller = sections[0]?.parentElement;
    expect(scroller?.classList.contains('oc-hide-scrollbar')).toBe(true);
    expect(sections.every((section) => section.parentElement === scroller)).toBe(true);
    expect(view.host.querySelector('aside')?.classList.contains('rounded-xl')).toBe(true);
    expect(view.host.querySelector('[data-work-status-heading]')).not.toBeNull();
    expect(view.host.querySelector('aside > div > button')).toBeNull();
    expect(fixture.commands).toEqual([]);
  } finally { await view.cleanup(); await fixture.dispose(); }
});

test('makes a closed card inert immediately while retained sections follow native ownership', async () => {
  // Given a visible card with mounted native sections.
  const fixture = createPanelFixture();
  await act(async () => { await fixture.store.selectSession('session-a'); });
  const render = (visible: boolean) => <NativeWorkStatusPanel client={fixture.client} store={fixture.store} sessionKey="session-a" visible={visible} />;
  const view = await mount(render(true));
  try {
    const goal = view.host.querySelector('[data-testid="omo-goal-panel"]');
    const tasks = view.host.querySelector('[data-testid="omo-tasks-panel"]');
    assert(goal && tasks);
    // When visibility closes, native drafts stay mounted behind an inert frame.
    mock.timers.enable({ apis: ['setTimeout'] });
    await view.render(render(false));
    expect(view.host.querySelector('aside')?.hasAttribute('inert')).toBe(true);
    expect(view.host.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => { mock.timers.tick(200); });
    expect(view.host.querySelector('[data-testid="omo-goal-panel"]') === goal).toBe(true);
    expect(view.host.querySelector('[data-testid="omo-tasks-panel"]') === tasks).toBe(true);
    // Hidden sections still consume authoritative ownership, not stale permissions.
    await act(async () => { await fixture.publish({ ...panelSnapshot(), revision: 2, ownership: 'terminal' }); });
    expect(view.host.querySelector('[data-testid="omo-panels-readonly"]')).not.toBeNull();
    expect(view.host.querySelector<HTMLTextAreaElement>('[data-testid="omo-goal-objective"]')?.disabled).toBe(true);
    expect(view.host.querySelector<HTMLTextAreaElement>('[data-testid="omo-task-message"]')?.disabled).toBe(true);
    await view.render(render(true));
    expect(view.host.querySelector('[data-testid="omo-goal-panel"]') === goal).toBe(true);
    expect(view.host.querySelector('[data-testid="omo-tasks-panel"]') === tasks).toBe(true);
    expect(view.host.querySelector('aside')?.hasAttribute('inert')).toBe(false);
    expect(fixture.commands).toEqual([]);
  } finally {
    mock.timers.reset();
    await view.cleanup(); await fixture.dispose();
  }
});

test('preserves the original frame default delayed unmount lifecycle', async () => {
  const render = (visible: boolean) => (
    <WorkStatusFrame sessionKey="legacy-session" visible={visible} overlay={false}>
      <input data-testid="legacy-work-content" />
    </WorkStatusFrame>
  );
  const view = await mount(render(false));
  try {
    expect(view.host.querySelector('[data-testid="legacy-work-content"]')).toBeNull();
    await view.render(render(true));
    const content = view.host.querySelector('[data-testid="legacy-work-content"]');
    assert(content);
    mock.timers.enable({ apis: ['setTimeout'] });
    const removed = changed(() => !view.host.querySelector('[data-testid="legacy-work-content"]'));
    await view.render(render(false));
    expect(view.host.querySelector('aside')?.hasAttribute('inert')).toBe(true);
    expect(view.host.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    await act(async () => { mock.timers.tick(199); });
    expect(view.host.querySelector('[data-testid="legacy-work-content"]') === content).toBe(true);
    await act(async () => { mock.timers.tick(1); });
    await removed;
    expect(view.host.querySelector('[data-testid="legacy-work-content"]')).toBeNull();
    await view.render(render(true));
    const reopened = view.host.querySelector('[data-testid="legacy-work-content"]');
    assert(reopened);
    expect(reopened === content).toBe(false);
    expect(view.host.querySelector('aside')?.hasAttribute('inert')).toBe(false);
  } finally {
    mock.timers.reset();
    await view.cleanup();
  }
});

test('keeps initially hidden retained frames inert despite an interactive override', async () => {
  // Given retained content in a frame that starts hidden.
  let dismissals = 0;
  const render = (visible: boolean) => (
    <WorkStatusFrame sessionKey="retained-session" visible={visible} overlay interactive retainContent
      onDismiss={() => { dismissals += 1; }}>
      <input data-testid="retained-work-content" />
    </WorkStatusFrame>
  );
  const view = await mount(render(false));
  try {
    const content = view.host.querySelector('[data-testid="retained-work-content"]');
    assert(content);
    // When the hidden frame outlives its collapse transition.
    mock.timers.enable({ apis: ['setTimeout'] });
    expect(view.host.querySelector('aside')?.hasAttribute('inert')).toBe(true);
    expect(view.host.querySelector('aside')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.host.querySelector('aside')?.style.pointerEvents).toBe('none');
    expect(view.host.querySelector('aside')?.style.opacity).toBe('0');
    await act(async () => { mock.timers.tick(200); });
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    // Then content stays mounted without hidden overlay listeners.
    expect(view.host.querySelector('[data-testid="retained-work-content"]') === content).toBe(true);
    expect(dismissals).toBe(0);
    await view.render(render(true));
    expect(view.host.querySelector('[data-testid="retained-work-content"]') === content).toBe(true);
    expect(view.host.querySelector('aside')?.hasAttribute('inert')).toBe(false);
  } finally {
    mock.timers.reset();
    await view.cleanup();
  }
});

test('preserves exact native drafts and output instances across collapse and placement changes', async () => {
  const fixture = createPanelFixture();
  await act(async () => { await fixture.store.selectSession('session-a'); });
  const render = (visible: boolean, overlay = false) => (
    <NativeWorkStatusPanel client={fixture.client} store={fixture.store} sessionKey="session-a" visible={visible} overlay={overlay} />
  );
  const view = await mount(render(true));
  try {
    const objective = view.host.querySelector<HTMLTextAreaElement>('[data-testid="omo-goal-objective"]');
    const message = view.host.querySelector<HTMLTextAreaElement>('[data-testid="omo-task-message"]');
    const readOutput = view.host.querySelector<HTMLButtonElement>('[data-testid="omo-task-output-tail"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    assert(objective && message && readOutput && setter);
    const objectiveDraft = '  Native objective draft\npreserve spacing  ';
    const messageDraft = '  Native task message\npreserve spacing  ';
    await act(async () => {
      setter.call(objective, objectiveDraft);
      objective.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(message, messageDraft);
      message.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const loaded = changed(() => !!view.host.querySelector('[data-testid="omo-task-output"]'));
    await act(async () => { readOutput.click(); });
    await loaded;
    const output = view.host.querySelector('[data-testid="omo-task-output"]');
    assert(output);
    const outputText = output.textContent;
    expect(outputText).toContain('NATIVE_OUTPUT');

    mock.timers.enable({ apis: ['setTimeout'] });
    // Hiding also models yielding to context; changing placement must not remount sections.
    for (const [visible, overlay] of [[false, false], [true, false], [true, true], [false, true], [false, false], [true, false]]) {
      await view.render(render(visible, overlay));
      expect(view.host.querySelector('aside')?.hasAttribute('inert')).toBe(!visible);
      expect(view.host.querySelector('aside')?.getAttribute('aria-hidden')).toBe(String(!visible));
      await act(async () => { mock.timers.tick(200); });
      expect(view.host.querySelector('[data-testid="omo-goal-objective"]') === objective).toBe(true);
      expect(view.host.querySelector('[data-testid="omo-task-message"]') === message).toBe(true);
      expect(objective.value).toBe(objectiveDraft);
      expect(message.value).toBe(messageDraft);
      expect(view.host.querySelector('[data-testid="omo-task-output"]') === output).toBe(true);
      expect(output.textContent).toBe(outputText);
    }
    expect(fixture.outputCalls).toHaveLength(1);
    expect(fixture.commands).toEqual([]);
  } finally {
    mock.timers.reset();
    await view.cleanup(); await fixture.dispose();
  }
});

test('keeps controlled overlay dismissal with editor and menu Escape owners', async () => {
  // Given an overlay and a native session with authoritative goal data.
  const fixture = createPanelFixture();
  fixture.setSnapshot(panelSnapshot());
  await act(async () => { await fixture.store.selectSession('session-a'); });
  let dismissals = 0;
  const view = await mount(<NativeWorkStatusPanel client={fixture.client} store={fixture.store} sessionKey="session-a"
    visible overlay onDismiss={() => { dismissals += 1; }} />);
  const editor = document.createElement('div');
  editor.className = 'cm-editor';
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  document.body.append(editor, menu);
  try {
    // When Escape is owned by an editor or a portalled menu.
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Then the overlay stays open; a free Escape reports dismissal to its parent.
    expect(dismissals).toBe(0);
    await act(async () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(dismissals).toBe(1);
  } finally {
    editor.remove(); menu.remove();
    await view.cleanup(); await fixture.dispose();
  }
});
