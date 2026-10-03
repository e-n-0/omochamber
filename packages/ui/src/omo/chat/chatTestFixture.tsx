import { afterAll, expect } from 'bun:test';
import { plugin } from 'bun';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { EditorView } from '@codemirror/view';
import { Window } from 'happy-dom';
import { createNativeClient } from '../client';
import { createNativeStore } from '../state';
import type { NativeStore } from '../state';
import { commandEnvelopeSchema, uiResponseEnvelopeSchema } from '../contracts';
import type { CommandEnvelope, NativeEvent, NativeSnapshot, SessionEvent, UiResponseEnvelope } from '../contracts';

export const browser = new Window({ url: 'http://localhost' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  Worker: undefined, customElements: browser.customElements, DOMParser: browser.DOMParser,
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  HTMLElement: browser.HTMLElement, HTMLAnchorElement: browser.HTMLAnchorElement, HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement, Element: browser.Element, Node: browser.Node,
  Document: browser.Document, Text: browser.Text, Range: browser.Range, HTMLButtonElement: browser.HTMLButtonElement,
  DocumentFragment: browser.DocumentFragment, MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), Event: browser.Event,
  MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent, CustomEvent: browser.CustomEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent, CSS: browser.CSS, IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true });
}
// Match Vite's worker-URL transform without replacing the markdown pipeline.
plugin({ name: 'native-dom-worker-url', setup(build) {
  build.onLoad({ filter: /\.worker\.ts\?worker&url$/ }, (args) => ({ contents: `export default ${JSON.stringify(args.path)};`, loader: 'js' }));
} });


// Happy DOM has no layout engine. Give the real list a bounded viewport so
// these small history fixtures are mounted by LegendList rather than mocked.
const elementPrototype = browser.HTMLElement.prototype;
const layoutDescriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [key, size] of Object.entries({ clientHeight: 2400, clientWidth: 960 })) {
  const descriptor = Object.getOwnPropertyDescriptor(elementPrototype, key);
  layoutDescriptors.set(key, descriptor);
  Object.defineProperty(elementPrototype, key, { configurable: true, get() { return size; } });
}
layoutDescriptors.set('getBoundingClientRect', Object.getOwnPropertyDescriptor(elementPrototype, 'getBoundingClientRect'));
Object.defineProperty(elementPrototype, 'getBoundingClientRect', { configurable: true, value: function(this: HTMLElement) {
  return new browser.DOMRect(0, 0, 960, this.matches('[data-testid="omo-transcript"]') ? 2400 : 320);
} });

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of layoutDescriptors) {
    if (descriptor) Object.defineProperty(elementPrototype, key, descriptor);
    else Reflect.deleteProperty(elementPrototype, key);
  }
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

export function nativeSnapshot(): NativeSnapshot {
  return {
    schemaVersion: 1, sessionKey: 'chat-a', durableSessionId: 'durable-a', connectionEpoch: 1, revision: 1,
    ownership: 'hosted', connection: 'connected',
    state: {
      directory: '/workspace', name: 'test', isStreaming: false, isCompacting: false, isBashRunning: false,
      isRetrying: false, retryAttempt: 0, projectTrusted: true,
      model: { provider: 'provider-a', id: 'model-a' }, thinkingLevel: 'medium',
      availableModels: [
        { provider: 'provider-a', id: 'model-a', name: 'Model A' },
        { provider: 'provider-b', id: 'model-b', name: 'Model B' },
      ], availableThinkingLevels: ['medium', 'high'], commands: [],
    },
    activeBranch: { leafId: null, entries: [] },
    goal: { status: 'ready', value: null }, todo: { status: 'ready', value: null },
    tasks: { status: 'ready', value: [] }, dags: { status: 'ready', value: [] }, pendingInteractions: [],
  };
}

function untilState(store: NativeStore, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(2_000);
    const cleanup = () => { unsubscribe(); timeout.removeEventListener('abort', expired); };
    const expired = () => { cleanup(); reject(new Error('Native fixture transition timed out')); };
    const observe = () => { if (predicate()) { cleanup(); resolve(); } };
    const unsubscribe = store.subscribe(observe);
    timeout.addEventListener('abort', expired, { once: true });
    observe();
  });
}

export function nativeHarness(snapshot = nativeSnapshot()) {
  const commands: CommandEnvelope[] = [];
  const responses: UiResponseEnvelope[] = [];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  let revision = snapshot.revision;
  let responseStatus = 202;
  let readStatus = 200;
  const client = createNativeClient({
    fetch: async (path, init) => {
      if (path.endsWith('/events')) return new Response(new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        cancel() { cancelled = true; },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
      if (path.endsWith('/attach') || path.endsWith('/snapshot')) return Response.json(snapshot, {
        status: path.endsWith('/snapshot') ? readStatus : 200,
      });
      const envelope = path.endsWith('/ui-responses') ? uiResponseEnvelopeSchema.parse(JSON.parse(String(init?.body)))
        : commandEnvelopeSchema.parse(JSON.parse(String(init?.body)));
      if ('uiRequestId' in envelope) responses.push(envelope);
      else commands.push(envelope);
      return Response.json({ requestId: envelope.requestId, connectionEpoch: envelope.connectionEpoch, accepted: true }, { status: responseStatus });
    },
  });
  const store = createNativeStore({ client, waitForReconnect: (_attempt, signal) => new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  }) });
  const emit = async (event: SessionEvent) => {
    const received = untilState(store, () => store.getState().sessions.get('chat-a')?.snapshot?.revision === event.revision ||
      (event.type === 'commandResult' && store.getState().sessions.get('chat-a')?.mutations.get(event.result.requestId)?.status ===
        (event.result.success ? 'succeeded' : 'failed')));
    assert(controller);
    const stream = controller;
    await act(async () => {
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      await received;
    });
  };
  return {
    client, store, commands, responses,
    select: () => store.selectSession('chat-a'),
    native: (event: NativeEvent) => emit({ type: 'native', sessionKey: 'chat-a', connectionEpoch: 1, revision: ++revision, event }),
    connection: (connection: 'connected' | 'reconnecting' | 'unavailable') => emit({
      type: 'connection', sessionKey: 'chat-a', connectionEpoch: 1, revision: ++revision, connection,
    }),
    result: (requestId: string, success = true) => emit({
      type: 'commandResult', sessionKey: 'chat-a', connectionEpoch: 1, revision: ++revision,
      result: success ? { requestId, success: true } : { requestId, success: false, error: 'NATIVE_REJECTED' },
    }),
    responseStatus: (status: number) => { responseStatus = status; },
    readStatus: (status: number) => { readStatus = status; },
    cleanup: async () => { await store.dispose(); expect(cancelled).toBe(true); },
  };
}

export async function mount(element: React.ReactNode) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
  return {
    host,
    render: (next: React.ReactNode) => act(async () => root.render(<I18nProvider>{next}</I18nProvider>)),
    cleanup: async () => { await act(async () => root.unmount()); host.remove(); },
  };
}

export function untilDOM(host: HTMLElement, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(3_000);
    const cleanup = () => { observer.disconnect(); timeout.removeEventListener('abort', expired); };
    const expired = () => { cleanup(); reject(new Error('Native DOM transition timed out')); };
    const check = () => { if (predicate()) { cleanup(); resolve(); } };
    const observer = new MutationObserver(check);
    observer.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    timeout.addEventListener('abort', expired, { once: true });
    check();
  });
}

export function draftValue(selector = '[data-testid="omo-draft"]'): string {
  const host = document.querySelector(selector);
  const content = host?.querySelector('.cm-content');
  assert(content instanceof HTMLElement, 'The actual composer editor must be mounted');
  const editor = EditorView.findFromDOM(content);
  assert(editor, 'The composer must expose its real CodeMirror view');
  return editor.state.doc.toString();
}

export async function type(selector: string, text: string) {
  const field = document.querySelector(selector);
  assert(field);
  const content = field.querySelector('.cm-content');
  if (content instanceof HTMLElement) {
    const editor = EditorView.findFromDOM(content);
    assert(editor, 'The composer must expose its real CodeMirror view');
    await act(async () => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, selection: { anchor: text.length } }));
    return;
  }
  assert(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement);
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  assert(setter);
  await act(async () => { setter.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new Event('change', { bubbles: true })); });
}

export function click(selector: string) {
  return act(async () => {
    const button = document.querySelector(selector);
    assert(button instanceof HTMLElement, `Missing fixture control ${selector}`);
    button.click();
  });
}
