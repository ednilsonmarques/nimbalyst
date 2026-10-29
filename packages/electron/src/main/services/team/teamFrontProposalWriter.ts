/**
 * The only writer of approved front proposals (F1.1, M-13 ADR-2). It goes
 * through the Tracker UI funnel of the workspace's document service:
 * `createTrackerItem` and `updateTrackerItem`, NOT `createHostOwnedTrackerItem`
 * and with no `agent` or `hostOwned` flag, so the team-front rules apply to it
 * exactly as they do to the user typing in the Tracker (never more permissive
 * than the UI). It never writes `currentMission`.
 *
 * Called only by the approval executor (teamFrontProposalDecision.ts), after
 * the user's decision, under the locks the executor holds.
 */

import { TEAM_FRONT_TYPE } from '@nimbalyst/tracker-core';
import type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
import type { NativeTrackerCreatePayload } from '../tracker/createNativeTrackerItem';
import type { TeamFrontStatus } from './teamFrontProposals';

/** The id shape the Tracker UI gives a team-front: the model's `idPrefix` (team-front.yaml) and a time/random suffix. */
function newTeamFrontId(): string {
  return `tfr_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * What a write reports besides success. `syncWarning` is set when the item was
 * saved but the step that shares it with the team room failed; the save is not
 * undone and the sync is not retried (the Tracker UI's own retry-on-reconnect
 * applies, as for any item it saved).
 */
export interface TeamFrontWriteOutcome {
  syncWarning?: string;
  /**
   * Set when the save went through but a step inside the document service after it threw (an observer, an index
   * refresh). The writer then confirmed by reading the item back that it IS persisted, and reports that instead
   * of a failure; the write is never retried.
   */
  followUpWarning?: string;
}

export interface TeamFrontWriter {
  /** Create a team-front as the Tracker UI would. Returns the new item id. */
  createFront(input: { workspacePath: string; title: string; description: string; status: TeamFrontStatus }): Promise<{ id: string } & TeamFrontWriteOutcome>;
  /** Set the status of an existing team-front, refusing (before any write) anything that is not that team-front. */
  setFrontStatus(input: { workspacePath: string; frontId: string; status: TeamFrontStatus }): Promise<TeamFrontWriteOutcome>;
}

/**
 * The Tracker UI's own write steps, reused as they are (trackerItemShareGate.ts):
 * the room-size check before an update is saved, and the sync after a save.
 */
export interface TrackerWriteSteps {
  beforeWrite(): Promise<(candidate: TrackerItem) => void>;
  syncCreated(item: TrackerItem, payload: { workspace: string; type: string }): Promise<{ syncError?: unknown; shared?: boolean }>;
  syncUpdated(item: TrackerItem, markPending: (itemId: string) => Promise<unknown>): Promise<{ syncError?: unknown; shared?: boolean }>;
  /**
   * The Tracker list of the project's window, told about a change, when the write went through a temporary
   * document service (the open window's own service already notifies its window).
   */
  notifyChanged?(workspacePath: string, change: { added?: TrackerItem[]; updated?: TrackerItem[] }): Promise<void> | void;
  /** The analytics event the Tracker UI emits for the same mutation (no new event names). */
  track?(item: TrackerItem, action: 'created' | 'status_changed', shared: boolean): void;
}

/** What `withDocumentService` tells the writer about the service it lent. */
export interface DocumentServiceContext {
  /** True when no window had the project open and a throwaway service was used. */
  temporary: boolean;
}

/** Tell the project's window the Tracker changed (the shape trackerSyncListeners expects). */
export async function notifyTrackerWindowOfChange(workspacePath: string, change: { added?: TrackerItem[]; updated?: TrackerItem[] }): Promise<void> {
  const { findWindowByWorkspace } = await import('../../window/WindowManager');
  const win = findWindowByWorkspace(workspacePath);
  if (win && !win.isDestroyed()) {
    win.webContents.send('document-service:tracker-items-changed', {
      added: change.added ?? [],
      updated: change.updated ?? [],
      removed: [],
      timestamp: new Date(),
    });
  }
}

const productionSteps: TrackerWriteSteps = {
  // Loaded on demand: the share gate pulls the sync engine, which the pure parts of this module do not need.
  beforeWrite: async () => (await import('../tracker/trackerItemShareGate')).sharedTrackerItemBeforeWrite(),
  syncCreated: async (item, payload) => (await import('../tracker/trackerItemShareGate')).syncCreatedTrackerItem(item, payload),
  syncUpdated: async (item, markPending) => (await import('../tracker/trackerItemShareGate')).syncUpdatedTrackerItem(item, {}, markPending),
  notifyChanged: notifyTrackerWindowOfChange,
  track: (item, action, shared) => {
    // Loaded on demand: the document service is large and only the app's writer needs it.
    void (async () => {
      try {
        const { trackTrackerMutation } = await import('../ElectronDocumentService');
        trackTrackerMutation({ itemId: item.id, action, collaborationScope: shared ? 'shared' : 'personal', trackerType: item.type, view: 'service' });
      } catch (error) {
        console.warn('[team] Failed to record the front mutation:', error);
      }
    })();
  },
};

/** Best-effort after a save: neither the change notification nor the analytics may fail or repeat a write. */
async function afterSave(
  steps: TrackerWriteSteps,
  context: DocumentServiceContext | undefined,
  workspacePath: string,
  item: TrackerItem,
  action: 'created' | 'status_changed',
  shared: boolean | undefined,
): Promise<void> {
  try {
    steps.track?.(item, action, shared === true);
    if (context?.temporary === true && steps.notifyChanged) {
      await steps.notifyChanged(workspacePath, action === 'created' ? { added: [item] } : { updated: [item] });
    }
  } catch (error) {
    console.warn('[team] Failed to announce a front written from a proposal:', error);
  }
}

function warningOf(syncError: unknown): string | undefined {
  if (syncError === undefined) return undefined;
  const message = syncError instanceof Error ? syncError.message : String(syncError);
  return `Saved, but sharing it with the team did not complete: ${message.length > 200 ? `${message.slice(0, 200)}...` : message}`;
}

/** The part of ElectronDocumentService the writer uses (the Tracker UI funnel). */
export interface FrontDocumentService {
  createTrackerItem(payload: NativeTrackerCreatePayload): Promise<TrackerItem>;
  updateTrackerItem(
    itemId: string,
    updates: Record<string, unknown>,
    options?: { beforeWrite?: (item: TrackerItem) => void },
  ): Promise<TrackerItem>;
  updateTrackerItemSyncStatus(itemId: string, status: string): Promise<unknown>;
  /** Read an item back, to tell "the write did not happen" from "the write happened and a later step threw". */
  getTrackerItemById(itemId: string): Promise<TrackerItem | null>;
  destroy?: () => void;
}

/**
 * The write threw and the item could not be read back either, so nobody can say whether it was persisted. Not a
 * failure: the item may exist. The executor reports it as `unconfirmed` and tells the user to check the Tracker.
 */
export class TeamFrontWriteUnconfirmedError extends Error {
  constructor(readonly itemId: string, message: string) {
    super(message);
    this.name = 'TeamFrontWriteUnconfirmedError';
  }
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}...` : message;
}

/**
 * After an exception from a write: is the item persisted? `persisted` is the item as stored when `confirms` says
 * it carries our write; null when the store does not have our write (a genuine failure, the caller rethrows the
 * original error). Throws when the read-back itself fails, since then nothing can be confirmed either way.
 */
async function readBackAfterError(
  service: FrontDocumentService,
  itemId: string,
  confirms: (stored: TrackerItem) => boolean,
  original: unknown,
): Promise<TrackerItem | null> {
  let stored: TrackerItem | null;
  try {
    stored = await service.getTrackerItemById(itemId);
  } catch (readError) {
    throw new TeamFrontWriteUnconfirmedError(
      itemId,
      `The write failed with "${messageOf(original)}" and could not be confirmed (reading ${itemId} back failed: ${messageOf(readError)}). Check the Tracker before proposing it again.`,
    );
  }
  return stored && confirms(stored) ? stored : null;
}

export function buildTeamFrontWriter(
  withDocumentService: <T>(workspacePath: string, fn: (service: FrontDocumentService, context?: DocumentServiceContext) => Promise<T>) => Promise<T>,
  steps: TrackerWriteSteps = productionSteps,
): TeamFrontWriter {
  return {
    createFront: (input) =>
      withDocumentService(input.workspacePath, async (service, context) => {
        const id = newTeamFrontId();
        let item: TrackerItem;
        let followUpWarning: string | undefined;
        try {
          item = await service.createTrackerItem({
            id,
            type: TEAM_FRONT_TYPE,
            title: input.title,
            status: input.status,
            priority: 'medium',
            workspace: input.workspacePath,
            description: input.description,
          });
        } catch (error) {
          // The service inserts, then refreshes and notifies. An exception there does not mean nothing was
          // saved: read the item back by the id this writer generated. Never retry.
          const stored = await readBackAfterError(service, id, (found) => found.type === TEAM_FRONT_TYPE, error);
          if (!stored) throw error;
          item = stored;
          followUpWarning = `Saved, but a step after saving failed: ${messageOf(error)}`;
        }
        // Saved. From here nothing is retried: a sync failure is reported, not repeated.
        const extra = followUpWarning ? { followUpWarning } : {};
        try {
          const synced = await steps.syncCreated(item, { workspace: input.workspacePath, type: TEAM_FRONT_TYPE });
          const syncWarning = warningOf(synced.syncError);
          await afterSave(steps, context, input.workspacePath, item, 'created', synced.shared);
          return { id: item.id, ...extra, ...(syncWarning ? { syncWarning } : {}) };
        } catch (error) {
          await afterSave(steps, context, input.workspacePath, item, 'created', undefined);
          return { id: item.id, ...extra, syncWarning: warningOf(error) };
        }
      }),
    setFrontStatus: (input) =>
      withDocumentService(input.workspacePath, async (service, context) => {
        const room = await steps.beforeWrite();
        let item: TrackerItem;
        let followUpWarning: string | undefined;
        try {
          item = await service.updateTrackerItem(
            input.frontId,
            { status: input.status },
            {
              beforeWrite: (candidate) => {
                // The stored item must still be this team-front, as it is about to be saved.
                if (candidate.type !== TEAM_FRONT_TYPE || candidate.id !== input.frontId) {
                  throw new Error(`Item ${input.frontId} is not a team-front; its status was not changed.`);
                }
                // Then the Tracker UI's own check: a shared item its room would refuse is refused before the save.
                room(candidate);
              },
            },
          );
        } catch (error) {
          // The service updates, then indexes and notifies its observers. An exception there does not mean the
          // status was not saved: the executor only asks for a status the front does not have yet (under the front
          // lock), so a team-front that now has it carries our write. Never retry.
          const stored = await readBackAfterError(service, input.frontId, (found) => found.type === TEAM_FRONT_TYPE && found.status === input.status, error);
          if (!stored) throw error;
          item = stored;
          followUpWarning = `Saved, but a step after saving failed: ${messageOf(error)}`;
        }
        const extra = followUpWarning ? { followUpWarning } : {};
        try {
          const synced = await steps.syncUpdated(item, (itemId) => service.updateTrackerItemSyncStatus(itemId, 'pending'));
          const syncWarning = warningOf(synced.syncError);
          await afterSave(steps, context, input.workspacePath, item, 'status_changed', synced.shared);
          return { ...extra, ...(syncWarning ? { syncWarning } : {}) };
        } catch (error) {
          await afterSave(steps, context, input.workspacePath, item, 'status_changed', undefined);
          return { ...extra, syncWarning: warningOf(error) };
        }
      }),
  };
}

/** The app's writer: the open window's document service, else a temporary one. */
export const defaultTeamFrontWriter: TeamFrontWriter = buildTeamFrontWriter(async (workspacePath, fn) => {
  const { documentServices } = await import('../../window/WindowManager');
  let service = documentServices.get(workspacePath) as unknown as FrontDocumentService | undefined;
  let temporary: FrontDocumentService | null = null;
  if (!service) {
    const { ElectronDocumentService } = await import('../ElectronDocumentService');
    service = new ElectronDocumentService(workspacePath) as unknown as FrontDocumentService;
    temporary = service;
  }
  try {
    return await fn(service, { temporary: temporary !== null });
  } finally {
    temporary?.destroy?.();
  }
});
