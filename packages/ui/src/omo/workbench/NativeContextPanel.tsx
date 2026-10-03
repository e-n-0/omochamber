import React from 'react';
import { ContextPanelFrame, ContextPanelHeader } from '@/components/layout/ContextPanelFrame';
import { Icon } from '@/components/icon/Icon';
import { DiffViewIcon } from '@/components/icons/DiffIcon';
import { useI18n } from '@/lib/i18n';
import { NativeWorkspaceContents, type NativeWorkbenchProps } from './NativeWorkbench';

export interface NativeContextPanelProps extends NativeWorkbenchProps {
  readonly open: boolean;
  readonly expanded: boolean;
  readonly widthFraction: number;
  readonly onClose: () => void;
  readonly onExpandedChange: (expanded: boolean) => void;
  /** The parent persists this ratio under its canonical directory. */
  readonly onWidthChange: (widthFraction: number) => void;
}

/** One retained workspace owner inside the actual original context shell. */
export function NativeContextPanel({ directory, tab, onProjectsChange, open, expanded, widthFraction, onClose, onExpandedChange, onWidthChange }: NativeContextPanelProps) {
  const { t } = useI18n();
  const updateWidth = React.useCallback((width: number, available: number | null) => {
    if (available !== null && available > 0) onWidthChange(width / available);
  }, [onWidthChange]);
  const tools = {
    files: { title: t('contextPanel.mode.files'), icon: <Icon name="file" className="h-[18px] w-[18px]" /> },
    changes: { title: t('contextPanel.mode.diff'), icon: <DiffViewIcon className="h-[18px] w-[18px]" /> },
    terminal: { title: t('layout.mainTab.terminal'), icon: <Icon name="terminal" className="h-[18px] w-[18px]" /> },
  } satisfies Record<NativeWorkbenchProps['tab'], { readonly title: string; readonly icon: React.ReactNode }>;
  const { title, icon } = tools[tab];
  return (
    <ContextPanelFrame
      scopeKey={`${directory ?? ''}:${tab}`}
      open={open}
      expanded={expanded && open}
      widthFraction={widthFraction}
      onWidthChange={updateWidth}
      onClose={onClose}
      panelProps={{ id: 'omo-context-pane', 'data-testid': 'omo-context-pane' }}
      resizeHandleProps={{ tabIndex: 0, 'data-testid': 'omo-context-resize', onKeyDown: (event) => {
        const available = event.currentTarget.closest('aside')?.parentElement?.clientWidth;
        const next = event.key === 'Home' ? 0.2 : event.key === 'End' ? 0.8
          : available && event.key === 'ArrowLeft' ? widthFraction + 16 / available
          : available && event.key === 'ArrowRight' ? widthFraction - 16 / available : null;
        if (next === null) return;
        event.preventDefault();
        onWidthChange(Math.min(0.8, Math.max(0.2, next)));
      } }}
      header={
        <ContextPanelHeader expanded={expanded} onExpandedChange={onExpandedChange} onClose={onClose}
          expandButtonProps={{ 'data-testid': 'omo-context-expand', 'aria-pressed': expanded }}
          closeButtonProps={{ 'data-testid': 'omo-context-close' }}>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3">
            {icon}
            <span className="truncate typography-ui-label text-foreground">{title}</span>
          </div>
        </ContextPanelHeader>
      }
    >
      <NativeWorkspaceContents directory={directory} tab={tab} onProjectsChange={onProjectsChange} visible={open} />
    </ContextPanelFrame>
  );
}
