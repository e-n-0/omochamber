import { DirectoryActionIndicator } from '../sessions/DirectoryActionIndicator';
import React from 'react';
import { ProjectHeaderView } from './ProjectHeaderView';
import { ProjectIdentityView, type ProjectIdentityProps, type ProjectPickerOption } from './ProjectIdentityView';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { CrossfadeZoneHeader } from './CrossfadeZoneHeaders';
import { useProjectFolderMissing } from './useProjectFolderMissing';

export type SortableDragHandleProps = {
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
};

const ProjectHeaderIdentity: React.FC<ProjectIdentityProps & { isCollapsed?: boolean; alwaysShowActions?: boolean }> = ({ id, projectLabel, projectIcon, projectColor, projectIconImage, projectIconBackground, isCollapsed, alwaysShowActions }) => {
  const { currentTheme } = useThemeSystem();
  const projectIconName = projectIcon ? PROJECT_ICON_MAP[projectIcon] : undefined;
  const iconColor = projectColor ? PROJECT_COLOR_MAP[projectColor] : undefined;
  return <ProjectIdentityView projectLabel={projectLabel} isCollapsed={isCollapsed} alwaysShowActions={alwaysShowActions}
    projectIconName={projectIconName} iconColor={iconColor} iconBackground={projectIconBackground}
    image={projectIconImage ? <ProjectIconImage project={{ id, iconImage: projectIconImage }}
      options={{ themeVariant: currentTheme.metadata.variant, iconColor: currentTheme.colors.surface.foreground }}
      className="h-full w-full object-contain"
      fallback={projectIconName ? <Icon name={projectIconName} className="h-3.5 w-3.5" style={iconColor ? { color: iconColor } : undefined} /> : <Icon name="folder" className="h-3.5 w-3.5 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />}
    /> : undefined}
  />;
};

export interface SortableProjectItemProps extends ProjectIdentityProps {
  disabled?: boolean;
  projectDescription: string;
  projectDirectory?: string;
  isCollapsed: boolean;
  isRepo: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onNewWorktreeSession?: () => void;
  onManageWorktrees?: () => void;
  /** The project's isolated spaces page; absent while the feature is off, and always in VS Code. */
  onManageSpaces?: () => void;
  onRenameStart: () => void;
  onClose: () => void;
  children?: React.ReactNode;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
  /** Aggregated activity/attention indicator shown while the project is collapsed. */
  statusIndicator?: React.ReactNode;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  projectPickerOptions?: ProjectPickerOption[];
  onProjectSelect?: (projectId: string) => void;
}

export const SortableProjectItem: React.FC<SortableProjectItemProps> = ({
  id,
  disabled = false,
  projectLabel,
  projectDescription,
  projectDirectory,
  projectIcon,
  projectColor,
  projectIconImage,
  projectIconBackground,
  isCollapsed,
  isRepo,
  hideDirectoryControls,
  alwaysShowActions,
  onToggle,
  onNewSession,
  onNewWorktreeSession,
  onManageWorktrees,
  onManageSpaces,
  onRenameStart,
  onClose,
  children,
  showCreateButtons = true,
  hideHeader = false,
  statusIndicator = null,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  projectPickerOptions,
  onProjectSelect,
}) => {
  const { t } = useI18n();
  const folderMissing = useProjectFolderMissing(projectDirectory);
  // Project headers only exist in the projects view, which always pins them.
  const stickyZoneHeaders = true;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const suppressNextToggleRef = React.useRef(false);
  const menuInstanceKey = `project:${id}`;
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);

  const handleMenuOpenChange = React.useCallback((open: boolean) => {
    if (open) setIsContextMenuOpen(false);
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  }, [menuInstanceKey, setOpenSidebarMenuKey]);

  const renderProjectMenuItems = (Item: React.ElementType) => (
    <>
      {showCreateButtons && !isRepo && !hideDirectoryControls && onNewSession && (
        <Item onClick={onNewSession}>
          <Icon name="add" className="mr-1.5 h-4 w-4" />
          {t('sessions.sidebar.project.actions.newSession')}
        </Item>
      )}
      {isRepo && !hideDirectoryControls && onManageWorktrees && (
        <Item onClick={onManageWorktrees}>
          <Icon name="node-tree" className="mr-1.5 h-4 w-4" />
          {t('sessions.sidebar.project.actions.manageWorktrees')}
        </Item>
      )}
      {isRepo && !hideDirectoryControls && onManageSpaces && (
        <Item onClick={onManageSpaces}>
          <Icon name="box-3" className="mr-1.5 h-4 w-4" />
          {t('spaces.page.menuItem')}
        </Item>
      )}
      <Item onClick={onRenameStart}>
        <Icon name="pencil-ai" className="mr-1.5 h-4 w-4" />
        {t('sessions.sidebar.project.actions.edit')}
      </Item>
      <Item onClick={onClose} className="text-destructive focus:text-destructive">
        <Icon name="close" className="mr-1.5 h-4 w-4" />
        {t('sessions.sidebar.project.actions.closeProject')}
      </Item>
    </>
  );

  const handleMenuTriggerClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleToggleMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      suppressNextToggleRef.current = true;
    }
  }, []);

  const handleToggleClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    // Drop mouse-click focus so hover-revealed chrome (chevron, actions)
    // hides again on mouse-leave instead of sticking via :focus-within.
    // Keyboard users keep their focus-visible ring (blur only fires here
    // for pointer interactions that produced a click).
    event.currentTarget.blur();
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-30')}
    >
      {!hideHeader ? (
        <>
          <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
            <ContextMenuTrigger
              render={
                // Keep the live context-menu trigger when the shared zone
                // header moves between the section and the pinned layer.
                // Full-bleed band: pull past the list container's padding so
                // the section band spans the entire sidebar width (ref: edge-
                // to-edge section headers, not rounded pills).
                <CrossfadeZoneHeader
                  className={cn(
                    '-ml-2.5 -mr-2 text-left group/project select-none',
                    stickyZoneHeaders && 'sticky top-0 z-20 bg-sidebar',
                  )}
                  data-sidebar-sticky-header={stickyZoneHeaders ? 'true' : undefined}
                  onContextMenu={(event) => {
                    // VS Code hides project actions entirely (hideDirectoryControls).
                    if (hideDirectoryControls) return;
                    event.preventDefault();
                    setIsContextMenuOpen(true);
                  }}
                />
              }
            >
            <ProjectHeaderView
              id={id} projectLabel={projectLabel} projectDescription={projectDescription}
              identity={<ProjectHeaderIdentity id={id} projectLabel={projectLabel} projectIcon={projectIcon} projectColor={projectColor} projectIconImage={projectIconImage} projectIconBackground={projectIconBackground} isCollapsed={isCollapsed} alwaysShowActions={alwaysShowActions} />}
              isCollapsed={isCollapsed} isRepo={isRepo} hideDirectoryControls={hideDirectoryControls}
              alwaysShowActions={alwaysShowActions} showCreateButtons={showCreateButtons}
              folderMissing={folderMissing} statusIndicator={statusIndicator}
              directoryAction={projectDirectory ? <DirectoryActionIndicator directory={projectDirectory} className="ml-auto" /> : null}
              projectPickerOptions={projectPickerOptions?.map((option) => ({ ...option, identity: <ProjectHeaderIdentity {...option} /> }))} onProjectSelect={onProjectSelect}
              attributes={attributes} listeners={listeners} isMenuOpen={isMenuOpen}
              handleMenuOpenChange={handleMenuOpenChange} handleToggleMouseDown={handleToggleMouseDown} handleToggleClick={handleToggleClick}
              handleMenuTriggerClick={handleMenuTriggerClick} handleMenuTriggerPointerDown={handleMenuTriggerPointerDown} handleMenuTriggerMouseDown={handleMenuTriggerMouseDown}
              onNewSession={onNewSession} onNewWorktreeSession={onNewWorktreeSession}
              menuItems={renderProjectMenuItems(DropdownMenuItem)}
            />
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-[180px]">
              {renderProjectMenuItems(ContextMenuItem)}
            </ContextMenuContent>
          </ContextMenu>
        </>
      ) : null}

      {children}
    </div>
  );
};

const SortableGroupItemBase: React.FC<{
  id: string;
  disabled?: boolean;
  children: (dragHandleProps: SortableDragHandleProps) => React.ReactNode;
}> = ({ id, disabled = false, children }) => {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const dragHandleProps = React.useMemo<SortableDragHandleProps>(() => ({
    listeners,
    setActivatorNodeRef,
  }), [listeners, setActivatorNodeRef]);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-50',
      )}
    >
      {children(dragHandleProps)}
    </div>
  );
};

export const SortableGroupItem = React.memo(SortableGroupItemBase);
