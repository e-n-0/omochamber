import React from 'react';
import { ChatTranscriptView, ChatMessageView } from '@/components/chat/presentation/ChatTranscriptView';
import type { LegendListRef } from '@legendapp/list/react';
import { useI18n } from '@/lib/i18n';
import type { NativeEntry, NativeMessage } from '../contracts';
import type { NativeStore } from '../state';
import { NativeContent, NativeMarkdown } from './NativeContent';
import { useNativeSlice } from './nativeHooks';

const Message = React.memo(function Message({ message, messageId }: { readonly message: NativeMessage; readonly messageId: string }) {
  const { t } = useI18n();
  if (message.role === 'custom' && !message.display) return null;
  if (message.role === 'bashExecution') {
    return <section className="space-y-2" data-message-role={message.role}>
      <pre className="oc-surface-code overflow-auto whitespace-pre-wrap break-words typography-code">{message.command}</pre>
      <pre className="oc-surface-code max-h-96 overflow-auto whitespace-pre-wrap break-words typography-code">{message.output}</pre>
      {message.truncated && <p role="status" className="typography-meta text-[var(--status-warning-text)]">{t('chat.toolPart.outputTruncated')}</p>}
      {message.cancelled && <p className="typography-meta text-muted-foreground">{t('omo.chat.cancelled')}</p>}
      {message.exitCode !== undefined && <p className="typography-meta text-muted-foreground">{t('omo.chat.exitCode', { code: message.exitCode })}</p>}
    </section>;
  }
  return <ChatMessageView messageId={messageId} isUser={message.role === 'user'} role={message.role}>
    <header className="typography-meta font-medium text-muted-foreground">
      {message.role === 'toolResult' ? message.toolName : message.role === 'custom' ? message.customType
        : t(message.role === 'user' ? 'omo.chat.user' : 'omo.chat.assistant')}
    </header>
    {message.role === 'toolResult' && message.isError &&
      <p role="alert" className="typography-meta text-[var(--status-error-text)]">{t('omo.chat.toolError')}</p>}
    {Array.isArray(message.content) ? <NativeContent content={message.content} variant={message.role === 'user' ? 'user' : 'assistant'} /> : <NativeMarkdown text={message.content} variant={message.role === 'user' ? 'user' : 'assistant'} />}
    {message.role === 'assistant' && message.errorMessage &&
      <p role="alert" className="whitespace-pre-wrap break-words typography-meta text-[var(--status-error-text)]">{message.errorMessage}</p>}
  </ChatMessageView>;
});

const Entry = React.memo(function Entry({ entry }: { readonly entry: NativeEntry }) {
  const { t } = useI18n();
  switch (entry.type) {
    case 'message': return <Message message={entry.message} messageId={entry.id} />;
    case 'custom_message': return entry.display
      ? Array.isArray(entry.content) ? <NativeContent content={entry.content} /> : <NativeMarkdown text={entry.content} />
      : null;
    case 'compaction':
    case 'branch_summary': return <details className="rounded-lg border border-border p-3">
      <summary className="cursor-pointer typography-meta text-muted-foreground">
        {t(entry.type === 'compaction' ? 'omo.chat.compaction' : 'omo.chat.branchSummary')}
      </summary><div className="mt-3"><NativeMarkdown text={entry.summary} /></div>
    </details>;
    case 'custom':
    case 'model_change':
    case 'model_change_rejected':
    case 'configuration_update':
    case 'thinking_level_change':
    case 'session_info':
    case 'label': return null;
    default: return entry satisfies never;
  }
});

function LiveMessage({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const message = useNativeSlice(store, sessionKey, (session) => session?.liveMessage);
  const content = useNativeSlice(store, sessionKey, (session) => session?.liveContent);
  const streaming = useNativeSlice(store, sessionKey, (session) => Boolean(session?.snapshot?.state.isStreaming));
  const argumentsById = useNativeSlice(store, sessionKey, (session) => session?.toolArguments);
  if (!message || !content || (message.role === 'custom' && !message.display)) return null;
  return <ChatMessageView messageId="native-live-message" testId="omo-live-message" isUser={message.role === 'user'} role={message.role}>
    <header className="typography-meta font-medium text-muted-foreground">
      {message.role === 'toolResult' ? message.toolName : t(message.role === 'user' ? 'omo.chat.user' : 'omo.chat.assistant')}
    </header>
    <NativeContent content={content} toolArguments={argumentsById} isStreaming={streaming} />
    {message.role === 'assistant' && message.errorMessage &&
      <p role="alert" className="whitespace-pre-wrap break-words text-[var(--status-error-text)]">{message.errorMessage}</p>}
  </ChatMessageView>;
}

function LiveTools({ store, sessionKey, persisted }: {
  readonly store: NativeStore; readonly sessionKey: string; readonly persisted: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const tools = useNativeSlice(store, sessionKey, (session) => session?.tools);
  const liveResultId = useNativeSlice(store, sessionKey, (session) =>
    session?.liveMessage?.role === 'toolResult' ? session.liveMessage.toolCallId : null);
  return <>{tools && [...tools.values()].filter((tool) => !persisted.has(tool.toolCallId) && tool.toolCallId !== liveResultId).map((tool) =>
    <section key={tool.toolCallId} data-testid="omo-live-tool" data-tool-status={tool.status} className="space-y-2 rounded-lg border border-border p-3">
      <header className="flex flex-wrap items-center gap-2 typography-meta">
        <span className="font-medium">{tool.toolName}</span>
        <span className={tool.status === 'error' ? 'text-[var(--status-error-text)]' : 'text-muted-foreground'}>
          {t(tool.status === 'running' ? 'omo.chat.toolRunning' : tool.status === 'error' ? 'omo.chat.toolError' : 'omo.chat.toolCompleted')}
        </span>
      </header><NativeContent content={tool.content} />
    </section>)}</>;
}

const emptyEntries: NativeEntry[] = [];
const entryKey = (entry: NativeEntry) => entry.id;
const entryType = (entry: NativeEntry) => entry.type;
const renderEntry = ({ item }: { readonly item: NativeEntry }) => <Entry entry={item} />;

function isVisibleEntry(entry: NativeEntry): boolean {
  switch (entry.type) {
    case 'message': return entry.message.role !== 'custom' || entry.message.display;
    case 'custom_message': return entry.display;
    case 'compaction':
    case 'branch_summary': return true;
    case 'custom':
    case 'model_change':
    case 'model_change_rejected':
    case 'configuration_update':
    case 'thinking_level_change':
    case 'session_info':
    case 'label': return false;
    default: return entry satisfies never;
  }
}

export function NativeTranscript({ store, sessionKey, composerOverlayHeight = 0 }: {
  readonly store: NativeStore; readonly sessionKey: string; readonly composerOverlayHeight?: number;
}) {
  const { t } = useI18n();
  const entries = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.activeBranch.entries);
  const visibleEntries = React.useMemo(() => entries?.filter(isVisibleEntry) ?? emptyEntries, [entries]);
  const persistedTools = React.useMemo(() => new Set(entries?.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message.toolCallId] : [])), [entries]);
  const ready = useNativeSlice(store, sessionKey, (session) => session?.status === 'ready');
  const busy = useNativeSlice(store, sessionKey, (session) => Boolean(session?.snapshot?.state.isStreaming));
  const list = React.useRef<LegendListRef | null>(null);
  // NativeChat keys this subtree by sessionKey. A reopened session gets a new
  // positioning phase; refreshes of the same mounted history do not.
  const historyPosition = React.useRef<'pending' | 'positioning' | 'positioned'>('pending');
  const [endPinningReleased, setEndPinningReleased] = React.useState(false);
  const endPinningReleasedRef = React.useRef(false);
  const releaseEndPin = React.useCallback((released: boolean) => {
    endPinningReleasedRef.current = released;
    setEndPinningReleased(released);
  }, []);
  const registerList = React.useCallback((value: LegendListRef | null) => { list.current = value; }, []);
  const onIsAtEndChange = React.useCallback((value: boolean) => {
    // Rewrapping can move the measured end without the reader moving at all.
    // Only actual scrolling below releases the pin; reaching the end rearms it.
    if (value && historyPosition.current === 'positioned') releaseEndPin(false);
  }, [releaseEndPin]);
  React.useLayoutEffect(() => {
    const value = list.current;
    const lastEntry = visibleEntries.at(-1);
    if (!value || !ready || !lastEntry) return;
    const node = value.getScrollableNode();
    if (!(node instanceof HTMLElement)) return;
    let previousScroll = node.scrollTop;
    const onScroll = () => {
      const scroll = node.scrollTop;
      const maximum = Math.max(0, node.scrollHeight - node.clientHeight);
      if (historyPosition.current === 'positioned') {
        if (scroll >= maximum) releaseEndPin(false);
        // A shrinking layout may clamp the old offset to its new maximum.
        // Movement farther into history is the reader taking over.
        else if (scroll < Math.min(previousScroll, maximum)) releaseEndPin(true);
      }
      previousScroll = scroll;
    };
    // Observe reader movement before scrolling mounts and measures older rows.
    node.addEventListener('scroll', onScroll, { capture: true, passive: true });
    const positionHistory = () => {
      if (historyPosition.current === 'positioning' || endPinningReleasedRef.current) return;
      if (historyPosition.current === 'positioned') {
        void value.scrollToEnd({ animated: false });
        return;
      }
      const state = value.getState();
      const index = state.indexByKey(lastEntry.id);
      if (index !== visibleEntries.length - 1 || !Number.isFinite(state.positionAtIndex(index))) return;
      historyPosition.current = 'positioning';
      void value.scrollToEnd({ animated: false }).then(() => {
        if (list.current === value) historyPosition.current = 'positioned';
      });
    };
    // Keep a held pin through measured rewraps and live footer growth, even
    // when the entries are unchanged. Hydration still waits for row positions.
    const state = value.getState();
    const unsubscribe = [
      state.listen('totalSize', positionHistory),
      state.listen('footerSize', positionHistory),
      state.listen('isAtEnd', (atEnd) => { if (!atEnd) positionHistory(); }),
    ];
    positionHistory();
    return () => {
      node.removeEventListener('scroll', onScroll, true);
      for (const stop of unsubscribe) stop();
    };
  }, [ready, releaseEndPin, visibleEntries]);
  const onTimelineDataChange = React.useCallback(() => {
    if (ready && historyPosition.current === 'positioned' && !endPinningReleasedRef.current) {
      void list.current?.scrollToEnd({ animated: false });
    }
  }, [ready]);
  return <ChatTranscriptView entries={visibleEntries} renderItem={renderEntry} keyExtractor={entryKey}
    getItemType={entryType} registerList={registerList} endPinningReleased={endPinningReleased}
    composerOverlayHeight={composerOverlayHeight} sessionIsWorking={busy} onIsAtEndChange={onIsAtEndChange}
    onTimelineDataChange={onTimelineDataChange}
    scrollContainerProps={{ 'data-testid': 'omo-transcript', role: 'region', 'aria-label': t('omo.chat.transcript'),
      className: 'min-h-0 flex-1 overscroll-contain' }}
    listFooter={<><LiveMessage store={store} sessionKey={sessionKey} /><LiveTools store={store} sessionKey={sessionKey} persisted={persistedTools} /></>} />;
}
