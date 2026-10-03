import React from 'react';
import { LegendList, type LegendListRef } from '@legendapp/list/react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { FadeInOnReveal } from '../message/FadeInOnReveal';
import { resolveTimelineIsAtEnd } from '../lib/scroll/timelineScrollAnchoring';

export type ChatTranscriptViewProps<T> = Pick<React.ComponentProps<typeof LegendList<T>>, 'renderItem' | 'keyExtractor' | 'getItemType'> & {
    readonly entries: T[];
    readonly registerList: (list: LegendListRef | null) => void;
    readonly endPinningReleased: boolean;
    readonly composerOverlayHeight: number;
    readonly sessionIsWorking: boolean;
    readonly streamingAutoFollowEnabled?: boolean;
    readonly estimatedItemSize?: number;
    readonly onIsAtEndChange: (value: boolean) => void;
    readonly onListMetricsChange?: (metrics: { readonly footerSize: number }) => void;
    readonly onTimelineDataChange: () => void;
    readonly listHeader?: React.ReactNode;
    readonly listFooter?: React.ReactNode;
    readonly scrollContainerProps?: {
        readonly className?: string; readonly style?: React.CSSProperties; readonly tabIndex?: number;
        readonly onClick?: React.MouseEventHandler<HTMLDivElement>;
        readonly 'data-scrollbar'?: string; readonly 'data-scroll-shadow'?: string;
        readonly 'data-testid'?: string; readonly role?: string; readonly 'aria-label'?: string;
    };
};

export function ChatTranscriptView<T>({
    entries,
    renderItem,
    keyExtractor,
    getItemType,
    estimatedItemSize = 320,
    sessionIsWorking,
    streamingAutoFollowEnabled = true,
    registerList,
    endPinningReleased,
    composerOverlayHeight,
    onIsAtEndChange,
    onListMetricsChange,
    onTimelineDataChange,
    listHeader,
    listFooter,
    scrollContainerProps,
}: ChatTranscriptViewProps<T>) {
    const listRef = React.useRef<LegendListRef | null>(null);
    // With streaming auto-follow off, content growth must never move the
    // viewport; explicit commands (the scroll-to-bottom pill, session open)
    // still scroll through the imperative handle.
    const isAtEndRef = React.useRef(true);

    const setListRef = React.useCallback((list: LegendListRef | null) => {
        listRef.current = list;
        registerList(list);
    }, [registerList]);

    // A width change re-wraps every row. Suspend the list's end maintenance
    // while the owning hook holds the measured end and decides whether to
    // release the pin once the resize settles.
    const [isWidthResizing, setIsWidthResizing] = React.useState(false);
    React.useEffect(() => {
        const node = listRef.current?.getScrollableNode();
        if (!node) return;
        let lastWidth: number | null = null;
        let quietTimer: ReturnType<typeof setTimeout> | null = null;
        const observer = new ResizeObserver((observerEntries) => {
            const width = observerEntries[observerEntries.length - 1]?.contentRect.width;
            if (width === undefined) return;
            if (lastWidth === null) {
                lastWidth = width;
                return;
            }
            if (Math.abs(width - lastWidth) < 1) return;
            lastWidth = width;
            setIsWidthResizing(true);
            if (quietTimer !== null) clearTimeout(quietTimer);
            // Released after the owning hook's 350ms settle decision — while a
            // pin release is still pending, re-enabled end maintenance would
            // snap the viewport back before the hook can let it go.
            quietTimer = setTimeout(() => {
                quietTimer = null;
                setIsWidthResizing(false);
            }, 400);
        });
        observer.observe(node);
        return () => {
            observer.disconnect();
            if (quietTimer !== null) clearTimeout(quietTimer);
        };
    }, []);

    // The list reports scroll continuously; only end-crossings are interesting,
    // so the edge is debounced to a state transition here rather than pushing a
    // callback on every frame.
    const handleScroll = React.useCallback(() => {
        const state = listRef.current?.getState();
        if (!state) return;
        const isAtEnd = resolveTimelineIsAtEnd(state);
        if (isAtEnd === undefined || isAtEnd === isAtEndRef.current) return;
        isAtEndRef.current = isAtEnd;
        onIsAtEndChange(isAtEnd);
    }, [onIsAtEndChange]);

    // Data changes are the only moment an automatic correction can be needed;
    // the owning hook decides whether one actually applies.
    React.useEffect(() => {
        onTimelineDataChange();
    }, [entries, onTimelineDataChange]);

    const header = React.useMemo(() => (listHeader ? <>{listHeader}</> : undefined), [listHeader]);
    const footer = React.useMemo(() => (listFooter ? <>{listFooter}</> : undefined), [listFooter]);

    return (
        <>
            <LegendList<T>
                ref={setListRef}
                data={entries}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                renderItem={renderItem}
                estimatedItemSize={estimatedItemSize}
                initialScrollAtEnd
                // Chat rows own internal state (expanded tool calls, reveal
                // animations); recycling a container into a different row would
                // carry that state across.
                recycleItems={false}
                contentInsetEndAdjustment={composerOverlayHeight}
                // Live only while the session streams: outside a stream the
                // owning hook keeps a pinned reader on the end with same-frame
                // writes, and the list's own correction runs a frame later
                // against a content length that can still be stale (a
                // re-wrap, a late measurement) — that is the visible bounce
                // an idle reader saw on every panel toggle. Also off while the
                // width resizes, where the hook holds the measured end itself.
                maintainScrollAtEnd={!streamingAutoFollowEnabled || !sessionIsWorking || isWidthResizing || endPinningReleased
                    ? false
                    // Animated: the block-step growth turns each correction
                    // into a glide and reveal + scroll read as one motion.
                    : {
                        animated: true,
                        on: { dataChange: true, itemLayout: true, layout: true, footerLayout: true },
                    }}
                // A prepend first positions rows using estimated heights;
                // later measurements must preserve the same visible row too.
                // Keep size compensation active while reading history, including
                // when scrolling mounts older rows above the viewport. A pinned
                // reader is held on the end by the owning hook instead.
                maintainVisibleContentPosition={{ data: true, size: endPinningReleased }}
                onScroll={handleScroll}
                onMetricsChange={onListMetricsChange}
                ListHeaderComponent={header}
                ListFooterComponent={footer}
                {...scrollContainerProps}
            />
        </>
    );
}

export interface ChatMessageViewProps {
    readonly messageId: string;
    readonly isUser: boolean;
    readonly isMobile?: boolean;
    readonly topPaddingClass?: string;
    readonly bottomPaddingClass?: string;
    readonly userGapClassName?: string;
    readonly animateUserOnMount?: boolean;
    readonly containerRef?: React.Ref<HTMLDivElement>;
    readonly children: React.ReactNode;
    readonly userActions?: React.ReactNode;
    readonly role?: string;
    readonly testId?: string;
}

export function ChatMessageView({ messageId, isUser, isMobile = false, topPaddingClass = 'pt-0',
    bottomPaddingClass = 'pb-2', userGapClassName, animateUserOnMount = false, containerRef, children, userActions, role, testId }: ChatMessageViewProps) {
    return <div className={cn('group w-full', isUser ? (isMobile ? 'pt-2' : 'pt-4') : topPaddingClass, isUser ? 'pb-0' : bottomPaddingClass)}
        id={`message-${messageId}`} data-message-id={messageId} data-message-role={role} data-testid={testId} ref={containerRef}>
        <div className="chat-message-column relative">
            {isUser ? <FadeInOnReveal forceAnimation skipAnimation={!animateUserOnMount} ignoreContextDisabled respectReducedMotion>
                <div className={cn('relative flex justify-end', !isMobile ? 'group/user-shell' : undefined)}>
                    <div className={cn('max-w-[85%]', userGapClassName)}>
                        <div style={{ backgroundColor: 'var(--chat-user-message-bg)', borderRadius: 'var(--radius-xl)', borderBottomRightRadius: 'var(--radius-sm)' }}
                            className="px-5 py-3 shadow-none border border-primary/5">{children}</div>
                        {userActions}
                    </div>
                </div>
            </FadeInOnReveal> : <div className="relative">{children}</div>}
        </div>
    </div>;
}

export function ChatAssistantTextView({ children, className }: { readonly children: React.ReactNode; readonly className?: string }) {
    return <div className={cn('group/assistant-text relative break-words', className)}>{children}</div>;
}
export const ChatUserTextView = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function ChatUserTextView({ className, ...props }, ref) {
        return <div {...props} ref={ref} className={cn('break-words font-sans typography-markdown-body', className)} />;
    },
);

export const ChatReasoningTextView = React.forwardRef<React.ComponentRef<typeof ScrollableOverlay>, React.ComponentProps<typeof ScrollableOverlay>>(
    function ChatReasoningTextView(props, ref) {
        return <ScrollableOverlay {...props} ref={ref} as="div" className="p-0" useScrollShadow scrollShadowSize={36} userIntentOnly data-scrollable="true" />;
    },
);
