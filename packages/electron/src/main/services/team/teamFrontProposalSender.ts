/**
 * Who is asking, for the front proposal IPC (F1.1). The decision of a proposal
 * is the user's click, so the handler accepts only an event that really came
 * from a renderer: it must carry a sender and a frame, the frame must be the
 * top frame (a subframe of an app window is not the app), and the workspace the
 * request acts on is the one the HOST knows the sender window shows, never one
 * the payload names.
 *
 * Events with no sender (the main process feeding a handler with
 * `ipcMain.emit(channel, null, ...)`) are refused here even though the IPC
 * registry lets them through: nothing in the main process may settle a card.
 */

export interface ProposalIpcEvent {
  sender?: unknown;
  senderFrame?: { parent?: unknown } | null;
}

export interface ProposalSenderDeps {
  /**
   * The workspace(s) the sender window has open, from host state, the active one
   * first; null or empty when unknown. A multi-project window can show a root of a
   * project that is not its active one, so the root's workspace is matched against
   * all of them; each comes from the host, none from the payload.
   */
  workspaceOfSender: (sender: unknown) => Promise<string | string[] | null> | string | string[] | null;
}

export type ProposalSenderResult =
  | { ok: true; workspacePath: string; workspacePaths: string[] }
  | { ok: false; reason: 'no-sender' | 'no-frame' | 'subframe' | 'unknown-workspace' };

export async function resolveProposalSender(event: unknown, deps: ProposalSenderDeps): Promise<ProposalSenderResult> {
  const e = event as ProposalIpcEvent | null | undefined;
  if (!e || typeof e !== 'object' || !e.sender) return { ok: false, reason: 'no-sender' };
  const frame = e.senderFrame;
  if (!frame || typeof frame !== 'object') return { ok: false, reason: 'no-frame' };
  if (frame.parent) return { ok: false, reason: 'subframe' };
  const found = await deps.workspaceOfSender(e.sender);
  const workspacePaths = [...new Set((Array.isArray(found) ? found : [found]).filter((p): p is string => typeof p === 'string' && p.length > 0))];
  if (workspacePaths.length === 0) return { ok: false, reason: 'unknown-workspace' };
  return { ok: true, workspacePath: workspacePaths[0], workspacePaths };
}

/**
 * The projects a window has open, from its state: the one it shows first, then its primary and the
 * project rail's additional ones (not attached folders, which are not projects). Empty when the window
 * has no document-service workspace (wrong mode), which refuses.
 */
export function openProjectsOfWindow(
  state: { workspacePath?: string | null; additionalWorkspacePaths?: string[] } | undefined,
  active: string | null,
): string[] {
  if (!state || !active) return [];
  return [...new Set([active, state.workspacePath, ...(state.additionalWorkspacePaths ?? [])].filter((p): p is string => typeof p === 'string' && p.length > 0))];
}

/** The production lookup: the app window of the sender and the projects it has open (its active one first). */
export async function productionWorkspaceOfSender(sender: unknown): Promise<string[] | null> {
  const { BrowserWindow } = await import('electron');
  const { getWindowIdForWindow, resolveDocumentServicePath, windowStates } = await import('../../window/windowState');
  const webContents = sender as import('electron').WebContents;
  if (!webContents || webContents.isDestroyed?.()) return null;
  const window = BrowserWindow.fromWebContents(webContents);
  const windowId = getWindowIdForWindow(window);
  if (windowId === null) return null;
  const state = windowStates.get(windowId);
  return openProjectsOfWindow(state, resolveDocumentServicePath(state));
}
