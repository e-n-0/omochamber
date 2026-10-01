import React from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import { Button } from '@/components/ui/button';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { OmoAppearanceProvider } from '../AppearanceProvider';
import { createNativeClient } from '../client';
import type { NativeProject } from '../contracts';
import { NativeWorkbench } from './NativeWorkbench';

const client = createNativeClient();
export function NativeWorkbenchFixture() {
  const { t } = useI18n();
  const [projects, setProjects] = React.useState<NativeProject[]>([]);
  const [directory, setDirectory] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<'files' | 'changes' | 'terminal'>('files');
  const [error, setError] = React.useState<Error | null>(null);
  const refresh = React.useCallback(() => {
    void client.projects().then((next) => {
      setProjects(next);
      setDirectory((selected) => selected ?? next[0]?.path ?? null);
    }, (cause) => setError(cause));
  }, []);
  React.useEffect(refresh, [refresh]);
  return <OmoAppearanceProvider client={client}>
    <main className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex flex-wrap gap-2 border-b border-border p-2">
        {(['files', 'changes', 'terminal'] as const).map((value) => <Button key={value} size="sm" variant="chip"
          aria-pressed={tab === value} data-testid={`fixture-${value}`} onClick={() => setTab(value)}>
          {t(value === 'files' ? 'layout.mainTab.files' : value === 'changes' ? 'layout.mainTab.diff' : 'layout.mainTab.terminal')}
        </Button>)}
        {projects.map((project, index) => <Button key={project.id} size="sm" variant="chip" aria-pressed={directory === project.path}
          data-testid={`fixture-directory-${index}`} onClick={() => setDirectory(project.path)}>{project.name}</Button>)}
      </header>
      {error && <p role="alert">{error.message}</p>}
      <div className="min-h-0 flex-1"><NativeWorkbench directory={directory} tab={tab} onProjectsChange={refresh} /></div>
    </main>
  </OmoAppearanceProvider>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root missing');
createRoot(root).render(<React.StrictMode><I18nProvider><NativeWorkbenchFixture /></I18nProvider></React.StrictMode>);
