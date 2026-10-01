import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { click, mount, nativeHarness, nativeSnapshot, type } from './chatTestFixture';

const { NativeChat } = await import('./NativeChat');

async function pick(selector: string, index: number) {
  await click(selector);
  const popupId = document.querySelector(selector)?.getAttribute('aria-controls');
  assert(popupId, 'Native picker must identify its own popup');
  const option = document.getElementById(popupId)?.querySelectorAll('[role="option"]')[index];
  assert(option instanceof HTMLElement, `Missing native option ${index}`);
  await act(async () => option.focus());
  await act(async () => option.click());
}

test('model and thinking commands use native identities and selected values wait for native events', async () => {
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
    await pick('[data-testid="omo-thinking"]', 1);
    expect(h.commands[1].command).toEqual({ type: 'setThinking', level: 'high' });
    expect(h.store.getState().sessions.get('chat-a')?.snapshot?.state.thinkingLevel).toBe('medium');
    await h.native({ type: 'model_changed', model: { provider: 'provider-b', id: 'model-b' }, thinkingLevel: 'high' });
    expect(h.store.getState().sessions.get('chat-a')?.snapshot?.state.thinkingLevel).toBe('high');
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
    const field = view.host.querySelector('textarea');
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
    expect(view.host.querySelector('textarea')?.value).toBe('REJECTED_SENTINEL');
    expect(view.host.querySelector('textarea')?.disabled).toBe(false);
    await click('[data-testid="omo-send"]');
    expect(h.commands).toHaveLength(2);
    expect(h.commands[1].requestId).not.toBe(h.commands[0].requestId);
  } finally { await view.cleanup(); await h.cleanup(); }
});
