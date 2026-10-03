import React from 'react';
import { TitlebarLeftControlsView } from './TitlebarLeftControlsView';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';



/**
 * Persistent top-left titlebar controls (app menu on frameless chrome + sidebar toggle).
 *
 * Rendered exactly once as an absolutely-positioned overlay above both the
 * sidebar and the header, so the buttons never migrate / re-mount between the
 * two while the sidebar animates open or closed — the panels slide *underneath*
 * a fixed control cluster instead. Its height tracks `--oc-header-height` and
 * its left padding clears the OS window controls via `--oc-titlebar-left-inset`.
 * The cluster's measured width is published as `--oc-titlebar-controls-width`
 * so the header can reserve matching space when the sidebar is collapsed.
 */
export const TitlebarLeftControls: React.FC = () => {
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  // Starting a session shares the titlebar row with the sidebar toggle, so it
  // stays in one place whether the sidebar is open or collapsed.
  const handleNewSession = React.useCallback(() => {
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().openNewSessionDraft();
  }, []);
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, []);

  return <TitlebarLeftControlsView
    isSidebarOpen={isSidebarOpen} onToggleSidebar={toggleSidebar} onNewSession={handleNewSession}
    toggleShortcut={toggleShortcut}
    windowControls={usesFramelessChrome && windowControlsSide === 'left' ? <WindowsWindowControls visible position="left" /> : null}
    onOpenAppMenu={usesFramelessChrome ? handleOpenWindowsAppMenu : undefined}
  />;
};
