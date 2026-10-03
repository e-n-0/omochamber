import React from 'react';

const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 600;
const CHAT_MIN_WIDTH = 400;
const RESIZE_FOLLOW_INTERVAL_MS = 100;

export interface ContextPanelGeometryOptions {
  readonly open: boolean;
  readonly expanded: boolean;
  readonly scopeKey: string;
  readonly widthFraction?: number;
  readonly widthPixels?: number;
  readonly clampWidth?: (width: number, availableWidth: number | null) => number;
  readonly onWidthChange: (width: number, availableWidth: number | null) => void;
  readonly onAvailableWidthChange?: (width: number | null) => void;
}

/** Geometry belongs to the mounted frame; preferences belong to its caller. */
export function useContextPanelGeometry(options: ContextPanelGeometryOptions) {
  const { open, expanded, scopeKey, widthFraction, widthPixels, onWidthChange, onAvailableWidthChange, clampWidth: clampPreferenceWidth } = options;
  const panelRef = React.useRef<HTMLElement | null>(null);
  const [availableWidth, setAvailableWidth] = React.useState<number | null>(null);
  const [isResizing, setIsResizing] = React.useState(false);
  const startX = React.useRef(0);
  const startWidth = React.useRef(0);
  const pendingWidth = React.useRef<number | null>(null);
  const pointerID = React.useRef<number | null>(null);
  const availableAtStart = React.useRef<number | null>(null);
  const followTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasOpen = React.useRef(false);

  const clampWidth = React.useCallback((value: number, available: number | null) => {
    if (clampPreferenceWidth) return clampPreferenceWidth(value, available);
    const maximum = available === null ? Infinity : Math.max(MIN_WIDTH, available - CHAT_MIN_WIDTH);
    const clamped = Math.min(maximum, Math.max(MIN_WIDTH, Math.round(value)));
    return available === null ? clamped : Math.min(clamped, Math.max(1, available));
  }, [clampPreferenceWidth]);
  const storedWidth = widthFraction !== undefined && availableWidth !== null
    ? widthFraction * availableWidth
    : widthPixels ?? DEFAULT_WIDTH;
  const width = clampWidth(storedWidth, availableWidth);

  React.useLayoutEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(([entry]) => {
      setAvailableWidth(entry?.contentRect.width || null);
    });
    observer.observe(parent);
    setAvailableWidth(parent.clientWidth || null);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    onAvailableWidthChange?.(availableWidth);
  }, [availableWidth, onAvailableWidthChange]);

  React.useEffect(() => {
    if (!open || wasOpen.current) {
      wasOpen.current = open;
      return;
    }
    const frame = window.requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    wasOpen.current = true;
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const clearResize = React.useCallback(() => {
    if (followTimer.current !== null) {
      clearTimeout(followTimer.current);
      followTimer.current = null;
    }
    pointerID.current = null;
    pendingWidth.current = null;
    document.documentElement.style.cursor = '';
    document.documentElement.style.userSelect = '';
    setIsResizing(false);
  }, []);

  // A changed owner cancels a drag rather than writing its width to the new directory.
  React.useEffect(() => {
    clearResize();
    return clearResize;
  }, [scopeKey, open, expanded, clearResize]);

  const applyFollowWidth = React.useCallback(() => {
    followTimer.current = null;
    if (pendingWidth.current !== null) {
      panelRef.current?.style.setProperty('--oc-context-panel-width', `${pendingWidth.current}px`);
    }
  }, []);

  const finishResize = React.useCallback(() => {
    if (pointerID.current === null) return;
    if (pendingWidth.current !== null) onWidthChange(pendingWidth.current, availableAtStart.current);
    clearResize();
  }, [onWidthChange, clearResize]);

  const onResizePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !open || expanded) return;
    event.preventDefault();
    pointerID.current = event.pointerId;
    startX.current = event.clientX;
    startWidth.current = panelRef.current?.getBoundingClientRect().width ?? width;
    availableAtStart.current = panelRef.current?.parentElement?.getBoundingClientRect().width ?? availableWidth;
    pendingWidth.current = startWidth.current;
    document.documentElement.style.cursor = 'col-resize';
    document.documentElement.style.userSelect = 'none';
    setIsResizing(true);
  }, [availableWidth, expanded, open, width]);

  React.useEffect(() => {
    if (!isResizing) return;
    const move = (event: PointerEvent) => {
      if (pointerID.current !== event.pointerId) return;
      const nextWidth = clampWidth(startWidth.current + startX.current - event.clientX, availableAtStart.current);
      if (pendingWidth.current === nextWidth) return;
      pendingWidth.current = nextWidth;
      if (followTimer.current === null) followTimer.current = setTimeout(applyFollowWidth, RESIZE_FOLLOW_INTERVAL_MS);
    };
    const end = (event: PointerEvent) => {
      if (pointerID.current === event.pointerId) finishResize();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', finishResize);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', finishResize);
    };
  }, [isResizing, clampWidth, applyFollowWidth, finishResize]);

  const widthStyle: React.CSSProperties & { readonly '--oc-context-panel-width': string } = !open
    ? { '--oc-context-panel-width': `${width}px`, width: 0, maxWidth: '100%', overflowX: 'clip' }
    : expanded
      ? { '--oc-context-panel-width': availableWidth === null ? '100%' : `${availableWidth}px`, width: availableWidth === null ? '100%' : `${availableWidth}px`, maxWidth: '100%' }
      : { '--oc-context-panel-width': `${width}px`, width: 'min(var(--oc-context-panel-width), 100%)', maxWidth: '100%', overflowX: 'clip' };
  const contentStyle = {
    width: expanded ? (availableWidth === null ? '100%' : `${availableWidth}px`) : 'var(--oc-context-panel-width)',
  };

  return { panelRef, widthStyle, contentStyle, isResizing, onResizePointerDown };
}
