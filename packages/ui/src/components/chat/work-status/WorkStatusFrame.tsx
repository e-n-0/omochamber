import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { WORK_STATUS_PANEL_WIDTH, type WorkStatusVisibility } from './workStatusVisibility';
import { WorkStatusPresentation } from './WorkStatusPresentation';

const PANEL_TRANSITION_MS = 200;
const PANEL_TRANSITION_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

export interface WorkStatusFrameProps extends WorkStatusVisibility {
  readonly sessionKey: string | null;
  readonly children: React.ReactNode;
  readonly headerAction?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly dialog?: React.ReactNode;
  readonly dismissDisabled?: boolean;
  readonly onDismiss?: () => void;
  readonly getScrollTop?: () => number;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  readonly interactive?: boolean;
  /** Keep consumer-owned drafts and output mounted while the card is hidden. */
  readonly retainContent?: boolean;
}

/** The original work-card lifecycle, sizing, overlay, and scroll surface. */
export function WorkStatusFrame({ sessionKey, visible, overlay, children, headerAction, footer, dialog, dismissDisabled, onDismiss, getScrollTop, onScrollTopChange, interactive = visible, retainContent = false }: WorkStatusFrameProps) {
  const { t } = useI18n();
  const [contentMounted, setContentMounted] = React.useState(visible || retainContent);
  const isInteractive = visible && interactive;
  const overlayRef = React.useRef<HTMLElement | null>(null);
  const scrollNode = React.useRef<HTMLDivElement | null>(null);
  const scrollTopRef = React.useRef(0);
  const frameRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (visible || retainContent) {
      setContentMounted(true);
      return;
    }
    const timer = setTimeout(() => setContentMounted(false), PANEL_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [visible, retainContent]);
  const restore = React.useCallback((node: HTMLDivElement | null) => {
    scrollNode.current = node;
    if (node) node.scrollTop = getScrollTop?.() ?? scrollTopRef.current;
  }, [getScrollTop]);
  const handleScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (frameRef.current !== null) return;
    const node = event.currentTarget;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      scrollTopRef.current = node.scrollTop;
      onScrollTopChange?.(node.scrollTop);
    });
  }, [onScrollTopChange]);
  React.useEffect(() => () => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);
  React.useEffect(() => {
    if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null; }
    scrollTopRef.current = 0;
    if (scrollNode.current) scrollNode.current.scrollTop = 0;
    onScrollTopChange?.(0);
  }, [sessionKey, onScrollTopChange]);
  React.useEffect(() => {
    if (!overlay || !visible || dismissDisabled || !onDismiss) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (overlayRef.current?.contains(target)) return;
      if (target?.closest('[data-work-status-toggle], [role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return;
      onDismiss();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-oc-escape-owner="terminal"], .cm-editor, [role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overlay, visible, dismissDisabled, onDismiss]);
  return (
    <aside
      ref={overlayRef}
      aria-label={t('chat.workStatus.ariaLabel')}
      aria-hidden={!isInteractive}
      // The card stays mounted while hidden so it can animate its own collapse,
      // and the sections button sits outside the content gate. Without `inert`
      // Tab could land on an invisible control — and `aria-hidden` around a
      // focusable descendant is an accessibility fault in its own right.
      inert={!isInteractive}
      className={cn(
        // `self-start` keeps the card at content height instead of stretching
        // to the row; `max-h` then caps it so a long panel scrolls rather than
        // overflowing the chat.
        // A left margin as well as a right one: flush against the transcript
        // the card's own shadow had no room and was clipped down that edge.
        'relative my-4 flex shrink-0 flex-col self-start overflow-hidden',
        'max-h-[calc(100%-2rem)]',
        isInteractive ? 'ml-2 mr-4' : 'ml-0 mr-0',
        // Out of the flow entirely, anchored to the chat column's top-right so
        // it reads as a dropdown from the header button. As a flex child it
        // took part in the layout and pushed the transcript, which is the one
        // thing an overlay must not do. Stronger shadow: it sits on content now.
        overlay && [
          'absolute right-3 top-3 z-30 mx-0 my-0',
          'max-h-[calc(100%-1.5rem)]',
          'shadow-[0_8px_28px_-8px_rgb(0_0_0_/_0.28)]',
        ],
        // When every section is hidden the card keeps its border and background
        // so the settings button stays discoverable — going transparent made the
        // only recovery path unreachable.
        'motion-reduce:transition-none',
        'rounded-xl border border-[var(--interactive-border)]',
        !overlay && 'bg-[var(--surface-muted)]/40',
        // A lighter version of the composer's lift: the same shape, but this
        // card is taller, so the composer's spread reads as heavy here.
        'shadow-[0_2px_8px_-3px_rgb(0_0_0_/_0.08)]',
      )}
      style={{
        // The overlay keeps its width: it takes no space from the chat, so
        // collapsing it would animate a dimension nothing depends on. It fades
        // and lifts instead, like the dropdown it reads as.
        width: overlay || isInteractive ? WORK_STATUS_PANEL_WIDTH : 0,
        opacity: isInteractive ? 1 : 0,
        transform: visible
          ? 'translateY(0) scale(1)'
          : overlay
            ? 'translateY(-6px) scale(0.98)'
            // Inline: leaves to the right and arrives from it, so the card
            // reads as sliding out past the window edge.
            : `translateX(${WORK_STATUS_PANEL_WIDTH / 4}px)`,
        transformOrigin: 'top right',
        transitionProperty: 'width, opacity, transform, margin',
        transitionDuration: `${PANEL_TRANSITION_MS}ms`,
        transitionTimingFunction: PANEL_TRANSITION_EASING,
        pointerEvents: isInteractive ? undefined : 'none',
      }}
    >
      {/* Beside the transcript the translucent fill reads as depth; on top of
          it, message bubbles showed straight through the rows, so the overlay
          is frosted. The glass sits on this inner layer, away from the card's
          shadow: on one element Chromium grows the backdrop-filter layer by
          the shadow's blur and paints a grey band past the card's edge. */}
      <div className={cn('flex min-h-0 flex-1 flex-col', overlay && 'oc-glass-panel')}>

      {headerAction}
      {contentMounted ? <WorkStatusPresentation scrollRef={restore} onScroll={handleScroll}>{children}</WorkStatusPresentation> : null}
      {contentMounted ? footer : null}
      </div>
      {dialog}
    </aside>
  );
}
