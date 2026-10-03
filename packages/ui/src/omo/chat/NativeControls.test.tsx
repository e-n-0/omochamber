import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { click, draftValue, mount, nativeHarness, nativeSnapshot, type } from './chatTestFixture';

const { NativeChat } = await import('./NativeChat');

async function pick(selector: string, index: number) {
  await click(selector);
  const popupId = document.querySelector(selector)?.getAttribute('aria-controls');
  assert(popupId, 'Native picker must identify its own popup');
  const option = document.getElementById(popupId)?.querySelectorAll('[role="menuitem"], [role="option"]')[index];
  assert(option instanceof HTMLElement, `Missing native option ${index}`);
  await act(async () => option.focus());
  await act(async () => option.click());
}

test('model commands use native identities and selected values wait for native events', async () => {
  const h = nativeHarness();
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await pick('[data-testid="omo-model"]', 1);
    expect(h.commands[0].command).toEqual({ type: 'setModel', provider: 'provider-b', id: 'model-b' });
    expect(view.host.querySelector('[data-testid="omo-model"]')?.textContent).toContain('Model A');
    await h.result(h.commands[0].requestId);
    await h.native({ type: 'model_changed', model: { provider: 'provider-b', id: 'model-b' }, thinkingLevel: 'medium' });
    expect(view.host.querySelector('[data-testid="omo-model"]')?.textContent).toContain('Model B');
  } finally { await view.cleanup(); await h.cleanup(); }
});
for (const scenario of [
  { name: 'model', selector: '[data-testid="omo-model"]', command: { type: 'setModel', provider: 'provider-b', id: 'model-b' } },
  { name: 'thinking', selector: '[data-testid="omo-thinking"]', command: { type: 'setThinking', level: 'high' } },
]) {
  test(`retains one ${scenario.name} intent across synchronous duplicate selection and accepted response`, async () => {
    // Given a connected owner and a mounted original picker.
    const h = nativeHarness();
    await h.select();
    const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
    try {
      await click(scenario.selector);
      const popupId = document.querySelector(scenario.selector)?.getAttribute('aria-controls');
      assert(popupId);
      const item = document.getElementById(popupId)?.querySelectorAll('[role="menuitem"]')[1];
      assert(item instanceof HTMLElement);
      // When the same mounted handler receives two events before React commits.
      await act(async () => { item.click(); item.click(); });
      // Then one accepted native request is retained, without optimistic selection.
      expect(h.commands).toHaveLength(1);
      expect(h.commands[0].command).toEqual(scenario.command);
      expect(h.store.getState().sessions.get('chat-a')?.mutations.get(h.commands[0].requestId)?.status).toBe('accepted');
      expect(view.host.querySelector(scenario.selector)?.getAttribute('aria-disabled')).toBe('true');
    } finally { await view.cleanup(); await h.cleanup(); }
  });
}

test('retains one abort intent across synchronous duplicate clicks and accepted response', async () => {
  // Given a connected native session that is streaming.
  const snapshot = nativeSnapshot();
  snapshot.state.isStreaming = true;
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    const button = view.host.querySelector('[data-testid="omo-abort"]');
    assert(button instanceof HTMLButtonElement);
    // When the original stop control is clicked twice before React commits.
    await act(async () => { button.click(); button.click(); });
    // Then acceptance retains the request lock until native completion.
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0].command).toEqual({ type: 'abort' });
    expect(h.store.getState().sessions.get('chat-a')?.mutations.get(h.commands[0].requestId)?.status).toBe('accepted');
    expect(button.disabled).toBe(true);
  } finally { await view.cleanup(); await h.cleanup(); }
});


test('selecting Low thinking replaces High only after the authoritative correlated native result', async () => {
  const snapshot = nativeSnapshot();
  snapshot.state.thinkingLevel = 'high';
  snapshot.state.availableThinkingLevels = ['low', 'high'];
  const h = nativeHarness(snapshot);
  const subscribe = h.client.subscribe;
  h.client.subscribe = (key, listener, signal) => subscribe(key, (event) => {
    // set_thinking_level acknowledges without data. The backend reads get_state
    // and supplies thinkingLevel in commandResult, not a model_changed event.
    listener(event.type === 'commandResult' && event.result.success
      ? { ...event, result: { ...event.result, data: { thinkingLevel: 'low' } } }
      : event);
  }, signal);
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await pick('[data-testid="omo-thinking"]', 0);
    const command = h.commands[0];
    assert(command);
    expect(command.command).toEqual({ type: 'setThinking', level: 'low' });
    expect(view.host.querySelector('[data-testid="omo-thinking"]')?.textContent).toBe('High');
    expect(h.store.getState().sessions.get('chat-a')?.mutations.get(command.requestId)?.status).toBe('accepted');
    await h.result(command.requestId);
    expect(h.store.getState().sessions.get('chat-a')?.mutations.get(command.requestId)).toMatchObject({
      status: 'succeeded', result: { data: { thinkingLevel: 'low' } },
    });
    expect(view.host.querySelector('[data-testid="omo-thinking"]')?.textContent).toBe('Low');
    expect(h.store.getState().sessions.get('chat-a')?.snapshot?.state.model).toEqual(snapshot.state.model);
    expect(h.store.getState().sessions.get('chat-a')?.snapshot?.state.thinkingLevel).toBe('low');
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('a native thinking refusal preserves High and the selected model', async () => {
  const snapshot = nativeSnapshot();
  snapshot.state.thinkingLevel = 'high';
  snapshot.state.availableThinkingLevels = ['low', 'high'];
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await pick('[data-testid="omo-thinking"]', 0);
    const command = h.commands[0];
    assert(command);
    expect(command.command).toEqual({ type: 'setThinking', level: 'low' });
    await h.result(command.requestId, false);
    expect(view.host.querySelector('[data-mutation-status="failed"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="omo-thinking"]')?.textContent).toBe('High');
    expect(h.store.getState().sessions.get('chat-a')?.snapshot?.state.model).toEqual(snapshot.state.model);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('busy composer supports follow-up, steer, and abort without pretending low-level end is settled', async () => {
  const snapshot = nativeSnapshot();
  snapshot.state.isStreaming = true;
  const h = nativeHarness(snapshot);
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await type('[data-testid="omo-composer"]', 'FOLLOWUP_SENTINEL');
    await click('[data-testid="omo-send"]');
    expect(h.commands[0].command).toEqual({ type: 'followUp', text: 'FOLLOWUP_SENTINEL' });
    await h.result(h.commands[0].requestId);
    await pick('[data-testid="omo-send-mode"]', 0);
    await type('[data-testid="omo-composer"]', 'STEER_SENTINEL');
    await click('[data-testid="omo-send"]');
    expect(h.commands[1].command).toEqual({ type: 'steer', text: 'STEER_SENTINEL' });
    await click('[data-testid="omo-abort"]');
    expect(h.commands[2].command).toEqual({ type: 'abort' });
    await h.native({ type: 'agent_end' });
    expect(view.host.querySelector('[data-testid="omo-abort"]')).not.toBeNull();
    await h.native({ type: 'agent_settled' });
    expect(view.host.querySelector('[data-testid="omo-abort"]')).toBeNull();
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('IME confirmation, Shift+Enter and repeated Enter do not submit unintended native prompts', async () => {
  const h = nativeHarness();
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await type('[data-testid="omo-composer"]', 'IME_SENTINEL');
    const field = view.host.querySelector('[data-testid="omo-draft"] .cm-content');
    assert(field);
    const key = (options: KeyboardEventInit) => act(async () => {
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...options }));
    });
    await key({ isComposing: true });
    await key({ keyCode: 229 });
    await key({ shiftKey: true });
    await key({ repeat: true });
    expect(h.commands).toHaveLength(0);
    await key({});
    expect(h.commands).toHaveLength(1);
  } finally { await view.cleanup(); await h.cleanup(); }
});

test('a correlated native failure retains the draft and re-enables a deliberate retry', async () => {
  const h = nativeHarness();
  await h.select();
  const view = await mount(<NativeChat client={h.client} store={h.store} sessionKey="chat-a" />);
  try {
    await type('[data-testid="omo-composer"]', 'REJECTED_SENTINEL');
    await click('[data-testid="omo-send"]');
    await h.result(h.commands[0].requestId, false);
    expect(view.host.querySelector('[data-mutation-status="failed"]')).not.toBeNull();
    expect(draftValue()).toBe('REJECTED_SENTINEL');
    expect(view.host.querySelector('[data-testid="omo-draft"] .cm-content')?.getAttribute('contenteditable') !== 'true').toBe(false);
    await click('[data-testid="omo-send"]');
    expect(h.commands).toHaveLength(2);
    expect(h.commands[1].requestId).not.toBe(h.commands[0].requestId);
  } finally { await view.cleanup(); await h.cleanup(); }
});
