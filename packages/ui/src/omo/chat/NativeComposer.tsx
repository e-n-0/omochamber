import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

function ModelControls({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const writable = useNativeWritable(store, sessionKey);
  const models = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.availableModels);
  const model = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.model);
  const levels = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.availableThinkingLevels);
  const level = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.state.thinkingLevel);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<Error | null>(null);
  const submit = async (command: NativeCommand) => {
    setSubmitting(true);
    setError(null);
    try { await store.execute(command); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native control failed', null, { cause })); }
    finally { setSubmitting(false); }
  };
  const modelValue = model ? JSON.stringify([model.provider, model.id]) : '';
  return <>
    <Select value={modelValue} disabled={!writable || submitting || !models?.length} onValueChange={(value) => {
      const selected = models?.find((option) => JSON.stringify([option.provider, option.id]) === value);
      if (selected && value !== modelValue) void submit({ type: 'setModel', provider: selected.provider, id: selected.id });
    }}>
      <SelectTrigger aria-label={t('chat.unifiedControls.model.title')} data-testid="omo-model" className="min-w-0 max-w-full">
        <SelectValue>{models?.find((option) => option.provider === model?.provider && option.id === model.id)?.name
          ?? model?.id ?? t('chat.unifiedControls.model.title')}</SelectValue>
      </SelectTrigger>
      <SelectContent>{models?.map((option) =>
        <SelectItem key={JSON.stringify([option.provider, option.id])} value={JSON.stringify([option.provider, option.id])}>
          {option.name ?? option.id} / {option.provider}
        </SelectItem>)}</SelectContent>
    </Select>
    <Select value={level ?? ''} disabled={!writable || submitting || !levels?.length} onValueChange={(value) => {
      if (value !== level) void submit({ type: 'setThinking', level: value });
    }}>
      <SelectTrigger aria-label={t('chat.unifiedControls.effort.title')} data-testid="omo-thinking">
        <SelectValue>{level === null || level === undefined ? t('chat.unifiedControls.effort.title') : thinkingLabel(level, t)}</SelectValue>
      </SelectTrigger>
      <SelectContent>{levels?.map((option) => <SelectItem key={option} value={option}>{thinkingLabel(option, t)}</SelectItem>)}</SelectContent>
    </Select>
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
  const [error, setError] = React.useState<Error | null>(null);
  const mutation = useNativeSlice(store, sessionKey, (session) => submission ? session?.mutations.get(submission.requestId) : undefined);
  const inFlight = React.useRef(false);
  const pending = mutation?.status === 'submitting' || mutation?.status === 'accepted' || mutation?.status === 'uncertain';
  React.useEffect(() => {
    if (mutation?.status === 'succeeded') setText((draft) => draft === submission?.text ? '' : draft);
  }, [mutation?.status, submission]);

  const send = async () => {
    if (!writable || pending || inFlight.current || !text.trim()) return;
    inFlight.current = true;
    const requestId = crypto.randomUUID();
    setSubmission({ requestId, text });
    setError(null);
    try { await store.execute({ type: busy ? mode : 'prompt', text }, requestId); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native submission failed', null, { cause })); }
    finally { inFlight.current = false; }
  };
  const abort = async () => {
    setError(null);
    try { await store.execute({ type: 'abort' }); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native abort failed', null, { cause })); }
  };
  return <div className="mx-auto w-full max-w-3xl shrink-0 space-y-3 px-4 pb-4">
    <NativeMutationNotice store={store} sessionKey={sessionKey} />
    {error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
    <form className="oc-surface-elevated space-y-2 rounded-xl border border-border bg-surface-elevated p-3"
      onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <Textarea data-testid="omo-composer" aria-label={t('omo.chat.composer')} placeholder={t('omo.chat.placeholder')}
        value={text} disabled={!writable || pending} rows={3} onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
            event.preventDefault();
            if (!event.repeat) void send();
          }
        }} />
      <div className="flex flex-wrap items-center gap-2">
        <ModelControls store={store} sessionKey={sessionKey} />
        {busy && <Select value={mode} onValueChange={(value) => { if (value === 'steer' || value === 'followUp') setMode(value); }}>
          <SelectTrigger aria-label={t('omo.chat.sendMode')} data-testid="omo-send-mode"><SelectValue>
            {t(mode === 'steer' ? 'omo.chat.steer' : 'omo.chat.followUp')}
          </SelectValue></SelectTrigger>
          <SelectContent>
            <SelectItem value="steer">{t('omo.chat.steer')}</SelectItem>
            <SelectItem value="followUp">{t('omo.chat.followUp')}</SelectItem>
          </SelectContent>
        </Select>}
        <div className="ml-auto flex items-center gap-2">
          {busy && <Button size="sm" variant="outline" disabled={!writable} data-testid="omo-abort" onClick={() => { void abort(); }}>
            <Icon name="stop" className="size-4" />{t('chat.chatInput.actions.stopGeneratingAria')}
          </Button>}
          <Button type="submit" size="sm" disabled={!writable || pending || !text.trim()} data-testid="omo-send"
            aria-label={t('chat.chatInput.actions.sendMessageAria')}><Icon name="arrow-up" className="size-4" />
            {t('chat.chatInput.actions.sendMessageAria')}
          </Button>
        </div>
      </div>
    </form>
  </div>;
}
