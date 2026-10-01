import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { nativeCommandSchema } from '../contracts';
import type { NativeStore } from '../state';
import { ActionNotice, PanelSection, ProjectionNotice, RecordedStatus } from './PanelSection';
import { canControl, usePanelAction, usePanelSlice } from './panel-state';

export function GoalPanel({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const inputId = useId();
  const [objective, setObjective] = useState('');
  const projection = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.goal ?? null);
  const supported = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.state.commands
    .some((command) => command.name === 'goal' && command.source === 'extension') ?? false);
  const writable = usePanelSlice(store, () => canControl(store, sessionKey));
  const action = usePanelAction(store, sessionKey);
  const goal = projection?.value;
  const parsed = nativeCommandSchema.safeParse({ type: 'goalSet', objective: objective.trim() });
  const enabled = writable && supported && projection?.status === 'ready' && !action.busy;

  return (
    <PanelSection id="omo-goal-panel" title={t('omo.panels.goal.title')} icon="target">
      <ProjectionNotice projection={projection} />
      {goal ? (
        <div data-testid="omo-goal-value" className="space-y-2">
          <div className="flex flex-wrap items-start gap-2">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words typography-ui-label">{goal.objective}</p>
            <RecordedStatus status={goal.status} />
          </div>
          <p className="typography-meta tabular-nums text-muted-foreground">
            {t('omo.panels.goal.usage', { tokens: goal.tokensUsed, seconds: goal.timeUsedSeconds })}
          </p>
          {goal.status === 'blocked' && <p className="break-words typography-meta text-[var(--status-warning-text)]">{goal.blockedReason}</p>}
          <div className="flex flex-wrap gap-2">
            {goal.status === 'active' && <Button size="sm" variant="outline" disabled={!enabled} data-testid="omo-goal-pause" onClick={() => { void action.execute({ type: 'goalPause' }); }}>{t('omo.panels.goal.pause')}</Button>}
            {(goal.status === 'paused' || goal.status === 'blocked') && <Button size="sm" variant="outline" disabled={!enabled} data-testid="omo-goal-resume" onClick={() => { void action.execute({ type: 'goalResume' }); }}>{t('omo.panels.goal.resume')}</Button>}
            <Button size="sm" variant="destructive" disabled={!enabled} data-testid="omo-goal-clear" onClick={() => { void action.execute({ type: 'goalClear' }); }}>{t('omo.panels.goal.clear')}</Button>
          </div>
        </div>
      ) : projection?.status === 'ready' ? <p data-testid="omo-goal-empty" className="typography-meta text-muted-foreground">{t('omo.panels.goal.empty')}</p> : null}
      <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault();
        if (enabled && parsed.success) void action.execute(parsed.data);
      }}>
        <label htmlFor={inputId} className="block typography-ui-label">{t('omo.panels.goal.objective')}</label>
        <Textarea id={inputId} data-testid="omo-goal-objective" value={objective} disabled={!enabled}
          onChange={(event) => setObjective(event.target.value)} aria-invalid={objective.length > 0 && !parsed.success} />
        <p className="typography-meta text-muted-foreground">{t('omo.panels.goal.nativeOwner')}</p>
        {!supported && projection && <p className="typography-meta text-muted-foreground">{t('omo.panels.goal.unsupported')}</p>}
        {objective.length > 0 && !parsed.success && <p role="alert" className="typography-meta text-[var(--status-error-text)]">{t('omo.panels.goal.invalidObjective')}</p>}
        <Button type="submit" size="sm" data-testid="omo-goal-set" disabled={!enabled || !parsed.success}>
          {goal ? t('omo.panels.goal.replace') : t('omo.panels.goal.set')}
        </Button>
      </form>
      <ActionNotice mutation={action.mutation} error={action.error} />
    </PanelSection>
  );
}
