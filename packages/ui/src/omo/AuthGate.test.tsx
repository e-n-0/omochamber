import { expect, test } from 'bun:test';
import { act } from 'react';
import { click, mount, type } from './chat/chatTestFixture';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';

const { AuthGate } = await import('./AuthGate');

test('does not mount the workspace before same-origin authentication is established', async () => {
  // Given a password-protected native runtime.
  const calls: { path: string; options?: RuntimeFetchOptions }[] = [];
  const fetchSession = async (path: string, options?: RuntimeFetchOptions) => {
    calls.push({ path, options });
    return Response.json(options?.method === 'POST' ? { authenticated: true } : { authenticated: false }, {
      status: options?.method === 'POST' ? 200 : 401,
    });
  };
  const view = await mount(<AuthGate fetchSession={fetchSession}><div data-testid="protected-workspace" /></AuthGate>);
  try {
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).toBeNull();
    await type('[data-testid="omo-auth-password"]', 'PASSWORD_FIXTURE');
    // When the user explicitly unlocks.
    await click('[data-testid="omo-auth-unlock"]');
    // Then native cookie auth gates the mount and no client token is requested.
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).not.toBeNull();
    expect(calls.map((call) => call.path)).toEqual(['/auth/session', '/auth/session']);
    expect(calls.map((call) => call.options?.credentials)).toEqual(['same-origin', 'same-origin']);
    expect(JSON.parse(String(calls[1].options?.body))).toEqual({ password: 'PASSWORD_FIXTURE' });
    expect(localStorage.length).toBe(0);
  } finally { await view.cleanup(); }
});

test('keeps a rejected password private and allows an explicit later attempt', async () => {
  // Given a native login that rejects the first password.
  let posts = 0;
  const fetchSession = async (_path: string, options?: RuntimeFetchOptions) => {
    if (options?.method !== 'POST') return Response.json({ authenticated: false }, { status: 401 });
    posts += 1;
    return Response.json({ authenticated: posts > 1 }, { status: posts > 1 ? 200 : 401 });
  };
  const view = await mount(<AuthGate fetchSession={fetchSession}><div data-testid="protected-workspace" /></AuthGate>);
  try {
    await type('[data-testid="omo-auth-password"]', 'REJECTED_FIXTURE');
    // When the password is rejected.
    await click('[data-testid="omo-auth-unlock"]');
    // Then the workspace stays gated and the password is cleared.
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.host.querySelector('input')?.value).toBe('');
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).toBeNull();
    await type('[data-testid="omo-auth-password"]', 'ACCEPTED_FIXTURE');
    await click('[data-testid="omo-auth-unlock"]');
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).not.toBeNull();
    expect(posts).toBe(2);
  } finally { await view.cleanup(); }
});

test('fails closed on malformed successful authentication without mounting native children', async () => {
  const view = await mount(<AuthGate fetchSession={async () => Response.json({ disabled: true })}>
    <div data-testid="protected-workspace" />
  </AuthGate>);
  try {
    expect(view.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).toBeNull();
  } finally { await view.cleanup(); }
});

test('aborts a pending status check when the native gate unmounts', async () => {
  const signals: AbortSignal[] = [];
  const view = await mount(<AuthGate fetchSession={async (_path, options) => {
    if (options?.signal) signals.push(options.signal);
    return new Promise<Response>((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  }}><div /></AuthGate>);
  await act(async () => { await view.cleanup(); });
  expect(signals[0]?.aborted).toBe(true);
});

test('confirmed cookie expiry gates the workspace again and native login restores it', async () => {
  // Given an authenticated native workspace.
  const view = await mount(<AuthGate fetchSession={async () => Response.json({ authenticated: true })}>
    <div data-testid="protected-workspace" />
  </AuthGate>);
  try {
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).not.toBeNull();
    // When the shared transport confirms cookie expiry.
    await act(async () => useAuthSessionStore.getState().markExpired());
    // Then the native password gate returns without a provider credential flow.
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).toBeNull();
    await type('[data-testid="omo-auth-password"]', 'REAUTH_FIXTURE');
    await click('[data-testid="omo-auth-unlock"]');
    expect(view.host.querySelector('[data-testid="protected-workspace"]')).not.toBeNull();
    expect(useAuthSessionStore.getState().state).toBe('ok');
  } finally { await view.cleanup(); useAuthSessionStore.getState().markAuthenticated(); }
});
