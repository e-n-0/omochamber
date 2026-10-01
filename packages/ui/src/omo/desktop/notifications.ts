import { useEffect, useState } from 'react';
import { useNativeDesktop } from './context';

export type NativeRequestNotification =
  | { readonly status: 'supported' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'failed'; readonly error: Error };
export type RequestNotifications = Map<string, Promise<NativeRequestNotification>>;

/** The dialog root owns this pending-only ledger, including tab/session revisits. */
export function useNativeRequestNotification(
  requests: RequestNotifications, interactionId: string, enabled: boolean, body: string,
): NativeRequestNotification | null {
  const desktop = useNativeDesktop();
  const [result, setResult] = useState<NativeRequestNotification | null>(null);
  useEffect(() => {
    if (!desktop || !enabled) return;
    let request = requests.get(interactionId);
    if (!request) {
      request = desktop.notify({ title: 'OmoChamber', body }).then(
        (reply): NativeRequestNotification => ({ status: reply.supported ? 'supported' : 'unsupported' }),
        (cause): NativeRequestNotification => ({
          status: 'failed', error: cause instanceof Error ? cause : new Error('Native notification failed', { cause }),
        }),
      );
      // Record before subscribing. StrictMode effect replay reuses this promise.
      requests.set(interactionId, request);
    }
    let active = true;
    void request.then((notice) => { if (active) setResult(notice); });
    return () => { active = false; };
  }, [desktop, requests, interactionId, enabled, body]);
  return result;
}
