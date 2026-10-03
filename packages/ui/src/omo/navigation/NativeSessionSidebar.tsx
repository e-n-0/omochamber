import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { SessionGroupView } from '@/components/session/sidebar/projects/DirectoryHeaderView';
import { DirectoryLabelView } from '@/components/session/sidebar/projects/DirectoryLabelView';
import type { SessionSummary } from '../contracts';
import type { NativeStore } from '../state';
import { nativeErrorCopy } from '../error-copy';
import { NativeSessionRow } from './NativeSessionRow';

export interface NativeSessionSidebarProps {
  readonly sessions: readonly SessionSummary[];
  readonly store: NativeStore;
  readonly sessionKey: string | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly creating: boolean;
  readonly canCreate: boolean;
  readonly onCreate: () => void;
  readonly onSelect: (session: SessionSummary) => void;
  readonly onRefresh: () => void;
  readonly showCreate?: boolean;
  readonly directories?: readonly string[];
  readonly onDirectorySelect?: (directory: string) => void;
  readonly directoryActions?: (directory: string) => ReactNode;
  readonly showToolbar?: boolean;
  readonly showFeedback?: boolean;
  readonly showRows?: boolean;
}

export function NativeSessionSidebar({ sessions, store, sessionKey, loading, error, creating, canCreate, onCreate, onSelect, onRefresh, showCreate = true, directories, onDirectorySelect, directoryActions, showToolbar = true, showFeedback = true, showRows = true }: NativeSessionSidebarProps) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (directory: string) => setCollapsed((prior) => { const next = new Set(prior); if (next.has(directory)) next.delete(directory); else next.add(directory); return next; });
  const rows = (items: readonly SessionSummary[]) => <ul className="min-w-0">{items.map((session) => <NativeSessionRow key={session.sessionKey} session={session} store={store} selected={sessionKey === session.sessionKey} onSelect={onSelect} />)}</ul>;
  const { t } = useI18n();
  return <section aria-label={t('mobile.sessions.sheet.title')} data-testid="omo-session-sidebar" className="min-w-0">
    {showToolbar && <div className="flex items-center gap-2">
      <h2 className="flex-1 typography-ui-header font-medium">{t('mobile.sessions.sheet.title')}</h2>
      <Button size="xs" variant="ghost" aria-label={t('gitView.history.refresh')} disabled={loading} onClick={onRefresh}>
        <Icon name="refresh" className="size-4" />
      </Button>
    </div>}
    {showToolbar && showCreate && <Button size="sm" className="w-full" disabled={!canCreate || creating} onClick={onCreate} data-testid="omo-new-session">
      <Icon name="add" className="size-4" />{t('sessions.sidebar.header.actions.newSession')}
    </Button>}
    {showFeedback && loading && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
    {showFeedback && error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
    {showFeedback && !loading && !error && sessions.length === 0 && <p className="typography-meta text-muted-foreground">
      {t('sessions.sidebar.empty.noSessions.description')}
    </p>}
    {showRows && (directories ? <>
      {directories.map((directory) => <SessionGroupView key={directory} name={directory} collapsed={collapsed.has(directory)}
        toggleProps={{ 'data-directory-path': directory }} onToggle={() => { onDirectorySelect?.(directory); toggle(directory); }}
        label={<DirectoryLabelView label={directory.split('/').filter(Boolean).at(-1) ?? directory} />} actions={directoryActions?.(directory)}>
        {rows(sessions.filter((session) => session.directory === directory))}
      </SessionGroupView>)}
      {rows(sessions.filter((session) => !directories.includes(session.directory)))}
    </> : rows(sessions))}
  </section>;
}
