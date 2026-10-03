import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const RAIL_TOOLTIP_DELAY_MS = 150;
const formatRailBadgeCount = (count: number): string => (count > 99 ? '99+' : String(count));

export interface ContextPanelRailItemViewProps {
  readonly icon: React.ReactNode;
  readonly isActive: boolean;
  readonly showActivityDot?: boolean;
  readonly label: string;
  readonly description: string;
  readonly badgeCount?: number | null;
  readonly badgeAriaLabel?: string | null;
  readonly badgeDescription?: string | null;
  readonly orderNumber?: number | null;
  readonly showOrderNumber?: boolean;
  readonly onSelect: () => void;
  readonly itemRef?: React.Ref<HTMLDivElement>;
  readonly style?: React.CSSProperties;
  readonly isDragging?: boolean;
  readonly buttonProps?: React.ButtonHTMLAttributes<HTMLButtonElement> & { readonly 'data-testid'?: string };
}

export const ContextPanelRailItemView: React.FC<ContextPanelRailItemViewProps> = ({
  icon, isActive, showActivityDot, label, description, badgeCount, badgeAriaLabel, badgeDescription,
  orderNumber, showOrderNumber, onSelect, itemRef, style, isDragging, buttonProps,
}) => {
  const displayBadgeCount = badgeCount != null && badgeCount > 0 ? formatRailBadgeCount(badgeCount) : null;

  return (
    <div
      ref={itemRef}
      style={style}
      className={cn('relative', isDragging && 'z-10 opacity-70')}
    >
      <Tooltip delayDuration={RAIL_TOOLTIP_DELAY_MS}>
        <TooltipTrigger asChild>
          <button
            type="button"
            {...buttonProps}
            onClick={onSelect}
            aria-label={badgeAriaLabel ?? label}
            aria-pressed={isActive}
            className={cn(
              'flex h-9 w-9 touch-none select-none items-center justify-center rounded-md transition-colors',
              isActive
                ? 'text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {icon}
            {showOrderNumber && orderNumber != null ? (
              <span
                aria-hidden="true"
                className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-muted px-1 text-[0.625rem] font-medium leading-none text-muted-foreground"
              >
                {orderNumber === 10 ? '0' : orderNumber}
              </span>
            ) : displayBadgeCount ? (
              <span
                aria-hidden="true"
                // Muted digits on the muted surface sat at almost the same
                // luminance as the glyph they overlap. The count is a live
                // signal, so it takes the info tone on its own opaque chip.
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold leading-none"
                style={{
                  backgroundColor: 'var(--status-info-background)',
                  color: 'var(--status-info)',
                }}
              >
                {displayBadgeCount}
              </span>
            ) : showActivityDot ? (
              <span
                aria-hidden="true"
                className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--status-info)]"
              />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          <div className="flex flex-col gap-0.5">
            <span>{label}</span>
            <span className="typography-micro text-muted-foreground">{description}</span>
            {badgeDescription ? (
              <span className="typography-micro text-muted-foreground">{badgeDescription}</span>
            ) : null}
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
};


export interface ContextPanelRailViewProps<T> {
  readonly ariaLabel: string;
  readonly items: readonly T[];
  readonly renderItem: (item: T, index: number) => React.ReactNode;
  readonly wrapItems?: (children: React.ReactNode) => React.ReactNode;
  readonly footer?: React.ReactNode;
}

export function ContextPanelRailView<T>({ ariaLabel, items, renderItem, wrapItems, footer }: ContextPanelRailViewProps<T>) {
  const list = items.map(renderItem);
  return (
    <nav aria-label={ariaLabel} className="flex h-full w-11 flex-shrink-0 flex-col items-center gap-1 bg-background py-2">
      {wrapItems ? wrapItems(list) : list}
      {footer}
    </nav>
  );
}
