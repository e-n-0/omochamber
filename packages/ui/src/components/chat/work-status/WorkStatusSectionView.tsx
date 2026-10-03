import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

/**
 * Row/section vocabulary for the work-status panel.
 *
 * Every readout is a labelled row — icon, name, trailing value — so a glance
 * answers "what is this number" without hovering. Sections carry a heading and
 * are separated by a hairline; the panel itself stays chrome-less, since it is
 * an object inside the chat rather than a docked pane.
 */

/**
 * Sections are direct siblings inside the panel (fragments add no DOM nodes),
 * so the separator is a first-child CSS rule. Passing "am I first?" down as a
 * prop would mean every group tracking what the groups above it decided to
 * render.
 */
const SECTION_CLASS = cn(
  'flex flex-col',
  '[&:not(:first-child)]:mt-3 [&:not(:first-child)]:border-t',
  '[&:not(:first-child)]:border-[var(--interactive-border)] [&:not(:first-child)]:pt-3',
);

const HEADING_CLASS = 'text-xs font-semibold text-foreground';

export const WorkStatusSection: React.FC<{
  id?: string;
  testId?: string;
  title: React.ReactNode;
  /** Aggregate for the whole section; belongs on the heading, not on a row. */
  summary?: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, testId, title, summary, children }) => (
  <section className={SECTION_CLASS} aria-labelledby={id ? `${id}-heading` : undefined} data-testid={testId}>
    <div data-work-status-heading className="mb-0.5 flex items-center gap-2 px-1">
      <h3 id={id ? `${id}-heading` : undefined} className={cn(HEADING_CLASS, 'min-w-0 flex-1 truncate')}>{title}</h3>
      {summary !== undefined && summary !== null ? (
        <span className="min-w-0 max-w-[60%] truncate text-right text-xs text-muted-foreground tabular-nums">{summary}</span>
      ) : null}
    </div>
    {children}
  </section>
);

/**
 * Section whose body folds away. The chevron swaps on expand exactly as the
 * transcript's tool blocks do, so the two collapsibles read as the same
 * control rather than two conventions in one window.
 *
 * Expanded state lives in the persisted UI store, not in component state: the
 * panel unmounts whenever the context panel opens, and local state would
 * silently discard the user's arrangement every time.
 */
export const WorkStatusCollapsibleSectionView: React.FC<{
  /** Stable key for persisting expanded state. */
  title: string;
  icon?: IconName;
  /** For glyphs that live outside the sprite, such as the MCP mark. */
  iconNode?: React.ReactNode;
  iconColor?: string;
  /** Shown on the header while collapsed and expanded alike. */
  summary?: React.ReactNode;
  /** An independent header action, such as refreshing this section's data. */
  action?: React.ReactNode;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Optional preview that stays below the heading while the section is folded. */
  collapsedContent?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon, iconNode, iconColor, summary, action, expanded, onExpandedChange, collapsedContent, children }) => {
  return (
    <section className={SECTION_CLASS}>
      <div data-work-status-heading className="mb-0.5 flex h-6 items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className={cn(
            'group/section flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left',
            // No hover fill anywhere in the panel: at this row density the blocks
            // of colour read as selection, not as affordance. Interactivity shows
            // through the text instead.
            'transition-colors hover:text-foreground',
          )}
        >
          {iconNode ?? (icon ? (
            <Icon
              name={icon}
              className={cn('size-4 shrink-0', !iconColor && 'text-muted-foreground')}
              style={iconColor ? { color: iconColor } : undefined}
            />
          ) : null)}
          <span className={cn(HEADING_CLASS, 'min-w-0 truncate')}>{title}</span>
          <Icon
            name={expanded ? 'arrow-down-s' : 'arrow-right-s'}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="flex-1" />
          {summary !== undefined && summary !== null ? (
            <span className="min-w-0 max-w-[60%] truncate text-right text-xs text-muted-foreground tabular-nums">{summary}</span>
          ) : null}
        </button>
        {action}
      </div>
      {expanded ? children : collapsedContent}
    </section>
  );
};
