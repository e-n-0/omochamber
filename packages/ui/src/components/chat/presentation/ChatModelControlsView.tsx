import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';

export interface ChatModelControlsViewProps {
    readonly model: React.ReactNode;
    readonly thinking?: React.ReactNode;
    readonly agent?: React.ReactNode;
    readonly popups?: React.ReactNode;
    readonly isMobile?: boolean;
    readonly inlineMobileSelection?: boolean;
    readonly gapClass?: string;
    readonly className?: string;
}

export function ChatModelControlsView({ model, thinking, agent, popups, isMobile = false, inlineMobileSelection = false, gapClass = 'gap-x-3', className }: ChatModelControlsViewProps) {
    return <>
        <div className={cn('@container/model-controls flex items-center min-w-0', isMobile && 'w-full', className)}>
            <div className={cn('flex items-center min-w-0 flex-1', inlineMobileSelection ? 'justify-start' : 'justify-end', gapClass, isMobile && 'overflow-hidden')}>
                {!inlineMobileSelection && thinking}
                {model}
                {inlineMobileSelection && thinking}
                {agent}
            </div>
        </div>
        {popups}
    </>;
}

export type ChatModelControlTriggerViewProps = React.HTMLAttributes<HTMLDivElement> & {
    readonly kind: 'model' | 'variant';
    readonly heightClass?: string;
};

export const ChatModelControlTriggerView = React.forwardRef<HTMLDivElement, ChatModelControlTriggerViewProps>(
    function ChatModelControlTriggerView({ kind, heightClass = 'h-8', className, ...props }, ref) {
        const chrome = kind === 'model'
            ? 'model-controls__model-trigger flex items-center gap-1.5 cursor-pointer select-none hover:bg-transparent hover:opacity-70 min-w-0'
            : 'model-controls__variant-trigger flex items-center gap-1.5 transition-colors cursor-pointer select-none hover:bg-transparent hover:opacity-70 min-w-0';
        return <div {...props} ref={ref} className={cn(chrome, heightClass, className)} />;
    },
);

export interface ChatModelPickerOption { readonly value: string; readonly label: string; }
export interface ChatModelPickerViewProps {
    readonly kind: 'model' | 'variant';
    readonly label: string;
    readonly ariaLabel: string;
    readonly testId: string;
    readonly value: string;
    readonly options: readonly ChatModelPickerOption[];
    readonly disabled: boolean;
    readonly onSelect: (value: string) => void;
}

export function ChatModelPickerView({ kind, label, ariaLabel, testId, value, options, disabled, onSelect }: ChatModelPickerViewProps) {
    return <DropdownMenu>
        <DropdownMenuTrigger asChild nativeButton={false} disabled={disabled}>
            <ChatModelControlTriggerView kind={kind} aria-label={ariaLabel} data-testid={testId}
                className={disabled ? 'opacity-60 cursor-not-allowed' : undefined}>
                <Icon name={kind === 'model' ? 'pencil-ai' : 'brain-ai-3'} className={cn('size-4 flex-shrink-0', kind === 'model' ? 'text-muted-foreground' : 'text-[color:var(--status-info)]')} />
                <span className={cn(kind === 'model' ? 'model-controls__model-label' : 'model-controls__variant-label', 'typography-meta font-medium min-w-0 truncate')}>{label}</span>
            </ChatModelControlTriggerView>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
            {options.map((option) => <DropdownMenuItem key={option.value} onSelect={() => onSelect(option.value)} className="gap-2 min-w-0">
                <span className="flex-1 min-w-0 truncate">{option.label}</span>
                {option.value === value && <Icon name="check" className="size-4 flex-shrink-0" />}
            </DropdownMenuItem>)}
        </DropdownMenuContent>
    </DropdownMenu>;
}
