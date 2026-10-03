import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';

export type ProjectIdentityProps = {
  id: string;
  projectLabel: string;
  projectIcon?: string;
  projectColor?: string;
  projectIconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  projectIconBackground?: string;
};



export type ProjectPickerOption = ProjectIdentityProps & { projectDescription: string };

export interface ProjectIdentityViewProps {
  readonly projectLabel: string;
  readonly isCollapsed?: boolean;
  readonly alwaysShowActions?: boolean;
  readonly projectIconName?: IconName;
  readonly iconColor?: string;
  readonly image?: React.ReactNode;
  readonly iconBackground?: string;
}

export function ProjectIdentityView({ projectLabel, isCollapsed, alwaysShowActions = false, projectIconName, iconColor, image, iconBackground }: ProjectIdentityViewProps) {
  const hasCollapseControl = isCollapsed !== undefined;
  const iconVisibilityClassName = hasCollapseControl ? (alwaysShowActions ? 'hidden' : 'group-hover/project:hidden group-focus-within/project:hidden') : undefined;
  return (
    <>
      <span className="inline-flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
        {hasCollapseControl ? (
          <span className={cn(
            'h-3.5 w-3.5 items-center justify-center text-muted-foreground',
            alwaysShowActions ? 'inline-flex' : 'hidden group-hover/project:inline-flex group-focus-within/project:inline-flex',
          )}>
            <Icon name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {image ? (
          <span
            className={cn(
              'h-3.5 w-3.5 items-center justify-center overflow-hidden rounded-[3px]',
              hasCollapseControl && alwaysShowActions ? 'hidden' : 'inline-flex',
              iconVisibilityClassName,
            )}
            style={iconBackground ? { backgroundColor: iconBackground } : undefined}
          >
            {image}          </span>
        ) : projectIconName ? (
          <Icon name={projectIconName} className={cn('h-3.5 w-3.5', iconVisibilityClassName)} style={iconColor ? { color: iconColor } : undefined} />
        ) : (
          <Icon name="folder" className={cn('h-3.5 w-3.5 text-muted-foreground/80', iconVisibilityClassName)} style={iconColor ? { color: iconColor } : undefined} />
        )}
      </span>
      <span className="truncate typography-ui-label font-semibold lowercase text-foreground">{projectLabel}</span>
    </>
  );
}
