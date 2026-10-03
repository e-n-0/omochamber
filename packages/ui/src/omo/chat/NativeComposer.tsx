import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChatComposerView, ChatComposerEditorView, ChatComposerFooterView, ChatComposerFormView } from '@/components/chat/presentation/ChatComposerView';
import { ChatModelControlsView, ChatModelPickerView } from '@/components/chat/presentation/ChatModelControlsView';
import { ComposerActionButtons } from '@/components/chat/composer/ui/ComposerActionButtons';
import type { ComposerLanguageContext } from '@/components/chat/composer/language/tokenize';
import { useI18n } from '@/lib/i18n';
import type { NativeCommand } from '../contracts';
import type { NativeStore } from '../state';
import { useNativeSlice, useNativeWritable } from './nativeHooks';
import { NativeMutationNotice } from './NativeFeedback';
import { nativeErrorCopy } from '../error-copy';
import { NativeClientError } from '../client';

function thinkingLabel(level: string, t: ReturnType<typeof useI18n>['t']): string {
  switch (level) {
    case 'off': return t('omo.chat.thinking.off');
    case 'minimal': return t('omo.chat.thinking.minimal');
    case 'low': return t('omo.chat.thinking.low');
    case 'medium': return t('omo.chat.thinking.medium');
    case 'high': return t('omo.chat.thinking.high');
    case 'xhigh': return t('omo.chat.thinking.xhigh');
    case 'max': return t('omo.chat.thinking.max');
    default: return level;
  }
}


const languageContext: ComposerLanguageContext = { inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
  knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [] };

function requestRetained(store: NativeStore, sessionKey: string, requestId: string | null): boolean {
  if (!requestId) return false;
  const status = store.getState().sessions.get(sessionKey)?.mutations.get(requestId)?.status;
  return status !== 'succeeded' && status !== 'failed';
}

function ModelControls({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const writable = useNativeWritable(store, sessionKey);
  const models = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.availableModels);
  const model = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.model);
  const levels = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.availableThinkingLevels);
  const level = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.thinkingLevel);
  const [requestId, setRequestId] = React.useState<string | null>(null);
  const retained = React.useRef<string | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const mutation = useNativeSlice(store, sessionKey, (session) => requestId ? session?.mutations.get(requestId) : undefined);
  const pending = Boolean(requestId && (!mutation || mutation.status === 'submitting' || mutation.status === 'accepted' || mutation.status === 'uncertain'));
  const submit = async (command: NativeCommand) => {
    if (!writable || requestRetained(store, sessionKey, retained.current)) return;
    const id = crypto.randomUUID();
    retained.current = id;
    setRequestId(id);
    setError(null);
    try { await store.execute(command, id); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native control failed', null, { cause })); }
  };
  const modelValue = model ? JSON.stringify([model.provider, model.id]) : '';
  return <>
    <ChatModelControlsView
      model={<ChatModelPickerView kind="model" testId="omo-model" ariaLabel={t('chat.unifiedControls.model.title')}
        label={models?.find((option) => option.provider === model?.provider && option.id === model.id)?.name ?? model?.id ?? t('chat.unifiedControls.model.title')}
        value={modelValue} options={models?.map((option) => ({ value: JSON.stringify([option.provider, option.id]), label: `${option.name ?? option.id} / ${option.provider}` })) ?? []}
        disabled={!writable || pending || !models?.length} onSelect={(value) => {
          const selected = models?.find((option) => JSON.stringify([option.provider, option.id]) === value);
          if (selected && value !== modelValue) void submit({ type: 'setModel', provider: selected.provider, id: selected.id });
        }} />}
      thinking={<ChatModelPickerView kind="variant" testId="omo-thinking" ariaLabel={t('chat.unifiedControls.effort.title')}
        label={level === null || level === undefined ? t('chat.unifiedControls.effort.title') : thinkingLabel(level, t)}
        value={level ?? ''} options={levels?.map((option) => ({ value: option, label: thinkingLabel(option, t) })) ?? []}
        disabled={!writable || pending || !levels?.length} onSelect={(value) => {
          if (levels?.includes(value) && value !== level) void submit({ type: 'setThinking', level: value });
        }} />} />

    {error && <p role="alert" className="w-full break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
  </>;
}

export function NativeComposer({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const writable = useNativeWritable(store, sessionKey);
  const busy = useNativeSlice(store, sessionKey, (session) => Boolean(session?.snapshot &&
    (session.snapshot.state.isStreaming || session.snapshot.state.isCompacting || session.snapshot.state.isRetrying || session.snapshot.state.isBashRunning)));
  const [text, setText] = React.useState('');
  const [mode, setMode] = React.useState<'steer' | 'followUp'>('followUp');
  const [submission, setSubmission] = React.useState<{ readonly requestId: string; readonly text: string } | null>(null);
  const [abortId, setAbortId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<Error | null>(null);
  const mutation = useNativeSlice(store, sessionKey, (session) => submission ? session?.mutations.get(submission.requestId) : undefined);
  const abortMutation = useNativeSlice(store, sessionKey, (session) => abortId ? session?.mutations.get(abortId) : undefined);
  const retained = React.useRef<string | null>(null);
  const retainedAbort = React.useRef<string | null>(null);
  const pending = Boolean(submission && (!mutation || mutation.status === 'submitting' || mutation.status === 'accepted' || mutation.status === 'uncertain'));
  const abortPending = Boolean(abortId && (!abortMutation || abortMutation.status === 'submitting' || abortMutation.status === 'accepted' || abortMutation.status === 'uncertain'));
  React.useEffect(() => {
    if (mutation?.status === 'succeeded') setText((draft) => draft === submission?.text ? '' : draft);
  }, [mutation?.status, submission]);

  const send = async () => {
    if (!writable || requestRetained(store, sessionKey, retained.current) || !text.trim()) return;
    const requestId = crypto.randomUUID();
    retained.current = requestId;
    setSubmission({ requestId, text });
    setError(null);
    try { await store.execute({ type: busy ? mode : 'prompt', text }, requestId); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native submission failed', null, { cause })); }
  };
  const abort = async () => {
    if (!writable || !busy || requestRetained(store, sessionKey, retainedAbort.current)) return;
    const requestId = crypto.randomUUID();
    retainedAbort.current = requestId;
    setAbortId(requestId);
    setError(null);
    try { await store.execute({ type: 'abort' }, requestId); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native abort failed', null, { cause })); }
  };
  const sendLabel = t('chat.chatInput.actions.sendMessageAria');
  return <div className="min-w-0 flex-1" data-testid="omo-composer">
    <NativeMutationNotice store={store} sessionKey={sessionKey} />
    {error && <p role="alert" className="mb-2 break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
    <ChatComposerFormView data-testid="omo-composer-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="chat-input-column relative overflow-visible"><ChatComposerView>
        <div className="relative flex flex-col">
          <div className="overflow-hidden"><div className="relative overflow-hidden">
            <ChatComposerEditorView value={text} onChange={(change) => setText(change.value)} languageContext={languageContext}
              placeholder={t('omo.chat.placeholder')} aria-label={t('omo.chat.placeholder')} data-testid="omo-draft"
              editable={writable && !pending} onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return false;
                event.preventDefault();
                if (!event.repeat) void send();
                return true;
              }} />
          </div></div>
          <ChatComposerFooterView>
            <div className="flex items-center gap-x-1.5">
              {busy && <Select value={mode} disabled={!writable || pending} onValueChange={(value) => { if (value === 'steer' || value === 'followUp') setMode(value); }}>
                <SelectTrigger aria-label={t('omo.chat.sendMode')} data-testid="omo-send-mode"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="steer">{t('omo.chat.steer')}</SelectItem>
                  <SelectItem value="followUp">{t('omo.chat.followUp')}</SelectItem></SelectContent>
              </Select>}
            </div>
            <div className="flex items-center gap-x-1.5 min-w-0">
              <ModelControls store={store} sessionKey={sessionKey} />
              <ComposerActionButtons isMobile={false} footerIconButtonClass="inline-flex items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none h-8 w-8"
                sendIconSizeClass="size-4" stopIconSizeClass="size-4" canSend={writable && !pending && Boolean(text.trim())}
                canAbort={busy} hasContent={Boolean(text.trim())} currentSessionId={sessionKey} newSessionDraftOpen={false}
                onPrimaryAction={() => { void send(); }} onQueueMessage={() => { void send(); }} onAbort={() => { void abort(); }}
                queueDisabled={!writable || pending} stopDisabled={!writable || abortPending} sendLabel={sendLabel} queueLabel={sendLabel}
                sendTestId="omo-send" queueTestId="omo-send" stopTestId="omo-abort" />
            </div>
          </ChatComposerFooterView>
        </div>
      </ChatComposerView></div>
    </ChatComposerFormView>
  </div>;
}
