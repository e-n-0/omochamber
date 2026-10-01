import type { ReactNode } from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import type { NativeProjections } from '../contracts';
import type { NativeMutation } from '../state';
import { nativeErrorCopy } from '../error-copy';

export function PanelSection({ id, title, icon, children }: {
  readonly id: string;
  readonly title: string;
  readonly icon: IconName;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} data-testid={id} className="min-w-0 space-y-3 border-b border-border p-4">
      <h3 id={`${id}-heading`} className="flex items-center gap-2 typography-ui-header font-semibold text-foreground">
        <Icon name={icon} className="size-4 shrink-0 text-muted-foreground" />
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ProjectionNotice({ projection }: {
  readonly projection: NativeProjections[keyof NativeProjections] | null;
}) {
  const { t } = useI18n();
  if (!projection) return <p role="status" data-projection="loading" className="typography-meta text-muted-foreground">{t('common.loading')}</p>;
  if (projection.status === 'ready') return null;
  return (
    <div role="status" data-projection={projection.status} className="space-y-1 typography-meta text-[var(--status-warning-text)]">
      <p>{projection.status === 'incomplete' ? t('omo.panels.projection.incomplete') : t('omo.panels.projection.unavailable')}</p>
      {projection.reason && <p className="break-words text-muted-foreground">{projection.reason}</p>}
      {projection.value !== null && <p data-testid="omo-retained-projection">{t('omo.panels.projection.retained')}</p>}
    </div>
  );
}

export function ActionNotice({ mutation, error }: {
  readonly mutation: NativeMutation | null;
  readonly error: Error | null;
}) {
  const { t } = useI18n();
  if (error) return <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{t('omo.panels.action.failed', { error: nativeErrorCopy(error, t) })}</p>;
  if (!mutation) return null;
  switch (mutation.status) {
    case 'submitting':
    case 'accepted':
      return <p role="status" data-action-state={mutation.status} className="typography-meta text-muted-foreground">{t('omo.panels.action.pending')}</p>;
    case 'succeeded': {
      const data = mutation.result.success ? mutation.result.data : undefined;
      return (
        <p role="status" data-action-state={mutation.status} className="typography-meta text-muted-foreground">
          {data?.queued ? t('omo.panels.action.queued') : data?.cancelled === false
            ? t('omo.panels.action.noChange') : t('omo.panels.action.acknowledged')}
        </p>
      );
    }
    case 'failed':
      return <p role="alert" data-action-state="failed" className="break-words typography-meta text-[var(--status-error-text)]">{t('omo.panels.action.failed', { error: nativeErrorCopy(mutation.error, t) })}</p>;
    case 'uncertain':
      return <p role="alert" data-action-state="uncertain" className="typography-meta text-[var(--status-warning-text)]">{t('omo.panels.action.uncertain')}</p>;
    default: mutation satisfies never; return null;
  }
}

const statusKeys = {
  active: 'omo.panels.status.active', paused: 'omo.panels.status.paused',
  complete: 'omo.panels.status.complete', blocked: 'omo.panels.status.blocked',
  pending: 'omo.panels.status.pending', in_progress: 'omo.panels.status.inProgress',
  completed: 'omo.panels.status.completed', abandoned: 'omo.panels.status.abandoned',
  running: 'omo.panels.status.running', error: 'omo.panels.status.error',
  cancelled: 'omo.panels.status.cancelled', interrupted: 'omo.panels.status.interrupted',
  lost: 'omo.panels.status.lost', scheduled: 'omo.panels.status.scheduled',
  failed: 'omo.panels.status.failed', skipped: 'omo.panels.status.skipped',
} as const;

export function RecordedStatus({ status }: { readonly status: keyof typeof statusKeys }) {
  const { t } = useI18n();
  return <span data-recorded-status={status} className="shrink-0 typography-meta text-muted-foreground">{t(statusKeys[status])}</span>;
}
