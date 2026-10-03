import React from 'react';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { useI18n } from '@/lib/i18n';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

const SIDEBAR_CONTENT_WIDTH = 280;
// Wide enough for the toolbar's eight icons and a labelled titlebar button.
const SIDEBAR_MIN_WIDTH = 264;
const SIDEBAR_MAX_WIDTH = 500;

export interface SidebarViewProps {
    readonly width: number;
    readonly onWidthChange: (width: number, persist?: boolean) => void;
    readonly cancelRestoresWidth?: boolean;
    readonly resizeHandleProps?: React.HTMLAttributes<HTMLDivElement> & { readonly 'data-testid'?: string };
    isOpen: boolean;
    isMobile: boolean;
    children: React.ReactNode;
    className?: string;
    /** Fixed strip rendered above the scrollable content (e.g. toggle + project actions). */
    topBar?: React.ReactNode;
}

export const SidebarView: React.FC<SidebarViewProps> = ({ isOpen, isMobile, children, className, topBar, width: sidebarWidth, onWidthChange: setSidebarWidth, cancelRestoresWidth = false, resizeHandleProps }) => {
    const { t } = useI18n();
    const [isResizing, setIsResizing] = React.useState(false);
    const startXRef = React.useRef(0);
    const startWidthRef = React.useRef(sidebarWidth || SIDEBAR_CONTENT_WIDTH);
    const resizingWidthRef = React.useRef<number | null>(null);
    const activeResizePointerIDRef = React.useRef<number | null>(null);
    const sidebarRef = React.useRef<HTMLElement | null>(null);

    const clampSidebarWidth = React.useCallback((value: number) => {
        return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
    }, []);

    const applyLiveWidth = React.useCallback((nextWidth: number) => {
        const sidebar = sidebarRef.current;
        if (!sidebar) {
            return;
        }

        sidebar.style.width = `${nextWidth}px`;
        sidebar.style.minWidth = `${nextWidth}px`;
        sidebar.style.maxWidth = `${nextWidth}px`;
        sidebar.style.setProperty('--oc-left-sidebar-width', `${nextWidth}px`);
    }, []);

    React.useEffect(() => {
        if (isMobile && isResizing) {
            setIsResizing(false);
        }
    }, [isMobile, isResizing]);

    React.useEffect(() => {
        if (!isResizing) {
            resizingWidthRef.current = null;
            activeResizePointerIDRef.current = null;
        }
    }, [isResizing]);

    if (isMobile) {
        return null;
    }

    const openWidth = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, sidebarWidth || SIDEBAR_CONTENT_WIDTH)
    );
    const appliedWidth = isOpen ? openWidth : 0;

    const handlePointerDown = (event: React.PointerEvent) => {
        if (!isOpen) {
            return;
        }

        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // ignore
        }

        activeResizePointerIDRef.current = event.pointerId;
        setIsResizing(true);
        startXRef.current = event.clientX;
        startWidthRef.current = appliedWidth;
        resizingWidthRef.current = appliedWidth;
        applyLiveWidth(appliedWidth);
        event.preventDefault();
    };

    const handlePointerMove = (event: React.PointerEvent) => {
        if (isMobile || !isResizing || activeResizePointerIDRef.current !== event.pointerId) {
            return;
        }

        const delta = event.clientX - startXRef.current;
        const nextWidth = clampSidebarWidth(startWidthRef.current + delta);
        if (resizingWidthRef.current === nextWidth) {
            return;
        }

        resizingWidthRef.current = nextWidth;
        applyLiveWidth(nextWidth);
    };

    const handlePointerEnd = (event: React.PointerEvent) => {
        if (activeResizePointerIDRef.current !== event.pointerId || isMobile) {
            return;
        }

        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // ignore
        }

        const cancelled = cancelRestoresWidth && event.type === 'pointercancel';
        const finalWidth = clampSidebarWidth(cancelled ? startWidthRef.current : resizingWidthRef.current ?? appliedWidth);
        activeResizePointerIDRef.current = null;
        resizingWidthRef.current = null;
        setIsResizing(false);
        applyLiveWidth(finalWidth);
        setSidebarWidth(finalWidth, !cancelled);
    };

    const currentWidth = isResizing ? (resizingWidthRef.current ?? appliedWidth) : appliedWidth;

    const sidebarStyle: React.CSSProperties & { readonly '--oc-left-sidebar-width': string } = {
                width: `${currentWidth}px`,
                minWidth: `${currentWidth}px`,
                maxWidth: `${currentWidth}px`,
                '--oc-left-sidebar-width': `${isResizing ? currentWidth : openWidth}px`,
                overflowX: 'clip',
                transitionProperty: isResizing ? 'none' : 'width, min-width, max-width',
                transitionDuration: '200ms',
                transitionTimingFunction: 'cubic-bezier(0.22, 1, 0.36, 1)',
            };

    return (
        <aside
            ref={sidebarRef}
            className={cn(
                'relative flex h-full overflow-hidden border-r border-border will-change-[width] motion-reduce:transition-none',
                'bg-sidebar',
                !isOpen && 'border-r-0',
                className,
            )}
            style={sidebarStyle}
            aria-hidden={!isOpen || appliedWidth === 0}
        >
            {isOpen && (
                <div
                    className="pointer-events-none absolute inset-0 z-30 shadow-[inset_-2px_0_10px_-2px_rgb(0_0_0_/_0.06)]"
                    aria-hidden="true"
                />
            )}
            {isOpen && (
                <div
                    {...resizeHandleProps}
                    className={cn(
                        'absolute right-0 top-0 z-20 h-full w-[3px] cursor-col-resize hover:bg-[var(--interactive-border)]/80 transition-colors',
                        isResizing && 'bg-[var(--interactive-border)]'
                    )}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerEnd}
                    onPointerCancel={handlePointerEnd}
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={t('sidebar.resize.leftPanelAria')}
                />
            )}
            <div
                className={cn(
                    'relative z-10 flex h-full shrink-0 flex-col transition-opacity duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
                    isResizing && 'pointer-events-none',
                    !isOpen && 'pointer-events-none select-none opacity-0'
                )}
                style={{ width: 'var(--oc-left-sidebar-width)', overflowX: 'hidden' }}
                aria-hidden={!isOpen}
            >
                {topBar}
                <ScrollableOverlay outerClassName="flex-1 min-h-0" disableHorizontal>
                    <ErrorBoundary>{children}</ErrorBoundary>
                </ScrollableOverlay>
            </div>
        </aside>
    );
};
