/**
 * Electron-facing half of the IPC sender policy (NIB.85 stage d1). The decision
 * itself is the pure `decideIpcSender`; this adapts an IPC event to its input.
 */

import { BrowserWindow } from 'electron';
import type { WebContents, WebFrameMain } from 'electron';

import { decideIpcSender, type AppOriginConfig } from './navigationPolicy';
import type { IpcSenderValidator } from '../utils/ipcRegistry';

interface IpcLikeEvent {
  sender?: WebContents;
  senderFrame?: WebFrameMain | null;
}

/**
 * A top frame has no parent. `sender.mainFrame` is not used for this: during a
 * reload the sender's `mainFrame` can still be the previous document's frame
 * while the new document's top frame is already sending (seen at run time as a
 * false "subframe" on workspace:get-state), so comparing against it rejects the
 * app's own startup calls.
 */
function isTopFrame(frame: WebFrameMain): boolean {
  return !frame.parent;
}

export function createIpcSenderValidator(cfg: AppOriginConfig): IpcSenderValidator {
  return (event) => {
    // The main process feeds its own handlers through ipcMain.emit(channel, null | {}, ...)
    // (WindowManager's console-log mirror, ask-user-question answers, prompt responses).
    // Those events have no sender: they never came from a renderer, so there is nothing
    // to validate. A renderer event always carries `sender`.
    if (!event || typeof event !== 'object' || !(event as IpcLikeEvent).sender) return { allowed: true };
    const e = event as IpcLikeEvent;
    const sender = e.sender;
    const frame = e.senderFrame ?? null;
    const inAppWindow = !!sender && !sender.isDestroyed() && !!BrowserWindow.fromWebContents(sender);
    return decideIpcSender(
      {
        hasFrame: !!frame,
        isTopFrame: !!frame && isTopFrame(frame),
        inAppWindow,
        frameUrl: frame ? frame.url : '',
      },
      cfg,
    );
  };
}
