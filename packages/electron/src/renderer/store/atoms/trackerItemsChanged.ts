import { atom } from 'jotai';

/**
 * Request atom bumped by the central listener of
 * `document-service:tracker-items-changed` (store/listeners/trackerItemsChangedListeners.ts).
 * Components and widget hosts that must react to a tracker change subscribe
 * to this atom (store.sub / useAtomValue) instead of to the IPC channel, per
 * docs/IPC_LISTENERS.md: the subscription to Electron lives in one sanctioned
 * place, installed once. `payload` is the raw change event as the main process
 * sent it; `version` increases on every event so equal payloads still notify.
 */
export interface TrackerItemsChangedRequest {
  version: number;
  payload: unknown;
}

export const trackerItemsChangedAtom = atom<TrackerItemsChangedRequest | null>(null);
