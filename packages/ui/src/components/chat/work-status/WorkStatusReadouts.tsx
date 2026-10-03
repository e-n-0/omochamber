import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

type RowProps = {
  icon?: IconName;
  iconColor?: string;
  leading?: React.ReactNode;
  label: React.ReactNode;
  value?: React.ReactNode;
  muted?: boolean;
  /** Turns the row into a button; the caller decides what it opens. */
  onClick?: () => void;
  ariaLabel?: string;
  className?: string;
};

/**
 * A single readout. `value` sits hard right; `label` truncates before it, so a
 * long branch name never pushes its own ahead/behind counts out of view.
 */
export const WorkStatusRow: React.FC<RowProps> = ({
  icon,
  iconColor,
  leading,
  label,
  value,
  muted,
  onClick,
  ariaLabel,
  className,
}) => {
  const body = (
    <>
      {leading ?? (icon ? (
        <Icon
          name={icon}
          className={cn('size-4 shrink-0', !iconColor && 'text-muted-foreground')}
          style={iconColor ? { color: iconColor } : undefined}
        />
      ) : null)}
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', muted && 'text-muted-foreground')}>
        {label}
      </span>
      {value !== undefined && value !== null ? (
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] tabular-nums">{value}</span>
      ) : null}
    </>
  );

  const shared = cn(
    'flex h-7 w-full items-center gap-2 rounded-md px-1 text-left text-muted-foreground',
    className,
  );

  if (!onClick) return <div className={shared}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      className={cn(shared, 'transition-colors hover:text-foreground')}
    >
      {body}
    </button>
  );
};

type WorkStatusTone = 'default' | 'muted' | 'success' | 'error' | 'warning' | 'info';

const TONE_COLOR = {
  success: 'var(--status-success)',
  error: 'var(--status-error)',
  warning: 'var(--status-warning)',
  info: 'var(--status-info)',
} satisfies Record<Exclude<WorkStatusTone, 'default' | 'muted'>, string>;

export const WorkStatusValue: React.FC<{
  children: React.ReactNode;
  tone?: WorkStatusTone;
}> = ({ children, tone = 'default' }) => (
  <span
    className={tone === 'muted' ? 'text-muted-foreground' : undefined}
    style={tone === 'default' || tone === 'muted' ? undefined : { color: TONE_COLOR[tone] }}
  >
    {children}
  </span>
);

/**
 * Trailing control shaped like the PR badge: a status that is also the thing
 * you press. Used where the state itself is the affordance — an MCP server
 * asking for sign-in, a goal waiting to be resumed.
 */
export const WorkStatusRowAction: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'default' | 'warning' | 'error' | 'info';
  disabled?: boolean;
  ariaLabel?: string;
  testId?: string;
}> = ({ children, onClick, tone = 'default', disabled, ariaLabel, testId }) => {
  const color = tone === 'default' ? undefined : TONE_COLOR[tone];
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(event) => {
        // The row underneath is often a button of its own with a different
        // destination.
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium leading-4 transition-opacity',
        'hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50',
        !color && 'bg-[var(--interactive-hover)] text-muted-foreground',
      )}
      style={color
        ? { color, backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` }
        : undefined}
    >
      {children}
    </button>
  );
};

export const WorkStatusPill: React.FC<{
  children: React.ReactNode;
  color?: string;
  background?: string;
}> = ({ children, color, background }) => (
  <span
    className={cn(
      'rounded-full px-1.5 py-px text-[11px] font-medium leading-4',
      !color && 'bg-[var(--interactive-hover)] text-muted-foreground',
    )}
    style={color ? { color, backgroundColor: background } : undefined}
  >
    {children}
  </span>
);

/** Full-width callout for states that block the branch (merge, rebase, …). */
export const WorkStatusCallout: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    className="mx-1 mb-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] font-medium"
    style={{ backgroundColor: 'var(--status-warning-background)', color: 'var(--status-warning)' }}
  >
    <Icon name="alert" className="size-4 shrink-0" />
    <span className="min-w-0 truncate">{children}</span>
  </div>
);

/** Context-window fill, drawn under its row rather than inside it. */
export const WorkStatusMeter: React.FC<{ percent: number; color: string }> = ({ percent, color }) => (
  <div className="mx-1 mb-1 h-1 overflow-hidden rounded-full bg-[var(--chat-divider)]">
    <div
      className="h-full rounded-full"
      style={{ width: `${Math.max(0, Math.min(100, percent))}%`, backgroundColor: color }}
    />
  </div>
);
