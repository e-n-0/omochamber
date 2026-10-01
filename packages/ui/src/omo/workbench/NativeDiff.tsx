import React from 'react';
import { MultiFileDiff } from '@pierre/diffs/react';
import type { FileDiffOptions } from '@pierre/diffs';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';

/** Local review has no session comment controller or legacy sync dependency. */
export function NativeDiff({ original, modified, fileName }: {
  readonly original: string;
  readonly modified: string;
  readonly fileName: string;
}) {
  const { currentTheme } = useThemeSystem();
  const options = React.useMemo<FileDiffOptions<undefined>>(() => {
    ensurePierreThemeRegistered(currentTheme);
    return {
      theme: currentTheme.metadata.id,
      themeType: currentTheme.metadata.variant,
      diffStyle: 'unified',
      overflow: 'wrap',
      disableFileHeader: true,
      unsafeCSS: `
        :host, pre, [data-code] {
          font-family: var(--font-mono);
          font-size: var(--text-code);
        }
      `,
    };
  }, [currentTheme]);
  return <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="omo-diff-content">
    <MultiFileDiff oldFile={{ name: fileName, contents: original, lang: 'text' }}
      newFile={{ name: fileName, contents: modified, lang: 'text' }} options={options} />
  </div>;
}
