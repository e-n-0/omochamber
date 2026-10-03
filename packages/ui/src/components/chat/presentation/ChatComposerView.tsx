import React from 'react';
import { cn } from '@/lib/utils';
import { ComposerEditor } from '../composer/editor/ComposerEditor';


export type ChatComposerFormViewProps = React.FormHTMLAttributes<HTMLFormElement> & {
    readonly isMobile?: boolean; readonly isDesktopExpanded?: boolean; readonly isMobileExpanded?: boolean;
};

export const ChatComposerFormView = React.forwardRef<HTMLFormElement, ChatComposerFormViewProps>(
    function ChatComposerFormView({ isMobile, isDesktopExpanded, isMobileExpanded, className, ...props }, ref) {
        return <form {...props} ref={ref} className={cn('relative w-full pt-0 pb-4',
            isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
            isMobileExpanded && 'flex h-full min-h-0 flex-col pt-2',
            isMobile && 'bottom-safe-area oc-mobile-composer', className)} />;
    },
);

export interface ChatComposerViewProps {
    readonly children: React.ReactNode;
    readonly isExpanded?: boolean;
    readonly radius?: string;
    readonly isDragging?: boolean;
    readonly boxProps?: React.HTMLAttributes<HTMLDivElement> & React.RefAttributes<HTMLDivElement> & { readonly 'data-composer-box'?: string };
}

/** The original glass box and its separate lift shadow. Controllers own all content slots. */
export function ChatComposerView({ children, isExpanded = false, radius = 'var(--radius-xl)', isDragging = false, boxProps }: ChatComposerViewProps) {
    return <div className={cn('flex flex-col', isExpanded && 'flex-1 min-h-0', 'shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]')} style={{ borderRadius: radius }}>
        <div {...boxProps} className={cn('flex flex-col relative overflow-visible', isExpanded && 'flex-1 min-h-0',
            'border border-border/80 focus-within:border-interactive-selection-foreground/35', 'oc-glass-composer',
            isDragging && 'ring-2 ring-primary ring-offset-2')} style={{ borderRadius: radius }}>
            {children}
        </div>
    </div>;
}

export type ChatComposerEditorViewProps = React.ComponentProps<typeof ComposerEditor> & { readonly isMobile?: boolean; readonly isExpanded?: boolean };

export const ChatComposerEditorView = React.forwardRef<React.ComponentRef<typeof ComposerEditor>, ChatComposerEditorViewProps>(
    function ChatComposerEditorView({ isMobile = false, isExpanded = false, className, ...props }, ref) {
        return <ComposerEditor {...props} maxLines={props.maxLines ?? (isMobile ? 16 : 8)} ref={ref} className={cn('min-h-[52px] px-3 relative z-10',
            isExpanded ? cn('h-full min-h-0', isMobile ? 'py-2.5' : 'py-4') : isMobile ? 'pt-4 pb-2.5' : 'pt-4 pb-2',
            props.languageContext.inputMode === 'shell' ? 'font-mono' : 'typography-markdown md:typography-ui-label', className)} />;
    },
);

export interface ChatComposerFooterViewProps {
    readonly children: React.ReactNode;
    readonly isMobile?: boolean;
    readonly radius?: string;
    readonly paddingClass?: string;
    readonly gapClass?: string;
}

export function ChatComposerFooterView({ children, isMobile = false, radius = 'var(--radius-xl)',
    paddingClass = 'px-2.5 py-1.5', gapClass = 'gap-x-1.5 gap-y-0' }: ChatComposerFooterViewProps) {
    return <div className={cn('bg-transparent flex-shrink-0', paddingClass,
        isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', gapClass))}
        style={{ borderBottomLeftRadius: radius, borderBottomRightRadius: radius }} data-chat-input-footer="true">
        {children}
    </div>;
}
