import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { SidebarView, type SidebarViewProps } from './SidebarView';

export const Sidebar: React.FC<Omit<SidebarViewProps, 'width' | 'onWidthChange'>> = (props) => {
  const width = useUIStore((state) => state.sidebarWidth);
  const onWidthChange = useUIStore((state) => state.setSidebarWidth);
  return <SidebarView {...props} width={width} onWidthChange={onWidthChange} />;
};
