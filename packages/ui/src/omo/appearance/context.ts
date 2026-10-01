import { createContext, useContext } from 'react';
import type { NativeSettings, SettingsUpdate } from '../contracts';

export interface NativeAppearance {
  readonly settings: NativeSettings;
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly error: Error | null;
  readonly saving: boolean;
  updateSettings(patch: SettingsUpdate): Promise<void>;
  reload(): Promise<void>;
}

export const NativeAppearanceContext = createContext<NativeAppearance | undefined>(undefined);

/** Native shell controls share the provider's settings authority, not UIStore. */
export function useOmoAppearance(): NativeAppearance {
  const appearance = useContext(NativeAppearanceContext);
  if (!appearance) throw new Error('Native appearance provider is missing');
  return appearance;
}
