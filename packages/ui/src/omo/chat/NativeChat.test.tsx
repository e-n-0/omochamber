import { expect, test } from 'bun:test';
import { act } from 'react';
import { browser, click, mount, nativeHarness, nativeSnapshot, type } from './chatTestFixture';

const { NativeChat } = await import('./NativeChat');
const { NativeDialogs } = await import('./NativeDialogs');
const { useNativeSlice } = await import('./nativeHooks');

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
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    expect(view.host.querySelector('strong')?.textContent).toBe('MARKDOWN_SENTINEL');
    expect(view.host.querySelector('pre code')?.textContent).toContain('const answer = 42;');
    expect(view.host.querySelector('script')).toBeNull();
    expect(view.host.querySelector('[data-testid="omo-reasoning"]')?.textContent).toContain('REASONING_SENTINEL');
    expect(view.host.querySelector('[data-message-role="toolResult"]')?.textContent).toContain('TOOL_SENTINEL');
    expect(view.host.querySelectorAll('img')).toHaveLength(1);
    expect(view.host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,aW1hZ2U=');
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
    const field = view.host.querySelector('[data-testid="omo-composer"]');
    expect(field).toBeInstanceOf(browser.HTMLTextAreaElement);
    expect(field?.getAttribute('disabled')).not.toBeNull();
    expect(view.host.querySelector('[data-mutation-status="accepted"]')).not.toBeNull();
    await h.result(h.commands[0].requestId);
    expect(view.host.querySelector('textarea')?.value).toBe('');
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
    expect(view.host.querySelector('textarea')?.value).toBe('UNCERTAIN_SENTINEL');
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
    expect(view.host.querySelector('textarea')?.disabled).toBe(true);
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
