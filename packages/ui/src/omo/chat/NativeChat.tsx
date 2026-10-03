import { useI18n } from '@/lib/i18n';
import type { NativeClient } from '../client';
import type { NativeStore } from '../state';
import { NativeComposer } from './NativeComposer';
import { NativeConnectionNotice } from './NativeFeedback';
import { NativeTranscript } from './NativeTranscript';

export function NativeChat({ store, sessionKey, floatingComposer = false }: {
  readonly client: NativeClient;
  readonly store: NativeStore;
  readonly sessionKey: string | null;
  readonly floatingComposer?: boolean;
}) {
  const { t } = useI18n();
  const [composerNode, setComposerNode] = useState<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const composerRef = useCallback((node: HTMLDivElement | null) => setComposerNode(node), []);
  useEffect(() => {
    if (!composerNode || !floatingComposer) return;
    const measure = () => setComposerHeight(composerNode.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composerNode);
    return () => observer.disconnect();
  }, [composerNode, floatingComposer]);
  if (!sessionKey) return <section className="flex min-h-0 flex-1 items-center justify-center p-6" data-testid="omo-chat-empty">
    <div className="max-w-md space-y-2 text-center">
      <h2 className="typography-markdown font-medium">{t('omo.chat.emptyTitle')}</h2>
      <p className="typography-meta text-muted-foreground">{t('omo.chat.emptyDescription')}</p>
    </div>
  </section>;
  return <section key={sessionKey} className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="omo-chat">
    <ChatColumnView>
      <NativeConnectionNotice store={store} sessionKey={sessionKey} />
      <NativeTranscript store={store} sessionKey={sessionKey} composerOverlayHeight={floatingComposer ? composerHeight : 0} />
      <ChatComposerSlotView ref={composerRef} floatingComposer={floatingComposer}>
        <NativeComposer store={store} sessionKey={sessionKey} />
      </ChatComposerSlotView>
    </ChatColumnView>
  </section>;
}
import { useCallback, useEffect, useState } from 'react';
import { ChatColumnView, ChatComposerSlotView } from '@/components/chat/presentation/ChatColumnView';
