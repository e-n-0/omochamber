import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { z } from 'zod';
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

function NativeResizeHandle({ label, value, min, max, direction, onResize, testId, distanceScale = () => 1 }: {
  readonly label: string; readonly value: number; readonly min: number; readonly max: number;
  readonly direction: 1 | -1; readonly onResize: (width: number, persist: boolean) => void; readonly testId: string;
  readonly distanceScale?: () => number;
}) {
  const resizing = useRef<AbortController | null>(null);
  useEffect(() => () => resizing.current?.abort(), []);
  const clamp = (width: number) => Math.min(max, Math.max(min, width));
  return <div className="omo-resize-handle" role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} data-testid={testId}
    onKeyDown={(event) => {
      const step = 16 * distanceScale();
      const next = event.key === 'Home' ? min : event.key === 'End' ? max
        : event.key === 'ArrowLeft' ? value - direction * step : event.key === 'ArrowRight' ? value + direction * step : null;
      if (next === null) return;
      event.preventDefault();
      onResize(clamp(next), true);
    }}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      resizing.current?.abort();
      const abort = new AbortController();
      resizing.current = abort;
      const start = event.clientX;
      const pointerId = event.pointerId;
      const scale = distanceScale();
      let width = value;
      window.addEventListener('pointermove', (move) => {
        if (move.pointerId !== pointerId) return;
        width = clamp(value + (move.clientX - start) * direction * scale);
        onResize(width, false);
      }, { signal: abort.signal });
      window.addEventListener('pointerup', (end) => {
        if (end.pointerId !== pointerId) return;
        onResize(width, true);
        abort.abort();
      }, { signal: abort.signal });
      const cancel = () => { onResize(value, false); abort.abort(); };
      window.addEventListener('pointercancel', (cancelled) => {
        if (cancelled.pointerId === pointerId) cancel();
      }, { signal: abort.signal });
      window.addEventListener('blur', cancel, { signal: abort.signal });
    }} />;
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
  const chatArea = useRef<HTMLDivElement | null>(null);
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
  const visibleSessions = useMemo(() => sessions.filter((session) => session.directory === scope?.directory), [sessions, scope?.directory]);
  const project = projects.find((item) => item.id === scope?.projectId);
  const contextTool = tools.find((item) => item.id === preferences.contextTool) ?? tools[0];
  const contextOpen = Boolean(scope && preferences.contextOpen);
  const contextExpanded = contextOpen && preferences.contextExpanded;
  const showPanels = preferences.panelsOpen && !contextOpen;
  const shellStyle: CSSProperties & { '--omo-navigation-width': string; '--omo-context-width': string } = {
    '--omo-navigation-width': `${preferences.navigationWidth}px`,
    '--omo-context-width': `${preferences.contextWidths[preferences.contextTool] * 100}%`,
  };
  const openTool = (tool: Tool) => {
    layout.update({ ...preferences, contextTool: tool, contextOpen: !contextOpen || tool !== preferences.contextTool });
    setMobileNavigationOpen(false);
  };
  const resizeContext = (percent: number, persist: boolean) => {
    layout.update({ ...preferences, contextWidths: {
      ...preferences.contextWidths, [preferences.contextTool]: percent / 100,
    } }, persist);
  };

  return <div className="omo-shell" style={shellStyle} data-testid="omo-app" data-navigation-open={navigationOpen}
    data-panels-open={showPanels} data-context-open={contextOpen} data-context-expanded={contextExpanded}
    data-navigation-width={preferences.navigationWidth} data-context-width={preferences.contextWidths[preferences.contextTool]}>
    <div className="omo-titlebar-controls app-region-no-drag">
      <Button variant="ghost" size="sm" aria-label={t('commandPalette.item.toggleSidebar')}
        aria-expanded={navigationOpen} aria-controls="omo-navigation" data-testid="omo-navigation-toggle"
        onClick={() => {
          if (compact) setMobileNavigationOpen(!mobileNavigationOpen);
          else layout.update({ ...preferences, navigationOpen: !navigationOpen });
        }}><Icon name="layout-left" className="size-4" /></Button>
      <Button variant="ghost" size="sm" disabled={!project || !status?.available || creating} onClick={() => { void create(); }}
        data-testid="omo-new-session" aria-label={t('sessions.sidebar.header.actions.newSession')}
        title={t('sessions.sidebar.header.actions.newSession')}>
        <Icon name="chat-new" className="size-4" />
        <span className="omo-new-session-label">{t('sessions.sidebar.header.actions.newSession')}</span>
      </Button>
    </div>
    <aside id="omo-navigation" className="omo-navigation" inert={!navigationOpen || undefined} aria-hidden={!navigationOpen}>
      <div className="omo-titlebar-space app-region-drag" aria-hidden />
      <div className="omo-navigation-content">
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
          onCreate={() => { void create(); }} onSelect={selectSession} onRefresh={() => { void refreshSessions(); }} showCreate={false} />
        <AppearanceNotice />
      </div>
      <NativeResizeHandle label={t('sidebar.resize.leftPanelAria')} value={preferences.navigationWidth}
        min={SIDEBAR_MIN_WIDTH} max={SIDEBAR_MAX_WIDTH} direction={1} testId="omo-navigation-resize"
        onResize={(width, persist) => layout.update({ ...preferences, navigationWidth: width }, persist)} />
    </aside>
    <div className="omo-workspace">
      <header className="omo-toolbar app-region-drag">
        <div className="omo-header-controls-space" aria-hidden />
        <div className="omo-heading">
          <strong className="omo-brand truncate typography-ui-header">OmoChamber</strong>
          <span className="truncate typography-meta text-muted-foreground" title={scope?.directory}>
            {project?.name ?? t('mobile.header.noProject')}
          </span>
        </div>
        <Button variant="ghost" size="sm" aria-pressed={preferences.panelsOpen} aria-controls="omo-panels"
          className="app-region-no-drag" data-testid="omo-panels-toggle" aria-label={t('header.workStatusPanel.toggleAria')}
          title={t('omo.panels.title')} onClick={() => {
            layout.update({ ...preferences, panelsOpen: contextOpen || !preferences.panelsOpen, contextOpen: false });
            setMobileNavigationOpen(false);
          }}><Icon name="list-check-2" className="size-4" /></Button>
      </header>
      <div className="omo-main">
        <div className="omo-context border-b border-border px-4 py-2">
          <p className="truncate typography-micro text-muted-foreground" title={scope?.directory}>{scope?.directory}</p>
          <NativeStatusBar store={store} sessionKey={sessionKey} status={status} error={statusError} onRefresh={() => { void refreshStatus(); }} />
          {operationError && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(operationError, t)}</p>}
          {layout.error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(layout.error, t)}</p>}
        </div>
        <div className="omo-content">
          <div ref={chatArea} className="omo-chat-area" data-chat-area="true">
            <main className="omo-chat-column" inert={contextExpanded || undefined} aria-hidden={contextExpanded || undefined}>
              <div className="omo-chat-content" data-testid="omo-chat-column">
                <NativeChat client={client} store={store} sessionKey={sessionKey} />
              </div>
              <div id="omo-panels" className="omo-panels" hidden={!showPanels} inert={!showPanels || undefined}>
                <NativePanels client={client} store={store} sessionKey={sessionKey} />
              </div>
            </main>
            <aside id="omo-context-pane" className="omo-context-pane" data-testid="omo-context-pane" data-expanded={contextExpanded}
              aria-label={t(contextTool.label)} hidden={!contextOpen} inert={!contextOpen || undefined}>
              <NativeResizeHandle label={t('contextPanel.actions.resizePanelAria')}
                value={preferences.contextWidths[preferences.contextTool] * 100}
                min={20} max={80} direction={-1} testId="omo-context-resize" onResize={resizeContext}
                distanceScale={() => {
                  const width = chatArea.current?.clientWidth;
                  return width ? 100 / width : 0;
                }} />
              <header className="omo-context-header">
                <Icon name={contextTool.icon} className="size-4 shrink-0" />
                <h2 className="min-w-0 flex-1 truncate typography-ui-label">{t(contextTool.label)}</h2>
                <Button variant="ghost" size="xs" aria-pressed={contextExpanded} data-testid="omo-context-expand"
                  aria-label={t(contextExpanded ? 'contextPanel.actions.collapsePanel' : 'contextPanel.actions.expandPanel')}
                  title={t(contextExpanded ? 'contextPanel.actions.collapsePanel' : 'contextPanel.actions.expandPanel')}
                  onClick={() => layout.update({ ...preferences, contextExpanded: !contextExpanded })}>
                  <Icon name={contextExpanded ? 'fullscreen-exit' : 'fullscreen'} className="size-4" />
                </Button>
                <Button variant="ghost" size="xs" data-testid="omo-context-close" aria-label={t('contextPanel.actions.closePanel')}
                  title={t('contextPanel.actions.closePanel')} onClick={() => layout.update({ ...preferences, contextOpen: false })}>
                  <Icon name="close" className="size-4" />
                </Button>
              </header>
              <div className="omo-context-content">
                <NativeWorkbench directory={contextOpen ? scope?.directory ?? null : null}
                  tab={preferences.contextTool} onProjectsChange={() => { void refreshProjects(); }} />
              </div>
            </aside>
          </div>
          <nav className="omo-context-rail" aria-label={t('contextRail.aria.rail')}>
            {tools.map((item) => <Button key={item.id} variant="ghost" size="icon" aria-pressed={contextOpen && preferences.contextTool === item.id}
              aria-controls="omo-context-pane" aria-expanded={contextOpen && preferences.contextTool === item.id}
              aria-label={t(item.label)} title={t(item.label)} disabled={!scope}
              className={contextOpen && preferences.contextTool === item.id ? 'bg-interactive-selection text-interactive-selection-foreground' : 'text-muted-foreground'}
              data-testid={`omo-tab-${item.id}`} onClick={() => openTool(item.id)}>
              <Icon name={item.icon} className="size-4" />
            </Button>)}
          </nav>
        </div>
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
