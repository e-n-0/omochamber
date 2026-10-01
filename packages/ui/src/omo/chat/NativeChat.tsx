import { useI18n } from '@/lib/i18n';
import type { NativeClient } from '../client';
import type { NativeStore } from '../state';
import { NativeComposer } from './NativeComposer';
import { NativeConnectionNotice } from './NativeFeedback';
import { NativeTranscript } from './NativeTranscript';

export function NativeChat({ store, sessionKey }: {
  readonly client: NativeClient;
  readonly store: NativeStore;
  readonly sessionKey: string | null;
}) {
  const { t } = useI18n();
  if (!sessionKey) return <section className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid="omo-chat-empty">
    <div className="max-w-md space-y-2 text-center">
      <h2 className="typography-markdown font-medium">{t('omo.chat.emptyTitle')}</h2>
      <p className="typography-meta text-muted-foreground">{t('omo.chat.emptyDescription')}</p>
    </div>
  </section>;
  return <section key={sessionKey} className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="omo-chat">
    <NativeConnectionNotice store={store} sessionKey={sessionKey} />
    <NativeTranscript store={store} sessionKey={sessionKey} />
    <NativeComposer store={store} sessionKey={sessionKey} />
  </section>;
}
