import React from 'react';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
export { WorkStatusSection, WorkStatusCollapsibleSectionView } from './WorkStatusSectionView';
export { WorkStatusRow, WorkStatusValue, WorkStatusRowAction, WorkStatusPill, WorkStatusCallout, WorkStatusMeter } from './WorkStatusReadouts';

export interface WorkStatusPresentationProps {
  readonly children: React.ReactNode;
  readonly scrollRef?: React.Ref<HTMLDivElement>;
  readonly onScroll?: React.UIEventHandler<HTMLDivElement>;
}

/** Sections stay direct siblings in the original work-card scroller. */
export function WorkStatusPresentation({ children, scrollRef, onScroll }: WorkStatusPresentationProps) {
  return (
    <ScrollShadow
      ref={scrollRef}
      onScroll={onScroll}
      size={24}
      className="oc-hide-scrollbar min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2 [&>section:first-child>[data-work-status-heading]]:pr-7"
    >
      {children}
    </ScrollShadow>
  );
}
