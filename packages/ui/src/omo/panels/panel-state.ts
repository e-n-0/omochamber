import { useRef, useState, useSyncExternalStore } from 'react';
import type { NativeCommand } from '../contracts';
import { NativeStateError } from '../state';
import type { NativeStore, NativeStoreState } from '../state';
import { NativeClientError } from '../client';

/** Select only primitives or store-owned references, never a newly allocated slice. */
export function usePanelSlice<T>(store: NativeStore, select: (state: NativeStoreState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()), () => select(store.getState()));
}

export function canControl(store: NativeStore, sessionKey: string): boolean {
  const state = store.getState();
  const session = state.sessions.get(sessionKey);
  return state.selectedSessionKey === sessionKey && session?.status === 'ready'
    && session.snapshot?.connection === 'connected' && session.snapshot.ownership === 'hosted';
}

export function usePanelAction(store: NativeStore, sessionKey: string) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const submitting = useRef(false);
  const mutation = usePanelSlice(store, (state) => requestId
    ? state.sessions.get(sessionKey)?.mutations.get(requestId) ?? null : null);
  const busy = submitting.current || mutation?.status === 'submitting' || mutation?.status === 'accepted';

  async function execute(command: NativeCommand) {
    if (submitting.current || busy) return;
    if (!canControl(store, sessionKey)) {
      setError(new NativeStateError('not-ready'));
      return;
    }
    submitting.current = true;
    setError(null);
    const id = crypto.randomUUID();
    setRequestId(id);
    try {
      await store.execute(command, id);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native command failed', null, { cause }));
    } finally {
      submitting.current = false;
    }
  }

  return { execute, busy, mutation, error };
}
