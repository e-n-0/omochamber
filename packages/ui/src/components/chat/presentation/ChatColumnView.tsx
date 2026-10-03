import React from 'react';
import { cn } from '@/lib/utils';

export function ChatColumnView({ children }: { readonly children: React.ReactNode }) {
    return <div data-composer-bound className="relative flex min-w-0 flex-1 flex-col h-full bg-background">{children}</div>;
}

export interface ChatComposerSlotViewProps {
    readonly children: React.ReactNode;
    readonly floatingComposer: boolean;
    readonly expanded?: boolean;
    readonly centeredDraft?: boolean;
}

export const ChatComposerSlotView = React.forwardRef<HTMLDivElement, ChatComposerSlotViewProps>(
    function ChatComposerSlotView({ children, floatingComposer, expanded = false, centeredDraft = false }, ref) {
        return <div ref={ref} data-composer-slot={floatingComposer ? 'floating' : 'flow'}
            className={cn(
                'z-10 flex min-h-0',
                floatingComposer ? 'absolute inset-x-0 bottom-0' : 'relative',
                expanded ? 'flex-1 min-h-0 bg-background'
                    : centeredDraft ? 'flex-1 items-center justify-center bg-background pb-[6vh]'
                    : !floatingComposer && 'bg-background',
            )}>
            {children}
        </div>;
    },
);
