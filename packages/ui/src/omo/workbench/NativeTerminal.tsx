import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { TerminalViewport } from '@/components/terminal/TerminalViewport';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';
import { DEFAULT_MONO_FONT } from '@/lib/fontOptions';
import { convertThemeToXterm } from '@/lib/terminalTheme';
import { createTerminalWorkspace, type TerminalWorkspace } from './terminal';
import { useOmoAppearance } from '../appearance/context';
import { nativeErrorCopy } from '../error-copy';

function TerminalOutput({ workspace, active }: { workspace: TerminalWorkspace; active: boolean }) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { settings } = useOmoAppearance();
  const selected = React.useSyncExternalStore(workspace.subscribe, workspace.getSelected);
  const buffer = React.useSyncExternalStore(workspace.subscribe, () => workspace.getBuffer(selected));
  const theme = React.useMemo(() => convertThemeToXterm(currentTheme), [currentTheme]);
  const container = React.useRef<HTMLDivElement>(null);
  const [font, setFont] = React.useState<{ size: number; family: string } | null>(null);
  React.useEffect(() => {
    const node = container.current;
    if (!node) return;
    const measure = () => {
      const computed = getComputedStyle(node);
      const size = Number.parseFloat(computed.fontSize);
      if (Number.isFinite(size) && size > 0) setFont((previous) => previous?.size === size && previous.family === computed.fontFamily
        ? previous : { size, family: computed.fontFamily });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [currentTheme, settings.fontSize, active]);
  return (
    <div ref={container} className="flex min-h-0 flex-1 flex-col font-mono typography-code" data-testid="omo-terminal-output">
      {!selected ? <p className="p-4 typography-ui-label text-muted-foreground">{t('terminalView.tabs.newTabTitle')}</p> : <>
      <div role="status" className="flex flex-wrap gap-2 px-2 py-1 typography-micro text-muted-foreground">
        {buffer.status === 'attaching' ? t('common.loading')
          : buffer.status === 'reconnecting' ? t('desktopHostSwitcher.sshPhase.reconnecting')
          : buffer.status === 'running' ? t('desktopHostSwitcher.status.connected')
          : buffer.status === 'exited' ? t('terminalView.error.sessionEnded') : t('common.unavailable')}
        {buffer.truncated && <span className="text-[var(--status-warning-text)]">{t('chat.toolPart.outputTruncated')}</span>}
      </div>
      {font && <TerminalViewport key={selected} sessionKey={selected} chunks={buffer.chunks}
        onInput={(data) => void workspace.write(data)} onResize={(cols, rows) => void workspace.resize(selected, cols, rows)}
        onProvisionalSize={() => {}} theme={theme} monoFont={DEFAULT_MONO_FONT} fontFamily={font.family} fontSize={font.size}
        isVisible={active} className="min-h-0 flex-1" />}
      </>}
    </div>
  );
}

export function NativeTerminal({ directory, active }: { directory: string; active: boolean }) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const [workspace] = React.useState(() => createTerminalWorkspace(directory));
  const tabs = React.useSyncExternalStore(workspace.subscribe, workspace.getTabs);
  const selected = React.useSyncExternalStore(workspace.subscribe, workspace.getSelected);
  const error = React.useSyncExternalStore(workspace.subscribe, workspace.getError);
  const busy = React.useSyncExternalStore(workspace.subscribe, workspace.isBusy);
  const appearance = React.useMemo(() => ({
    themeMode: currentTheme.metadata.variant,
    terminalBackground: currentTheme.colors.surface.background,
    terminalForeground: currentTheme.colors.syntax.base.foreground,
  }), [currentTheme]);
  React.useEffect(() => {
    workspace.setActive(active);
    if (active) void workspace.refresh();
    return () => workspace.setActive(false);
  }, [active, workspace]);
  React.useEffect(() => { void workspace.appearance(appearance); }, [appearance, workspace, selected, active]);
  React.useEffect(() => () => workspace.dispose(), [workspace]);
  return (
    <section className="flex h-full min-h-0 flex-col" data-testid="omo-terminal">
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1">
          {tabs.map((tab, index) => (
            <div key={tab.sessionId} className="flex items-center gap-1">
              <Button size="sm" variant="chip" aria-pressed={selected === tab.sessionId} onClick={() => workspace.select(tab.sessionId)} title={tab.sessionId}>
                <Icon name="terminal" className="size-4" />{index + 1}
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void workspace.close(tab.sessionId)}
                aria-label={t('terminalView.tabs.closeTabTitle')} data-testid="omo-terminal-close"><Icon name="close" className="size-4" /></Button>
            </div>
          ))}
        </div>
        <Button size="sm" disabled={busy} onClick={() => void workspace.create(appearance)} data-testid="omo-terminal-new">
          <Icon name="add" className="size-4" />{t('terminalView.tabs.newTabTitle')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void workspace.refresh()} aria-label={t('gitView.history.refresh')}>
          <Icon name="refresh" className="size-4" />
        </Button>
      </div>
      {error && <p role="alert" className="p-2 typography-ui-label text-[var(--status-error-text)]">{t('terminalView.error.connectionFailed', { message: nativeErrorCopy(error, t) })}</p>}
      <TerminalOutput workspace={workspace} active={active} />
    </section>
  );
}
