/**
 * Closing a window that has unsaved changes (NIB.97, reviewer 5b9e8749).
 *
 * Kept out of WindowManager so the decisions can be tested without a window:
 *  - the confirmation listener and the cleanup listener share one ordering contract: the cleanup
 *    (state removal, session save) runs only when the close actually proceeds;
 *  - "Save" closes the window only when the renderer reports that every dirty tab was saved AND the
 *    window no longer reports unsaved changes; anything else keeps the window open;
 *  - the native prompt for a reload (or close) that the page's beforeunload blocked.
 * Closing goes through `window.close()` (never `destroy()`) so the normal close cleanup runs.
 */
import type { MessageBoxSyncOptions } from 'electron';
import { t } from '@nimbalyst/runtime/i18n';
import type { WindowState } from '../types';

export interface CloseEventLike {
  preventDefault(): void;
  readonly defaultPrevented: boolean;
}

export interface CloseWindowLike {
  on(event: 'close' | 'closed', listener: (event: CloseEventLike) => void): unknown;
  close(): void;
  isDestroyed(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

/** Windows whose close the user already decided (saved everything, or chose to discard). */
const confirmedClose = new Set<number>();

/**
 * The save-and-close attempt in flight for a window (A2). The renderer starts one with an id, and
 * only a result carrying that same id may close the window: a cancel, a discard or a newer attempt
 * replaces/clears it, so a late success cannot close a window the user already kept open. An
 * attempt that never reports back expires.
 */
const ATTEMPT_TTL_MS = 5 * 60 * 1000;
const activeAttempts = new Map<number, { id: string; startedAt: number }>();
let attemptNow: () => number = () => Date.now();

export function setAttemptClockForTests(now: (() => number) | null): void {
  attemptNow = now ?? (() => Date.now());
}

function activeAttemptId(windowId: number): string | null {
  const attempt = activeAttempts.get(windowId);
  if (!attempt) return null;
  if (attemptNow() - attempt.startedAt > ATTEMPT_TTL_MS) {
    activeAttempts.delete(windowId);
    return null;
  }
  return attempt.id;
}

export function forgetCloseConfirmation(windowId: number): void {
  confirmedClose.delete(windowId);
  activeAttempts.delete(windowId);
}

export interface CloseListenerDeps {
  windowId: number;
  getState(): WindowState | undefined;
  isQuitting(): boolean;
  /** Runs only when the close proceeds (nobody called preventDefault). */
  onProceed(event: CloseEventLike): void;
  /** The window is really gone ('closed'): the place for destructive cleanup (A1). */
  onClosed(): void;
}

export function registerCloseListeners(window: CloseWindowLike, deps: CloseListenerDeps): void {
  // 1. Ask before losing unsaved changes. Quitting never prompts.
  window.on('close', (event) => {
    if (deps.isQuitting()) return;
    // A save-and-close attempt is in flight (its dialog is open): cancel any close, whatever the edited
    // flag says right now (it can read false between a save and the next report), and do not open a second dialog.
    if (activeAttemptId(deps.windowId) !== null) {
      event.preventDefault();
      return;
    }
    if (deps.getState()?.documentEdited) {
      event.preventDefault();
      window.webContents.send('confirm-close-unsaved');
    }
  });
  // 2. Cleanup (state removal, session save) only if the close was not cancelled above. Running it
  // for a prevented close left the window without state while it stayed open.
  window.on('close', (event) => {
    if (event.defaultPrevented) return;
    deps.onProceed(event);
  });
  // Electron can still cancel a close that got past both listeners (beforeunload -> "Stay"), so
  // nothing destructive may happen before 'closed'.
  window.on('closed', () => {
    forgetCloseConfirmation(deps.windowId);
    deps.onClosed();
  });
}

export interface CloseEnv {
  getWindowId(window: unknown): number | null;
  getState(windowId: number): WindowState | undefined;
  log?(message: string, detail?: unknown): void;
}

/**
 * The renderer's answer to "Save": `{ ok: true }` only after every dirty tab was saved. The window
 * closes only on that report, and only if the window state no longer says there are unsaved
 * changes (and exists at all: a missing state is not proof of "saved").
 */
export function handleCloseWindowSave(
  window: CloseWindowLike | null | undefined,
  payload: unknown,
  env: CloseEnv,
): 'closing' | 'kept-open' {
  if (!window || window.isDestroyed()) return 'kept-open';
  const windowId = env.getWindowId(window);
  const state = windowId === null ? undefined : env.getState(windowId);
  const report = typeof payload === 'object' && payload !== null ? payload as { ok?: unknown; attemptId?: unknown } : {};
  const ok = report.ok === true;
  // Only the attempt currently in flight may close the window (A2): a cancel, a discard or a newer
  // attempt invalidated any other one.
  const current = windowId === null ? null : activeAttemptId(windowId);
  const isCurrent = typeof report.attemptId === 'string' && report.attemptId === current;
  // ANY report for the current attempt ends it, before ok/documentEdited are evaluated: the attempt is
  // over whether it succeeded or not. Otherwise a failed save left it active and the X did nothing.
  if (isCurrent && windowId !== null) activeAttempts.delete(windowId);
  if (windowId === null || !state || !ok || !isCurrent || state.documentEdited) {
    env.log?.('[WindowLifecycle] close-window-save: window kept open', {
      reportedOk: ok, hasState: !!state, stillEdited: !!state?.documentEdited, staleAttempt: !isCurrent,
    });
    return 'kept-open';
  }
  confirmedClose.add(windowId);
  window.close();
  return 'closing';
}

/** The attempt in flight is tied to the page that started it: a navigation or a renderer crash ends it. */
export function clearCloseAttempt(windowId: number): void {
  activeAttempts.delete(windowId);
}

/**
 * did-start-navigation arrives as (details) in newer Electron and as (event, url, isInPlace, isMainFrame)
 * in the legacy form. True for a main-frame navigation that replaces the document.
 */
export function isDocumentReplacingNavigation(args: unknown[]): boolean {
  const first = args[0] as { isMainFrame?: boolean; isSameDocument?: boolean } | undefined;
  const isMainFrame = typeof first?.isMainFrame === 'boolean' ? first.isMainFrame : args[3] === true;
  const isSameDocument = typeof first?.isSameDocument === 'boolean' ? first.isSameDocument : args[2] === true;
  return isMainFrame && !isSameDocument;
}

/** The renderer starts a save-and-close attempt. A newer attempt replaces the one in flight. */
export function handleCloseWindowSaveStarted(
  window: CloseWindowLike | null | undefined,
  payload: unknown,
  env: CloseEnv,
): boolean {
  if (!window || window.isDestroyed()) return false;
  const windowId = env.getWindowId(window);
  const attemptId = typeof payload === 'object' && payload !== null ? (payload as { attemptId?: unknown }).attemptId : undefined;
  if (windowId === null || typeof attemptId !== 'string' || attemptId === '') return false;
  activeAttempts.set(windowId, { id: attemptId, startedAt: attemptNow() });
  return true;
}

/**
 * The user chose "Cancel" (keep editing), while asking or while saving. A cancel that names an attempt
 * clears only that attempt (a newer one keeps guarding the window); a cancel without an id clears
 * whatever is in flight. Either way normal close behaviour returns at once, and a late result of the
 * cancelled attempt is stale and cannot close the window.
 */
export function handleCloseWindowCancel(
  window: CloseWindowLike | null | undefined,
  payload: unknown,
  env: CloseEnv,
): void {
  if (!window || window.isDestroyed()) return;
  const windowId = env.getWindowId(window);
  if (windowId === null) return;
  const attemptId = typeof payload === 'object' && payload !== null ? (payload as { attemptId?: unknown }).attemptId : undefined;
  const current = activeAttemptId(windowId);
  if (typeof attemptId === 'string' && current !== null && attemptId !== current) return; // a newer attempt owns the window
  activeAttempts.delete(windowId);
  confirmedClose.delete(windowId);
}

/** "Don't save": the user chose to lose the changes. */
export function handleCloseWindowDiscard(
  window: CloseWindowLike | null | undefined,
  env: CloseEnv,
): 'closing' | 'kept-open' {
  if (!window || window.isDestroyed()) return 'kept-open';
  const windowId = env.getWindowId(window);
  if (windowId === null) return 'kept-open';
  const state = env.getState(windowId);
  activeAttempts.delete(windowId);
  if (state) state.documentEdited = false;
  confirmedClose.add(windowId);
  window.close();
  return 'closing';
}

export function buildUnloadPrompt(): MessageBoxSyncOptions {
  return {
    type: 'warning',
    message: t('general:app.unsavedChanges.unloadMessage'),
    buttons: [t('general:app.unsavedChanges.unloadReload'), t('general:app.unsavedChanges.unloadStay')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

export interface UnloadEnv {
  windowId: number | null;
  isQuitting(): boolean;
  /** Synchronous native prompt; returns the clicked button index. */
  prompt(options: MessageBoxSyncOptions): number;
}

/**
 * `will-prevent-unload`: the page's beforeunload blocked a reload or close. With no handler Electron
 * keeps the page and says nothing. Allow the unload (preventDefault) when quitting or when the user
 * already decided; otherwise ask, with "Stay" as the default and Esc.
 */
export function handleWillPreventUnload(
  event: { preventDefault(): void },
  env: UnloadEnv,
): 'allow' | 'stay' {
  if (env.isQuitting() || (env.windowId !== null && confirmedClose.has(env.windowId))) {
    event.preventDefault();
    return 'allow';
  }
  let choice = 1;
  try {
    choice = env.prompt(buildUnloadPrompt());
  } catch {
    choice = 1;
  }
  if (choice === 0) {
    event.preventDefault();
    return 'allow';
  }
  return 'stay';
}
