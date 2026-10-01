import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { NativeStore } from '../state';
import { useNativeSlice } from './nativeHooks';
import { nativeErrorCopy } from '../error-copy';

export function NativeConnectionNotice({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const status = useNativeSlice(store, sessionKey, (session) => session?.status);
  const error = useNativeSlice(store, sessionKey, (session) => session?.error);
  const ownership = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.ownership);
  return <div className="space-y-2 px-4 pt-3 typography-meta">
    {status !== 'ready' && <div role="status" data-testid="omo-connection-notice" className="flex flex-wrap items-center gap-2 text-muted-foreground">
      <span>{t(status === 'reconnecting' ? 'omo.chat.reconnecting' : status === 'unavailable' ? 'omo.chat.unavailable' : 'common.loading')}</span>
      {status === 'unavailable' && <Button variant="outline" size="xs" onClick={() => { void store.reconnect(); }}>
        {t('chat.container.sessionLoadError.retry')}
      </Button>}
    </div>}
    {error && <p role="alert" className="break-words text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
    {ownership && ownership !== 'hosted' && <p role="status" data-testid="omo-read-only" className="text-muted-foreground">{t('omo.chat.readOnly')}</p>}
  </div>;
}

export function NativeMutationNotice({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const mutations = useNativeSlice(store, sessionKey, (session) => session?.mutations);
  return <div className="space-y-2 typography-meta">{mutations && [...mutations.values()]
    .filter((mutation) => !mutation.interactionId && mutation.status !== 'succeeded').map((mutation) => {
      switch (mutation.status) {
        case 'succeeded': return null;
        case 'submitting':
        case 'accepted': return <p key={mutation.requestId} role="status" data-mutation-status={mutation.status} className="text-muted-foreground">
          {t(mutation.status === 'submitting' ? 'omo.chat.submitting' : 'omo.chat.accepted')}
        </p>;
        case 'uncertain':
        case 'failed': return <div key={mutation.requestId} role="alert" data-mutation-status={mutation.status}
          className={mutation.status === 'uncertain' ? 'text-[var(--status-warning-text)]' : 'text-[var(--status-error-text)]'}>
          <p>{t(mutation.status === 'uncertain' ? 'omo.chat.uncertain' : 'omo.chat.failed')}</p>
          <p className="whitespace-pre-wrap break-words">{nativeErrorCopy(mutation.error, t)}</p>
        </div>;
        default: return mutation satisfies never;
      }
    })}</div>;
}
