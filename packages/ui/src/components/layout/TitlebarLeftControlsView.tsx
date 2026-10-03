import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-interactive-hover transition-colors';

export interface TitlebarLeftControlsViewProps {
  readonly isSidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
  readonly onNewSession: () => void;
  readonly newSessionDisabled?: boolean;
  readonly toggleShortcut?: string;
  readonly windowControls?: React.ReactNode;
  readonly onOpenAppMenu?: React.MouseEventHandler<HTMLButtonElement>;
  readonly toggleButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly 'data-testid'?: string };
  readonly newSessionButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly 'data-testid'?: string };
}

export function TitlebarLeftControlsView({ isSidebarOpen, onToggleSidebar: toggleSidebar, onNewSession: handleNewSession, newSessionDisabled = false, toggleShortcut = '', windowControls, onOpenAppMenu: handleOpenWindowsAppMenu, toggleButtonProps, newSessionButtonProps }: TitlebarLeftControlsViewProps) {
  const { t } = useI18n();
  const clusterRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const node = clusterRef.current;
    if (!node) {
      return;
    }

    const publishWidth = () => {
      // Prefer scrollWidth so negative child margins / overflow cannot under-report
      // the space the overlay actually occupies over the header.
      const width = Math.max(node.getBoundingClientRect().width, node.scrollWidth);
      document.documentElement.style.setProperty('--oc-titlebar-controls-width', `${Math.round(width)}px`);
    };

    publishWidth();

    const Observer = globalThis.ResizeObserver;
    if (!Observer) {
      return;
    }
    const observer = new Observer(publishWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    // The overlay is a CSS no-drag zone so its buttons stay clickable. The
    // header / sidebar strip beneath carve a matching no-drag region under it
    // and remain drag regions everywhere else, so window dragging still works
    // in the empty parts of the strip.
    <div
      className="app-region-no-drag absolute left-0 top-0 z-30 flex select-none items-center pr-2"
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingLeft: 'var(--oc-titlebar-left-inset, 0.75rem)',
      }}
    >
      <div ref={clusterRef} className="flex items-center gap-2">
        {windowControls}

        {handleOpenWindowsAppMenu ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={t('header.actions.openAppMenuAria')}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openAppMenu')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              {...toggleButtonProps}
              onClick={toggleSidebar}
              aria-label={t('header.actions.openSessionsAria')}
              className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
            >
              <Icon name="layout-left" className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.openSessionsWithShortcut', { shortcut: toggleShortcut })}</p>
          </TooltipContent>
        </Tooltip>

        {/* Labelled while the sidebar is open; collapses to an icon with a
            tooltip so the cluster stays compact over the header otherwise. */}
        {isSidebarOpen ? (
          <button
            type="button"
            {...newSessionButtonProps}
            onClick={handleNewSession}
            disabled={newSessionDisabled}
            className={cn(ICON_BUTTON_CLASS, '-ml-1 w-auto shrink-0 px-2 font-normal')}
          >
            <Icon name="chat-new" className="h-[18px] w-[18px]" />
            <span className="truncate">{t('sessions.sidebar.header.actions.newSession')}</span>
          </button>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                {...newSessionButtonProps}
                onClick={handleNewSession}
                disabled={newSessionDisabled}
                aria-label={t('sessions.sidebar.header.actions.newSession')}
                className={cn(ICON_BUTTON_CLASS, '-ml-1 shrink-0')}
              >
                <Icon name="chat-new" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('sessions.sidebar.header.actions.newSession')}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );
}
