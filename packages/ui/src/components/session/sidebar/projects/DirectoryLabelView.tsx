import type { ReactNode } from 'react';

export interface DirectoryLabelViewProps {
  readonly label: ReactNode;
  readonly activity?: ReactNode;
}

export function DirectoryLabelView({ label, activity }: DirectoryLabelViewProps) {
  return <span className="inline-flex min-w-0 max-w-full items-center gap-1">
    <span className="min-w-0 truncate">{label}</span>
    {activity}
  </span>;
}
