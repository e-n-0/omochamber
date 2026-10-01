import type { NativeClient } from '../client';
import { NativeClientError } from '../client';
import type { NativeAppearance } from './context';
import type { SettingsUpdate } from '../contracts';
import { settingsUpdateSchema } from '../contracts';

export class NativeAppearanceError extends Error {
  readonly name = 'NativeAppearanceError';
  constructor(readonly kind: 'not-ready' | 'invalid-settings' | 'owner-changed', options?: ErrorOptions) {
    super(`Native appearance operation refused: ${kind}`, options);
  }
}

/** Settings writes are explicit and serialized; hydration never writes defaults. */
export function createAppearanceController(client: NativeClient) {
  const runtimeKey = client.runtimeKey();
  const listeners = new Set<() => void>();
  let disposed = false;
  let revision = 0;
  let readGeneration = 0;
  let pending = 0;
  let writes: Promise<void> = Promise.resolve();
  let readAbort: AbortController | null = null;
  let state: NativeAppearance;
  const current = () => !disposed && runtimeKey === client.runtimeKey();
  const asError = (cause: unknown) => cause instanceof Error ? cause
    : new NativeClientError('transport', 'Native settings failed', null, { cause });
  function publish(next: NativeAppearance) {
    if (!current()) return;
    state = next;
    for (const listener of listeners) listener();
  }
  async function reload(): Promise<void> {
    readAbort?.abort();
    const abort = new AbortController();
    readAbort = abort;
    const generation = ++readGeneration;
    const startedAt = revision;
    try {
      const settings = await client.settings(abort.signal);
      if (current() && generation === readGeneration && startedAt === revision) {
        publish({ ...state, settings, status: 'ready', error: null });
      }
    } catch (cause) {
      if (!current() || generation !== readGeneration || startedAt !== revision) return;
      const error = asError(cause);
      publish({ ...state, status: 'unavailable', error });
      throw error;
    }
  }
  function updateSettings(input: SettingsUpdate): Promise<void> {
    if (!current() || state.status !== 'ready') return Promise.reject(new NativeAppearanceError('not-ready'));
    let patch: SettingsUpdate;
    try { patch = settingsUpdateSchema.parse(input); }
    catch (cause) { return Promise.reject(new NativeAppearanceError('invalid-settings', { cause })); }
    // Match the native settings boundary rather than silently clamping a choice.
    if ((patch.fontSize !== undefined && patch.fontSize > 100)
      || (patch.fontFamily !== undefined && (!patch.fontFamily.trim() || patch.fontFamily.trim().length > 200))
      || (patch.theme !== undefined && (!patch.theme.trim() || patch.theme.trim().length > 100))) {
      return Promise.reject(new NativeAppearanceError('invalid-settings'));
    }
    const changed = (patch.theme !== undefined && patch.theme !== state.settings.theme)
      || (patch.fontSize !== undefined && patch.fontSize !== state.settings.fontSize)
      || (patch.fontFamily !== undefined && patch.fontFamily !== state.settings.fontFamily)
      || (patch.layout !== undefined && patch.layout !== state.settings.layout);
    if (pending === 0 && !changed) {
      return Promise.resolve();
    }
    revision += 1;
    pending += 1;
    publish({ ...state, saving: true, error: null });
    const operation = writes.then(async () => {
      if (!current()) throw new NativeAppearanceError('owner-changed');
      const settings = await client.updateSettings(patch);
      revision += 1;
      publish({ ...state, settings, status: 'ready', error: null });
    }).catch((cause) => {
      const error = asError(cause);
      publish({ ...state, error });
      throw error;
    }).finally(() => {
      pending -= 1;
      publish({ ...state, saving: pending > 0 });
    });
    // A failed write must reject its caller without blocking the next choice.
    writes = operation.catch(() => {});
    return operation;
  }
  state = {
    settings: { schemaVersion: 1 }, status: 'loading', error: null, saving: false,
    updateSettings, reload,
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      disposed = false;
      return reload();
    },
    dispose() {
      disposed = true;
      readAbort?.abort();
      listeners.clear();
    },
  };
}
