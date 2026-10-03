import React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export interface DirectoryHeaderViewProps {
  readonly name: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly label: React.ReactNode;
  readonly subtitle?: React.ReactNode;
  readonly indicator?: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly tooltip?: React.ReactNode;
  readonly rightPadding?: string;
  readonly dragHandleRef?: React.Ref<HTMLDivElement>;
  readonly dragListeners?: React.HTMLAttributes<HTMLDivElement>;
  readonly toggleProps?: React.HTMLAttributes<HTMLDivElement> & { readonly 'data-directory-path'?: string };
}

export function DirectoryHeaderView({ name, collapsed, onToggle, label, subtitle, indicator, actions, tooltip, rightPadding, dragHandleRef, dragListeners, toggleProps }: DirectoryHeaderViewProps) {
  const { t } = useI18n();
  return <div className={cn('group/gh relative flex items-start justify-between gap-1 py-1 min-w-0 rounded-md', 'cursor-pointer')}>
    <Tooltip disabled={!tooltip}>
      <TooltipTrigger asChild>
        <div {...toggleProps} className="min-w-0 flex-1" onClick={onToggle} role="button" tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } }}
          aria-label={collapsed ? t('sessions.sidebar.group.expandAria', { label: name }) : t('sessions.sidebar.group.collapseAria', { label: name })}
          aria-expanded={!collapsed}>
          <div ref={dragHandleRef} className={cn('min-w-0 flex flex-1 items-start gap-1 overflow-hidden pl-1.5 transition-[padding]', rightPadding)} {...dragListeners}>
            <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
              <p className="typography-ui-label font-normal truncate text-foreground/92">{label}</p>
              {subtitle}
            </div>
            {indicator}
          </div>
        </div>
      </TooltipTrigger>
      {tooltip ? <TooltipContent side="right" sideOffset={8} className="max-w-xs">{tooltip}</TooltipContent> : null}
    </Tooltip>
    {actions}
  </div>;
}

export interface SessionGroupViewProps extends DirectoryHeaderViewProps {
  readonly children?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly dialog?: React.ReactNode;
}

export function SessionGroupView({ children, footer, dialog, ...header }: SessionGroupViewProps) {
  return <><div className="oc-group">
    <DirectoryHeaderView {...header} />
    {footer}
    {!header.collapsed && children ? <div className={cn('oc-group-body', 'pb-2')}>{children}</div> : null}
  </div>{dialog}</>;
}

export interface DirectoryNewSessionViewProps {
  readonly label: string;
  readonly onNewSession: () => void;
  readonly disabled?: boolean;
  readonly alwaysShowActions?: boolean;
  readonly tooltip?: React.ReactNode;
  readonly ariaLabel?: string;
}

export function DirectoryNewSessionView({ label, onNewSession, disabled = false, alwaysShowActions = false, tooltip, ariaLabel }: DirectoryNewSessionViewProps) {
  const { t } = useI18n();
  return <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={(event) => { event.stopPropagation(); onNewSession(); }}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          aria-label={ariaLabel ?? t('sessions.sidebar.group.actions.newDraftInGroupAria', { label })}
        >
          <Icon name="add" className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}><p>{tooltip ?? t('sessions.sidebar.project.actions.newDraftSession')}</p></TooltipContent>
    </Tooltip>
  </div>;
}
