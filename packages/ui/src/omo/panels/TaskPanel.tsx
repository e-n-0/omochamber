import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { WorkStatusRow, WorkStatusRowAction } from '@/components/chat/work-status/WorkStatusPresentation';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import type { NativeClient } from '../client';
import type { TaskOutput, TaskOutputOptions, TaskView } from '../contracts';
import type { NativeStore } from '../state';
import { ActionNotice, PanelSection, ProjectionNotice, RecordedStatus } from './PanelSection';
import { canControl, usePanelAction, usePanelSlice } from './panel-state';
import { NativeClientError } from '../client';
import { nativeErrorCopy } from '../error-copy';

function TaskRow({ client, store, sessionKey, task }: {
  readonly client: NativeClient;
  readonly store: NativeStore;
  readonly sessionKey: string;
  readonly task: TaskView;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const [message, setMessage] = useState('');
  const [output, setOutput] = useState<TaskOutput | null>(null);
  const [readError, setReadError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const epoch = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.connectionEpoch ?? null);
  const [outputEpoch, setOutputEpoch] = useState<number | null>(null);
  const owned = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.durableSessionId === task.parentSessionId);
  const writable = usePanelSlice(store, () => canControl(store, sessionKey));
  const action = usePanelAction(store, sessionKey);
  const enabled = writable && owned && !action.busy;
  const stopped = task.status === 'cancelled' || task.status === 'lost';
  const cancellable = task.status === 'running';

  useEffect(() => () => { request.current?.abort(); }, [epoch, writable]);

  async function readOutput(options: TaskOutputOptions) {
    if (request.current || !canControl(store, sessionKey) || !owned) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setReadError(null);
    try {
      const result = await client.getTaskOutput(sessionKey, task.taskId, options, controller.signal);
      if (!controller.signal.aborted) {
        setOutput(result);
        setOutputEpoch(epoch);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setReadError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native task output failed', null, { cause }));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }

  return (
    <article data-task-id={task.taskId} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
      <WorkStatusRow label={task.taskSummary || task.description || task.name || task.taskId} value={<RecordedStatus status={task.status} />} />
      <p data-task-source={task.source} className="typography-meta text-muted-foreground">
        {task.source === 'live' && writable ? t('omo.panels.tasks.live') : t('omo.panels.tasks.recorded')}
      </p>
      <p className="break-all font-mono typography-micro text-muted-foreground">{task.taskId}</p>
      {task.error && <p className="break-words typography-meta text-[var(--status-error-text)]">{task.error}</p>}
      {task.output !== undefined && <pre data-testid="omo-task-recorded-output" className="whitespace-pre-wrap break-words font-mono typography-code">{task.output}</pre>}
      <div className="flex flex-wrap gap-2">
        <WorkStatusRowAction disabled={!enabled || loading} testId="omo-task-output-status" onClick={() => { void readOutput({ mode: 'status' }); }}>{t('omo.panels.tasks.outputStatus')}</WorkStatusRowAction>
        <WorkStatusRowAction disabled={!enabled || loading} testId="omo-task-output-tail" onClick={() => { void readOutput({ mode: 'tail', tailLines: 60 }); }}>{t('omo.panels.tasks.outputTail')}</WorkStatusRowAction>
        <WorkStatusRowAction disabled={!enabled || loading} testId="omo-task-output-full" onClick={() => { void readOutput({ mode: 'full' }); }}>{t('omo.panels.tasks.outputFull')}</WorkStatusRowAction>
        {cancellable && <Button size="sm" variant="destructive" disabled={!enabled} data-testid="omo-task-cancel" onClick={() => { void action.execute({ type: 'taskCancel', taskId: task.taskId }); }}>{t('omo.panels.tasks.cancel')}</Button>}
      </div>
      {loading && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
      {readError && <p role="alert" data-testid="omo-task-output-error" className="break-words typography-meta text-[var(--status-error-text)]">{t('omo.panels.action.failed', { error: nativeErrorCopy(readError, t) })}</p>}
      {output && (
        <div data-testid="omo-task-output" className="min-w-0 space-y-2">
          {(readError || loading || !writable || outputEpoch !== epoch) && <p data-testid="omo-task-output-retained" className="typography-meta text-[var(--status-warning-text)]">{t('omo.panels.projection.retained')}</p>}
          <RecordedStatus status={output.task.status} />
          {output.truncated && <p data-testid="omo-task-output-truncated" className="typography-meta text-[var(--status-warning-text)]">{t('omo.panels.tasks.truncated')}</p>}
          {output.output ? <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono typography-code">{output.output}</pre>
            : <p className="typography-meta text-muted-foreground">{t('omo.panels.tasks.noOutput')}</p>}
        </div>
      )}
      {!stopped && <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault();
        if (enabled && message.trim() && message.length <= 32_000) void action.execute({ type: 'taskSend', taskId: task.taskId, message });
      }}>
        <label htmlFor={inputId} className="block typography-ui-label">{t('omo.panels.tasks.message')}</label>
        <Textarea id={inputId} data-testid="omo-task-message" value={message} maxLength={32_000} disabled={!enabled}
          onChange={(event) => setMessage(event.target.value)} />
        <Button type="submit" size="sm" data-testid="omo-task-send" disabled={!enabled || !message.trim() || message.length > 32_000}>{t('omo.panels.tasks.send')}</Button>
      </form>}
      <ActionNotice mutation={action.mutation} error={action.error} />
    </article>
  );
}

export function TaskPanel({ client, store, sessionKey }: {
  readonly client: NativeClient; readonly store: NativeStore; readonly sessionKey: string;
}) {
  const { t } = useI18n();
  const projection = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.tasks ?? null);
  const parentId = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.durableSessionId ?? null);
  const tasks = projection?.value?.filter((task) => task.parentSessionId === parentId);
  return (
    <PanelSection id="omo-tasks-panel" title={t('omo.panels.tasks.title')} icon="ai-agent">
      <ProjectionNotice projection={projection} />
      <p className="typography-meta text-muted-foreground">{t('omo.panels.tasks.publicData')}</p>
      {tasks?.map((task) => <TaskRow key={task.taskId} client={client} store={store} sessionKey={sessionKey} task={task} />)}
      {projection?.status === 'ready' && tasks?.length === 0 && <p data-testid="omo-tasks-empty" className="typography-meta text-muted-foreground">{t('omo.panels.tasks.empty')}</p>}
    </PanelSection>
  );
}
