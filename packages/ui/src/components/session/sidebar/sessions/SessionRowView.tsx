import React from 'react';
import { cn } from '@/lib/utils';

export const ROW_GUTTER_LEFT_PX = 6;
export const ROW_DEPTH_STEP_PX = 14;
export const ROW_TEXT_LEFT_PX = ROW_GUTTER_LEFT_PX + 14 + 6;

export interface SessionRowViewProps extends React.ComponentProps<'div'> {
  readonly sessionId: string;
  readonly scopeKey?: string;
  readonly archived?: boolean;
  readonly active?: boolean;
  readonly selected?: boolean;
  readonly timeline?: boolean;
  readonly timelineChat?: boolean;
  readonly depth?: number;
}

export function SessionRowView({ sessionId, scopeKey = '', archived, active, selected, timeline, timelineChat, depth = 0, className, style, ...props }: SessionRowViewProps) {
  return <div {...props} data-session-row={sessionId} data-session-scope={scopeKey} data-session-archived={archived ? '1' : '0'} aria-current={active ? 'page' : undefined}
    style={{ paddingLeft: timeline ? ROW_GUTTER_LEFT_PX + 4 : ROW_TEXT_LEFT_PX + depth * ROW_DEPTH_STEP_PX, ...style }}
    className={cn('group relative my-0.5 flex cursor-pointer items-center rounded-md pr-2.5', timeline && !timelineChat ? 'py-1.5' : 'py-1', timeline && !(active || selected) && 'hover:bg-interactive-hover/60', (active || selected) && 'bg-interactive-selection/70 text-interactive-selection-foreground', selected && 'ring-1 ring-inset ring-border', className)} />;
}

export interface SessionRowButtonViewProps extends React.ComponentProps<'button'> {
  readonly selectionMode?: boolean;
  readonly selected?: boolean;
  readonly touchPressed?: boolean;
  readonly actionPadding?: string;
}

export function SessionRowButtonView({ selectionMode, selected, touchPressed, actionPadding, className, ...props }: SessionRowButtonViewProps) {
  return <button type="button" aria-pressed={selectionMode ? selected : undefined} {...props}
    className={cn('flex min-w-0 flex-1 cursor-pointer flex-col gap-0 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-foreground select-none transition-[padding]', touchPressed && 'bg-interactive-hover/70', actionPadding, className)} />;
}

export interface SessionRowTitleViewProps {
  readonly title: React.ReactNode;
  readonly active?: boolean;
  readonly selected?: boolean;
  readonly needsAttention?: boolean;
  readonly children?: React.ReactNode;
}

export function SessionRowTitleView({ title, active, selected, needsAttention, children }: SessionRowTitleViewProps) {
  return <div className="flex w-full items-center min-w-0 flex-1 gap-1 overflow-hidden">
    <div className={cn('block min-w-0 flex-1 truncate typography-ui-label font-normal', active || selected ? 'text-interactive-selection-foreground' : needsAttention ? 'text-foreground' : 'text-foreground/80')}>{title}</div>
    {children}
  </div>;
}

export interface SessionRowActionsViewProps {
  readonly timeline?: boolean;
  readonly timelineChat?: boolean;
  readonly menuOpen?: boolean;
  readonly alwaysShow?: boolean;
  readonly vscode?: boolean;
  readonly revealClassName?: string;
  readonly children?: React.ReactNode;
}

export function SessionRowActionsView({ timeline, timelineChat, menuOpen, alwaysShow, vscode, revealClassName, children }: SessionRowActionsViewProps) {
  return <div className={cn('absolute right-1 z-10 flex items-center gap-0.5 transition-opacity', timeline && !timelineChat ? 'top-1.5 h-5' : 'top-1/2 -translate-y-1/2', menuOpen ? 'opacity-100' : alwaysShow && !vscode ? 'opacity-100' : cn('opacity-0', revealClassName))}>{children}</div>;
}
