import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isTerminalEventTarget } from '@/lib/terminalFocus';
import { cn } from '@/lib/utils';
import { useContextPanelGeometry, type ContextPanelGeometryOptions } from './useContextPanelGeometry';

export interface ContextPanelHeaderProps {
  readonly children: React.ReactNode;
  readonly actions?: React.ReactNode;
  readonly expanded: boolean;
  readonly expandable?: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly onClose: () => void;
  readonly expandButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly 'data-testid'?: string };
  readonly closeButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly 'data-testid'?: string };
}

export function ContextPanelHeader({ children, actions, expanded, expandable = true, onExpandedChange, onClose, expandButtonProps, closeButtonProps }: ContextPanelHeaderProps) {
  const { t } = useI18n();
  return (
    <header className="flex h-10 items-stretch border-b border-border">
      {children}
      <div className="flex items-center gap-1 px-1.5">
        {actions}
        {expandable ? (
          <Button
            type="button"
            {...expandButtonProps}
            variant="ghost"
            size="sm"
            onClick={() => onExpandedChange(!expanded)}
            className="h-7 w-7 p-0"
            title={t(expanded ? 'contextPanel.actions.collapsePanel' : 'contextPanel.actions.expandPanel')}
            aria-label={t(expanded ? 'contextPanel.actions.collapsePanel' : 'contextPanel.actions.expandPanel')}
          >
            <Icon name={expanded ? 'fullscreen-exit' : 'fullscreen'} className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          {...closeButtonProps}
          variant="ghost"
          size="sm"
          onClick={onClose}
          className="h-7 w-7 p-0"
          title={t('contextPanel.actions.closePanel')}
          aria-label={t('contextPanel.actions.closePanel')}
        >
          <Icon name="close" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </header>
  );
}

export interface ContextPanelFrameProps extends ContextPanelGeometryOptions {
  readonly header: React.ReactNode;
  readonly children: React.ReactNode;
  readonly onClose: () => void;
  readonly resizeHandleProps?: React.HTMLAttributes<HTMLDivElement> & { readonly 'data-testid'?: string };
  readonly panelProps?: React.HTMLAttributes<HTMLElement> & { readonly 'data-testid'?: string };
}

/** The original aside, resize handle, and fixed-width content shell. */
export function ContextPanelFrame({ header, children, onClose, resizeHandleProps, panelProps, ...geometry }: ContextPanelFrameProps) {
  const { t } = useI18n();
  const { open, expanded } = geometry;
  const { panelRef, widthStyle, contentStyle, isResizing, onResizePointerDown } = useContextPanelGeometry(geometry);
  const handleEscape = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    if (event.target instanceof Node && !event.currentTarget.contains(event.target)) return;
    if (isTerminalEventTarget(event.target)) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-oc-escape-owner="terminal"], .cm-editor, [role="dialog"], [role="menu"]')) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <aside
      {...panelProps}
      ref={panelRef}
      data-context-panel="true"
      data-expanded={expanded}
      tabIndex={-1}
      onKeyDownCapture={handleEscape}
      inert={!open || undefined}
      className={cn(
        'flex min-h-0 flex-col overflow-hidden bg-background',
        expanded ? 'absolute inset-y-0 right-0 z-20 min-w-0' : 'relative h-full flex-shrink-0',
        !open && 'pointer-events-none',
        'will-change-[width] motion-reduce:transition-none',
        'transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]'
      )}
      style={widthStyle}
    >
      {open && !expanded && <div aria-hidden="true" className="absolute left-0 top-0 z-40 h-full w-px bg-border" />}
      {open && <div aria-hidden="true" className="absolute right-0 top-0 z-40 h-full w-px bg-border" />}
      {!expanded && (
        <div
          {...resizeHandleProps}
          className={cn(
            'absolute left-0 top-0 z-50 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
            isResizing && 'bg-[var(--interactive-border)]'
          )}
          onPointerDown={onResizePointerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label={t('contextPanel.actions.resizePanelAria')}
        />
      )}
      <div className={cn(
        'relative z-10 flex h-full min-h-0 shrink-0 flex-col duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        'transition-[width,opacity]',
        !open && 'pointer-events-none select-none opacity-0'
      )} style={contentStyle} aria-hidden={!open}>
        {header}
        <div className={cn('relative min-h-0 flex-1 overflow-hidden', isResizing && 'pointer-events-none')}>{children}</div>
      </div>
    </aside>
  );
}
