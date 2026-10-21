import { editorDirtyAtom, makeEditorKey } from '@nimbalyst/runtime/store';
import { isCollabUri } from '@nimbalyst/collab-protocol';
import { collabConnectionStatusAtom, hasCollabUnsyncedChanges } from '../store/atoms/collabEditor';

/**
 * Tells the main process whether the window has unsaved changes (NIB.97, N2). The main process reads
 * that report when the user closes the window, so it has to know before the user can close: a dirty
 * change is reported immediately (subscription on each tab's dirty atom), and `sync()` is kept as a
 * periodic backstop that also re-attaches the subscriptions when the tabs change.
 */
export interface TabsActionsLike {
  getSnapshot(): { tabOrder: string[]; tabs: Map<string, { filePath?: string | null }> };
  subscribe(listener: () => void): () => void;
}

export interface StoreLike {
  get(atom: any): any;
  sub(atom: any, listener: () => void): () => void;
}

export interface DocumentEditedSyncDeps {
  getTabsActions(): TabsActionsLike | null | undefined;
  store: StoreLike;
  report(edited: boolean): void;
}

export function createDocumentEditedSync(deps: DocumentEditedSyncDeps) {
  let attachedTo: TabsActionsLike | null = null;
  let unsubTabs: (() => void) | null = null;
  let unsubAtoms: Array<() => void> = [];

  const tabsOf = (actions: TabsActionsLike | null | undefined) => {
    const snapshot = actions?.getSnapshot?.();
    return snapshot ? snapshot.tabOrder.map((id) => snapshot.tabs.get(id)).filter(Boolean) as Array<{ filePath?: string | null }> : [];
  };

  const compute = (): boolean => tabsOf(attachedTo).some((tab) => {
    if (!tab.filePath) return false;
    if (deps.store.get(editorDirtyAtom(makeEditorKey(tab.filePath)))) return true;
    if (!isCollabUri(tab.filePath)) return false;
    return hasCollabUnsyncedChanges(deps.store.get(collabConnectionStatusAtom(tab.filePath)));
  });

  // Always report, never only on a change: the main process clears its flag on every save of ANY file
  // (save-file), which can happen while another tab is still dirty. Re-asserting after each dirty change
  // (the flag of the saved tab clears after the save returns) puts the main process back in sync.
  const reportCurrentState = () => {
    deps.report(compute());
  };

  const attachAtoms = () => {
    unsubAtoms.forEach((unsub) => unsub());
    unsubAtoms = [];
    for (const tab of tabsOf(attachedTo)) {
      if (!tab.filePath) continue;
      unsubAtoms.push(deps.store.sub(editorDirtyAtom(makeEditorKey(tab.filePath)), reportCurrentState));
      if (isCollabUri(tab.filePath)) {
        unsubAtoms.push(deps.store.sub(collabConnectionStatusAtom(tab.filePath), reportCurrentState));
      }
    }
  };

  const attach = (actions: TabsActionsLike | null | undefined) => {
    if (actions === attachedTo) return;
    unsubTabs?.();
    unsubTabs = null;
    attachedTo = actions ?? null;
    attachAtoms();
    if (attachedTo) {
      unsubTabs = attachedTo.subscribe(() => {
        attachAtoms();
        reportCurrentState();
      });
    }
  };

  return {
    /** Backstop: re-attach if the tabs actions changed, and report the current state every time. */
    sync() {
      attach(deps.getTabsActions());
      deps.report(compute());
    },
    dispose() {
      unsubTabs?.();
      unsubAtoms.forEach((unsub) => unsub());
      unsubTabs = null;
      unsubAtoms = [];
      attachedTo = null;
    },
  };
}
