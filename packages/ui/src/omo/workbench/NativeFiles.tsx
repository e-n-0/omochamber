import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { useI18n } from '@/lib/i18n';
import { createFileWorkspace, type FileWorkspace } from './files';
import { createWorkspaceClient } from './workspace';
import { nativeErrorCopy } from '../error-copy';
import { useNativeDesktop } from '../desktop/context';

function FileEditor({ workspace }: { workspace: FileWorkspace }) {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const path = React.useSyncExternalStore(workspace.subscribe, workspace.getSelected);
  const document = React.useSyncExternalStore(workspace.subscribe, () => workspace.getDocument(path));
  const extensions = React.useMemo(() => [
    createFlexokiCodeMirrorTheme(currentTheme),
    ...(path ? [languageByExtension(path)].filter((extension) => extension !== null) : []),
  ], [currentTheme, path]);
  const save = () => { if (path) void workspace.save(path).catch(() => {}); };

  if (!document) return <p className="p-4 typography-ui-label text-muted-foreground">{t('filesView.editor.pickFileFromTree')}</p>;
  if (document.status === 'loading') return <p className="p-4 typography-ui-label">{t('common.loading')}</p>;
  const dirty = document.content !== document.saved;
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); save(); }
    }}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <span className="min-w-0 flex-1 truncate typography-code" title={document.path}>{document.path}</span>
        <span className="typography-micro text-muted-foreground" role="status">
          {document.status === 'saving' ? t('filesView.editor.saving') : dirty ? t('filesView.unsaved.title') : t('filesView.editor.saved')}
        </span>
        <Button size="sm" disabled={!dirty || document.status === 'saving'} onClick={save} data-testid="omo-file-save">
          <Icon name="save-3" className="size-4" />{t('filesView.editor.saveFile')}
        </Button>
      </div>
      {document.error && <p role="alert" className="p-2 typography-ui-label text-[var(--status-error-text)]">{t('filesView.toast.saveFailed')}: {nativeErrorCopy(document.error, t)}</p>}
      <CodeMirrorEditor key={document.path} value={document.content} onChange={(content) => workspace.edit(document.path, content)}
        extensions={extensions} className="min-h-0 flex-1" />
    </section>
  );
}

export function NativeFiles({ directory, active }: { directory: string; active: boolean }) {
  const { t } = useI18n();
  const desktop = useNativeDesktop();
  const [workspace] = React.useState(() => createFileWorkspace(createWorkspaceClient(directory)));
  const listing = React.useSyncExternalStore(workspace.subscribe, workspace.getListing);
  const error = React.useSyncExternalStore(workspace.subscribe, workspace.getListingError);
  const browsing = React.useSyncExternalStore(workspace.subscribe, workspace.getBrowsing);
  const selected = React.useSyncExternalStore(workspace.subscribe, workspace.getSelected);
  const document = React.useSyncExternalStore(workspace.subscribe, () => workspace.getDocument(selected));
  const dirty = React.useSyncExternalStore(workspace.subscribe, workspace.isDirty);
  const [desktopError, setDesktopError] = React.useState<Error | null>(null);
  const [desktopBusy, setDesktopBusy] = React.useState(false);
  const operating = React.useRef(false);
  const activeRef = React.useRef(active);
  activeRef.current = active;
  const runDesktop = async (operation: 'selectFile' | 'openPath' | 'revealPath') => {
    if (!desktop || !active || operating.current) return;
    if (operation !== 'selectFile' && (!selected || !document || document.status === 'loading')) return;
    operating.current = true;
    setDesktopBusy(true);
    setDesktopError(null);
    try {
      if (operation === 'selectFile') {
        const path = await desktop.selectFile({ defaultPath: directory });
        if (path === null || !activeRef.current) return;
        const previous = workspace.getSelected();
        // The registered-directory server remains authoritative, even for a
        // main-granted selection. A refused read must not replace the editor.
        await workspace.open(path);
        if (!workspace.getDocument(path) && previous && workspace.getSelected() === path) await workspace.open(previous);
      } else if (selected) await desktop[operation](selected);
    } catch (cause) {
      setDesktopError(cause instanceof Error ? cause : new Error('Native file action failed', { cause }));
    } finally { operating.current = false; setDesktopBusy(false); }
  };
  React.useEffect(() => { if (active) void workspace.list(); }, [active, workspace]);
  React.useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  const parent = browsing.slice(0, browsing.lastIndexOf('/')) || '/';
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="omo-files">
      {desktop && <div className="flex flex-wrap items-center gap-2 border-b border-border p-2">
        <Button size="sm" variant="outline" disabled={!active || desktopBusy} data-testid="omo-file-choose"
          onClick={() => { void runDesktop('selectFile'); }}>{t('filesView.editor.selectFile')}</Button>
        <Button size="sm" variant="ghost" disabled={!active || desktopBusy || !document || document.status === 'loading'}
          data-testid="omo-file-open-native" onClick={() => { void runDesktop('openPath'); }}>{t('omo.desktop.openPath')}</Button>
        <Button size="sm" variant="ghost" disabled={!active || desktopBusy || !document || document.status === 'loading'}
          data-testid="omo-file-reveal-native" onClick={() => { void runDesktop('revealPath'); }}>{t('common.revealPath.fileManager')}</Button>
      </div>}
      {desktopError && <p role="alert" data-testid="omo-file-desktop-error" className="break-words p-2 typography-ui-label text-[var(--status-error-text)]">
        {t('omo.desktop.operationFailed', { error: nativeErrorCopy(desktopError, t) })}
      </p>}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex max-h-48 min-h-0 flex-col border-b border-border md:max-h-none md:w-64 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 border-b border-border p-2">
          <Button size="xs" variant="ghost" disabled={browsing === directory} onClick={() => void workspace.list(parent)}>{t('filesView.editor.back')}</Button>
          <span className="min-w-0 flex-1 truncate typography-micro" title={browsing}>{browsing}</span>
          <Button size="xs" variant="ghost" aria-label={t('filesView.tree.actions.refreshTitle')} onClick={() => void workspace.list()}>
            <Icon name="refresh" className="size-4" />
          </Button>
        </div>
        {error && <p role="alert" className="p-2 typography-ui-label text-[var(--status-error-text)]">
          {t('filesView.error.readFileFailed')}: {nativeErrorCopy(error, t)}
        </p>}
        {!listing && !error && <p className="p-2 typography-ui-label">{t('common.loading')}</p>}
        <nav className="min-h-0 flex-1 overflow-auto p-2" aria-label={t('omo.workbench.browserAria')}>
          {(listing?.path === browsing ? listing.entries : []).map((entry) => (
            <Button key={entry.path} size="sm" variant="ghost" className={`w-full justify-start ${entry.path === selected ? 'bg-interactive-selection text-interactive-selection-foreground' : ''}`}
              title={entry.path} onClick={() => { if (entry.isDirectory) void workspace.list(entry.path); else void workspace.open(entry.path); }}>
              <Icon name={entry.isDirectory ? 'folder' : 'file'} className="size-4" /><span className="truncate">{entry.name}</span>
            </Button>
          ))}
        </nav>
      </aside>
      <FileEditor workspace={workspace} />
      </div>
    </div>
  );
}
