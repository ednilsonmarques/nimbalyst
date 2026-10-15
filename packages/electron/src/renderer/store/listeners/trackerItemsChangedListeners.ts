/**
 * Central listener for `document-service:tracker-items-changed` (IPC_LISTENERS.md):
 * installed once at startup, it bumps `trackerItemsChangedAtom` so any
 * component or widget host reacts through the store rather than through its
 * own `electronAPI.on` (NIB.35: the Tool Manifest card of SessionTranscript
 * used to subscribe from the component file).
 */
import { store } from '@nimbalyst/runtime/store';
import { trackerItemsChangedAtom } from '../atoms/trackerItemsChanged';

let version = 0;

export function initTrackerItemsChangedListeners(): () => void {
  const api = window.electronAPI;
  if (!api?.on) return () => {};
  return api.on('document-service:tracker-items-changed', (payload: unknown) => {
    version += 1;
    store.set(trackerItemsChangedAtom, { version, payload });
  });
}

/**
 * Subscribe to tracker changes through the store. Returns the unsubscribe
 * closure. The listener receives the change payload of each event.
 */
export function subscribeTrackerItemsChanged(listener: (payload: unknown) => void): () => void {
  let seen = store.get(trackerItemsChangedAtom)?.version ?? 0;
  return store.sub(trackerItemsChangedAtom, () => {
    const current = store.get(trackerItemsChangedAtom);
    if (!current || current.version === seen) return;
    seen = current.version;
    listener(current.payload);
  });
}
