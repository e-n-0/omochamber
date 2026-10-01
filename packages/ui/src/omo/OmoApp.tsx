import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { createNativeClient, NativeClientError } from './client';
import type { NativeClient } from './client';
import { createNativeStore } from './state';
import type { NativeStore } from './state';
import type { CreateSession, NativeProject, NativeStatus, SessionSummary } from './contracts';
import { OmoAppearanceProvider } from './AppearanceProvider';
import { useOmoAppearance } from './appearance/context';
import { AuthGate } from './AuthGate';
import { ProjectSidebar } from './ProjectSidebar';
import { SessionSidebar } from './SessionSidebar';
import { NativeChat } from './chat/NativeChat';
import { NativeDialogs } from './chat/NativeDialogs';
import { useNativeSlice } from './chat/nativeHooks';
import { NativePanels } from './panels/NativePanels';
import { NativeWorkbench } from './workbench/NativeWorkbench';
import { nativeErrorCopy } from './error-copy';
import './omo.css';

const tabs = [
  { id: 'chat', label: 'layout.mainTab.chat', icon: 'chat-3' },
  { id: 'files', label: 'layout.mainTab.files', icon: 'folder' },
  { id: 'changes', label: 'mobile.menu.changes', icon: 'git-branch' },
  { id: 'terminal', label: 'layout.mainTab.terminal', icon: 'terminal' },
] as const satisfies readonly { readonly id: string; readonly label: string; readonly icon: IconName }[];
type Tab = typeof tabs[number]['id'];
const asError = (cause: unknown) => cause instanceof Error ? cause
  : new NativeClientError('transport', 'Native workspace operation failed', null, { cause });

function NativeStatusBar({ store, sessionKey, status, error, onRefresh }: {
  readonly store: NativeStore; readonly sessionKey: string | null;
  readonly status: NativeStatus | null; readonly error: Error | null; readonly onRefresh: () => void;
}) {
  const { t } = useI18n();
  const connection = useNativeSlice(store, sessionKey, (session) => session?.status);
  const sessionError = useNativeSlice(store, sessionKey, (session) => session?.error);
  const ownership = useNativeSlice(store, sessionKey, (session) => session?.snapshot?.ownership);
  const failure = sessionError ?? error;
  return <div className="flex min-w-0 flex-wrap items-center gap-2 typography-meta" data-testid="omo-native-status">
    <span role="status" className={status?.available && (!connection || connection === 'ready')
      ? 'text-[var(--status-success-text)]' : 'text-muted-foreground'}>
      {t(connection === 'hydrating' || !status ? 'common.loading' : connection === 'reconnecting'
        ? 'omo.chat.reconnecting' : connection === 'unavailable' || !status.available
          ? 'omo.shell.nativeUnavailable' : 'omo.shell.nativeReady')}
    </span>
    {ownership && ownership !== 'hosted' && <span className="text-muted-foreground">{t('omo.chat.readOnly')}</span>}
    {status?.reason && <span className="break-words text-muted-foreground">{status.reason}</span>}
    {failure && <span role="alert" className="break-words text-[var(--status-error-text)]">{nativeErrorCopy(failure, t)}</span>}
    <Button variant="ghost" size="xs" aria-label={t('sessionAuth.error.retry')} data-testid="omo-status-refresh" onClick={() => {
      onRefresh();
      if (sessionKey) void store.reconnect();
    }}><Icon name="refresh" className="size-4" /></Button>
  </div>;
}

function AppearanceNotice() {
  const { t } = useI18n();
  const appearance = useOmoAppearance();
  return <div className="space-y-2 border-t border-border pt-3 typography-meta">
    <span className="text-muted-foreground">{t('settings.page.appearance.title')}</span>
    <div className="flex flex-wrap gap-2">
      <Button size="xs" variant="chip" disabled={appearance.status !== 'ready' || appearance.saving}
        aria-pressed={appearance.settings.theme === 'openchamber-light'} data-testid="omo-theme-light"
        onClick={() => { void appearance.updateSettings({ theme: 'openchamber-light' }).catch(() => {}); }}>
        {t('omo.shell.light')}
      </Button>
      <Button size="xs" variant="chip" disabled={appearance.status !== 'ready' || appearance.saving}
        aria-pressed={appearance.settings.theme === 'openchamber-dark'} data-testid="omo-theme-dark"
        onClick={() => { void appearance.updateSettings({ theme: 'openchamber-dark' }).catch(() => {}); }}>
        {t('omo.shell.dark')}
      </Button>
      <Button size="xs" variant="chip" disabled={appearance.status !== 'ready' || appearance.saving}
        aria-pressed={(appearance.settings.theme ?? 'system') === 'system'} data-testid="omo-theme-system"
        onClick={() => { void appearance.updateSettings({ theme: 'system' }).catch(() => {}); }}>
        {t('omo.shell.system')}
      </Button>
    </div>
    {appearance.error && <div role="alert" className="space-y-2">
      <p className="break-words text-[var(--status-error-text)]">{nativeErrorCopy(appearance.error, t)}</p>
      <Button size="xs" variant="outline" onClick={() => { void appearance.reload().catch(() => {}); }}>{t('sessionAuth.error.retry')}</Button>
    </div>}
  </div>;
}

function NativeWorkspace({ client, store }: { readonly client: NativeClient; readonly store: NativeStore }) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<NativeProject[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [scope, setScope] = useState<{ readonly projectId: string; readonly directory: string } | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chat');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<Error | null>(null);
  const [sessionsError, setSessionsError] = useState<Error | null>(null);
  const [operationError, setOperationError] = useState<Error | null>(null);
  const [status, setStatus] = useState<NativeStatus | null>(null);
  const [statusError, setStatusError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const projectsRequest = useRef<AbortController | null>(null);
  const sessionsRequest = useRef<AbortController | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const projectsRevision = useRef(0);
  const sessionsRevision = useRef(0);

  const refreshProjects = useCallback(async () => {
    projectsRequest.current?.abort();
    const abort = new AbortController();
    projectsRequest.current = abort;
    const revision = projectsRevision.current;
    setProjectsLoading(true);
    try {
      const next = await client.projects(abort.signal);
      if (abort.signal.aborted || revision !== projectsRevision.current) return;
      setProjects(next);
      setProjectsError(null);
      setScope((previous) => {
        const project = next.find((item) => item.id === previous?.projectId) ?? next[0];
        if (!project) return null;
        const directory = previous && [project.path, ...(project.worktreePaths ?? [])].includes(previous.directory)
          ? previous.directory : project.path;
        return previous?.projectId === project.id && previous.directory === directory ? previous : { projectId: project.id, directory };
      });
    } catch (cause) { if (!abort.signal.aborted) setProjectsError(asError(cause)); }
    finally { if (!abort.signal.aborted) setProjectsLoading(false); }
  }, [client]);
  const refreshSessions = useCallback(async () => {
    sessionsRequest.current?.abort();
    const abort = new AbortController();
    sessionsRequest.current = abort;
    const revision = sessionsRevision.current;
    setSessionsLoading(true);
    try {
      const next = await client.sessions(undefined, abort.signal);
      if (!abort.signal.aborted && revision === sessionsRevision.current) { setSessions(next); setSessionsError(null); }
    } catch (cause) { if (!abort.signal.aborted) setSessionsError(asError(cause)); }
    finally { if (!abort.signal.aborted) setSessionsLoading(false); }
  }, [client]);
  const refreshStatus = useCallback(async () => {
    statusRequest.current?.abort();
    const abort = new AbortController();
    statusRequest.current = abort;
    try {
      const next = await client.status(abort.signal);
      if (!abort.signal.aborted) { setStatus(next); setStatusError(null); }
    } catch (cause) { if (!abort.signal.aborted) setStatusError(asError(cause)); }
  }, [client]);
  useEffect(() => {
    void refreshProjects();
    void refreshSessions();
    void refreshStatus();
    return () => {
      projectsRequest.current?.abort();
      sessionsRequest.current?.abort();
      statusRequest.current?.abort();
    };
  }, [refreshProjects, refreshSessions, refreshStatus]);
  const previousScope = useRef(scope);
  useEffect(() => {
    if (previousScope.current?.directory !== scope?.directory || previousScope.current?.projectId !== scope?.projectId) {
      setSessionKey(null);
      setOperationError(null);
    }
    previousScope.current = scope;
  }, [scope]);
  const selectDirectory = (project: NativeProject, directory: string) => {
    setSessionKey(null);
    setScope({ projectId: project.id, directory });
    setOperationError(null);
  };
  const selectSession = (session: SessionSummary) => {
    setSessionKey(session.sessionKey);
    setTab('chat');
    setNavigationOpen(false);
    setOperationError(null);
    void store.selectSession(session.sessionKey);
  };
  const create = async () => {
    const captured = scopeRef.current;
    if (!captured || creatingRef.current) return;
    const project = projects.find((item) => item.id === captured.projectId);
    if (!project || ![project.path, ...(project.worktreePaths ?? [])].includes(captured.directory)) return;
    creatingRef.current = true;
    setCreating(true);
    setOperationError(null);
    try {
      const input: CreateSession = { requestId: crypto.randomUUID(), projectId: project.id };
      if (captured.directory !== project.path) input.worktreePath = captured.directory;
      const session = await client.createSession(input);
      sessionsRevision.current += 1;
      setSessions((previous) => [...previous.filter((item) => item.sessionKey !== session.sessionKey), session]);
      if (scopeRef.current?.projectId === captured.projectId && scopeRef.current.directory === captured.directory) selectSession(session);
    } catch (cause) { setOperationError(asError(cause)); }
    finally { creatingRef.current = false; setCreating(false); }
  };
  const visibleSessions = useMemo(() => sessions.filter((session) => session.directory === scope?.directory), [sessions, scope?.directory]);
  const project = projects.find((item) => item.id === scope?.projectId);

  return <div className="omo-shell" data-testid="omo-app" data-navigation-open={navigationOpen} data-panels-open={panelsOpen}>
    <header className="omo-toolbar">
      <Button variant="ghost" size="sm" aria-label={t(navigationOpen ? 'mobile.sessions.closeSheetAria' : 'mobile.sessions.openSheetAria')}
        aria-expanded={navigationOpen} aria-controls="omo-navigation" data-testid="omo-navigation-toggle"
        onClick={() => setNavigationOpen(!navigationOpen)}><Icon name="folder" className="size-4" /></Button>
      <strong className="omo-brand typography-ui-header">OmoChamber</strong>
      <span className="omo-project-title truncate typography-meta text-muted-foreground" title={scope?.directory}>
        {project?.name ?? t('mobile.header.noProject')}
      </span>
      <nav className="omo-tabs" aria-label={t('mobile.menu.titleAria')}>
        {tabs.map((item) => <Button key={item.id} variant="chip" size="sm" aria-pressed={tab === item.id}
          aria-label={t(item.label)} title={t(item.label)}
          data-testid={`omo-tab-${item.id}`} onClick={() => { setTab(item.id); setNavigationOpen(false); setPanelsOpen(false); }}>
          <Icon name={item.icon} className="size-4" /><span className="min-w-0 truncate">{t(item.label)}</span>
        </Button>)}
      </nav>
      <Button variant="chip" size="sm" aria-pressed={panelsOpen} aria-controls="omo-panels"
        data-testid="omo-panels-toggle" onClick={() => { setPanelsOpen(!panelsOpen); setNavigationOpen(false); }}>
        {t('omo.panels.title')}
      </Button>
    </header>
    <div className="omo-workspace">
      <aside id="omo-navigation" className="omo-navigation">
        <ProjectSidebar projects={projects} projectId={scope?.projectId ?? null} directory={scope?.directory ?? null}
          loading={projectsLoading} error={projectsError} onSelect={selectDirectory} onRefresh={() => { void refreshProjects(); }}
          onAdd={async (input) => {
            const added = await client.addProject(input);
            projectsRevision.current += 1;
            setProjects((previous) => [...previous, added]);
            selectDirectory(added, added.path);
          }}
          onRename={async (item, name) => {
            const renamed = await client.updateProject(item.id, { name });
            projectsRevision.current += 1;
            setProjects((previous) => previous.map((entry) => entry.id === item.id ? renamed : entry));
          }} />
        <SessionSidebar sessions={visibleSessions} store={store} sessionKey={sessionKey}
          loading={sessionsLoading} error={sessionsError} creating={creating} canCreate={Boolean(project && status?.available)}
          onCreate={() => { void create(); }} onSelect={selectSession} onRefresh={() => { void refreshSessions(); }} />
        <AppearanceNotice />
      </aside>
      <main className="omo-main">
        <div className="omo-context border-b border-border px-4 py-2">
          <p className="truncate typography-micro text-muted-foreground" title={scope?.directory}>{scope?.directory}</p>
          <NativeStatusBar store={store} sessionKey={sessionKey} status={status} error={statusError} onRefresh={() => { void refreshStatus(); }} />
          {operationError && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(operationError, t)}</p>}
        </div>
        <div className="omo-content">
          <div hidden={tab !== 'chat'} className="omo-tab-content">
            <NativeChat client={client} store={store} sessionKey={sessionKey} />
          </div>
          <div hidden={tab === 'chat'} className="omo-tab-content">
            <NativeWorkbench directory={tab === 'chat' ? null : scope?.directory ?? null}
              tab={tab === 'chat' ? 'files' : tab} onProjectsChange={() => { void refreshProjects(); }} />
          </div>
        </div>
      </main>
      <div id="omo-panels" className="omo-panels">
        <NativePanels client={client} store={store} sessionKey={sessionKey} />
      </div>
    </div>
    <NativeDialogs store={store} sessionKey={sessionKey} />
  </div>;
}

function OwnedWorkspace({ client }: { readonly client: NativeClient }) {
  const [store, setStore] = useState<NativeStore | null>(null);
  const { t } = useI18n();
  useEffect(() => {
    const owned = createNativeStore({ client });
    setStore(owned);
    return () => { void owned.dispose(); };
  }, [client]);
  return store ? <NativeWorkspace client={client} store={store} /> : <p role="status">{t('common.loading')}</p>;
}

/** The native entrypoint owns runtime transport and I18nProvider, not legacy bootstrap. */
export function OmoApp({ client, store }: { readonly client?: NativeClient; readonly store?: NativeStore }) {
  const resolvedClient = useMemo(() => client ?? createNativeClient(), [client]);
  const [runtimeKey, setRuntimeKey] = useState(resolvedClient.runtimeKey);
  useEffect(() => subscribeRuntimeEndpointChanged(() => {
    store?.resetRuntime();
    setRuntimeKey(resolvedClient.runtimeKey());
  }), [resolvedClient, store]);
  return <AuthGate key={runtimeKey}>
    <OmoAppearanceProvider client={resolvedClient}>
      {store ? <NativeWorkspace client={resolvedClient} store={store} /> : <OwnedWorkspace client={resolvedClient} />}
    </OmoAppearanceProvider>
  </AuthGate>;
}
