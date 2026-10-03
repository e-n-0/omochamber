import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { nativeHarness, mount } from '../chat/chatTestFixture';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { NativeProject, SessionSummary } from '../contracts';
import { NativeNavigation, type NativeNavigationProps } from './NativeNavigation';
import { NativeSessionSidebar } from './NativeSessionSidebar';

const projects: readonly NativeProject[] = [
  { id: 'project-a', name: 'Workspace', path: '/workspace', worktreePaths: ['/worktree', '/worktree'] },
  { id: 'project-b', name: 'Other', path: '/other' },
];
const sessions: readonly SessionSummary[] = [
  { sessionKey: 'chat-a', durableSessionId: 'shared-id', directory: '/workspace', name: 'Historical name', ownership: 'hosted', connection: 'connected' },
  { sessionKey: 'terminal/key', durableSessionId: 'shared-id', directory: '/worktree', name: 'Terminal', ownership: 'terminal', connection: 'unavailable' },
  { sessionKey: 'reopen/key', durableSessionId: 'third-id', directory: '/outside', name: 'Reopen', ownership: 'offline', connection: 'unavailable' },
];

test('opens each original project menu and invokes its supplied action once before closing', async () => {
  const harness = nativeHarness();
  await harness.select();
  const invoked: string[] = [];
  let selections = 0;
  const view = await mount(<NativeNavigation projects={projects} sessions={sessions} store={harness.store}
    projectId="project-a" directory="/workspace" sessionKey="chat-a" loading={false} error={null}
    creating={false} canCreate onCreate={() => {}} onSelect={() => {}} onRefresh={() => {}}
    onProjectSelect={() => selections++}
    projectActions={(project) => <DropdownMenuItem onSelect={() => invoked.push(project.id)}>Rename</DropdownMenuItem>} />);
  try {
    for (const [index, project] of projects.entries()) {
      const trigger = view.host.querySelector(`[data-native-project="${project.id}"] [data-slot="dropdown-menu-trigger"]`);
      assert(trigger instanceof HTMLButtonElement);
      expect(trigger.getAttribute('aria-expanded')).not.toBe('true');
      expect(document.querySelector('[role="menu"]')).toBeNull();

      await act(async () => {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        trigger.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        trigger.click();
      });
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      const popupId = trigger.getAttribute('aria-controls');
      assert(popupId, 'The original project trigger must identify its portaled menu');
      const menu = document.getElementById(popupId);
      assert(menu instanceof HTMLElement);
      expect(menu.getAttribute('role')).toBe('menu');
      expect(view.host.contains(menu)).toBe(false);
      const action = menu.querySelector('[role="menuitem"]');
      assert(action instanceof HTMLElement);
      expect(invoked).toHaveLength(index);
      for (const other of projects.filter((item) => item.id !== project.id)) {
        expect(view.host.querySelector(`[data-native-project="${other.id}"] [data-slot="dropdown-menu-trigger"]`)
          ?.getAttribute('aria-expanded')).not.toBe('true');
      }

      await act(async () => action.focus());
      await act(async () => action.click());
      expect(invoked).toEqual(projects.slice(0, index + 1).map((item) => item.id));
      expect(trigger.getAttribute('aria-expanded')).not.toBe('true');
      expect(document.querySelector('[role="menu"]')).toBeNull();
    }
    expect(selections).toBe(0);
    expect(view.host.querySelectorAll('[data-session-key]')).toHaveLength(sessions.length);
    expect(harness.commands).toHaveLength(0);
  } finally {
    await view.cleanup();
    await harness.cleanup();
  }
});

test('groups registered directories with one actionable selector per native session', async () => {
  // Given
  const harness = nativeHarness();
  await harness.select();
  const selected: string[] = [];
  const props: NativeNavigationProps = {
    projects, sessions, store: harness.store, projectId: 'project-a', directory: '/worktree', sessionKey: 'chat-a',
    loading: false, error: null, creating: false, canCreate: true,
    onCreate: () => {}, onSelect: (session) => selected.push(session.sessionKey),
    onRefresh: () => {}, onProjectSelect: () => {},
  };
  const view = await mount(<NativeNavigation {...props} />);
  try {
    // When
    expect(view.host.querySelectorAll('[data-session-key]')).toHaveLength(sessions.length);
    for (const session of sessions) {
      const targets = view.host.querySelectorAll(`[data-session-key="${session.sessionKey}"]`);
      expect(targets).toHaveLength(1);
      const target = targets[0];
      assert(target instanceof HTMLButtonElement);
      expect(target.closest('[data-session-row]')?.getAttribute('data-session-row')).toBe(session.sessionKey);
      await act(async () => target.click());
    }
    // Then
    expect(selected).toEqual(sessions.map((session) => session.sessionKey));
    expect(view.host.querySelectorAll('.oc-group')).toHaveLength(3);
    expect(view.host.querySelector('[data-native-project="project-b"] [data-session-row]')).toBeNull();
    expect(view.host.querySelector('[data-session-row="reopen/key"]')?.closest('[data-native-project]')).toBeNull();
    expect(view.host.querySelector('[data-session-row="chat-a"]')?.getAttribute('aria-current')).toBe('page');
    expect(view.host.querySelector('[data-session-row="terminal/key"]')?.getAttribute('aria-current')).toBeNull();
    expect(view.host.querySelector('[data-session-row="chat-a"]')?.textContent).toContain('test');
    expect(view.host.querySelector('[data-session-row="chat-a"]')?.textContent).not.toContain('Historical name');
    expect(view.host.querySelector('[data-session-ownership="terminal"]')).not.toBeNull();
    expect(view.host.querySelector('[data-session-ownership="offline"]')).not.toBeNull();
    expect(harness.commands).toHaveLength(0);
  } finally {
    await view.cleanup();
    await harness.cleanup();
  }
});

test('preserves prior inventory and selection when a refresh fails', async () => {
  // Given
  const harness = nativeHarness();
  await harness.select();
  const props: NativeNavigationProps = {
    projects, sessions, store: harness.store, projectId: 'project-a', directory: '/workspace', sessionKey: 'chat-a',
    loading: false, error: null, creating: false, canCreate: true,
    onCreate: () => {}, onSelect: () => {}, onRefresh: () => {}, onProjectSelect: () => {},
  };
  const view = await mount(<NativeNavigation {...props} />);
  try {
    // When
    await view.render(<NativeNavigation {...props} error={new Error('Refresh failed')} />);
    // Then
    expect(view.host.querySelectorAll('[data-session-row]')).toHaveLength(3);
    expect(view.host.querySelectorAll('[data-native-project]')).toHaveLength(2);
    expect(view.host.querySelector('[data-session-row="chat-a"]')?.getAttribute('aria-current')).toBe('page');
    expect(view.host.querySelectorAll('[role="alert"]')).toHaveLength(1);
  } finally {
    await view.cleanup();
    await harness.cleanup();
  }
});

test('selects the registered worktree through its directory header', async () => {
  // Given
  const harness = nativeHarness();
  await harness.select();
  const selected: Array<{ project: NativeProject; directory: string }> = [];
  const view = await mount(<NativeNavigation projects={projects} sessions={sessions} store={harness.store}
    projectId="project-a" directory="/workspace" sessionKey="chat-a" loading={false} error={null}
    creating={false} canCreate onCreate={() => {}} onSelect={() => {}} onRefresh={() => {}}
    onProjectSelect={(project, directory) => selected.push({ project, directory })} />);
  try {
    // When
    const worktree = view.host.querySelectorAll('[data-native-project="project-a"] .oc-group [role="button"]')[1];
    assert(worktree instanceof HTMLElement);
    await act(async () => worktree.click());
    // Then
    expect(selected).toEqual([{ project: projects[0], directory: '/worktree' }]);
    expect(view.host.querySelector('[data-session-row="terminal/key"]')).toBeNull();
    expect(view.host.querySelector('[data-session-row="chat-a"]')).not.toBeNull();
  } finally {
    await view.cleanup();
    await harness.cleanup();
  }
});

test('preserves the established standalone create callback and disablement', async () => {
  // Given
  const harness = nativeHarness();
  await harness.select();
  let creates = 0;
  const props = {
    sessions, store: harness.store, sessionKey: 'chat-a', loading: false, error: null,
    creating: false, canCreate: true, onCreate: () => creates++, onSelect: () => {}, onRefresh: () => {},
  };
  const view = await mount(<NativeSessionSidebar {...props} />);
  try {
    // When
    const create = view.host.querySelector('[data-testid="omo-new-session"]');
    assert(create instanceof HTMLButtonElement);
    await act(async () => create.click());
    await view.render(<NativeSessionSidebar {...props} creating />);
    await act(async () => create.click());
    // Then
    expect(creates).toBe(1);
    expect(create.disabled).toBe(true);
  } finally {
    await view.cleanup();
    await harness.cleanup();
  }
});

test('routes original project and directory create actions to explicit native context', async () => {
  const harness = nativeHarness();
  await harness.select();
  const creates: Array<{ project: NativeProject; directory: string }> = [];
  let currentDirectoryCreates = 0;
  let selections = 0;
  const props: NativeNavigationProps = {
    projects, sessions, store: harness.store, projectId: 'project-b', directory: '/other',
    sessionKey: 'terminal/key', loading: false, error: null, creating: false, canCreate: true,
    onCreate: () => currentDirectoryCreates++, onSelect: () => {}, onRefresh: () => {},
    onProjectSelect: () => selections++,
    onCreateInDirectory: (project, directory) => creates.push({ project, directory }),
  };
  const view = await mount(<NativeNavigation {...props} />);
  try {
    const project = view.host.querySelector('[data-native-project="project-a"]');
    assert(project);
    const projectCreate = project.querySelectorAll('[data-sidebar-sticky-header] button')[1];
    const worktreeHeader = project.querySelectorAll('.oc-group [role="button"]')[1];
    const worktreeCreate = worktreeHeader?.parentElement?.querySelector('button');
    assert(projectCreate instanceof HTMLButtonElement && worktreeCreate instanceof HTMLButtonElement);
    await act(async () => { projectCreate.click(); worktreeCreate.click(); });
    expect(creates).toEqual([
      { project: projects[0], directory: '/workspace' },
      { project: projects[0], directory: '/worktree' },
    ]);
    expect([currentDirectoryCreates, selections]).toEqual([0, 0]);
    expect(view.host.querySelector('[data-session-row="terminal/key"]')).not.toBeNull();

    await view.render(<NativeNavigation {...props} creating />);
    await act(async () => { projectCreate.click(); worktreeCreate.click(); });
    expect(projectCreate.disabled && worktreeCreate.disabled).toBe(true);
    expect(creates).toHaveLength(2);

    await view.render(<NativeNavigation {...props} canCreate={false} />);
    await act(async () => { projectCreate.click(); worktreeCreate.click(); });
    expect(projectCreate.disabled && worktreeCreate.disabled).toBe(true);
    expect(creates).toHaveLength(2);
  } finally {
    await view.cleanup();
    await harness.cleanup();
  }
});

test('omits unbound directory creation without hiding prior native inventory', async () => {
  const harness = nativeHarness();
  await harness.select();
  let creates = 0;
  const view = await mount(<NativeNavigation projects={projects} sessions={sessions} store={harness.store}
    projectId="project-a" directory="/workspace" sessionKey="chat-a" loading error={new Error('Inventory unavailable')}
    creating={false} canCreate onCreate={() => creates++} onSelect={() => {}} onRefresh={() => {}}
    onProjectSelect={() => {}} />);
  try {
    const project = view.host.querySelector('[data-native-project="project-a"]');
    assert(project);
    expect(project.querySelectorAll('[data-sidebar-sticky-header] button')).toHaveLength(1);
    for (const header of project.querySelectorAll('.oc-group [role="button"]')) {
      expect(header.parentElement?.querySelector('button')).toBeNull();
    }
    expect(view.host.querySelectorAll('[data-session-row]')).toHaveLength(sessions.length);
    expect(view.host.querySelector('[data-session-row="reopen/key"]')).not.toBeNull();
    expect(view.host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(creates).toBe(0);
  } finally {
    await view.cleanup();
    await harness.cleanup();
  }
});
