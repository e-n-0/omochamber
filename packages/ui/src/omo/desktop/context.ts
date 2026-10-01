import { createContext, useContext } from 'react';
import type { NativeDesktopCapabilities } from './adapter';

export const NativeDesktopContext = createContext<NativeDesktopCapabilities | undefined>(undefined);

/** Only the native runtime adapter supplies desktop privileges. */
export function useNativeDesktop(): NativeDesktopCapabilities | undefined {
  return useContext(NativeDesktopContext);
}
