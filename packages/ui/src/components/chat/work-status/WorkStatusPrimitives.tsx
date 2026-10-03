import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSectionView } from './WorkStatusSectionView';
export { WorkStatusSection } from './WorkStatusSectionView';
export { WorkStatusRow, WorkStatusValue, WorkStatusRowAction, WorkStatusPill, WorkStatusCallout, WorkStatusMeter } from './WorkStatusReadouts';

type CollapsibleProps = Omit<React.ComponentProps<typeof WorkStatusCollapsibleSectionView>, 'expanded' | 'onExpandedChange'> & {
  readonly id: string;
  readonly defaultExpanded?: boolean;
};

export function WorkStatusCollapsibleSection({ id, defaultExpanded = false, ...presentation }: CollapsibleProps) {
  const stored = useUIStore(React.useCallback((state) => state.workStatusExpandedSections[id], [id]));
  const setExpanded = useUIStore((state) => state.setWorkStatusSectionExpanded);
  return <WorkStatusCollapsibleSectionView {...presentation} expanded={stored ?? defaultExpanded} onExpandedChange={(expanded) => setExpanded(id, expanded)} />;
}
