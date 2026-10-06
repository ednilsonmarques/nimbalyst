/**
 * The document view's right-panel surfaces, in one place: the panel renders
 * them, the window top bar's split button lists them.
 *
 * Kept out of `TrackerDocumentPanel` so WindowTopBar doesn't drag the whole
 * chat stack in behind a list of two labels.
 */

import type { TrackerDocumentPanelMode } from '../../store/atoms/trackers';

export interface TrackerDocumentPanelModeOption {
  id: TrackerDocumentPanelMode;
  label: string;
  /** i18n key (tracker namespace) for `label`; `label` stays the English source. */
  labelKey: string;
  icon: string;
}

export const TRACKER_DOCUMENT_PANEL_MODES: readonly TrackerDocumentPanelModeOption[] = [
  { id: 'chat', label: 'Chat about this item', labelKey: 'document.panel.chat', icon: 'forum' },
  { id: 'discussion', label: 'Discussion', labelKey: 'document.panel.discussion', icon: 'chat' },
];
