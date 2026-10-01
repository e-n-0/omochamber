import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { createChangesWorkspace, type ChangesWorkspace } from './changes';
import { createWorkspaceClient } from './workspace';
import { NativeWorktrees } from './NativeWorktrees';
import { SubmoduleDiffSummary } from '@/components/views/SubmoduleDiffSummary';
import { nativeErrorCopy } from '../error-copy';

const NativeDiff = React.lazy(() => import('./NativeDiff').then((module) => ({ default: module.NativeDiff })));

function WorkingDiff({ workspace }: { workspace: ChangesWorkspace }) {
  const { t } = useI18n();
  const diff = React.useSyncExternalStore(workspace.subscribe, workspace.getDiff);
  if (!diff) return <p className="p-4 typography-ui-label text-muted-foreground">{t('filesView.editor.selectFile')}</p>;
  if (diff.error) return <p role="alert" className="p-4 typography-ui-label text-[var(--status-error-text)]">{nativeErrorCopy(diff.error, t)}</p>;
  if (!diff.value) return <p className="p-4 typography-ui-label">{t('common.loading')}</p>;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="omo-working-diff">
      <div className="flex flex-wrap gap-2 border-b border-border p-2 typography-code">
        <span className="min-w-0 flex-1 break-all">{diff.selection.path}</span>
        <span className="typography-micro text-muted-foreground">{t(diff.selection.staged ? 'gitView.changes.stagedTitle' : 'gitView.changes.title')}</span>
      </div>
      {diff.value.isBinary ? <p className="p-4 typography-ui-label">{t('filesView.editor.cannotPreviewBinary')}</p> : (
        <React.Suspense fallback={<p className="p-4 typography-ui-label">{t('common.loading')}</p>}>
          <NativeDiff original={diff.value.original} modified={diff.value.modified} fileName={diff.selection.path} />
        </React.Suspense>
      )}
      {diff.value.submodule && <div className="p-2"><SubmoduleDiffSummary state={diff.value.submodule} staged={diff.selection.staged} /></div>}
    </section>
  );
}

export function NativeChanges({ directory, active, onProjectsChange }: {
  directory: string; active: boolean; onProjectsChange?: () => void;
}) {
  const { t } = useI18n();
  const [workspace] = React.useState(() => createChangesWorkspace(createWorkspaceClient(directory)));
  const status = React.useSyncExternalStore(workspace.subscribe, workspace.getStatus);
  const error = React.useSyncExternalStore(workspace.subscribe, workspace.getError);
  const busy = React.useSyncExternalStore(workspace.subscribe, workspace.isBusy);
  React.useEffect(() => {
    if (active) { void workspace.refresh(); void workspace.refreshWorktrees(); }
  }, [active, workspace]);
  const staged = status?.files.filter((file) => file.index !== ' ' && file.index !== '?') ?? [];
  const working = status?.files.filter((file) => file.working_dir !== ' ') ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row" data-testid="omo-changes">
      <aside className="max-h-80 min-h-0 overflow-auto border-b border-border md:max-h-none md:w-80 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b border-border p-2">
          <span className="min-w-0 flex-1 truncate typography-code">{status?.current ?? t('gitView.branch.detachedHead')}</span>
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void workspace.refresh()} aria-label={t('gitView.history.refresh')}>
            <Icon name="refresh" className="size-4" />
          </Button>
        </div>
        {error && <p role="alert" className="p-2 typography-ui-label text-[var(--status-error-text)]">{t('gitView.branch.operationFailed')}: {nativeErrorCopy(error, t)}</p>}
        {!status && !error && <p className="p-2 typography-ui-label">{t('common.loading')}</p>}
        {status?.isGitRepository === false ? <p className="p-4 typography-ui-label">{t('gitView.empty.notGitRepository')}</p> : (
          <>
            {status && status.files.length === 0 && <p className="p-4 typography-ui-label text-muted-foreground">{t('gitView.empty.cleanTitle')}</p>}
            {[{ files: working, staged: false }, { files: staged, staged: true }].map((group) => (
              <section key={String(group.staged)} className="space-y-1 p-2">
                <h2 className="typography-ui-label text-muted-foreground">{t(group.staged ? 'gitView.changes.stagedTitle' : 'gitView.changes.title')}</h2>
                {group.files.map((file) => (
                  <div key={file.path} className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" className="min-w-0 flex-1 justify-start" disabled={busy}
                      onClick={() => void workspace.select({ path: file.path, staged: group.staged })} title={file.path} data-testid="omo-changed-file">
                      <span className="typography-code">{group.staged ? file.index : file.working_dir}</span><span className="truncate">{file.path}</span>
                    </Button>
                    <Button size="xs" variant="ghost" disabled={busy} onClick={() => void workspace.stage({ path: file.path, staged: group.staged })}
                      aria-label={t(group.staged ? 'gitView.changes.unstageFileAria' : 'gitView.changes.stageFileAria', { path: file.path })}
                      data-testid={group.staged ? 'omo-unstage' : 'omo-stage'}>
                      <Icon name={group.staged ? 'subtract' : 'add'} className="size-4" />
                    </Button>
                  </div>
                ))}
              </section>
            ))}
            <NativeWorktrees workspace={workspace} onProjectsChange={onProjectsChange} />
          </>
        )}
      </aside>
      <WorkingDiff workspace={workspace} />
    </div>
  );
}
