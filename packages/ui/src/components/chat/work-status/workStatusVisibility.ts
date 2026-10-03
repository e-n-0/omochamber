/**
 * Fixed panel width. The panel is not user-resizable: it is an object inside
 * the chat rather than a docked pane, so it has no resizer and no persisted
 * width.
 */
export const WORK_STATUS_PANEL_WIDTH = 300;

/**
 * Minimum width the message column must keep for itself. Below this the panel
 * yields — a squeezed transcript costs more than the status it displaces.
 */
const WORK_STATUS_MIN_CHAT_WIDTH = 560;

/** The card's own horizontal margins (`ml-2` + `mr-4`). */
const WORK_STATUS_PANEL_GUTTER = 8 + 16;

/** Row width below which the panel gives its space back to the transcript. */
export const WORK_STATUS_REQUIRED_ROW_WIDTH =
  WORK_STATUS_PANEL_WIDTH + WORK_STATUS_PANEL_GUTTER + WORK_STATUS_MIN_CHAT_WIDTH;

export interface WorkStatusVisibility {
  readonly visible: boolean;
  readonly overlay: boolean;
}
