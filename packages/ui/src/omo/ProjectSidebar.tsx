import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { NativeProject, ProjectInput } from './contracts';
import { nativeErrorCopy } from './error-copy';
import { NativeClientError } from './client';
import { useNativeDesktop } from './desktop/context';

export function ProjectSidebar({ projects, projectId, directory, loading, error, onSelect, onAdd, onRename, onRefresh }: {
  readonly projects: readonly NativeProject[];
  readonly projectId: string | null;
  readonly directory: string | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly onSelect: (project: NativeProject, directory: string) => void;
  readonly onAdd: (input: ProjectInput) => Promise<void>;
  readonly onRename: (project: NativeProject, name: string) => Promise<void>;
  readonly onRefresh: () => void;
}) {
  const { t } = useI18n();
  const desktop = useNativeDesktop();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const [pickerError, setPickerError] = useState<Error | null>(null);
  const picking = useRef(false);
  const chooseFolder = async () => {
    if (!desktop || busy || picking.current) return;
    picking.current = true;
    setBusy(true);
    setPickerError(null);
    try {
      const defaultPath = path.trim() || directory;
      const selected = await desktop.selectFolder(defaultPath ? { defaultPath } : {});
      if (selected !== null) setPath(selected);
    } catch (cause) {
      setPickerError(cause instanceof Error ? cause : new Error('Native folder selection failed', { cause }));
    } finally { picking.current = false; setBusy(false); }
  };
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setPickerError(null);
    try {
      const project = projects.find((item) => item.id === editing);
      if (adding) {
        const input: ProjectInput = { path: path.trim() };
        if (name.trim()) input.name = name.trim();
        await onAdd(input);
      }
      else if (project) await onRename(project, name.trim());
      setAdding(false);
      setEditing(null);
      setPath('');
      setName('');
    } catch (cause) {
      setFailure(cause instanceof Error ? cause : new NativeClientError('transport', 'Native project operation failed', null, { cause }));
    } finally { setBusy(false); }
  };
  return <section aria-label={t('mobile.sessions.section.projects')} data-testid="omo-project-sidebar" className="space-y-3">
    <div className="flex items-center gap-2">
      <h2 className="flex-1 typography-ui-header font-medium">{t('mobile.sessions.section.projects')}</h2>
      <Button size="xs" variant="ghost" aria-label={t('gitView.history.refresh')} onClick={onRefresh} disabled={loading}>
        <Icon name="refresh" className="size-4" />
      </Button>
      <Button size="xs" variant="ghost" data-testid="omo-add-project" aria-label={t('sessions.sidebar.header.actions.addProject')}
        disabled={busy} onClick={() => { setAdding(true); setEditing(null); setName(''); setFailure(null); setPickerError(null); }}>
        <Icon name="add" className="size-4" />
      </Button>
    </div>
    {loading && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
    {error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
    {!loading && !error && projects.length === 0 && <p className="typography-meta text-muted-foreground">
      {t('mobile.sessions.empty.noProjectsDescription')}
    </p>}
    <ul className="space-y-2">
      {projects.map((project) => <li key={project.id} className="min-w-0">
        <div className="flex items-center gap-1">
          <Button variant="chip" size="sm" className="min-w-0 flex-1 justify-start" data-project-id={project.id}
            aria-pressed={projectId === project.id && directory === project.path} title={project.path}
            onClick={() => onSelect(project, project.path)}>
            <Icon name="folder" className="size-4" /><span className="truncate">{project.name}</span>
          </Button>
          <Button variant="ghost" size="xs" aria-label={t('mobile.sessions.editProjectAria', { label: project.name })}
            data-project-rename={project.id} disabled={busy}
            onClick={() => { setEditing(project.id); setAdding(false); setName(project.name); setFailure(null); setPickerError(null); }}>
            <Icon name="edit" className="size-4" />
          </Button>
        </div>
        {projectId === project.id && <div className="mt-1 space-y-1 pl-4">
          <p className="break-all typography-micro text-muted-foreground">{project.path}</p>
          {project.worktreePaths?.map((worktree) => <Button key={worktree} size="sm" variant="chip"
            className="w-full min-w-0 justify-start" data-worktree-path={worktree} title={worktree}
            aria-pressed={directory === worktree} onClick={() => onSelect(project, worktree)}>
            <Icon name="git-branch" className="size-4" /><span className="truncate">{worktree.split('/').at(-1) || worktree}</span>
          </Button>)}
        </div>}
      </li>)}
    </ul>
    {(adding || editing) && <form className="space-y-2 border-t border-border pt-3" data-testid="omo-project-form"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {adding && <Input autoFocus value={path} onChange={(event) => setPath(event.currentTarget.value)} disabled={busy}
        aria-label={t('omo.shell.projectPath')} placeholder={t('omo.shell.projectPath')} data-testid="omo-project-path" />}
      {adding && desktop && <Button size="sm" variant="outline" disabled={busy} data-testid="omo-project-choose-folder"
        onClick={() => { void chooseFolder(); }}>
        <Icon name="folder" className="size-4" />{t('omo.desktop.chooseFolder')}
      </Button>}
      <Input value={name} onChange={(event) => setName(event.currentTarget.value)} disabled={busy} autoFocus={!adding}
        aria-label={t('projectEditDialog.field.name')} placeholder={t('projectEditDialog.field.namePlaceholder')} data-testid="omo-project-name" />
      {failure && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(failure, t)}</p>}
      {pickerError && <p role="alert" data-testid="omo-project-picker-error" className="break-words typography-meta text-[var(--status-error-text)]">
        {t('omo.desktop.operationFailed', { error: nativeErrorCopy(pickerError, t) })}
      </p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || (adding ? !path.trim() : !name.trim())} data-testid="omo-project-save">
          {t(adding ? 'sessions.sidebar.header.actions.addProject' : 'projectEditDialog.actions.save')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setAdding(false); setEditing(null); setFailure(null); setPickerError(null); }}>
          {t('projectEditDialog.actions.cancel')}
        </Button>
      </div>
    </form>}
  </section>;
}
