import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { createChangesWorkspace, type ChangesWorkspace } from './changes';
import { createWorkspaceClient } from './workspace';

// Shared primitives establish their DOM mode when imported.
const initialWindow = new Window();
Object.assign(globalThis, { window: initialWindow, document: initialWindow.document });
const { NativeWorktrees } = await import('./NativeWorktrees');

function observe(workspace: ChangesWorkspace, predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Worktree state did not settle')); }, 5_000);
    const unsubscribe = workspace.subscribe(() => {
      if (!predicate()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

describe('native visible worktree conflict state', () => {
  let dom: Window;
  let root: Root;
  let original: Map<string, PropertyDescriptor | undefined>;
  beforeEach(() => {
    dom = new Window();
    original = new Map();
    for (const [key, value] of Object.entries({
      window: dom, document: dom.document, navigator: dom.navigator,
      Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
      Event: dom.Event, MouseEvent: dom.MouseEvent, CustomEvent: dom.CustomEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    })) {
      original.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
  });

  for (const code of ['worktree_dirty', 'directory_in_use']) test(`${code} remains visible with the worktree and no project-change callback`, async () => {
    const tree = { name: 'qa', path: '/owned/qa', head: 'abc', branch: 'qa' };
    let projectChanges = 0;
    let removals = 0;
    const workspace = createChangesWorkspace(createWorkspaceClient('/project', async (path, options) => {
      if (options?.method === 'DELETE') {
        removals++;
        return Response.json({ error: code, code }, { status: 409 });
      }
      if (path.endsWith('/projects')) return Response.json([{ id: 'p', path: '/project', name: 'P', worktreePaths: [tree.path] }]);
      return Response.json([tree]);
    }));
    await workspace.refreshWorktrees();
    await act(async () => root.render(<I18nProvider><NativeWorktrees workspace={workspace} onProjectsChange={() => { projectChanges++; }} /></I18nProvider>));
    const remove = document.querySelector<HTMLButtonElement>('[data-testid="omo-worktree-remove"]');
    expect(remove).not.toBeNull();
    await act(async () => remove?.click());
    const settled = observe(workspace, () => workspace.getWorktrees().error !== null && !workspace.isBusy());
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="omo-worktree-remove-confirm"]')?.click();
      await settled;
    });
    const alert = document.querySelector('[data-testid="omo-worktree-error"]');
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert?.textContent).toContain('409');
    expect(alert?.textContent).toContain(code);
    expect(document.querySelectorAll('li')).toHaveLength(1);
    expect(document.querySelector('[data-testid="omo-worktree-remove-confirm"]')).not.toBeNull();
    expect(projectChanges).toBe(0);
    expect(removals).toBe(1);
  });
});
