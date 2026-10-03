import type { ReactNode } from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export interface HeaderTitleViewProps {
  readonly title?: string;
  readonly generating?: boolean;
  readonly switcher?: ReactNode;
  readonly editing?: ReactNode;
  readonly metadata?: ReactNode;
  readonly menu?: ReactNode;
}

export function HeaderTitleView({ title, generating, switcher, editing, metadata, menu }: HeaderTitleViewProps) {
  const { t } = useI18n();
  return <div className="app-region-no-drag mr-3 flex min-w-0 max-w-full items-center gap-0.5 py-0.5 -my-0.5 text-left">
    {generating ? <Icon name="loader-4" className="mr-1 size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} /> : null}
    {switcher}
    <div className="flex min-w-0 flex-col justify-center px-1">
      {editing ?? (title ? <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">{title}</span> : null)}
      {metadata ? <span className="flex min-w-0 max-w-full items-center gap-1.5 truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">{metadata}</span> : null}
    </div>
    <div className={cn('flex h-[18px] shrink-0 items-center justify-center', metadata ? 'self-start' : 'self-center')}>{menu}</div>
  </div>;
}
