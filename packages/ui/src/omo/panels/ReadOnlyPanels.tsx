import { useI18n } from '@/lib/i18n';
import type { NativeStore } from '../state';
import { PanelSection, ProjectionNotice, RecordedStatus } from './PanelSection';
import { usePanelSlice } from './panel-state';

export function TodoPanel({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const projection = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.todo ?? null);
  const todo = projection?.value;
  return (
    <PanelSection id="omo-todo-panel" title={t('omo.panels.todo.title')} icon="checkbox-circle">
      <ProjectionNotice projection={projection} />
      <p className="typography-meta text-muted-foreground">{t('omo.panels.todo.readOnly')}</p>
      {todo?.ask && <p className="whitespace-pre-wrap break-words typography-ui-label">{todo.ask}</p>}
      {todo?.phases.map((phase, phaseIndex) => (
        <div key={phaseIndex} data-todo-phase={phaseIndex} className="space-y-2">
          <h4 className="break-words typography-ui-label font-medium">{phase.name}</h4>
          <ol className="space-y-2">
            {phase.tasks.map((task, taskIndex) => (
              <li key={taskIndex} data-todo-index={taskIndex} className="flex flex-wrap items-start gap-2">
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words typography-meta">{task.content}</span>
                <RecordedStatus status={task.status} />
              </li>
            ))}
          </ol>
        </div>
      ))}
      {projection?.status === 'ready' && (!todo || todo.phases.every((phase) => phase.tasks.length === 0)) && (
        <p data-testid="omo-todo-empty" className="typography-meta text-muted-foreground">{t('omo.panels.todo.empty')}</p>
      )}
    </PanelSection>
  );
}

export function DagPanel({ store, sessionKey }: { readonly store: NativeStore; readonly sessionKey: string }) {
  const { t } = useI18n();
  const projection = usePanelSlice(store, (state) => state.sessions.get(sessionKey)?.snapshot?.dags ?? null);
  return (
    <PanelSection id="omo-dags-panel" title={t('omo.panels.dags.title')} icon="node-tree">
      <ProjectionNotice projection={projection} />
      <p className="typography-meta text-muted-foreground">{t('omo.panels.dags.readOnly')}</p>
      {projection?.value?.map((dag) => (
        <article key={dag.runId} data-dag-id={dag.runId} className="min-w-0 space-y-3 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-start gap-2">
            <h4 className="min-w-0 flex-1 break-words typography-ui-label font-medium">{dag.name || dag.runId}</h4>
            <RecordedStatus status={dag.status} />
          </div>
          <p className="break-all font-mono typography-micro text-muted-foreground">{dag.runId}</p>
          <p className="typography-meta tabular-nums text-muted-foreground">{t('omo.panels.dags.checkpoint', { generation: dag.generation, sequence: dag.lastSeq })}</p>
          <ol className="space-y-2">
            {dag.nodes.map((node) => (
              <li key={node.nodeId} data-node-id={node.nodeId} className="space-y-1">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="min-w-0 flex-1 break-words typography-meta">{node.name || node.nodeId}</span>
                  <RecordedStatus status={node.status} />
                </div>
                {node.taskId && <p className="break-all font-mono typography-micro text-muted-foreground">{node.taskId}</p>}
                {node.wave !== undefined && <p className="typography-meta text-muted-foreground">{t('omo.panels.dags.wave', { wave: node.wave })}</p>}
                {node.error && <p className="break-words typography-meta text-[var(--status-error-text)]">{node.error}</p>}
              </li>
            ))}
          </ol>
          {dag.edges.length > 0 && (
            <div className="space-y-1">
              <h5 className="typography-meta font-medium">{t('omo.panels.dags.dependencies')}</h5>
              <ul className="space-y-1">
                {dag.edges.map((edge, index) => <li key={index} data-dag-edge className="break-all font-mono typography-micro text-muted-foreground">{edge.from} &rarr; {edge.to}</li>)}
              </ul>
            </div>
          )}
        </article>
      ))}
      {projection?.status === 'ready' && projection.value.length === 0 && <p data-testid="omo-dags-empty" className="typography-meta text-muted-foreground">{t('omo.panels.dags.empty')}</p>}
    </PanelSection>
  );
}
