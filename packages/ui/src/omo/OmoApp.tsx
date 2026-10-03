import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { MainLayoutView } from '@/components/layout/MainLayoutView';
import { HeaderView } from '@/components/layout/HeaderView';
import { HeaderTitleView } from '@/components/layout/HeaderTitleView';
import { SidebarView } from '@/components/layout/SidebarView';
import { SidebarTopBar } from '@/components/layout/SidebarTopBar';
import { TitlebarLeftControlsView } from '@/components/layout/TitlebarLeftControlsView';
import { ContextPanelRailItemView, ContextPanelRailView } from '@/components/layout/ContextPanelRailView';
import { WORK_STATUS_REQUIRED_ROW_WIDTH } from '@/components/chat/work-status/workStatusVisibility';
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
import { NativeChat } from './chat/NativeChat';
import { NativeDialogs } from './chat/NativeDialogs';
import { useNativeSlice } from './chat/nativeHooks';
import { nativeErrorCopy } from './error-copy';
import { NativeNavigation } from './navigation/NativeNavigation';
import { NativeWorkStatusPanel } from './panels/NativeWorkStatusPanel';
import { NativeContextPanel } from './workbench/NativeContextPanel';
import { useNativeDesktop } from './desktop/context';

const tools = [
  { id: 'files', label: 'layout.mainTab.files', icon: 'folder' },
  { id: 'changes', label: 'mobile.menu.changes', icon: 'git-branch' },
  { id: 'terminal', label: 'layout.mainTab.terminal', icon: 'terminal' },
] as const satisfies readonly { readonly id: string; readonly label: string; readonly icon: IconName }[];
type Tool = typeof tools[number]['id'];
const asError = (cause: unknown) => cause instanceof Error ? cause
  : new NativeClientError('transport', 'Native workspace operation failed', null, { cause });

const SIDEBAR_MIN_WIDTH = 264;
const SIDEBAR_MAX_WIDTH = 500;
const layoutSchema = z.object({
  version: z.literal(1),
  navigationOpen: z.boolean(),
  navigationWidth: z.number().min(SIDEBAR_MIN_WIDTH).max(SIDEBAR_MAX_WIDTH),
  panelsOpen: z.boolean(),
  contextOpen: z.boolean(),
  contextTool: z.enum(['files', 'changes', 'terminal']),
  contextExpanded: z.boolean(),
  contextWidths: z.object({
    files: z.number().min(0.2).max(0.8),
    changes: z.number().min(0.2).max(0.8),
    terminal: z.number().min(0.2).max(0.8),
  }),
});
type LayoutPreferences = Readonly<z.infer<typeof layoutSchema>>;
const defaultLayout: LayoutPreferences = {
  version: 1, navigationOpen: true, navigationWidth: 280, panelsOpen: true,
  contextOpen: false, contextTool: 'files', contextExpanded: false,
  contextWidths: { files: 0.5, changes: 0.5, terminal: 0.5 },
};
const layoutKey = (directory: string) => `omochamber.layout:${encodeURIComponent(directory)}`;

type DirectoryLayout = {
  readonly directory: string | null; readonly preferences: LayoutPreferences; readonly error: Error | null;
};
function readLayout(directory: string | null): DirectoryLayout {
  if (!directory) return { directory, preferences: defaultLayout, error: null };
  try {
    const saved = localStorage.getItem(layoutKey(directory));
    return { directory, preferences: saved ? layoutSchema.parse(JSON.parse(saved)) : defaultLayout, error: null };
  } catch (cause) {
    return { directory, preferences: defaultLayout, error: asError(cause) };
  }
}

/** Preferences only describe the UI. They never select or mutate native work. */
function useDirectoryLayout(directory: string | null) {
  const [state, setState] = useState(() => readLayout(directory));
  if (state.directory !== directory) setState(readLayout(directory));
  const update = (preferences: LayoutPreferences, persist = true) => {
    let error: Error | null = null;
    if (directory && persist) {
      try { localStorage.setItem(layoutKey(directory), JSON.stringify(preferences)); }
      catch (cause) { error = asError(cause); }
    }
    setState({ directory, preferences, error });
  };
  return { preferences: state.preferences, error: state.error, update };
}

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
  const desktop = useNativeDesktop();
  const [projects, setProjects] = useState<NativeProject[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [scope, setScope] = useState<{ readonly projectId: string; readonly directory: string } | null>(null);
  const [sessionKey, setSessionKey] = useState<string | null>(null);
  const layout = useDirectoryLayout(scope?.directory ?? null);
  const preferences = layout.preferences;
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const compactMedia = useMemo(() => window.matchMedia('(max-width: 64rem)'), []);
  const compact = useSyncExternalStore(useCallback((changed) => {
    compactMedia.addEventListener('change', changed);
    return () => compactMedia.removeEventListener('change', changed);
  }, [compactMedia]), () => compactMedia.matches);
  const navigationOpen = compact ? mobileNavigationOpen : preferences.navigationOpen;
  const [chatArea, setChatArea] = useState<HTMLDivElement | null>(null);
  const [chatAreaWidth, setChatAreaWidth] = useState<number | null>(null);
  const [panelsOverlayOpen, setPanelsOverlayOpen] = useState(false);
  useEffect(() => {
    if (!chatArea) return;
    const measured = chatArea.closest<HTMLElement>('[data-chat-area]') ?? chatArea;
    setChatAreaWidth(measured.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setChatAreaWidth(entry.contentRect.width);
    });
    observer.observe(measured);
    return () => observer.disconnect();
  }, [chatArea]);
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
      const selected = sessions.find((session) => session.sessionKey === sessionKey);
      if (scope && selected && selected.directory !== scope.directory) setSessionKey(null);
      setOperationError(null);
      setPanelsOverlayOpen(false);
    }
    previousScope.current = scope;
  }, [scope, sessionKey, sessions]);
  const selectDirectory = (project: NativeProject, directory: string) => {
    if (scope?.projectId === project.id && scope.directory === directory) return;
    setSessionKey(null);
    setScope({ projectId: project.id, directory });
    setOperationError(null);
  };
  const selectSession = (session: SessionSummary) => {
    const selectedProject = projects.find((item) => [item.path, ...(item.worktreePaths ?? [])].includes(session.directory));
    setScope(selectedProject ? { projectId: selectedProject.id, directory: session.directory } : null);
    setSessionKey(session.sessionKey);
    setMobileNavigationOpen(false);
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
  const project = projects.find((item) => item.id === scope?.projectId);
  const contextOpen = Boolean(scope && preferences.contextOpen);
  const contextExpanded = contextOpen && preferences.contextExpanded;
  const panelsFit = !compact && !contextOpen && chatAreaWidth !== null && chatAreaWidth >= WORK_STATUS_REQUIRED_ROW_WIDTH;
  const showPanels = Boolean(sessionKey && (panelsFit ? preferences.panelsOpen : panelsOverlayOpen));
  const openTool = (tool: Tool) => {
    layout.update({ ...preferences, contextTool: tool, contextOpen: !contextOpen || tool !== preferences.contextTool });
    setMobileNavigationOpen(false);
  };

  const nativeStyle: CSSProperties & { '--oc-titlebar-left-inset'?: string } = desktop && /Mac/.test(navigator.platform)
    ? { '--oc-titlebar-left-inset': '4.5rem' } : {};
  return <div style={nativeStyle} data-testid="omo-app" data-navigation-open={navigationOpen}
    data-panels-open={showPanels} data-context-open={contextOpen} data-context-expanded={contextExpanded}
    data-navigation-width={preferences.navigationWidth} data-context-width={preferences.contextWidths[preferences.contextTool]}>
    <MainLayoutView
      titlebarControls={<TitlebarLeftControlsView isSidebarOpen={navigationOpen}
        onToggleSidebar={() => {
          if (compact) setMobileNavigationOpen(!mobileNavigationOpen);
          else layout.update({ ...preferences, navigationOpen: !navigationOpen });
        }}
        toggleButtonProps={{ 'data-testid': 'omo-navigation-toggle', 'aria-expanded': navigationOpen, 'aria-controls': 'omo-navigation' }}
        newSessionButtonProps={{ 'data-testid': 'omo-new-session' }}
        onNewSession={() => { void create(); }} newSessionDisabled={!project || !status?.available || creating} />}
      sidebar={<div id="omo-navigation" className={compact ? 'absolute inset-y-0 left-0 z-40 shadow-xl' : 'contents'}
        hidden={compact && !navigationOpen} inert={!navigationOpen || undefined} aria-hidden={!navigationOpen}>
        <SidebarView isOpen={compact || navigationOpen} isMobile={false} width={preferences.navigationWidth}
          onWidthChange={(navigationWidth, persist) => layout.update({ ...preferences, navigationWidth }, persist)} topBar={<SidebarTopBar />}
          cancelRestoresWidth resizeHandleProps={{ tabIndex: 0, 'data-testid': 'omo-navigation-resize', onKeyDown: (event) => {
            const width = preferences.navigationWidth;
            const next = event.key === 'Home' ? SIDEBAR_MIN_WIDTH : event.key === 'End' ? SIDEBAR_MAX_WIDTH
              : event.key === 'ArrowLeft' ? width - 16 : event.key === 'ArrowRight' ? width + 16 : null;
            if (next === null) return;
            event.preventDefault();
            layout.update({ ...preferences, navigationWidth: Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next)) });
          } }}>
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
          }}
          renderNavigation={(editProject) => <NativeNavigation projects={projects} projectId={scope?.projectId ?? null}
            directory={scope?.directory ?? null} onProjectSelect={selectDirectory} sessions={sessions} store={store}
            sessionKey={sessionKey} loading={sessionsLoading} error={sessionsError} creating={creating}
            canCreate={Boolean(project && status?.available)} onCreate={() => { void create(); }} onSelect={selectSession}
            onRefresh={() => { void refreshSessions(); }} showCreate={false}
            projectActions={(item) => <DropdownMenuItem onSelect={() => editProject(item)} data-project-rename={item.id}>
              <Icon name="edit" className="size-4" />{t('mobile.sessions.editProjectAria', { label: item.name })}
            </DropdownMenuItem>} />} />
        <AppearanceNotice />
        </SidebarView>
      </div>}
      header={<HeaderView controlsWidth={!navigationOpen || compact
        ? 'calc(var(--oc-titlebar-left-inset, 0.75rem) + var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)' : 0}
        actions={<Button variant="ghost" size="sm" aria-pressed={showPanels} aria-controls="omo-panels"
          data-work-status-toggle data-testid="omo-panels-toggle" aria-label={t('header.workStatusPanel.toggleAria')}
          title={t('omo.panels.title')} onClick={() => {
            if (panelsFit) layout.update({ ...preferences, panelsOpen: !preferences.panelsOpen });
            else setPanelsOverlayOpen(!panelsOverlayOpen);
            setMobileNavigationOpen(false);
          }}><Icon name="list-check-2" className="size-4" /></Button>}>
        <HeaderTitleView title={sessions.find((session) => session.sessionKey === sessionKey)?.name ?? 'OmoChamber'}
          metadata={project?.name ?? t('mobile.header.noProject')} />
      </HeaderView>}
      chat={<div ref={setChatArea} className="relative flex h-full min-h-0 bg-background">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-testid="omo-chat-column"
          inert={contextExpanded || undefined} aria-hidden={contextExpanded || undefined}>
        <div className="shrink-0 space-y-1 px-4 py-2">
          <NativeStatusBar store={store} sessionKey={sessionKey} status={status} error={statusError} onRefresh={() => { void refreshStatus(); }} />
          {operationError && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(operationError, t)}</p>}
          {layout.error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(layout.error, t)}</p>}
        </div>
        <div className="flex min-h-0 flex-1">
          <NativeChat client={client} store={store} sessionKey={sessionKey} floatingComposer />
        </div>
        </div>
        <div id="omo-panels" className={!panelsFit ? 'contents' : 'flex min-h-0'}>
          <NativeWorkStatusPanel client={client} store={store} sessionKey={sessionKey} visible={showPanels}
            overlay={!panelsFit} onDismiss={() => setPanelsOverlayOpen(false)} />
        </div>
      </div>}
      contextPanel={<NativeContextPanel directory={scope?.directory ?? null} tab={preferences.contextTool}
        open={contextOpen} expanded={contextExpanded} widthFraction={preferences.contextWidths[preferences.contextTool]}
        onClose={() => layout.update({ ...preferences, contextOpen: false })}
        onExpandedChange={(contextExpanded) => layout.update({ ...preferences, contextExpanded })}
        onWidthChange={(width) => layout.update({ ...preferences, contextWidths: {
          ...preferences.contextWidths, [preferences.contextTool]: Math.min(0.8, Math.max(0.2, width)),
        } })}
        onProjectsChange={() => { void refreshProjects(); }} />}
      contextRail={<ContextPanelRailView ariaLabel={t('contextRail.aria.rail')} items={tools}
        renderItem={(tool) => <ContextPanelRailItemView key={tool.id} icon={<Icon name={tool.icon} className="size-4" />}
          isActive={contextOpen && preferences.contextTool === tool.id} label={t(tool.label)} description={t(tool.label)}
          onSelect={() => openTool(tool.id)} buttonProps={{ disabled: !scope, 'data-testid': `omo-tab-${tool.id}` }} />} />}
    />
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
