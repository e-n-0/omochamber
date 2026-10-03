import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { mount } from '../chat/chatTestFixture';
import { HeaderView } from '@/components/layout/HeaderView';
import { HeaderTitleView } from '@/components/layout/HeaderTitleView';
import { TitlebarLeftControlsView } from '@/components/layout/TitlebarLeftControlsView';
import { SidebarView } from '@/components/layout/SidebarView';
import { ProjectHeaderView } from '@/components/session/sidebar/projects/ProjectHeaderView';
import { DirectoryLabelView } from '@/components/session/sidebar/projects/DirectoryLabelView';
import { DirectoryNewSessionView, SessionGroupView } from '@/components/session/sidebar/projects/DirectoryHeaderView';
import { SessionRowView, SessionRowButtonView, SessionRowTitleView, SessionRowActionsView } from '@/components/session/sidebar/sessions/SessionRowView';

describe('original navigation presentation', () => {
  test('routes header slots through the original desktop chrome', async () => {
    // Given
    let newSessions = 0;
    const view = await mount(<HeaderView insetWidth={20} controlsWidth={64}
      actions={<button onClick={() => newSessions++}>New</button>}>
      <HeaderTitleView title="Existing session" metadata={<span>/workspace</span>} />
    </HeaderView>);
    try {
      // When
      const action = view.host.querySelector('button');
      assert(action);
      await act(async () => action.click());
      // Then
      expect(newSessions).toBe(1);
      expect(view.host.querySelector('[role="tablist"]')?.textContent).toContain('Existing session');
      expect(view.host.querySelector('.typography-micro')?.textContent).toBe('/workspace');
    } finally {
      await view.cleanup();
    }
  });

  test('keeps titlebar actions available when the sidebar closes', async () => {
    // Given
    let toggles = 0;
    let creates = 0;
    const props = { onToggleSidebar: () => toggles++, onNewSession: () => creates++ };
    const view = await mount(<TitlebarLeftControlsView {...props} isSidebarOpen />);
    try {
      // When
      const toggle = view.host.querySelector('button');
      assert(toggle);
      await act(async () => toggle.click());
      await view.render(<TitlebarLeftControlsView {...props} isSidebarOpen={false} />);
      const create = view.host.querySelectorAll('button')[1];
      assert(create);
      await act(async () => create.click());
      // Then
      expect([toggles, creates]).toEqual([1, 1]);
    } finally {
      await view.cleanup();
    }
  });

  test('keeps native new-session disablement at the titlebar action', async () => {
    // Given
    let creates = 0;
    const view = await mount(<TitlebarLeftControlsView isSidebarOpen={false}
      onToggleSidebar={() => {}} onNewSession={() => creates++} newSessionDisabled />);
    try {
      // When
      const create = view.host.querySelectorAll('button')[1];
      assert(create);
      await act(async () => create.click());
      // Then
      expect(create.disabled).toBe(true);
      expect(creates).toBe(0);
    } finally {
      await view.cleanup();
    }
  });

  test('preserves controlled desktop width', async () => {
    // Given
    const props = { isOpen: true, isMobile: false, width: 280, onWidthChange: () => {} };
    const view = await mount(<SidebarView {...props} topBar={<span>Top</span>}><span>Rows</span></SidebarView>);
    try {
      // When
      await view.render(<SidebarView {...props} width={340} topBar={<span>Top</span>}><span>Rows</span></SidebarView>);
      // Then
      expect(view.host.querySelector<HTMLElement>('aside')?.style.width).toBe('340px');
    } finally {
      await view.cleanup();
    }
  });

  test('leaves the mobile sidebar to its existing layout owner', async () => {
    // Given
    const view = await mount(<SidebarView isOpen isMobile width={280} onWidthChange={() => {}}><span data-mobile-row>Rows</span></SidebarView>);
    try {
      // When
      const aside = view.host.querySelector('aside');
      // Then
      expect(aside).toBeNull();
      expect(view.host.querySelector('[data-mobile-row]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test('routes the original project toggle and create controls independently', async () => {
    // Given
    let toggles = 0;
    let creates = 0;
    const view = await mount(<ProjectHeaderView id="project" projectLabel="Workspace" projectDescription="/workspace"
      isCollapsed={false} hideDirectoryControls alwaysShowActions
      handleToggleClick={() => toggles++} onNewSession={() => creates++} />);
    try {
      // When
      const buttons = view.host.querySelectorAll('button');
      assert(buttons[0] && buttons[1]);
      await act(async () => { buttons[0].click(); buttons[1].click(); });
      // Then
      expect([toggles, creates]).toEqual([1, 1]);
    } finally {
      await view.cleanup();
    }
  });

  test('keeps group rows until the owner commits a collapse', async () => {
    // Given
    let toggles = 0;
    const props = { name: '/workspace', collapsed: false, onToggle: () => toggles++,
      label: <DirectoryLabelView label="workspace" /> };
    const view = await mount(<SessionGroupView {...props}><span data-row>Row</span></SessionGroupView>);
    try {
      // When
      const toggle = view.host.querySelector('[role="button"]');
      assert(toggle instanceof HTMLElement);
      await act(async () => toggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
      // Then
      expect(toggles).toBe(1);
      expect(view.host.querySelector('[data-row]')).not.toBeNull();
      await view.render(<SessionGroupView {...props} collapsed><span data-row>Row</span></SessionGroupView>);
      expect(view.host.querySelector('[data-row]')).toBeNull();
      expect(view.host.querySelector('[role="button"]')?.getAttribute('aria-expanded')).toBe('false');
    } finally {
      await view.cleanup();
    }
  });

  test('keeps directory creation separate from collapse and honors disablement', async () => {
    let creates = 0;
    let toggles = 0;
    const render = (disabled: boolean) => <SessionGroupView name="/workspace" collapsed={false}
      label={<DirectoryLabelView label="workspace" />} onToggle={() => toggles++}
      actions={<DirectoryNewSessionView label="workspace" disabled={disabled} onNewSession={() => creates++} />}>
      <span data-row>Row</span>
    </SessionGroupView>;
    const view = await mount(render(false));
    try {
      const create = view.host.querySelector('button');
      assert(create);
      await act(async () => create.click());
      await view.render(render(true));
      await act(async () => create.click());
      expect(creates).toBe(1);
      expect(toggles).toBe(0);
      expect(create.disabled).toBe(true);
      expect(view.host.querySelector('[data-row]')).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test('disables the original project create action without disabling its toggle', async () => {
    let creates = 0;
    let toggles = 0;
    const view = await mount(<ProjectHeaderView id="project" projectLabel="Workspace"
      projectDescription="/workspace" isCollapsed={false} hideDirectoryControls alwaysShowActions
      newSessionDisabled handleToggleClick={() => toggles++} onNewSession={() => creates++} />);
    try {
      const buttons = view.host.querySelectorAll('button');
      assert(buttons[0] && buttons[1]);
      await act(async () => { buttons[0].click(); buttons[1].click(); });
      expect([toggles, creates]).toEqual([1, 0]);
      expect(buttons[1].disabled).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  test('keeps row selection separate from its trailing action', async () => {
    // Given
    let selections = 0;
    let actions = 0;
    const view = await mount(<SessionRowView sessionId="opaque/key" active>
      <div className="flex min-w-0 flex-1 items-center">
        <SessionRowButtonView onClick={() => selections++}><SessionRowTitleView title="Session" active /></SessionRowButtonView>
      </div>
      <SessionRowActionsView alwaysShow><button onClick={() => actions++}>Action</button></SessionRowActionsView>
    </SessionRowView>);
    try {
      // When
      const buttons = view.host.querySelectorAll('button');
      assert(buttons[0] && buttons[1]);
      await act(async () => { buttons[0].click(); buttons[1].click(); });
      // Then
      expect([selections, actions]).toEqual([1, 1]);
      expect(view.host.querySelector('[data-session-row]')?.getAttribute('data-session-row')).toBe('opaque/key');
      expect(view.host.querySelector('[data-session-row]')?.getAttribute('aria-current')).toBe('page');
    } finally {
      await view.cleanup();
    }
  });
});
