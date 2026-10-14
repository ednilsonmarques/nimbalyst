/**
 * Opens a tracker item in the app's Tracker view.
 *
 * The same window event the Tracker panels and the tracker tool widget
 * dispatch; the Electron renderer (App.tsx) listens for it and shows the item
 * in the existing Tracker surface. On a host without that listener it is a
 * no-op: nothing here fetches or renders the item.
 */
export const TRACKER_ITEM_NAVIGATION_EVENT = 'nimbalyst:navigate-tracker-item';

export function navigateToTrackerItem(itemId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(TRACKER_ITEM_NAVIGATION_EVENT, { detail: { itemId } }));
}
