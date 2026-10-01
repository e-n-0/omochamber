import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { NativeClient } from '../client';
import type { NativeStore } from '../state';
import { GoalPanel } from './GoalPanel';
import { TaskPanel } from './TaskPanel';
import { DagPanel, TodoPanel } from './ReadOnlyPanels';
import { usePanelSlice } from './panel-state';
import { nativeErrorCopy } from '../error-copy';

function SessionNotice({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const status = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.status ?? 'hydrating');
  const error = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.error ?? null);
  const ownership = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.ownership ?? null);
  const selected = usePanelSlice(store, (state) => state.selectedSessionKey === sessionKey);
  return (
    <div className="space-y-2 p-4 typography-meta text-muted-foreground">
      {status !== 'ready' && <p role="status" data-session-state={status}>
        {status === 'hydrating' ? t('common.loading') : status === 'reconnecting'
          ? t('omo.panels.session.reconnecting') : t('omo.panels.session.unavailable')}
      </p>}
      {error && <p role="alert" className="break-words text-[var(--status-error-text)]">{t('omo.panels.action.failed', { error: nativeErrorCopy(error, t) })}</p>}
      {ownership && ownership !== 'hosted' && <p data-testid="omo-panels-readonly">
        {ownership === 'terminal' ? t('omo.panels.session.terminal') : t('omo.panels.session.offline')}
      </p>}
      {status !== 'ready' && ownership && <p data-testid="omo-session-retained">{t('omo.panels.projection.retained')}</p>}
      {selected && <Button size="sm" variant="ghost" data-testid="omo-panels-refresh" disabled={status === 'hydrating'} onClick={() => { void store.refresh(); }}>
        <Icon name="refresh" className="size-4" />{t('omo.panels.refresh')}
      </Button>}
    </div>
  );
}

export function NativePanels({ client, store, sessionKey }: {
  readonly client: NativeClient;
  readonly store: NativeStore;
  readonly sessionKey: string | null;
}) {
  const { t } = useI18n();
  return (
    <aside aria-label={t('omo.panels.title')} data-testid="omo-native-panels" className="min-w-0 text-foreground">
      {sessionKey ? (
        <div key={sessionKey}>
          <SessionNotice store={store} sessionKey={sessionKey} />
          <GoalPanel store={store} sessionKey={sessionKey} />
          <TaskPanel client={client} store={store} sessionKey={sessionKey} />
          <TodoPanel store={store} sessionKey={sessionKey} />
          <DagPanel store={store} sessionKey={sessionKey} />
        </div>
      ) : <p data-testid="omo-panels-no-session" className="p-4 typography-meta text-muted-foreground">{t('omo.panels.session.select')}</p>}
    </aside>
  );
}
