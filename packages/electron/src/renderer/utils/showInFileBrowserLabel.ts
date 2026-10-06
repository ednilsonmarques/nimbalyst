import { getShowInFileBrowserLabel } from '@nimbalyst/runtime';
import { t } from '@nimbalyst/runtime/i18n';

const LABEL_KEYS: Record<string, string> = {
  'Show in Finder': 'menu:contextMenu.common.showInFinder',
  'Show in Explorer': 'menu:contextMenu.common.showInExplorer',
  'Show in Folder': 'menu:contextMenu.common.showInFolder',
};

/**
 * Localized "Show in Finder / Explorer / Folder" for desktop context menus.
 * The platform choice stays in runtime's getShowInFileBrowserLabel (shared with
 * the transcript bundle, which has no i18n); this only translates its result.
 * Call at render time so the current UI language is used.
 */
export function getLocalizedShowInFileBrowserLabel(platform?: string): string {
  const label = platform === undefined ? getShowInFileBrowserLabel() : getShowInFileBrowserLabel(platform);
  const key = LABEL_KEYS[label];
  return key ? t(key) : label;
}
