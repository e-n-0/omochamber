import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import type { InteractionAnswer, PendingInteraction } from '../contracts';
import type { NativeStore } from '../state';
import { NativeQuestionComment, NativeQuestionFields } from './NativeQuestionFields';
import type { QuestionAnswers } from './NativeQuestionFields';
import { useNativeSlice, useNativeWritable } from './nativeHooks';
import { nativeErrorCopy } from '../error-copy';
import { NativeClientError } from '../client';
import { useNativeRequestNotification, type RequestNotifications } from '../desktop/notifications';

function PendingDialog({ store, sessionKey, interaction, notifications }: {
  readonly store: NativeStore; readonly sessionKey: string; readonly interaction: PendingInteraction;
  readonly notifications: RequestNotifications;
}) {
  const { t } = useI18n();
  const writable = useNativeWritable(store, sessionKey);
  const mutations = useNativeSlice(store, sessionKey, (session) => session?.mutations);
  const mutation = React.useMemo(() => {
    let latest;
    for (const value of mutations?.values() ?? []) {
      if (value.interactionId === interaction.id) latest = value;
    }
    return latest;
  }, [mutations, interaction.id]);
  const [value, setValue] = React.useState(interaction.method === 'editor' ? interaction.prefill ?? '' : '');
  const [answers, setAnswers] = React.useState<QuestionAnswers>({});
  const [comment, setComment] = React.useState('');
  const [error, setError] = React.useState<Error | null>(null);
  const [expired, setExpired] = React.useState(false);
  const responding = React.useRef(false);
  const deadline = interaction.deadlineAtMs;
  React.useEffect(() => {
    setExpired(deadline !== undefined && deadline <= Date.now());
    if (deadline === undefined || deadline <= Date.now()) return;
    const timer = setTimeout(() => setExpired(true), deadline - Date.now());
    return () => clearTimeout(timer);
  }, [deadline]);
  const pending = mutation && mutation.status !== 'failed';
  const disabled = !writable || Boolean(pending) || expired || (deadline !== undefined && deadline <= Date.now());
  const notification = useNativeRequestNotification(notifications, interaction.id, !disabled, t('omo.dialogs.nativeRequest'));
  const respond = async (answer: InteractionAnswer) => {
    if (disabled || responding.current) return;
    responding.current = true;
    setError(null);
    try { await store.respond(interaction.id, answer); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native answer failed', null, { cause })); }
    finally { responding.current = false; }
  };
  const submit = () => {
    switch (interaction.method) {
      case 'select':
      case 'input':
      case 'editor': return respond({ value });
      case 'confirm': return respond({ confirmed: true });
      case 'question': {
        const filled: QuestionAnswers = {};
        for (const question of interaction.questions) {
          const answer = answers[question.id];
          if (answer && (answer.selected.length || answer.text?.trim())) filled[question.id] = answer;
        }
        const response: Extract<InteractionAnswer, { answers: object }> = { answers: filled };
        if (comment.trim()) response.comment = comment;
        return respond(response);
      }
      default: return interaction satisfies never;
    }
  };
  const complete = interaction.method === 'select' ? interaction.options.includes(value)
    : interaction.method === 'question' ? Boolean(comment.trim()) || interaction.questions.every((question) => {
      const answer = answers[question.id];
      return answer && (answer.selected.length > 0 || Boolean(answer.text?.trim()));
    }) : true;
  return <Dialog open onOpenChange={(open) => { if (!open) void respond({ cancelled: true }); }}>
    <DialogContent showCloseButton={false} data-testid="omo-pending-dialog">
      <DialogHeader>
        <DialogTitle>{interaction.title ?? t('chat.questionCard.inputNeeded')}</DialogTitle>
        <DialogDescription>{t('omo.dialogs.nativeRequest')}</DialogDescription>
      </DialogHeader>
      {interaction.remainingMs !== undefined && <p className="typography-meta text-muted-foreground">
        {t('omo.dialogs.remaining', { seconds: Math.ceil(interaction.remainingMs / 1_000) })}
      </p>}
      {expired && <p role="status" className="typography-meta text-[var(--status-warning-text)]">{t('omo.dialogs.expired')}</p>}
      {!writable && <p role="status" className="typography-meta text-muted-foreground">{t('omo.dialogs.readOnly')}</p>}
      {mutation && <div role={mutation.status === 'failed' || mutation.status === 'uncertain' ? 'alert' : 'status'}
        data-response-status={mutation.status} className="space-y-1 typography-meta text-muted-foreground">
        <p>{t(mutation.status === 'uncertain' ? 'omo.chat.uncertain' : mutation.status === 'failed' ? 'omo.chat.failed'
          : mutation.status === 'submitting' ? 'omo.chat.submitting' : 'omo.dialogs.awaitingResolution')}</p>
        {(mutation.status === 'uncertain' || mutation.status === 'failed') && <p className="break-words">{nativeErrorCopy(mutation.error, t)}</p>}
      </div>}
      {error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
      {notification && notification.status !== 'supported' && <p role="alert" data-testid="omo-dialog-notification-error"
        className="break-words typography-meta text-[var(--status-error-text)]">
        {notification.status === 'unsupported' ? t('omo.desktop.notificationUnsupported')
          : t('omo.desktop.operationFailed', { error: nativeErrorCopy(notification.error, t) })}
      </p>}
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (complete) void submit(); }}>
        {interaction.method === 'confirm' && <p className="whitespace-pre-wrap break-words typography-markdown">{interaction.message}</p>}
        {interaction.method === 'select' && <div className="flex flex-col items-start gap-2">
          {interaction.options.map((option) => <Button key={option} variant="chip" aria-pressed={value === option}
            disabled={disabled} className="max-w-full whitespace-normal text-left" data-native-option={option}
            onClick={() => setValue(option)}>{option}</Button>)}
        </div>}
        {interaction.method === 'input' && <Input aria-label={interaction.title} placeholder={interaction.placeholder}
          data-testid="omo-dialog-input" disabled={disabled} value={value} onChange={(event) => setValue(event.currentTarget.value)} />}
        {interaction.method === 'editor' && <Textarea rows={8} aria-label={interaction.title}
          data-testid="omo-dialog-editor" disabled={disabled} value={value} onChange={(event) => setValue(event.currentTarget.value)} />}
        {interaction.method === 'question' && <>
          <NativeQuestionFields questions={interaction.questions} answers={answers} onChange={setAnswers} disabled={disabled} />
          <NativeQuestionComment value={comment} onChange={setComment} disabled={disabled} />
        </>}
        <DialogFooter>
          <Button variant="outline" disabled={disabled} data-testid="omo-dialog-cancel" onClick={() => { void respond({ cancelled: true }); }}>
            {t('chat.questionCard.dismiss')}
          </Button>
          {interaction.method === 'confirm' && <Button variant="outline" disabled={disabled} data-testid="omo-dialog-deny"
            onClick={() => { void respond({ confirmed: false }); }}>{t('omo.dialogs.deny')}</Button>}
          <Button type="submit" disabled={disabled || !complete} data-testid="omo-dialog-submit">{t('chat.questionCard.submit')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

/** The shell mounts this once, independently of Chat/Files/Changes/Terminal tabs. */
export function NativeDialogs({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string | null }) {
  const interactions = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.pendingInteractions);
  const notificationsBySession = React.useRef(new Map<string, RequestNotifications>());
  React.useEffect(() => {
    if (!sessionKey || !interactions) return;
    const notifications = notificationsBySession.current.get(sessionKey);
    for (const id of notifications?.keys() ?? []) {
      if (!interactions.some((interaction) => interaction.id === id)) notifications?.delete(id);
    }
    if (notifications?.size === 0) notificationsBySession.current.delete(sessionKey);
  }, [interactions, sessionKey]);
  const interaction = interactions?.[0];
  if (!sessionKey || !interaction) return null;
  let notifications = notificationsBySession.current.get(sessionKey);
  if (!notifications) {
    notifications = new Map();
    notificationsBySession.current.set(sessionKey, notifications);
  }
  return <PendingDialog key={`${sessionKey}:${interaction.id}`} store={store} sessionKey={sessionKey}
    interaction={interaction} notifications={notifications} />;
}
