import { useState } from 'react';
import type { ReactNode } from 'react';
import { ProjectHeaderView } from '@/components/session/sidebar/projects/ProjectHeaderView';
import { CrossfadeZoneHeader } from '@/components/session/sidebar/projects/CrossfadeZoneHeaders';
import { DirectoryNewSessionView } from '@/components/session/sidebar/projects/DirectoryHeaderView';
import { useI18n } from '@/lib/i18n';
import type { NativeProject } from '../contracts';
import { NativeSessionSidebar, type NativeSessionSidebarProps } from './NativeSessionSidebar';

export interface NativeNavigationProps extends NativeSessionSidebarProps {
  readonly projects: readonly NativeProject[];
  readonly projectId: string | null;
  readonly directory: string | null;
  readonly onProjectSelect: (project: NativeProject, directory: string) => void;
  readonly projectActions?: (project: NativeProject) => ReactNode;
  readonly onCreateInDirectory?: (project: NativeProject, directory: string) => void;
}

export function NativeNavigation({ projects, projectId, directory, onProjectSelect, projectActions, onCreateInDirectory, ...sessions }: NativeNavigationProps) {
  const { t } = useI18n();
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(() => new Set());
  const [openProjectMenus, setOpenProjectMenus] = useState<ReadonlySet<string>>(() => new Set());
  const registeredDirectories = new Set(projects.flatMap((project) => [project.path, ...(project.worktreePaths ?? [])]));
  return <div className="min-w-0" data-native-navigation>
    <NativeSessionSidebar {...sessions} showRows={false} showToolbar={false} showCreate={false} />
    {projects.map((project) => {
      const directories = [...new Set([project.path, ...(project.worktreePaths ?? [])])];
      const projectSessions = sessions.sessions.filter((session) => directories.includes(session.directory));
      const collapsed = collapsedProjects.has(project.id);
      return <div key={project.id} data-native-project={project.id} data-selected={projectId === project.id || undefined} data-native-directory={projectId === project.id ? directory ?? undefined : undefined}>
        <CrossfadeZoneHeader className="-ml-2.5 -mr-2 text-left group/project select-none sticky top-0 z-20 bg-sidebar" data-sidebar-sticky-header="true">
          <ProjectHeaderView id={project.id} projectLabel={project.name} projectDescription={project.path} isCollapsed={collapsed}
            showCreateButtons={Boolean(onCreateInDirectory)} newSessionDisabled={!sessions.canCreate || sessions.creating}
            onNewSession={onCreateInDirectory ? () => onCreateInDirectory(project, project.path) : undefined}
            hideDirectoryControls={!projectActions} menuItems={projectActions?.(project)}
            isMenuOpen={openProjectMenus.has(project.id)}
            handleMenuOpenChange={(open) => {
              setOpenProjectMenus((prior) => {
                const next = new Set(prior);
                if (open) next.add(project.id);
                else next.delete(project.id);
                return next;
              });
            }}
            handleToggleClick={() => {
              onProjectSelect(project, project.path);
              setCollapsedProjects((prior) => { const next = new Set(prior); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; });
            }}
          />
        </CrossfadeZoneHeader>
        {!collapsed && <NativeSessionSidebar {...sessions} sessions={projectSessions} directories={directories} showCreate={false} showToolbar={false} showFeedback={false}
          directoryActions={onCreateInDirectory ? (path) => <DirectoryNewSessionView
            label={path.split('/').filter(Boolean).at(-1) ?? path}
            disabled={!sessions.canCreate || sessions.creating}
            tooltip={t('sessions.sidebar.project.actions.newSession')}
            ariaLabel={t('mobile.sessions.newSessionInProjectAria', { label: path.split('/').filter(Boolean).at(-1) ?? path })}
            onNewSession={() => onCreateInDirectory(project, path)}
          /> : sessions.directoryActions}
          onDirectorySelect={(path) => onProjectSelect(project, path)} />}
      </div>;
    })}
    <NativeSessionSidebar {...sessions} sessions={sessions.sessions.filter((session) => !registeredDirectories.has(session.directory))} showCreate={false} showToolbar={false} showFeedback={false} />
  </div>;
}
