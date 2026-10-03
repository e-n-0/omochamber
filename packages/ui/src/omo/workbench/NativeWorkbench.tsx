import React from 'react';
import { useI18n } from '@/lib/i18n';
import { NativeFiles } from './NativeFiles';
import { NativeChanges } from './NativeChanges';
import { NativeTerminal } from './NativeTerminal';

export interface NativeWorkbenchProps {
  directory: string | null;
  tab: 'files' | 'changes' | 'terminal';
  onProjectsChange?: () => void;
}

export interface NativeWorkspaceContentsProps extends NativeWorkbenchProps {
  readonly visible: boolean;
}

/**
 * The shell supplies the canonical directory. Retain visited scopes in memory
 * so selecting a project or another tool never discards unsaved file drafts.
 * Hidden scopes do not fetch or attach, and no native chat store is subscribed.
 */
export function NativeWorkbench(props: NativeWorkbenchProps) {
  return <NativeWorkspaceContents {...props} visible />;
}

export function NativeWorkspaceContents({ directory, tab, onProjectsChange, visible }: NativeWorkspaceContentsProps) {
  const { t } = useI18n();
  const [directories, setDirectories] = React.useState<string[]>(() => directory ? [directory] : []);
  if (directory && !directories.includes(directory)) setDirectories([...directories, directory]);
  return (
    <div className="h-full min-h-0 min-w-0 bg-background text-foreground" data-testid="omo-workbench" hidden={!visible}>
      {!directory && <p className="p-4 typography-ui-label text-muted-foreground">{t('omo.workbench.noDirectory')}</p>}
      {directories.map((scope) => (
        <div key={scope} hidden={scope !== directory} className="h-full min-h-0">
          <div hidden={tab !== 'files'} className="h-full min-h-0">
            <NativeFiles directory={scope} active={visible && scope === directory && tab === 'files'} />
          </div>
          <div hidden={tab !== 'changes'} className="h-full min-h-0">
            <NativeChanges directory={scope} active={visible && scope === directory && tab === 'changes'} onProjectsChange={onProjectsChange} />
          </div>
          <div hidden={tab !== 'terminal'} className="h-full min-h-0">
            <NativeTerminal directory={scope} active={visible && scope === directory && tab === 'terminal'} />
          </div>
        </div>
      ))}
    </div>
  );
}
