import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { WorkspaceError } from './workspace';
import type { ChangesWorkspace } from './changes';
import { nativeErrorCopy } from '../error-copy';

export function NativeWorktrees({ workspace, onProjectsChange }: {
  workspace: ChangesWorkspace;
  onProjectsChange?: () => void;
}) {
  const { t } = useI18n();
  const trees = React.useSyncExternalStore(workspace.subscribe, workspace.getWorktrees);
  const busy = React.useSyncExternalStore(workspace.subscribe, workspace.isBusy);
  const [branch, setBranch] = React.useState('');
  const [removing, setRemoving] = React.useState<string | null>(null);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!branch.trim()) return;
    if (await workspace.createWorktree(branch.trim())) { setBranch(''); onProjectsChange?.(); }
  };
  const remove = async (path: string) => {
    if (await workspace.removeWorktree(path)) { setRemoving(null); onProjectsChange?.(); }
  };
  return (
    <section className="space-y-2 border-t border-border p-2" data-testid="omo-worktrees">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 typography-ui-label">{t('mobile.sessions.section.worktrees')}</h2>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => void workspace.refreshWorktrees()} aria-label={t('gitView.history.refresh')}>
          <Icon name="refresh" className="size-4" />
        </Button>
      </div>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => void create(event)}>
        <Input aria-label={t('session.newWorktree.branchName')} placeholder={t('session.newWorktree.branchNamePlaceholder')}
          value={branch} onChange={(event) => setBranch(event.target.value)} disabled={busy} data-testid="omo-worktree-branch" />
        <Button size="sm" type="submit" disabled={busy || !branch.trim()} data-testid="omo-worktree-create">{t('session.newWorktree.actions.createWorktree')}</Button>
      </form>
      {trees.error && <div role="alert" className="space-y-1 typography-ui-label text-[var(--status-error-text)]" data-testid="omo-worktree-error">
        <p>{t('gitView.branch.operationFailed')}</p>
        {trees.error instanceof WorkspaceError && <p className="typography-code">{trees.error.status} {trees.error.code}</p>}
        <p>{nativeErrorCopy(trees.error, t)}</p>
      </div>}
      {!trees.loaded && !trees.error && <p className="typography-ui-label">{t('common.loading')}</p>}
      {trees.loaded && trees.entries.length === 0 && <p className="typography-ui-label text-muted-foreground">{t('mobile.projectEdit.worktreesEmpty')}</p>}
      <ul className="space-y-2">
        {trees.entries.map((tree) => (
          <li key={tree.path} className="space-y-1">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate typography-ui-label" title={tree.branch}>{tree.branch || tree.head.slice(0, 8)}</p>
                <p className="break-all typography-micro text-muted-foreground">{tree.path}</p>
              </div>
              {trees.owned.has(tree.path) && <Button size="xs" variant="ghost" disabled={busy} onClick={() => setRemoving(tree.path)}
                aria-label={t('mobile.projectEdit.deleteWorktreeAria', { label: tree.name })} data-testid="omo-worktree-remove">
                <Icon name="delete-bin" className="size-4" />
              </Button>}
            </div>
            {removing === tree.path && <div className="space-y-2 rounded-lg border border-border p-2">
              <p className="typography-ui-label">{t('sessions.sidebar.dialogs.worktreeDelete.descriptionNoLinked')}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove(tree.path)} data-testid="omo-worktree-remove-confirm">{t('mobile.projectEdit.deleteWorktreeTitle')}</Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(null)}>{t('gitView.common.cancel')}</Button>
              </div>
            </div>}
          </li>
        ))}
      </ul>
    </section>
  );
}
