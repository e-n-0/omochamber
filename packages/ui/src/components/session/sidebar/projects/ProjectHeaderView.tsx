import React from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { ProjectIdentityView, type ProjectIdentityProps, type ProjectPickerOption } from './ProjectIdentityView';

export interface ProjectHeaderViewProps extends Pick<ProjectIdentityProps, 'id' | 'projectLabel'> {
  readonly projectDescription: string;
  readonly identity?: React.ReactNode;
  readonly isCollapsed: boolean;
  readonly isRepo?: boolean;
  readonly hideDirectoryControls?: boolean;
  readonly alwaysShowActions?: boolean;
  readonly showCreateButtons?: boolean;
  readonly newSessionDisabled?: boolean;
  readonly folderMissing?: boolean;
  readonly statusIndicator?: React.ReactNode;
  readonly directoryAction?: React.ReactNode;
  readonly projectPickerOptions?: Array<ProjectPickerOption & { readonly identity?: React.ReactNode }>;
  readonly onProjectSelect?: (id: string) => void;
  readonly attributes?: React.HTMLAttributes<HTMLDivElement>;
  readonly listeners?: React.HTMLAttributes<HTMLButtonElement>;
  readonly isMenuOpen?: boolean;
  readonly handleMenuOpenChange?: (open: boolean) => void;
  readonly handleToggleMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  readonly handleToggleClick: React.MouseEventHandler<HTMLButtonElement>;
  readonly handleMenuTriggerClick?: React.MouseEventHandler<HTMLButtonElement>;
  readonly handleMenuTriggerPointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  readonly handleMenuTriggerMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  readonly onNewSession?: () => void;
  readonly onNewWorktreeSession?: () => void;
  readonly menuItems?: React.ReactNode;
}

export function ProjectHeaderView({ id, projectLabel, projectDescription, identity, isCollapsed, isRepo = false, hideDirectoryControls = false, alwaysShowActions = false, showCreateButtons = true, newSessionDisabled = false, folderMissing = false, statusIndicator, directoryAction, projectPickerOptions, onProjectSelect, attributes, listeners, isMenuOpen = false, handleMenuOpenChange, handleToggleMouseDown, handleToggleClick, handleMenuTriggerClick, handleMenuTriggerPointerDown, handleMenuTriggerMouseDown, onNewSession, onNewWorktreeSession, menuItems }: ProjectHeaderViewProps) {
  const { t } = useI18n();
  const isProjectPicker = Boolean(projectPickerOptions && onProjectSelect);
  return (
            <div
              className="relative flex items-center gap-1 py-1 pl-4 pr-3.5"
              {...attributes}
            >
              {isProjectPicker ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        'flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[padding]',
                        // Reserve hover space for the absolute action buttons,
                        // matching the collapse-toggle branch below.
                        isRepo && !hideDirectoryControls
                          ? (alwaysShowActions || isMenuOpen ? 'pr-20' : 'pr-0 group-hover/project:pr-20 group-focus-within/project:pr-20')
                          : (alwaysShowActions || isMenuOpen ? 'pr-14' : 'pr-0 group-hover/project:pr-14 group-focus-within/project:pr-14'),
                      )}
                      aria-label={t('sessions.sidebar.project.selectAria', { project: projectLabel })}
                    >
                      {identity ?? <ProjectIdentityView projectLabel={projectLabel} />}
                      <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      {directoryAction}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="max-h-[70vh] min-w-[220px] overflow-y-auto">
                    {projectPickerOptions?.map((option) => (
                      <DropdownMenuItem key={option.id} onClick={() => onProjectSelect?.(option.id)} className="flex items-center justify-between gap-3" title={option.projectDescription}>
                        <span className="flex min-w-0 items-center gap-1.5">
                          {option.identity ?? <ProjectIdentityView projectLabel={option.projectLabel} />}
                        </span>
                        {option.id === id ? <Icon name="check" className="h-4 w-4 flex-shrink-0 text-primary" /> : null}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : <Tooltip>
                <TooltipTrigger asChild>
                    <button
                      type="button"
                      onMouseDown={handleToggleMouseDown}
                      onClick={handleToggleClick}
                      {...listeners}
                      className={cn(
                        'flex-1 min-w-0 flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md cursor-grab active:cursor-grabbing transition-[padding]',
                        isRepo && !hideDirectoryControls
                          ? (alwaysShowActions || isMenuOpen ? 'pr-20' : 'pr-0 group-hover/project:pr-20 group-focus-within/project:pr-20')
                          : (alwaysShowActions || isMenuOpen ? 'pr-14' : 'pr-0 group-hover/project:pr-14 group-focus-within/project:pr-14'),
                      )}
                    >
                    {identity ?? <ProjectIdentityView projectLabel={projectLabel} isCollapsed={isCollapsed} alwaysShowActions={alwaysShowActions} />}
                    {folderMissing ? (
                      <span
                        className="inline-flex flex-shrink-0 items-center text-status-warning"
                        title={t('sessions.sidebar.project.folderMissing')}
                        aria-label={t('sessions.sidebar.project.folderMissing')}
                      >
                        <Icon name="alert" className="h-3 w-3" />
                      </span>
                    ) : null}
                    {statusIndicator ? (
                      <span className="ml-1 inline-flex flex-shrink-0 items-center">{statusIndicator}</span>
                    ) : null}
                    {directoryAction}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {projectDescription}
                </TooltipContent>
              </Tooltip>}

              <div className={cn(
                'absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1',
                showCreateButtons ? 'right-7' : 'right-0.5',
              )}>
                {showCreateButtons && isRepo && !hideDirectoryControls && onNewWorktreeSession ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewWorktreeSession();
                        }}
                        className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground transition-opacity',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.newWorktree')}
                      >
                        <Icon name="node-tree" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{t('sessions.sidebar.project.actions.newWorktreeEllipsis')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {!hideDirectoryControls ? (
                <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={handleMenuOpenChange}
                >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:text-foreground',
                          isMenuOpen
                            ? 'opacity-100 pointer-events-auto'
                            : alwaysShowActions
                              ? 'opacity-100'
                              : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                        onPointerDown={handleMenuTriggerPointerDown}
                        onMouseDown={handleMenuTriggerMouseDown}
                        onClick={handleMenuTriggerClick}
                      >
                        <Icon name="more-2" className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      {menuItems}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              {showCreateButtons && onNewSession ? (
                <div className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={newSessionDisabled}
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewSession();
                        }}
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-opacity disabled:opacity-50',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={isRepo
                          ? t('sessions.sidebar.project.actions.newDraftSession')
                          : t('sessions.sidebar.project.actions.newSession')}
                      >
                        <Icon name="add" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{isRepo
                        ? t('sessions.sidebar.project.actions.newDraftSession')
                        : t('sessions.sidebar.project.actions.newSession')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </div>
  );
}
