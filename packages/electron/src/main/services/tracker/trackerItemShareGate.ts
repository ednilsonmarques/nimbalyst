/**
 * Sharing an updated tracker item with its team room.
 *
 * The room refuses an item over its per-item limit, and the engine says so by
 * throwing `TrackerPayloadTooLargeError` before it queues anything. That check
 * has to run before the host saves the edit: run after, the refusal landed in
 * a catch that only logged, the row kept `synced` with nothing queued, and a
 * teammate's next edit overwrote the change.
 */
import type { TrackerItem } from '@nimbalyst/runtime';
import { encodeTrackerPayloadPlaintext, TrackerPayloadTooLargeError } from '@nimbalyst/tracker-engine';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { isTrackerSyncActive, isTrackerSyncConfigured, syncTrackerItem, trackerItemToPayload } from '../TrackerSyncManager';
import { getEffectiveTrackerSharingPolicy, shouldSyncTrackerItem } from '../TrackerPolicyService';

/**
 * Throw `TrackerPayloadTooLargeError` when `item` belongs to a workspace with a
 * tracker room and could not be sent to it. Call with the item as it is about
 * to be written, and only when that item is shared.
 */
export function assertTrackerItemFitsRoom(item: TrackerItem): void {
  if (!isTrackerSyncConfigured(item.workspace)) return;
  encodeTrackerPayloadPlaintext(trackerItemToPayload(item));
}

/**
 * The refusal for an item, as it is about to be written, that its tracker
 * shares with the team and that would not fit the room; null otherwise.
 */
export function sharedTrackerItemTooLarge(item: TrackerItem, workspacePath?: string): TrackerPayloadTooLargeError | null {
  const policy = getEffectiveTrackerSharingPolicy(workspacePath || item.workspace, item.type, globalRegistry.get(item.type));
  return shouldSyncTrackerItem(policy, item) ? trackerItemTooLargeForRoom(item) : null;
}

/** The refusal `assertTrackerItemFitsRoom` would throw, or null. Other errors propagate. */
export function trackerItemTooLargeForRoom(item: TrackerItem): TrackerPayloadTooLargeError | null {
  try {
    assertTrackerItemFitsRoom(item);
    return null;
  } catch (error) {
    if (error instanceof TrackerPayloadTooLargeError) return error;
    throw error;
  }
}

/**
 * Push a saved, shared item to its room, or mark it `pending` for the
 * reconnect drain when the room is not connected. A failure is logged and
 * not thrown: the local save has already happened. The failure is returned (not
 * thrown) so a caller that reports per item, like a front proposal's approval,
 * can say the sync did not go through; callers that ignore it behave as before.
 */
export async function pushSharedTrackerItem(
  item: TrackerItem,
  markPending: (itemId: string) => Promise<unknown>,
  logPrefix = '[DocumentService] update-tracker-item',
): Promise<unknown | undefined> {
  try {
    if (isTrackerSyncActive(item.workspace)) {
      await syncTrackerItem(item);
    } else {
      await markPending(item.id);
      // console.log(`${logPrefix} skipped: sync not active for workspace`);
    }
  } catch (syncErr) {
    console.error(`${logPrefix} sync failed:`, syncErr);
    return syncErr;
  }
  return undefined;
}

/** The sharing hints a Tracker write may carry; they only matter to the sharing policy. */
export interface TrackerSharingHints {
  sharing?: 'personal' | 'team';
  draftByDefault?: boolean;
}

/**
 * The `beforeWrite` of a tracker update: a shared item its room would refuse is
 * refused before the save. The one definition the Tracker UI's update handler
 * and a front proposal's approval both use.
 */
export function sharedTrackerItemBeforeWrite(hints: TrackerSharingHints = {}): (candidate: TrackerItem) => void {
  return (candidate) => {
    if (shouldSyncTrackerItem(getEffectiveTrackerSharingPolicy(candidate.workspace, candidate.type, hints), candidate)) {
      assertTrackerItemFitsRoom(candidate);
    }
  };
}

export interface TrackerPostWriteResult {
  /** Whether the item is shared with the team under its sharing policy. */
  shared: boolean;
  /** Set when the sync step failed after the save (never thrown, never retried here). */
  syncError?: unknown;
}

/**
 * After a Tracker UI creation: sync the new item when it is shared and the room
 * is connected. `skipSync` is the retryable-creation path, which publishes
 * through its own resume machinery. Shared by the creation IPC handler and a
 * front proposal's approval.
 */
export async function syncCreatedTrackerItem(
  item: TrackerItem,
  payload: TrackerSharingHints & { workspace: string; type: string },
  options: { skipSync?: boolean } = {},
): Promise<TrackerPostWriteResult> {
  const policy = getEffectiveTrackerSharingPolicy(payload.workspace, payload.type, payload);
  let syncError: unknown;
  if (!options.skipSync && shouldSyncTrackerItem(policy, item) && isTrackerSyncActive(payload.workspace)) {
    try {
      await syncTrackerItem(item);
    } catch (error) {
      console.error('[TrackerCreation] Metadata sync failed:', error);
      syncError = error;
    }
  }
  return { shared: shouldSyncTrackerItem(policy, item), ...(syncError !== undefined ? { syncError } : {}) };
}

/**
 * After a Tracker UI update: push the saved item to its room (or mark it pending)
 * when it is shared. Shared by the update IPC handler and a front proposal's approval.
 */
export async function syncUpdatedTrackerItem(
  item: TrackerItem,
  hints: TrackerSharingHints,
  markPending: (itemId: string) => Promise<unknown>,
): Promise<TrackerPostWriteResult> {
  const policy = getEffectiveTrackerSharingPolicy(item.workspace, item.type, hints);
  if (!shouldSyncTrackerItem(policy, item)) return { shared: false };
  const syncError = await pushSharedTrackerItem(item, markPending);
  return { shared: true, ...(syncError !== undefined ? { syncError } : {}) };
}
