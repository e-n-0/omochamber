import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { EditorView } from '@codemirror/view';
import { browser, click, mount } from '../chat/chatTestFixture';
import { createNativeClient } from '../client';
import { createNativeDesktopCapabilities, type NativeDesktopBridge } from '../desktop/adapter';
import { NativeDesktopContext } from '../desktop/context';

const { NativeFiles } = await import('./NativeFiles');
const { OmoAppearanceProvider } = await import('../AppearanceProvider');

function observe(predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const timeout = AbortSignal.timeout(2_000);
    const cleanup = () => { observer.disconnect(); timeout.removeEventListener('abort', expired); };
    const changed = () => { if (predicate()) { cleanup(); resolve(); } };
    const expired = () => { cleanup(); reject(new Error('File consumer transition timed out')); };
    const observer = new MutationObserver(changed);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    timeout.addEventListener('abort', expired, { once: true });
    changed();
  });
}

function fixture(selectFile?: NativeDesktopBridge['selectFile'], rejectPaths = false) {
  const paths: string[] = [];
  const requests: { route: string; directory: string | null; path: string | null }[] = [];
  const content = new Map([['/project/a.ts', 'const a = 1;\n'], ['/project/b.ts', 'const b = 2;\n']]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    const route = url.pathname;
    const directory = url.searchParams.get('directory');
    const path = url.searchParams.get('path');
    requests.push({ route, directory, path });
    if (route.endsWith('/list')) return Response.json({ path: '/project', entries: [...content.keys()].map((file) => ({
      path: file, name: file.split('/').at(-1), isDirectory: false, isFile: true, isSymbolicLink: false,
    })) });
    if (route.endsWith('/stat')) {
      if (!path?.startsWith('/project/')) return Response.json({ code: 'directory_not_registered', error: 'OUTSIDE_SENTINEL' }, { status: 403 });
      return Response.json({ path, isFile: true, size: 10, mtimeMs: 1 });
    }
    if (route.endsWith('/read')) return new Response(content.get(path ?? ''));
    if (route.endsWith('/write')) return Response.json({ success: true });
    return Response.json({}, { status: 503 });
  };
  const client = createNativeClient({
    fetch: async () => Response.json({ schemaVersion: 1, theme: 'openchamber-light' }),
  });
  const desktop = selectFile ? createNativeDesktopCapabilities({
    selectFolder: async () => null, selectFile,
    openPath: async (path) => { paths.push(`open:${path}`); if (rejectPaths) throw new Error('GRANT_REFUSED'); return null; },
    revealPath: async (path) => { paths.push(`reveal:${path}`); if (rejectPaths) throw new Error('GRANT_REFUSED'); return null; },
    notify: async () => ({ supported: true }),
  }) : undefined;
  const render = (active = true) => <NativeDesktopContext.Provider value={desktop}>
    <OmoAppearanceProvider client={client}><NativeFiles directory="/project" active={active} /></OmoAppearanceProvider>
  </NativeDesktopContext.Provider>;
  return { render, paths, requests, cleanup: () => { globalThis.fetch = originalFetch; } };
}

async function openTreeFile(path: string) {
  const ready = observe(() => Boolean(document.querySelector('[data-testid="omo-file-save"]')));
  await act(async () => { await click(`button[title="${path}"]`); await ready; });
}

async function editDraft(text: string) {
  const element = document.querySelector('.cm-content');
  assert(element instanceof HTMLElement);
  const editor = EditorView.findFromDOM(element);
  assert(editor);
  await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } }));
}

test('missing desktop capability hides native actions without breaking the file tree', async () => {
  const h = fixture();
  const view = await mount(h.render());
  try {
    expect(view.host.querySelector('[data-testid="omo-file-choose"]')).toBeNull();
    expect(view.host.querySelector('[data-testid="omo-file-open-native"]')).toBeNull();
    expect(view.host.querySelector('[data-testid="omo-file-reveal-native"]')).toBeNull();
    await openTreeFile('/project/a.ts');
    expect(view.host.querySelector('.cm-content')?.textContent).toContain('const a = 1;');
    expect(h.requests.filter((request) => request.route.endsWith('/read'))).toEqual([
      { route: '/api/fs/read', directory: '/project', path: '/project/a.ts' },
    ]);
  } finally { await view.cleanup(); h.cleanup(); }
});

test('native file picker cancel preserves the selected editor and unsaved draft', async () => {
  const options: { readonly defaultPath?: string }[] = [];
  const h = fixture(async (input = {}) => { options.push(input); return null; });
  const view = await mount(h.render());
  try {
    await openTreeFile('/project/a.ts');
    await editDraft('DRAFT_SENTINEL');
    await click('[data-testid="omo-file-choose"]');
    expect(options).toEqual([{ defaultPath: '/project' }]);
    expect(view.host.querySelector('.cm-content')?.textContent).toBe('DRAFT_SENTINEL');
    expect(view.host.querySelector('[data-testid="omo-file-save"]')?.getAttribute('disabled')).toBeNull();
    expect(h.requests.filter((request) => request.route.endsWith('/read'))).toHaveLength(1);
  } finally { await view.cleanup(); h.cleanup(); }
});

test('native selected file and path commands use exact canonical values without losing other drafts', async () => {
  const options: { readonly defaultPath?: string }[] = [];
  const h = fixture(async (input = {}) => { options.push(input); return '/project/b.ts'; });
  const view = await mount(h.render());
  try {
    await openTreeFile('/project/a.ts');
    await editDraft('DRAFT_SENTINEL');
    const selected = observe(() => document.querySelector('.cm-content')?.textContent?.includes('const b = 2;') ?? false);
    await act(async () => { await click('[data-testid="omo-file-choose"]'); await selected; });
    await click('[data-testid="omo-file-open-native"]');
    await click('[data-testid="omo-file-reveal-native"]');
    expect(options).toEqual([{ defaultPath: '/project' }]);
    expect(h.paths).toEqual(['open:/project/b.ts', 'reveal:/project/b.ts']);
    await click('button[title="/project/a.ts"]');
    expect(view.host.querySelector('.cm-content')?.textContent).toBe('DRAFT_SENTINEL');
    expect(h.requests.filter((request) => request.route.endsWith('/write'))).toHaveLength(0);
    expect(h.requests.every((request) => request.directory === '/project')).toBe(true);
  } finally { await view.cleanup(); h.cleanup(); }
});

test('server refusal of an outside picker selection restores the current draft without registering it', async () => {
  const h = fixture(async () => '/outside/private.ts');
  const view = await mount(h.render());
  try {
    await openTreeFile('/project/a.ts');
    await editDraft('DRAFT_SENTINEL');
    const refused = observe(() => Boolean(document.querySelector('[role="alert"]')));
    await act(async () => { await click('[data-testid="omo-file-choose"]'); await refused; });
    expect(view.host.querySelector('.cm-content')?.textContent).toBe('DRAFT_SENTINEL');
    expect(h.requests.filter((request) => request.path === '/outside/private.ts')).toEqual([
      { route: '/api/fs/stat', directory: '/project', path: '/outside/private.ts' },
    ]);
    expect(h.requests.some((request) => request.route.includes('/omo/projects'))).toBe(false);
  } finally { await view.cleanup(); h.cleanup(); }
});

test('native picker and path refusal remain visible while the draft remains editable', async () => {
  const h = fixture(async () => { throw new Error('PICKER_REFUSED'); }, true);
  const view = await mount(h.render());
  try {
    await openTreeFile('/project/a.ts');
    await editDraft('DRAFT_SENTINEL');
    await click('[data-testid="omo-file-choose"]');
    expect(view.host.querySelector('[data-testid="omo-file-desktop-error"]')?.getAttribute('role')).toBe('alert');
    await click('[data-testid="omo-file-open-native"]');
    await click('[data-testid="omo-file-reveal-native"]');
    expect(h.paths).toEqual(['open:/project/a.ts', 'reveal:/project/a.ts']);
    expect(view.host.querySelector('.cm-content')?.textContent).toBe('DRAFT_SENTINEL');
    expect(view.host.querySelector('[data-testid="omo-file-save"]')?.getAttribute('disabled')).toBeNull();
  } finally { await view.cleanup(); h.cleanup(); }
});

test('file picker completion in a hidden directory cannot change its selected editor', async () => {
  let resolve: (path: string | null) => void = () => { throw new Error('Picker not started'); };
  const h = fixture(() => new Promise((yes) => { resolve = yes; }));
  const view = await mount(h.render());
  try {
    await openTreeFile('/project/a.ts');
    await editDraft('DRAFT_SENTINEL');
    await click('[data-testid="omo-file-choose"]');
    await view.render(h.render(false));
    await act(async () => resolve('/project/b.ts'));
    await view.render(h.render(true));
    expect(view.host.querySelector('.cm-content')?.textContent).toBe('DRAFT_SENTINEL');
    expect(h.requests.some((request) => request.path === '/project/b.ts')).toBe(false);
  } finally { await view.cleanup(); h.cleanup(); }
});
