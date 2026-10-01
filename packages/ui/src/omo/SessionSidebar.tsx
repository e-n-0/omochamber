import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { SessionSummary } from './contracts';
import type { NativeStore } from './state';
import { useNativeSlice, useNativeWritable } from './chat/nativeHooks';
import { nativeErrorCopy } from './error-copy';
import { NativeClientError } from './client';

function SessionRow({ session, store, selected, onSelect }: {
  readonly session: SessionSummary;
  readonly store: NativeStore;
  readonly selected: boolean;
  readonly onSelect: (session: SessionSummary) => void;
}) {
  const { t } = useI18n();
  const nativeName = useNativeSlice(store, session.sessionKey, (state) => state?.snapshot?.state.name);
  const nativeOwnership = useNativeSlice(store, session.sessionKey, (state) => state?.snapshot?.ownership);
  const writable = useNativeWritable(store, session.sessionKey);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useNativeSlice(store, session.sessionKey, (state) => requestId ? state?.mutations.get(requestId) : undefined);
  const pending = mutation && mutation.status !== 'failed' && mutation.status !== 'succeeded';
  const title = nativeName ?? session.name ?? t('mobile.sessions.untitled');
  const ownership = nativeOwnership ?? session.ownership;
  const rename = async () => {
    if (!writable || pending || !name.trim()) return;
    const id = crypto.randomUUID();
    setRequestId(id);
    setError(null);
    try { await store.execute({ type: 'rename', name: name.trim() }, id); }
    catch (cause) { setError(cause instanceof Error ? cause : new NativeClientError('transport', 'Native rename failed', null, { cause })); }
  };
  return <li className="space-y-2" data-testid="omo-session-row">
    <div className="flex items-center gap-1">
      <Button variant="chip" size="sm" className="min-w-0 flex-1 justify-start" aria-pressed={selected}
        data-session-key={session.sessionKey} title={session.directory} onClick={() => onSelect(session)}>
        <span className="truncate">{title}</span>
      </Button>
      {selected && <Button variant="ghost" size="xs" disabled={!writable}
        data-testid="omo-session-rename" aria-label={t('mobile.sessions.renameSessionAria', { title })}
        onClick={() => { setName(title); setEditing(!editing); setRequestId(null); setError(null); }}>
        <Icon name="edit" className="size-4" />
      </Button>}
    </div>
    {ownership !== 'hosted' && <p className="typography-micro text-muted-foreground" data-session-ownership={ownership}>
      {t(ownership === 'terminal' ? 'omo.shell.terminalSession' : 'omo.shell.reopenSession')}
    </p>}
    {selected && editing && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
      <Input autoFocus data-testid="omo-session-name" aria-label={t('sessions.sidebar.session.menu.rename')}
        value={name} disabled={!writable || Boolean(pending)} onChange={(event) => setName(event.currentTarget.value)} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="xs" disabled={!writable || Boolean(pending) || !name.trim()} data-testid="omo-session-save">
          {t('projectEditDialog.actions.save')}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>{t('projectEditDialog.actions.cancel')}</Button>
      </div>
      {mutation && <p role={mutation.status === 'failed' || mutation.status === 'uncertain' ? 'alert' : 'status'}
        data-rename-status={mutation.status} className="break-words typography-meta text-muted-foreground">
        {mutation.status === 'failed' || mutation.status === 'uncertain' ? nativeErrorCopy(mutation.error, t)
          : t(mutation.status === 'succeeded' ? 'omo.shell.renameSaved' : 'omo.chat.accepted')}
      </p>}
      {error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
    </form>}
  </li>;
}

export function SessionSidebar({ sessions, store, sessionKey, loading, error, creating, canCreate, onCreate, onSelect, onRefresh }: {
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
}) {
  const { t } = useI18n();
  return <section aria-label={t('mobile.sessions.sheet.title')} data-testid="omo-session-sidebar" className="space-y-3 border-t border-border pt-4">
    <div className="flex items-center gap-2">
      <h2 className="flex-1 typography-ui-header font-medium">{t('mobile.sessions.sheet.title')}</h2>
      <Button size="xs" variant="ghost" aria-label={t('gitView.history.refresh')} disabled={loading} onClick={onRefresh}>
        <Icon name="refresh" className="size-4" />
      </Button>
    </div>
    <Button size="sm" className="w-full" disabled={!canCreate || creating} onClick={onCreate} data-testid="omo-new-session">
      <Icon name="add" className="size-4" />{t('sessions.sidebar.header.actions.newSession')}
    </Button>
    {loading && <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p>}
    {error && <p role="alert" className="break-words typography-meta text-[var(--status-error-text)]">{nativeErrorCopy(error, t)}</p>}
    {!loading && !error && sessions.length === 0 && <p className="typography-meta text-muted-foreground">
      {t('sessions.sidebar.empty.noSessions.description')}
    </p>}
    <ul className="space-y-2">{sessions.map((session) => <SessionRow key={session.sessionKey} session={session}
      store={store} selected={sessionKey === session.sessionKey} onSelect={onSelect} />)}</ul>
  </section>;
}
