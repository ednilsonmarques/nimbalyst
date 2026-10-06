import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { t as translate } from '@nimbalyst/runtime/i18n';
import type {
  DocumentSyncStatus,
  LocalDocumentReplicaOutboxState,
  LocalDocumentReplicaState,
} from '@nimbalyst/runtime/sync';

export interface CollabDocumentState {
  /**
   * Omitted for transport-only documents such as tracker bodies, which share
   * the DocumentRoom protocol but do not own a LocalDocumentReplica.
   */
  replica?: LocalDocumentReplicaState;
  transport: DocumentSyncStatus;
  outbox: LocalDocumentReplicaOutboxState;
  /**
   * A remote update reached this client and was applied to the Y.Doc, but the
   * editor binding threw while rendering it. The socket stays open and presence
   * keeps flowing, so without this flag the document reports itself fully
   * synced while silently showing stale content.
   */
  renderFailed?: boolean;
}

export type CollabProductStatusKind =
  | 'opening-local-copy'
  | 'connecting'
  | 'synced'
  | 'offline-safe'
  | 'replaying'
  | 'access-changed'
  | 'not-receiving-changes'
  | 'local-copy-damaged'
  | 'local-saving-unavailable';

export interface CollabProductStatus {
  kind: CollabProductStatusKind;
  label: string;
  detail: string | null;
  severity: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  showPresence: boolean;
  showRejectedActions: boolean;
}

export const DEFAULT_COLLAB_DOCUMENT_STATE: CollabDocumentState = {
  replica: 'loading',
  transport: 'disconnected',
  outbox: 'clean',
};

export function deriveCollabProductStatus(
  state: CollabDocumentState,
): CollabProductStatus {
  if (state.replica === 'corrupt') {
    return {
      kind: 'local-copy-damaged',
      label: 'Local copy damaged — downloading a clean copy',
      detail: 'The damaged local replica was quarantined. A complete copy will be downloaded when the server is reachable.',
      severity: 'error',
      showPresence: false,
      showRejectedActions: state.outbox === 'rejected',
    };
  }
  if (state.replica === 'unavailable') {
    return {
      kind: 'local-saving-unavailable',
      label: 'Changes are not saved locally',
      detail: 'Local persistence is unavailable. Keep this document open and reconnect before closing it.',
      severity: 'error',
      showPresence: state.transport === 'connected',
      showRejectedActions: state.outbox === 'rejected',
    };
  }
  if (state.replica === 'loading') {
    return {
      kind: 'opening-local-copy',
      label: 'Opening local copy…',
      detail: null,
      severity: 'neutral',
      showPresence: false,
      showRejectedActions: state.outbox === 'rejected',
    };
  }
  if (state.outbox === 'rejected') {
    return {
      kind: 'access-changed',
      label: 'Access changed — local edits have not been uploaded',
      detail: 'Copy the current document before discarding this local copy.',
      severity: 'error',
      showPresence: false,
      showRejectedActions: true,
    };
  }
  // Must outrank the connected/'Synced' branch below. A binding failure leaves
  // the socket healthy and the outbox clean, so every remaining check would
  // report this document as fully synced while it silently stops showing other
  // people's edits, which is the exact way this failure goes unnoticed.
  if (state.renderFailed) {
    return {
      kind: 'not-receiving-changes',
      label: 'Not showing other people’s changes',
      detail: 'Edits from collaborators are arriving but cannot be displayed. Reopen this document; if it persists, avoid editing to prevent conflicting with changes you cannot see.',
      severity: 'error',
      showPresence: state.transport === 'connected',
      showRejectedActions: false,
    };
  }
  // Any outbox work while connected is normal in-flight typing: every
  // keystroke walks the outbox clean -> pending -> in-flight -> clean, and
  // in-flight reports as outbox 'replaying'. Surfacing either state
  // flip-flopped the pill between "Synced" and "Syncing…" and unmounted the
  // presence avatars on every character. A genuine post-reconnect backlog is
  // reported by the transport itself as 'replaying' (the provider only
  // surfaces that status when the replay started from a non-connected
  // socket), so the connected check has to come first.
  if (state.transport === 'connected') {
    return {
      kind: 'synced',
      label: 'Synced',
      detail: null,
      severity: 'success',
      showPresence: true,
      showRejectedActions: false,
    };
  }
  if (state.outbox === 'replaying' || state.transport === 'replaying') {
    return {
      kind: 'replaying',
      label: 'Syncing offline changes…',
      detail: null,
      severity: 'info',
      showPresence: false,
      showRejectedActions: false,
    };
  }
  if (state.transport === 'connecting' || state.transport === 'syncing') {
    return {
      kind: 'connecting',
      label: 'Connecting…',
      detail: null,
      severity: 'info',
      showPresence: false,
      showRejectedActions: false,
    };
  }
  return {
    kind: 'offline-safe',
    label: state.replica === undefined
      ? 'Offline'
      : 'Offline — changes saved on this device',
    detail: state.replica === undefined
      ? 'Reconnect to continue syncing this tracker body.'
      : 'Offline changes are saved locally and shared with other open windows on this device.',
    severity: 'warning',
    showPresence: false,
    showRejectedActions: false,
  };
}

/**
 * Display-only translation of a product status. `label`/`detail` stay in
 * English on the status object (tests and logic read them); views call this
 * right before rendering so the text follows the UI language.
 */
const COLLAB_STATUS_TEXT_KEYS: Record<string, string> = {
  'Local copy damaged — downloading a clean copy': 'team:collabStatus.localCopyDamaged.label',
  'The damaged local replica was quarantined. A complete copy will be downloaded when the server is reachable.': 'team:collabStatus.localCopyDamaged.detail',
  'Changes are not saved locally': 'team:collabStatus.localSavingUnavailable.label',
  'Local persistence is unavailable. Keep this document open and reconnect before closing it.': 'team:collabStatus.localSavingUnavailable.detail',
  'Opening local copy…': 'team:collabStatus.openingLocalCopy',
  'Access changed — local edits have not been uploaded': 'team:collabStatus.accessChanged.label',
  'Copy the current document before discarding this local copy.': 'team:collabStatus.accessChanged.detail',
  'Not showing other people’s changes': 'team:collabStatus.notReceivingChanges.label',
  'Edits from collaborators are arriving but cannot be displayed. Reopen this document; if it persists, avoid editing to prevent conflicting with changes you cannot see.': 'team:collabStatus.notReceivingChanges.detail',
  'Synced': 'team:collabStatus.synced',
  'Syncing offline changes…': 'team:collabStatus.replaying',
  'Connecting…': 'team:collabStatus.connecting',
  'Offline': 'team:collabStatus.offline.label',
  'Reconnect to continue syncing this tracker body.': 'team:collabStatus.offline.detail',
  'Offline — changes saved on this device': 'team:collabStatus.offlineSafe.label',
  'Offline changes are saved locally and shared with other open windows on this device.': 'team:collabStatus.offlineSafe.detail',
};

function localizeCollabStatusText(text: string): string {
  const key = COLLAB_STATUS_TEXT_KEYS[text];
  return key ? translate(key) : text;
}

export function localizeCollabProductStatus(status: CollabProductStatus): CollabProductStatus {
  return {
    ...status,
    label: localizeCollabStatusText(status.label),
    detail: status.detail === null ? null : localizeCollabStatusText(status.detail),
  };
}

export function deriveLegacyDocumentSyncStatus(
  state: CollabDocumentState,
): DocumentSyncStatus {
  if (state.outbox === 'rejected') return 'offline-unsynced';
  if (state.outbox === 'replaying') return 'replaying';
  if (state.outbox === 'pending') {
    return state.transport === 'connected' ? 'replaying' : 'offline-unsynced';
  }
  return state.transport;
}

/** Authoritative three-dimensional state per collaborative document. */
export const collabDocumentStateAtom = atomFamily(
  (_uri: string) => atom<CollabDocumentState>(DEFAULT_COLLAB_DOCUMENT_STATE)
);

export const collabProductStatusAtom = atomFamily(
  (uri: string) => atom((get) => deriveCollabProductStatus(get(collabDocumentStateAtom(uri))))
);

/** Legacy single transport view for surfaces not yet migrated. */
export const collabConnectionStatusAtom = atomFamily(
  (uri: string) => atom(
    (get) => deriveLegacyDocumentSyncStatus(get(collabDocumentStateAtom(uri))),
    (get, set, transport: DocumentSyncStatus) => {
      set(collabDocumentStateAtom(uri), {
        ...get(collabDocumentStateAtom(uri)),
        transport,
      });
    },
  )
);

export interface RemoteUser {
  name: string;
  color: string;
}

/** Remote user awareness per collab document. */
export const collabAwarenessAtom = atomFamily(
  (_uri: string) => atom<Map<string, RemoteUser>>(new Map())
);

export function hasCollabUnsyncedChanges(status: DocumentSyncStatus): boolean {
  return status === 'offline-unsynced' || status === 'replaying';
}
