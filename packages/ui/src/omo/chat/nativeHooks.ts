import { useCallback, useSyncExternalStore } from 'react';
import type { NativeSessionState, NativeStore } from '../state';

/** Select an existing reference or primitive, never an allocated aggregate. */
export function useNativeSlice<T>(
  store: NativeStore,
  sessionKey: string | null,
  select: (session: NativeSessionState | undefined) => T,
): T {
  const read = useCallback(() => {
    const state = store.getState();
    return select(sessionKey && state.selectedSessionKey === sessionKey ? state.sessions.get(sessionKey) : undefined);
  }, [store, sessionKey, select]);
  return useSyncExternalStore(store.subscribe, read, read);
}

export function useNativeWritable(store: NativeStore, sessionKey: string | null): boolean {
  return useNativeSlice(store, sessionKey, (session) =>
    session?.status === 'ready' && session.snapshot?.connection === 'connected' && session.snapshot.ownership === 'hosted');
}
