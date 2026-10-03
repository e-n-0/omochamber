import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusFrame } from './WorkStatusFrame';
import { WorkStatusGoalRow } from './WorkStatusGoalRow';
import { WorkStatusPrimaryGroup } from './WorkStatusPrimaryGroup';
import { WorkStatusUsageSection } from './WorkStatusUsageSection';
import { WorkStatusTelemetrySection } from './WorkStatusTelemetrySection';
import { WorkStatusSubagentsSection } from './WorkStatusSubagentsSection';
import { WorkStatusMcpSection } from './WorkStatusMcpSection';
import { WorkStatusPinnedSection } from './WorkStatusPinnedSection';
import { WorkStatusContextSection } from './WorkStatusContextSection';
import { WorkStatusSectionsDialog } from './WorkStatusSectionsDialog';
import { WorkStatusExtensionSection } from './WorkStatusExtensionSection';
import {
  areAllWorkStatusSectionsHidden,
  isExtensionSectionId,
  isWorkStatusSectionVisible,
  resolveWorkStatusSectionOrder,
  type WorkStatusSectionId,
} from './sections';
import { useWorkStatusExtensionSections } from './useWorkStatusExtensionSections';
import { WorkStatusPresenceProvider } from './presence';
import { Icon } from '@/components/icon/Icon';

type Props = {
  /** Null on a new-session draft: repository readouts still apply. */
  sessionId: string | null;
  directory: string | null;
  /** Managed Chats have no project repository, even if another project remains active. */
  repositoryEnabled?: boolean;
  /** Whether the panel should currently occupy space. */
  visible: boolean;
  /**
   * Floats over the transcript instead of sitting beside it, for when the chat
   * is too narrow to give it a column of its own.
   */
  overlay?: boolean;
};

/**
 * Matches the context panel's own width animation exactly.
 *
 * The two are siblings of the transcript, and opening the context panel hides
 * this one. With an instant unmount the chat first jumped wider (this panel
 * gone) and then eased narrower (the context panel expanding) — two opposite
 * width changes in a row, which reads as a flutter. Collapsing on the same
 * curve and duration makes the chat's width move once, in one direction.
 */

/**
 * Work-status panel: a card inside the chat column reporting the state of the
 * session, its branch and its subagents.
 *
 * Sections follow the user's saved order. Each section renders
 * nothing when it has nothing, so the panel collapses toward the top instead of
 * reserving empty space.
 *
 * The card clips; the scroller lives inside it, so the same top/bottom scroll
 * shadows the transcript uses stay within the rounded border instead of
 * bleeding past it. The scrollbar itself is hidden — at this width it would
 * eat a visible slice of every row's trailing value, and the shadows already
 * say there is more to see.
 */
export const WorkStatusPanel: React.FC<Props> = ({ sessionId, directory, visible, repositoryEnabled = true, overlay = false }) => {
  const { t } = useI18n();
  const setScrollTop = useUIStore((state) => state.setWorkStatusScrollTop);
  const setOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);
  const hiddenSections = useUIStore((state) => state.workStatusHiddenSections);
  const storedOrder = useUIStore((state) => state.workStatusSectionOrder);
  const extensionSections = useWorkStatusExtensionSections();
  const sectionOrder = React.useMemo(
    () => resolveWorkStatusSectionOrder(storedOrder, extensionSections.ids),
    [extensionSections.ids, storedOrder],
  );
  const [sectionsDialogOpen, setSectionsDialogOpen] = React.useState(false);
  // Starts optimistic: sections report after their first commit, and rendering
  // nothing on the way in would make the card flash out and back on arrival.
  const [renderedSections, setRenderedSections] = React.useState(1);
  const sectionVisible = React.useCallback(
    (sectionId: Parameters<typeof isWorkStatusSectionVisible>[1]) =>
      isWorkStatusSectionVisible(hiddenSections, sectionId),
    [hiddenSections],
  );
  const allSectionsHidden = areAllWorkStatusSectionsHidden(hiddenSections, extensionSections.ids);

  const getScrollTop = React.useCallback(() => useUIStore.getState().workStatusScrollTop, []);
  const dismissOverlay = React.useCallback(() => setOverlayOpen(false), [setOverlayOpen]);

  // Keep these elements owned by the panel so primary readout updates do not
  // rerender unrelated sections through the composition callback.
  const secondarySections = {
    usage: <WorkStatusUsageSection />,
    telemetry: <WorkStatusTelemetrySection sessionId={sessionId} directory={directory} />,
    subagents: <WorkStatusSubagentsSection sessionId={sessionId} directory={directory} />,
    mcp: <WorkStatusMcpSection directory={directory} />,
    pinned: <WorkStatusPinnedSection sessionId={sessionId} directory={directory} />,
    contextSources: <WorkStatusContextSection sessionId={sessionId} directory={directory} />,
  } satisfies Record<Exclude<WorkStatusSectionId, 'session' | 'repository'>, React.ReactNode>;

  return (
    <WorkStatusFrame
      sessionKey={sessionId}
      visible={visible}
      interactive={visible && (renderedSections > 0 || allSectionsHidden)}
      overlay={overlay}
      getScrollTop={getScrollTop}
      onScrollTopChange={setScrollTop}
      onDismiss={dismissOverlay}
      dismissDisabled={sectionsDialogOpen}
      headerAction={
      <button
        type="button"
        aria-label={t('chat.workStatus.sections.open')}
        onClick={() => setSectionsDialogOpen(true)}
        className="absolute right-2 top-1.5 z-10 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon name="equalizer-2" className="size-4" />
      </button>
      }
footer={      allSectionsHidden ? (
        <div className="flex flex-col items-center justify-center px-4 py-8 text-center">
          <span className="text-sm text-muted-foreground">{t('chat.workStatus.sections.allHidden')}</span>
          <Button
            variant="link"
            size="xs"
            onClick={() => setSectionsDialogOpen(true)}
            className="mt-2 normal-case text-muted-foreground hover:text-foreground"
          >
            {t('chat.workStatus.sections.open')}
          </Button>
        </div>
       ) : null}
      dialog={<WorkStatusSectionsDialog open={sectionsDialogOpen} onOpenChange={setSectionsDialogOpen} />}
    >
      <WorkStatusPresenceProvider onChange={setRenderedSections}>
        <WorkStatusPrimaryGroup
          sessionId={sessionId}
          directory={directory}
          showSession={sectionVisible('session')}
          showRepository={repositoryEnabled && sectionVisible('repository')}
          goalRow={<WorkStatusGoalRow sessionId={sessionId} directory={directory} />}
        >
          {(primary) => sectionOrder.map((id) => {
            if (!sectionVisible(id)) return null;
            if (isExtensionSectionId(id)) {
              const guest = extensionSections.byId.get(id);
              return guest ? <WorkStatusExtensionSection key={id} guest={guest} /> : null;
            }
            return <React.Fragment key={id}>{id === 'session' || id === 'repository' ? primary[id] : secondarySections[id]}</React.Fragment>;
          })}
        </WorkStatusPrimaryGroup>

      </WorkStatusPresenceProvider>
    </WorkStatusFrame>
  );
};
