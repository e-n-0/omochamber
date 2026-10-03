import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface MainLayoutViewProps {
    overlays?: ReactNode;
    titlebarControls: ReactNode;
    sidebar: ReactNode;
    header: ReactNode;
    chat: ReactNode;
    chatHidden?: boolean;
    surfaces?: ReactNode;
    contextPanel: ReactNode;
    contextRail: ReactNode;
    guestHosts?: ReactNode;
    settings?: ReactNode;
}

export const MainLayoutView = ({
    overlays,
    titlebarControls,
    sidebar,
    header,
    chat,
    chatHidden = false,
    surfaces,
    contextPanel,
    contextRail,
    guestHosts,
    settings,
}: MainLayoutViewProps) => (
    <div
        data-page-scroll-lock="true"
        className="main-content-safe-area relative flex h-[100dvh] bg-background"
    >
        {overlays}
        {/* Persistent controls stay put while the sidebar/header animate. */}
        {titlebarControls}
        <div className="flex flex-1 overflow-hidden" data-page-scroll-lock="true">
            {sidebar}
            <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden bg-background" data-page-scroll-lock="true">
                {header}
                <div className="relative flex flex-1 min-h-0 overflow-hidden bg-background" data-page-scroll-lock="true">
                    <div className="relative flex flex-1 min-w-0 flex-col overflow-hidden border-t border-border bg-background" data-page-scroll-lock="true">
                        <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                            {/* Measure the stable chat/context area, not the animating chat width. */}
                            <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true" data-chat-area="true">
                                <main className="flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                    <div className={cn('absolute inset-0', chatHidden && 'invisible')}>
                                        {chat}
                                    </div>
                                    {surfaces}
                                </main>
                                {contextPanel}
                            </div>
                        </div>
                    </div>
                    <div className="border-t border-border" data-page-scroll-lock="true">
                        {contextRail}
                    </div>
                    {guestHosts}
                </div>
            </div>
        </div>
        {settings}
    </div>
);
