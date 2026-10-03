import type { NativeClient } from '../client';
import type { NativeStore } from '../state';
import { NativeWorkStatusPanel } from './NativeWorkStatusPanel';

export function NativePanels(props: { readonly client: NativeClient; readonly store: NativeStore; readonly sessionKey: string | null }) {
  return <NativeWorkStatusPanel {...props} visible />;
}
