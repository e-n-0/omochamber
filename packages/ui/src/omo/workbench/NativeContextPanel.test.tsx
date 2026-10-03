import { expect, test } from 'bun:test';
import { act } from 'react';
import { EditorView } from '@codemirror/view';
import { browser, click, mount } from '../chat/chatTestFixture';
import { createNativeClient } from '../client';
import { OmoAppearanceProvider } from '../AppearanceProvider';
import { NativeContextPanel, type NativeContextPanelProps } from './NativeContextPanel';

function observe(predicate: () => boolean) {
  return new Promise<void>((resolve, reject) => {
    const timeout = AbortSignal.timeout(2000);
    const cleanup = () => { observer.disconnect(); timeout.removeEventListener('abort', expired); };
    const changed = () => { if (predicate()) { cleanup(); resolve(); } };
    const expired = () => { cleanup(); reject(new Error('Context consumer transition timed out')); };
    const observer = new MutationObserver(changed);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    timeout.addEventListener('abort', expired, { once: true });
    changed();
  });
}

test('retains native editor ownership through close expand tool and directory changes', async () => {
  // Given a real native workspace with local HTTP boundary fixtures.
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), browser.location.href);
    const directory = url.searchParams.get('directory') ?? '/project';
    requests.push(url.pathname);
    if (url.pathname.endsWith('/list')) return Response.json({
      path: directory,
      entries: [{ path: `${directory}/a.ts`, name: 'a.ts', isDirectory: false, isFile: true, isSymbolicLink: false }],
    });
    if (url.pathname.endsWith('/stat')) return Response.json({ path: url.searchParams.get('path'), isFile: true, size: 10, mtimeMs: 1 });
    if (url.pathname.endsWith('/read')) return new Response('const a = 1;\n');
    return Response.json({}, { status: 503 });
  };
  const client = createNativeClient({ fetch: async () => Response.json({ schemaVersion: 1, theme: 'openchamber-light' }) });
  const options: NativeContextPanelProps = {
    directory: '/project', tab: 'files', open: true, expanded: false, widthFraction: 0.5,
    onClose: () => {}, onExpandedChange: () => {}, onWidthChange: () => {},
  };
  const render = (overrides: Partial<NativeContextPanelProps> = {}) => (
    <OmoAppearanceProvider client={client}><NativeContextPanel {...options} {...overrides} /></OmoAppearanceProvider>
  );
  const view = await mount(render());
  try {
    const listed = observe(() => Boolean(document.querySelector('button[title="/project/a.ts"]')));
    await act(async () => { await listed; });
    const opened = observe(() => Boolean(document.querySelector('[data-testid="omo-file-save"]')));
    await act(async () => { await click('button[title="/project/a.ts"]'); await opened; });
    const content = view.host.querySelector('.cm-content');
    if (!(content instanceof HTMLElement)) throw new Error('Missing real CodeMirror editor');
    const editor = EditorView.findFromDOM(content);
    if (!editor) throw new Error('Missing native editor view');
    await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'UNSAVED_NATIVE_DRAFT' } }));
    const requestCount = requests.length;
    // When the retained frame closes, expands, changes tools and revisits its directory.
    await view.render(render({ open: false }));
    expect(requests).toHaveLength(requestCount);
    expect(view.host.querySelector('[data-context-panel]')?.hasAttribute('inert')).toBe(true);
    await view.render(render({ expanded: true }));
    await view.render(render({ tab: 'changes' }));
    await view.render(render({ directory: '/other' }));
    await view.render(render());
    // Then the original DOM owner and its unsaved document survive every transition.
    expect(view.host.querySelectorAll('[data-testid="omo-workbench"]')).toHaveLength(1);
    expect(content.isConnected).toBe(true);
    expect(EditorView.findFromDOM(content)).toBe(editor);
    expect(editor.state.doc.toString()).toBe('UNSAVED_NATIVE_DRAFT');
    expect(view.host.querySelector('[data-testid="omo-file-save"]')?.hasAttribute('disabled')).toBe(false);
  } finally {
    await view.cleanup();
    globalThis.fetch = originalFetch;
  }
});
