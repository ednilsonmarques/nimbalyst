/**
 * Saves every dirty tab and reports whether all of them are actually saved (NIB.97, B2/A3/A4).
 *
 * What "saved" means here (see resultado.md, "contrato de salvar"):
 *  - the per-tab save functions resolve without a value and swallow refusals ("manual save held"),
 *    so resolving proves nothing;
 *  - TabEditor clears the dirty flag as soon as the write succeeds, WITHOUT comparing the buffer to
 *    the content that was written, so text typed while the write was in flight leaves the flag clear
 *    with an unsaved revision;
 *  - therefore a tab counts as saved only if its dirty flag is clear AND, when both are plain text,
 *    the tab's current content equals the last content persisted for its file. If the revision
 *    differs, the save is attempted again (bounded); if it still differs, the tab is failed.
 * Each save is bounded in time so a save that never resolves fails safe. Collab tabs with changes the
 * server has not confirmed cannot be "saved" and count as failed.
 */
export interface SaveAllTab {
  id: string;
  filePath?: string | null;
  fileName?: string | null;
}

export interface SaveAllDeps {
  listTabs(): SaveAllTab[];
  isDirty(filePath: string): boolean;
  isCollabUnsynced(filePath: string): boolean;
  saveTabById(tabId: string): Promise<void>;
  /** The tab's current content, when it can be read as text. */
  getContent?(tabId: string): string | null | undefined;
  /** The content last persisted for the file, when known as text. */
  getPersistedContent?(filePath: string): string | null | undefined;
  /** Upper bound for one save call. Default 15 000 ms. */
  perTabTimeoutMs?: number;
  /** How many times a tab is saved again when its revision is still not the persisted one. Default 1. */
  maxResaves?: number;
  /**
   * Marks the tab dirty again. Called for a tab that failed verification after its dirty flag had already
   * cleared: its revision is not on disk, so it must keep blocking a close (and the window must keep reporting
   * unsaved changes) until the current revision is saved or explicitly discarded.
   */
  markDirty?(filePath: string): void;
  /** How long to wait for the dirty flag / persisted content to settle after a save resolves. */
  settleTimeoutMs?: number;
  pollMs?: number;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

export interface SaveAllResult {
  ok: boolean;
  /** Display names of the tabs that are not saved. */
  failed: string[];
  /** The subset of `failed` whose save did not finish in time. */
  timedOut: string[];
  /** Slowest single revision check, in ms (reading the content of a large document is not free). */
  maxCheckCostMs: number;
}

class SaveTimeout extends Error {}

function labelOf(tab: SaveAllTab): string {
  if (tab.fileName) return tab.fileName;
  const path = tab.filePath ?? tab.id;
  return path.split(/[\\/]/).pop() || path;
}

export async function saveAllDirtyTabs(deps: SaveAllDeps): Promise<SaveAllResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());
  const settleTimeoutMs = deps.settleTimeoutMs ?? 1500;
  const pollMs = deps.pollMs ?? 50;
  const perTabTimeoutMs = deps.perTabTimeoutMs ?? 15000;
  const maxResaves = deps.maxResaves ?? 1;

  const isSaved = (tab: SaveAllTab): boolean => {
    const filePath = tab.filePath as string;
    if (deps.isDirty(filePath)) return false;
    const current = deps.getContent?.(tab.id);
    const persisted = deps.getPersistedContent?.(filePath);
    // Both known as text: the persisted revision must be the current one. Unknown (custom/binary
    // editors): the flag is all there is.
    if (typeof current === 'string' && typeof persisted === 'string' && current !== persisted) return false;
    return true;
  };

  let lastCheckCostMs = 0;
  let maxCheckCostMs = 0;
  const timedIsSaved = (tab: SaveAllTab): boolean => {
    const started = now();
    const saved = isSaved(tab);
    lastCheckCostMs = now() - started;
    maxCheckCostMs = Math.max(maxCheckCostMs, lastCheckCostMs);
    return saved;
  };

  const saveWithTimeout = (tab: SaveAllTab): Promise<void> => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SaveTimeout(labelOf(tab))), perTabTimeoutMs);
    deps.saveTabById(tab.id).then(
      () => { clearTimeout(timer); resolve(); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

  const pending = deps.listTabs().filter((tab) => tab.filePath && (deps.isDirty(tab.filePath) || deps.isCollabUnsynced(tab.filePath)));
  const failedIds = new Set<string>();
  const timedOutIds = new Set<string>();

  for (const tab of pending) {
    if (deps.isCollabUnsynced(tab.filePath as string)) {
      failedIds.add(tab.id);
      continue;
    }
    for (let attempt = 0; attempt <= maxResaves; attempt++) {
      try {
        await saveWithTimeout(tab);
      } catch (error) {
        failedIds.add(tab.id);
        if (error instanceof SaveTimeout) timedOutIds.add(tab.id);
        break;
      }
      // Let the dirty flag / persisted revision settle, then check that THIS revision is the saved one.
      const deadline = now() + settleTimeoutMs;
      let saved = timedIsSaved(tab);
      while (!saved && now() < deadline) {
        // Back off with the measured cost of the check: reading the content of a large document is not free.
        await sleep(Math.max(pollMs, lastCheckCostMs * 4));
        saved = timedIsSaved(tab);
      }
      if (saved) break;
      if (attempt === maxResaves) failedIds.add(tab.id);
    }
  }

  // A tab that failed while its dirty flag is clear (the write cleared it, but the revision check did not pass)
  // must not look clean: restore the blocking state.
  for (const tab of pending) {
    if (failedIds.has(tab.id) && !deps.isDirty(tab.filePath as string) && !deps.isCollabUnsynced(tab.filePath as string)) {
      deps.markDirty?.(tab.filePath as string);
    }
  }

  const failed = pending.filter((tab) => failedIds.has(tab.id)).map(labelOf);
  const timedOut = pending.filter((tab) => timedOutIds.has(tab.id)).map(labelOf);
  return { ok: failed.length === 0, failed, timedOut, maxCheckCostMs };
}
