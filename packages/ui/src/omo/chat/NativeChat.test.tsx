import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { NativeEntry } from '../contracts';
import { browser, click, draftValue, mount, nativeHarness, nativeSnapshot, type, untilDOM } from './chatTestFixture';

const { NativeChat } = await import('./NativeChat');
const { NativeDialogs } = await import('./NativeDialogs');
const { useNativeSlice } = await import('./nativeHooks');

function appendMetadata(entries: NativeEntry[], count: number) {
  const fields = { id: 'metadata', parentId: null, timestamp: '2026-10-01T00:00:00Z' };
  const metadata: NativeEntry[] = [
    { ...fields, type: 'custom', customType: 'work' },
    { ...fields, type: 'model_change', provider: 'provider-a', modelId: 'model-a' },
    { ...fields, type: 'model_change_rejected' },
    { ...fields, type: 'configuration_update', reasoning: { effort: 'high' } },
    { ...fields, type: 'thinking_level_change', thinkingLevel: 'high' },
    { ...fields, type: 'session_info', name: 'history' },
    { ...fields, type: 'label', targetId: 'latest', label: 'done' },
    { ...fields, type: 'custom_message', customType: 'private', display: false, content: 'HIDDEN_ENTRY_SENTINEL' },
    { ...fields, type: 'message', message: {
      role: 'custom', customType: 'private', display: false, content: 'HIDDEN_MESSAGE_SENTINEL', timestamp: 1,
    } },
  ];
  for (let index = 0; index < count; index += 1) {
    for (const entry of metadata) entries.push({
      ...entry, id: `metadata-${entries.length}`, parentId: entries.at(-1)?.id ?? null,
    });
  }
}

function longHistory(metadata = true) {
  const snapshot = nativeSnapshot();
  const entries: NativeEntry[] = [];
  for (let index = 0; index < 48; index += 1) {
    entries.push({ type: 'message', id: `history-${index}`, parentId: entries.at(-1)?.id ?? null,
      timestamp: '2026-10-01T00:00:00Z', message: { role: 'assistant', timestamp: index,
        content: [{ type: 'text', text: index === 47 ? 'LATEST_HISTORY_SENTINEL' : `OLDER_HISTORY_${index}` }] } });
    if (metadata) appendMetadata(entries, 1);
  }
  snapshot.activeBranch = { entries, leafId: entries.at(-1)?.id ?? null };
  return snapshot;
}

// Supply only the layout/scroll events Happy DOM lacks. The actual shared view,
// LegendList, native store and renderers still decide which rows are mounted.
const resizeObservers = new Set<MeasuredResizeObserver>();
class MeasuredResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) { resizeObservers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); resizeObservers.delete(this); }
  deliver(host: HTMLElement) {
    const entries = [...this.targets].filter((target) => host.contains(target)).map((target) => {
      const contentRect = target.getBoundingClientRect();
      const size = { inlineSize: contentRect.width, blockSize: contentRect.height };
      return { target, contentRect, borderBoxSize: [size], contentBoxSize: [size], devicePixelContentBoxSize: [size] };
    });
    if (entries.length) this.callback(entries, this);
  }
}

function transcriptLayout(viewportHeight = 640) {
  let width = 960;
  let rowHeight = 320;
  const resizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: MeasuredResizeObserver });
  const prototype = browser.HTMLElement.prototype;
  const keys = ['clientHeight', 'clientWidth', 'scrollHeight', 'scrollTop', 'onscrollend', 'getBoundingClientRect'];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(prototype, key)]));
  const rectangle = prototype.getBoundingClientRect;
  const scrolling = Object.getOwnPropertyDescriptor(browser.Element.prototype, 'scrollTop');
  assert(scrolling?.get && scrolling.set);
  const { get, set } = scrolling;
  Object.defineProperties(prototype, {
    clientHeight: { configurable: true, get(this: HTMLElement) {
      return this.matches('[data-testid="omo-transcript"]') ? viewportHeight : 2400;
    } },
    clientWidth: { configurable: true, get() { return width; } },
    scrollHeight: { configurable: true, get(this: HTMLElement) {
      const content = this.matches('[data-testid="omo-transcript"]') ? this.firstElementChild
        : this.classList.contains('legend-list-content-container') ? this : null;
      if (!content) return 0;
      return Math.max(viewportHeight, [...content.children].reduce((height, child) =>
        height + (child instanceof HTMLElement
          ? child.style.height.endsWith('px') ? Number.parseFloat(child.style.height) : child.getBoundingClientRect().height
          : 0), 0));
    } },
    scrollTop: { configurable: true, get(this: HTMLElement) { return get.call(this); }, set(this: HTMLElement, value: number) {
      const previous = get.call(this);
      set.call(this, value);
      if (previous !== value && this.matches('[data-testid="omo-transcript"]')) {
        this.dispatchEvent(new Event('scroll'));
      }
    } },
    onscrollend: { configurable: true, writable: true, value: null },
    getBoundingClientRect: { configurable: true, value(this: HTMLElement) {
      if (this.matches('[data-testid="omo-transcript"]')) return new browser.DOMRect(0, 0, width, viewportHeight);
      if (this.closest('.legend-list-content-container') && !this.hasChildNodes() && !this.style.height) {
        return new browser.DOMRect(0, 0, width, 0);
      }
      if (this.closest('.legend-list-content-container')) return new browser.DOMRect(0, 0, width, rowHeight);
      return rectangle.call(this);
    } },
  });
  return Object.assign(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(prototype, key, descriptor);
      else Reflect.deleteProperty(prototype, key);
    }
    if (resizeObserver) Object.defineProperty(globalThis, 'ResizeObserver', resizeObserver);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }, { narrow(host: HTMLElement) {
    width = 480;
    rowHeight = 480;
    for (const observer of resizeObservers) observer.deliver(host);
  } });
}

function untilHistoryVisible(root: Document | HTMLElement, id = 'history-47'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = AbortSignal.timeout(3_000);
    const cleanup = () => {
      observer.disconnect();
      root.removeEventListener('scroll', check, true);
      timeout.removeEventListener('abort', expired);
    };
    const expired = () => {
      const scroller = root.querySelector('[data-testid="omo-transcript"]');
      const row = root.querySelector(`[data-message-id="${id}"]`)?.closest('[style*="position: absolute"]');
      cleanup();
      reject(new Error(`Native history row ${id} did not enter the viewport: scroll=${scroller?.scrollTop}, viewport=${scroller?.clientHeight}, content=${scroller?.scrollHeight}, rowTop=${row instanceof HTMLElement ? row.style.top : 'unmounted'}`));
    };
    const check = () => {
      const scroller = root.querySelector('[data-testid="omo-transcript"]');
      const row = root.querySelector(`[data-message-id="${id}"]`)?.closest('[style*="position: absolute"]');
      if (!(scroller instanceof HTMLElement && row instanceof HTMLElement)) return;
      const top = Number.parseFloat(row.style.top);
      if (top < scroller.scrollTop + scroller.clientHeight && top + 320 > scroller.scrollTop) {
        cleanup();
        resolve();
      }
    };
    const observer = new MutationObserver(check);
    observer.observe(root, { subtree: true, childList: true, attributes: true });
    root.addEventListener('scroll', check, true);
    timeout.addEventListener('abort', expired, { once: true });
    check();
  });
}

test('metadata reserves no virtual rows while displayed custom messages and summaries remain visible', async () => {
  // Given a short active branch surrounded by every nonrenderable native entry.
  const restore = transcriptLayout(2400);
  const snapshot = nativeSnapshot();
  const entries: NativeEntry[] = [];
  appendMetadata(entries, 5);
  const fields = { id: 'visible', parentId: null, timestamp: '2026-10-01T00:00:01Z' };
  for (const entry of [
    { ...fields, type: 'custom_message', customType: 'notice', display: true, content: 'DISPLAYED_ENTRY_SENTINEL' },
    { ...fields, type: 'message', message: { role: 'custom', customType: 'notice', display: true, content: 'DISPLAYED_MESSAGE_SENTINEL', timestamp: 1 } },
    { ...fields, type: 'compaction', summary: 'COMPACTION_SENTINEL', firstKeptEntryId: entries[0].id, tokensBefore: 10 },
    { ...fields, type: 'branch_summary', summary: 'BRANCH_SUMMARY_SENTINEL', fromId: entries[0].id },
    { ...fields, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'LATEST_VISIBLE_SENTINEL' }], timestamp: 2 } },
  ] satisfies NativeEntry[]) {
    entries.push({ ...entry, id: `visible-${entries.length}`, parentId: entries.at(-1)?.id ?? null, timestamp: '2026-10-01T00:00:01Z' });
  }
  appendMetadata(entries, 5);
  snapshot.activeBranch = { entries, leafId: entries.at(-1)?.id ?? null };
  entries.push({ type: 'message', id: 'off-branch', parentId: null, timestamp: fields.timestamp,
    message: { role: 'assistant', timestamp: 3, content: [{ type: 'text', text: 'OFF_BRANCH_SENTINEL' }] } });
  const h = nativeHarness(snapshot);
  await h.select();
  // When the real virtualized native chat reopens that branch.
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await untilDOM(view.host, () => Boolean(view.host.textContent?.includes('LATEST_VISIBLE_SENTINEL')));
    const scroller = view.host.querySelector('[data-testid="omo-transcript"]');
    assert(scroller instanceof HTMLElement);
    // Then only the five visible entries occupy virtual height, not 90 metadata rows.
    expect(scroller.scrollHeight).toBe(scroller.clientHeight);
    expect(scroller.scrollTop).toBe(0);
    expect(view.host.textContent).toContain('DISPLAYED_ENTRY_SENTINEL');
    expect(view.host.textContent).toContain('DISPLAYED_MESSAGE_SENTINEL');
    expect(view.host.textContent).not.toContain('HIDDEN_ENTRY_SENTINEL');
    expect(view.host.textContent).not.toContain('HIDDEN_MESSAGE_SENTINEL');
    expect(view.host.textContent).not.toContain('OFF_BRANCH_SENTINEL');
    expect(view.host.querySelectorAll('[data-testid="omo-transcript"] details')).toHaveLength(2);
  } finally { await view.cleanup(); await h.cleanup(); restore(); }
});

for (const hydration of ['ready', 'hydrating', 'reopened']) {
  test(`opening ${hydration} long history mounts the latest visible assistant after trailing metadata`, async () => {
    // Given history much longer than the real list's bounded viewport and buffer.
    const restore = transcriptLayout(240);
    const h = nativeHarness(longHistory());
    if (hydration !== 'hydrating') await h.select();
    const chat = <NativeChat client={h.client} store={h.store} sessionKey="chat-a" />;
    const view = await mount(chat);
    try {
      // When ready history opens, or arrives after initial layout notifications.
      if (hydration === 'hydrating') {
        const scroller = view.host.querySelector('[data-testid="omo-transcript"]');
        assert(scroller instanceof HTMLElement);
        await act(async () => {
          scroller.dispatchEvent(new Event('scroll'));
          scroller.dispatchEvent(new Event('scrollend'));
        });
        await act(async () => { await h.select(); });
      } else if (hydration === 'reopened') {
        await view.render(<NativeChat client={h.client} store={h.store} sessionKey={null} />);
        await view.render(chat);
      }
      await untilHistoryVisible(view.host);
      const scroller = view.host.querySelector('[data-testid="omo-transcript"]');
      const latest = view.host.querySelector('[data-message-id="history-47"]');
      assert(scroller instanceof HTMLElement && latest instanceof HTMLElement);
      const row = latest.closest('[style*="position: absolute"]');
      assert(row instanceof HTMLElement);
      // Then the latest visible row is actually in the viewport, not only its buffer.
      expect(Number.parseFloat(row.style.top)).toBeLessThan(scroller.scrollTop + scroller.clientHeight);
      expect(Number.parseFloat(row.style.top) + 320).toBeGreaterThan(scroller.scrollTop);
      expect(view.host.textContent).toContain('LATEST_HISTORY_SENTINEL');
    } finally { await view.cleanup(); await h.cleanup(); restore(); }
  });
}

test('initial off-end footer measurements do not prevent positioning newly ready history', async () => {
  // Given a live tool footer before authoritative visible history has arrived.
  const restore = transcriptLayout(240);
  const snapshot = nativeSnapshot();
  const h = nativeHarness(snapshot);
  await h.select();
  await h.native({ type: 'tool_execution_start', toolCallId: 'read-call', toolName: 'read', args: {} });
  await h.native({ type: 'tool_execution_update', toolCallId: 'read-call', toolName: 'read',
    partialResult: { content: [{ type: 'text', text: 'INITIAL_TOOL_SENTINEL' }] } });
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    const scroller = view.host.querySelector('[data-testid="omo-transcript"]');
    assert(scroller instanceof HTMLElement);
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll'));
      scroller.dispatchEvent(new Event('scrollend'));
    });
    snapshot.activeBranch = longHistory(false).activeBranch;
    snapshot.activeBranch.entries[0] = { type: 'message', id: 'history-0', parentId: null,
      timestamp: '2026-10-01T00:00:00Z', message: { role: 'toolResult', toolCallId: 'read-call',
        toolName: 'read', isError: false, timestamp: 1, content: [{ type: 'text', text: 'PERSISTED_TOOL_SENTINEL' }] } };
    snapshot.revision = 4;
    // When the ready snapshot replaces the live footer with persisted history.
    const visible = untilHistoryVisible(view.host);
    await act(async () => { await h.store.refresh(); });
    await visible;
    // Then startup geometry has not been mistaken for the user reading older rows.
    expect(view.host.querySelector('[data-message-id="history-47"]')?.textContent).toContain('LATEST_HISTORY_SENTINEL');
    expect(view.host.querySelector('[data-testid="omo-live-tool"]')).toBeNull();
  } finally { await view.cleanup(); await h.cleanup(); restore(); }
});

test('reading older history stays at that row when visible history and metadata append', async () => {
  // Given a positioned native transcript with a long active branch.
  const restore = transcriptLayout();
  const snapshot = longHistory(false);
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await untilHistoryVisible(view.host);
    const scroller = view.host.querySelector('[data-testid="omo-transcript"]');
    assert(scroller instanceof HTMLElement);
    await act(async () => { scroller.dispatchEvent(new Event('scrollend')); });
    const olderVisible = untilHistoryVisible(view.host, 'history-0');
    await act(async () => {
      scroller.scrollTo({ top: 0, behavior: 'auto' });
      scroller.dispatchEvent(new Event('scrollend'));
    });
    await olderVisible;
    // When new authoritative entries arrive while the user reads older messages.
    await h.native({ type: 'entry_appended', entry: { type: 'message', id: 'newest', parentId: snapshot.activeBranch.leafId,
      timestamp: '2026-10-01T00:00:02Z', message: { role: 'assistant', timestamp: 50,
        content: [{ type: 'text', text: 'NEWEST_HISTORY_SENTINEL' }] } } });
    await h.native({ type: 'entry_appended', entry: { type: 'custom', id: 'newest-metadata', parentId: 'newest',
      timestamp: '2026-10-01T00:00:03Z', customType: 'work' } });
    await untilDOM(view.host, () => scroller.scrollHeight === 49 * 320);
    // Then the old row stays visible without an automatic return to the live edge.
    expect(scroller.scrollTop).toBe(0);
    expect(view.host.querySelector('[data-message-id="history-0"]')?.textContent).toContain('OLDER_HISTORY_0');
    expect(view.host.querySelector('[data-message-id="newest"]')).toBeNull();
  } finally { await view.cleanup(); await h.cleanup(); restore(); }
});

for (const readingOlder of [false, true]) {
  test(`narrowing unchanged history ${readingOlder ? 'preserves the released older row' : 'keeps the latest content above the floating composer'}`, async () => {
    // Given positioned history with trailing metadata and a floating composer.
    const layout = transcriptLayout();
    const h = nativeHarness(longHistory());
    await h.select();
    const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" floatingComposer />);
    try {
      await untilHistoryVisible(view.host);
      const scroller = view.host.querySelector('[data-testid="omo-transcript"]');
      const composer = view.host.querySelector('[data-composer-slot="floating"]');
      assert(scroller instanceof HTMLElement && composer instanceof HTMLElement);
      await act(async () => { scroller.dispatchEvent(new Event('scrollend')); });
      if (readingOlder) {
        const olderVisible = untilHistoryVisible(view.host, 'history-0');
        await act(async () => {
          scroller.scrollTo({ top: 0, behavior: 'auto' });
          scroller.dispatchEvent(new Event('scrollend'));
        });
        await olderVisible;
      }
      const previousHeight = scroller.scrollHeight;
      const resized = untilDOM(view.host, () => {
        if (scroller.scrollHeight <= previousHeight) return false;
        if (readingOlder) return Boolean(view.host.querySelector('[data-message-id="history-0"]'));
        const row = view.host.querySelector('[data-message-id="history-47"]')?.closest('[style*="position: absolute"]');
        return row instanceof HTMLElement && Number.parseFloat(row.style.top) + row.getBoundingClientRect().height <=
          scroller.scrollTop + scroller.clientHeight - composer.getBoundingClientRect().height;
      });
      // When a panel narrows the same entries and measured content rewraps.
      await act(async () => {
        layout.narrow(view.host);
        scroller.dispatchEvent(new Event('scroll'));
        scroller.dispatchEvent(new Event('scrollend'));
      });
      await resized;
      // Then a held pin follows the measured end, but an older reader stays put.
      if (readingOlder) {
        expect(scroller.scrollTop).toBe(0);
        expect(view.host.querySelector('[data-message-id="history-0"]')).not.toBeNull();
        expect(view.host.querySelector('[data-message-id="history-47"]')).toBeNull();
      } else {
        expect(view.host.querySelector('[data-message-id="history-47"]')?.textContent).toContain('LATEST_HISTORY_SENTINEL');
        expect(scroller.scrollHeight - scroller.scrollTop).toBeLessThanOrEqual(scroller.clientHeight);
      }
    } finally { await view.cleanup(); await h.cleanup(); layout(); }
  });
}

test('restores active history with safe Markdown, reasoning, native images, errors and truncated output', async () => {
  const snapshot = nativeSnapshot();
  snapshot.activeBranch = {
    leafId: 'bash', entries: [
      { type: 'message', id: 'u', parentId: null, timestamp: '2026-10-01T00:00:00Z',
        message: { role: 'user', content: 'USER_SENTINEL', timestamp: 1 } },
      { type: 'message', id: 'a', parentId: 'u', timestamp: '2026-10-01T00:00:01Z', message: {
        role: 'assistant', timestamp: 2, content: [
          { type: 'text', text: '**MARKDOWN_SENTINEL**\n\n```ts\nconst answer = 42;\n```\n\n<script>window.pwned = true</script>\n![remote](https://example.test/tracker.png)' },
          { type: 'thinking', thinking: 'REASONING_SENTINEL' },
          { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'qa.txt' } },
        ],
      } },
      { type: 'message', id: 't', parentId: 'a', timestamp: '2026-10-01T00:00:02Z', message: {
        role: 'toolResult', toolCallId: 'call', toolName: 'read', isError: true, timestamp: 3, content: [
          { type: 'text', text: 'TOOL_SENTINEL' }, { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
          { type: 'image', data: 'PHN2Zz4=', mimeType: 'image/svg+xml' },
        ],
      } },
      { type: 'message', id: 'hidden', parentId: 't', timestamp: '2026-10-01T00:00:03Z',
        message: { role: 'custom', customType: 'private', content: 'PRIVATE_SENTINEL', display: false, timestamp: 4 } },
      { type: 'message', id: 'bash', parentId: 'hidden', timestamp: '2026-10-01T00:00:04Z',
        message: { role: 'bashExecution', command: 'printf sentinel', output: 'BASH_SENTINEL', cancelled: false, truncated: true, exitCode: 1, timestamp: 5 } },
    ],
  };
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" floatingComposer />);
  try {
    await untilDOM(view.host, () => Boolean(view.host.querySelector('strong')));
    expect(view.host.querySelector('strong')?.textContent).toBe('MARKDOWN_SENTINEL');
    expect(view.host.querySelector('pre code')?.textContent).toContain('const answer = 42;');
    expect(view.host.querySelector('script')).toBeNull();
    expect(view.host.querySelector('[data-testid="omo-reasoning"]')?.textContent).toContain('REASONING_SENTINEL');
    expect(view.host.querySelector('[data-message-role="toolResult"]')?.textContent).toContain('TOOL_SENTINEL');
    expect(view.host.querySelectorAll('[data-testid="omo-transcript"] img')).toHaveLength(1);
    expect(view.host.querySelector('[data-testid="omo-transcript"] img')?.getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=');
    expect(view.host.querySelector('[data-message-role="bashExecution"]')?.textContent).toContain('BASH_SENTINEL');
    expect(view.host.textContent).not.toContain('PRIVATE_SENTINEL');
    expect(view.host.querySelectorAll('[role="alert"]').length).toBeGreaterThan(0);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('renders native deltas and execution results once when authoritative entries arrive', async () => {
  const h = nativeHarness();
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await h.native({ type: 'message_start', message: { role: 'assistant', timestamp: 2, content: [] } });
    await h.native({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'LIVE_SENTINEL' } });
    await h.native({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'THOUGHT_SENTINEL' } });
    await h.native({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 2, id: 'call', toolName: 'read' } });
    await h.native({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: '{"path":"qa.txt"}' } });
    expect(view.host.querySelector('[data-testid="omo-live-message"]')?.textContent).toContain('LIVE_SENTINEL');
    expect(view.host.querySelector('[data-tool-call-id="call"] pre')?.textContent).toBe('{"path":"qa.txt"}');
    await h.native({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: {} });
    await h.native({ type: 'tool_execution_update', toolCallId: 'call', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'PARTIAL_SENTINEL' }] } });
    expect(view.host.querySelector('[data-tool-status="running"]')?.textContent).toContain('PARTIAL_SENTINEL');
    await h.native({ type: 'tool_execution_end', toolCallId: 'call', toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'RESULT_SENTINEL' }] } });
    await h.native({ type: 'entry_appended', entry: {
      type: 'message', id: 'a', parentId: null, timestamp: '2026-10-01T00:00:01Z',
      message: { role: 'assistant', timestamp: 2, content: [{ type: 'text', text: 'LIVE_SENTINEL' }] },
    } });
    await h.native({ type: 'entry_appended', entry: {
      type: 'message', id: 't', parentId: 'a', timestamp: '2026-10-01T00:00:02Z',
      message: { role: 'toolResult', timestamp: 3, toolCallId: 'call', toolName: 'read', isError: false,
        content: [{ type: 'text', text: 'RESULT_SENTINEL' }] },
    } });
    expect(view.host.querySelector('[data-testid="omo-live-message"]')).toBeNull();
    expect(view.host.querySelector('[data-testid="omo-live-tool"]')).toBeNull();
    expect(view.host.textContent?.match(/LIVE_SENTINEL/g)).toHaveLength(1);
    expect(view.host.textContent?.match(/RESULT_SENTINEL/g)).toHaveLength(1);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('submits once, retains accepted draft until native result, and never creates a session on send', async () => {
  const h = nativeHarness();
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await type('[data-testid="omo-composer"]', 'PROMPT_SENTINEL');
    await click('[data-testid="omo-send"]');
    await click('[data-testid="omo-send"]');
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].command).toEqual({ type: 'prompt', text: 'PROMPT_SENTINEL' });
    const field = view.host.querySelector('[data-testid="omo-draft"] .cm-content');
    expect(field).toBeInstanceOf(browser.HTMLElement);
    expect(field?.getAttribute('contenteditable')).toBe('false');
    expect(view.host.querySelector('[data-mutation-status="accepted"]')).not.toBeNull();
    await h.result(h.commands[0].requestId);
    expect(draftValue()).toBe('');
    expect(view.host.querySelector('[data-testid="omo-send"]')?.getAttribute('disabled')).not.toBeNull();
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('uncertain submissions keep the draft and cannot be replayed automatically', async () => {
  const h = nativeHarness();
  await h.select();
  h.responseStatus(503);
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await type('[data-testid="omo-composer"]', 'UNCERTAIN_SENTINEL');
    await click('[data-testid="omo-send"]');
    expect(view.host.querySelector('[data-mutation-status="uncertain"]')).not.toBeNull();
    expect(draftValue()).toBe('UNCERTAIN_SENTINEL');
    await click('[data-testid="omo-send"]');
    expect(h.commands).toHaveLength(1);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('terminal ownership disables mutations and failed reads retain rendered history', async () => {
  const snapshot = nativeSnapshot();
  snapshot.ownership = 'terminal';
  snapshot.activeBranch = { leafId: 'u', entries: [{ type: 'message', id: 'u', parentId: null, timestamp: '2026-10-01T00:00:00Z',
    message: { role: 'user', content: 'RETAINED_SENTINEL', timestamp: 1 } }] };
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    expect(view.host.querySelector('[data-testid="omo-read-only"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="omo-draft"] .cm-content')?.getAttribute('contenteditable')).toBe('false');
    h.readStatus(503);
    await act(async () => { await h.store.refresh(); });
    expect(view.host.textContent).toContain('RETAINED_SENTINEL');
    expect(view.host.querySelector('[data-testid="omo-connection-notice"]')).not.toBeNull();
    await click('[data-testid="omo-send"]');
    expect(h.commands).toHaveLength(0);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('streaming does not rerender a primitive model consumer or global dialogs', async () => {
  const h = nativeHarness();
  await h.select();
  let renders = 0;
  function ModelLeaf() {
    const model = useNativeSlice(h.store, 'chat-a', (session) => session?.snapshot?.state.model);
    renders += 1;
    return <output>{model?.id}</output>;
  }
  const view = await mount(<><ModelLeaf /><NativeDialogs store={h.store} sessionKey="chat-a" /></>);
  try {
    const before = renders;
    await h.native({ type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } });
    await h.native({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'DELTA_SENTINEL' } });
    expect(renders).toBe(before);
    await h.native({ type: 'model_changed', model: { provider: 'provider-b', id: 'model-b' }, thinkingLevel: 'high' });
    expect(renders).toBe(before + 1);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('empty selection renders guidance without a duplicate creation composer', async () => {
  const h = nativeHarness();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey={null} />);
  try {
    expect(view.host.querySelector('[data-testid="omo-chat-empty"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="omo-composer"]')).toBeNull();
    expect(h.commands).toHaveLength(0);
  } finally { await view.cleanup(); await h.store.dispose(); }
});
test('native markdown keeps original rich rendering without arming file links or decoration media', async () => {
  // Given native text containing HTTP, local-file, app links and an image.
  const imagePrototype = browser.HTMLImageElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(imagePrototype, 'src');
  assert(descriptor?.set);
  const setter = descriptor.set;
  const media: string[] = [];
  Object.defineProperty(imagePrototype, 'src', { ...descriptor, set(value: string) { media.push(value); setter.call(this, value); } });
  const { NativeMarkdown } = await import('./NativeContent');
  let view: Awaited<ReturnType<typeof mount>> | undefined;
  try {
    view = await mount(<NativeMarkdown text="[SAFE_SENTINEL](https://example.com) [LOCAL_SENTINEL](file:///workspace/private.ts) [APP_SENTINEL](openchamber://command) ![IMAGE_SENTINEL](https://example.com/image.png)" />);
    const host = view.host;
    // When the actual original async block renderer finishes.
    await untilDOM(host, () => Boolean(host.querySelector('a[href="https://example.com"]')));
    // Then only a safe ordinary link is armed; no detached favicon was created.
    expect(view.host.querySelector('a[href="https://example.com"]')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(view.host.querySelector('a[href^="file:"], a[href^="openchamber:"]')).toBeNull();
    expect(view.host.querySelector('img')).toBeNull();
    expect(media).toEqual([]);
    expect(view.host.textContent).toContain('LOCAL_SENTINEL');
  } finally { await view?.cleanup(); Object.defineProperty(imagePrototype, 'src', descriptor); }
});
