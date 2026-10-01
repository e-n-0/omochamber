import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { NativeEntry, NativeMessage } from '../contracts';
import type { NativeStore } from '../state';
import { NativeContent, NativeMarkdown } from './NativeContent';
import { useNativeSlice } from './nativeHooks';

const Message = React.memo(function Message({ message }: { readonly message: NativeMessage }) {
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
  return <article data-message-role={message.role} className={message.role === 'user'
    ? 'space-y-2 rounded-xl bg-surface-elevated p-4' : 'space-y-2 py-2'}>
    <header className="typography-meta font-medium text-muted-foreground">
      {message.role === 'toolResult' ? message.toolName : message.role === 'custom' ? message.customType
        : t(message.role === 'user' ? 'omo.chat.user' : 'omo.chat.assistant')}
    </header>
    {message.role === 'toolResult' && message.isError &&
      <p role="alert" className="typography-meta text-[var(--status-error-text)]">{t('omo.chat.toolError')}</p>}
    {Array.isArray(message.content) ? <NativeContent content={message.content} /> : <NativeMarkdown text={message.content} />}
    {message.role === 'assistant' && message.errorMessage &&
      <p role="alert" className="whitespace-pre-wrap break-words typography-meta text-[var(--status-error-text)]">{message.errorMessage}</p>}
  </article>;
});

const Entry = React.memo(function Entry({ entry }: { readonly entry: NativeEntry }) {
  const { t } = useI18n();
  switch (entry.type) {
    case 'message': return <Message message={entry.message} />;
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
  const argumentsById = useNativeSlice(store, sessionKey, (session) => session?.toolArguments);
  if (!message || !content || (message.role === 'custom' && !message.display)) return null;
  return <article data-testid="omo-live-message" data-message-role={message.role} className="space-y-2 py-2">
    <header className="typography-meta font-medium text-muted-foreground">
      {message.role === 'toolResult' ? message.toolName : t(message.role === 'user' ? 'omo.chat.user' : 'omo.chat.assistant')}
    </header>
    <NativeContent content={content} toolArguments={argumentsById} />
    {message.role === 'assistant' && message.errorMessage &&
      <p role="alert" className="whitespace-pre-wrap break-words text-[var(--status-error-text)]">{message.errorMessage}</p>}
  </article>;
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

export function NativeTranscript({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const entries = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.activeBranch.entries);
  const persistedTools = React.useMemo(() => new Set(entries?.flatMap((entry) =>
    entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message.toolCallId] : [])), [entries]);
  const scroller = React.useRef<HTMLDivElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  const following = React.useRef(true);
  React.useLayoutEffect(() => {
    const viewport = scroller.current;
    const content = body.current;
    if (!viewport || !content) return;
    const follow = () => { if (following.current) viewport.scrollTop = viewport.scrollHeight; };
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    follow();
    return () => observer.disconnect();
  }, []);
  return <div ref={scroller} data-testid="omo-transcript" role="region" aria-label={t('omo.chat.transcript')}
    className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
    onScroll={(event) => {
      const node = event.currentTarget;
      following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 2;
    }}>
    <div ref={body} className="mx-auto w-full max-w-3xl space-y-4 px-4 py-6">
      {entries?.map((entry) => <Entry key={entry.id} entry={entry} />)}
      <LiveMessage store={store} sessionKey={sessionKey} />
      <LiveTools store={store} sessionKey={sessionKey} persisted={persistedTools} />
    </div>
  </div>;
}
