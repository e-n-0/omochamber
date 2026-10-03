import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export interface HeaderViewProps {
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly onMouseDown?: MouseEventHandler<HTMLDivElement>;
  readonly frameless?: boolean;
  readonly windowControlsSide?: 'left' | 'right';
  readonly insetWidth?: CSSProperties['width'];
  readonly controlsWidth?: CSSProperties['width'];
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly fillSpace?: boolean;
}

export function HeaderView({ children, actions, onMouseDown, frameless = false, windowControlsSide = 'right', insetWidth = 0, controlsWidth = 0, className, style, fillSpace = true }: HeaderViewProps) {
  const { t } = useI18n();
  return (
    <div onMouseDown={onMouseDown} className={cn('app-region-drag relative flex h-12 select-none items-center', frameless && windowControlsSide === 'right' ? 'pr-0' : 'pr-3', className)} style={style} role="tablist" aria-label={t('header.navigation.mainAria')}>
      <div aria-hidden className="shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none" style={{ width: insetWidth }} />
      <div aria-hidden className="app-region-no-drag shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none" style={{ width: controlsWidth }} />
      <div className="flex min-w-0 flex-1 items-center">
        {children}
        {fillSpace ? <div className="flex-1" /> : null}
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
    </div>
  );
}
