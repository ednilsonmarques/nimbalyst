/**
 * Recency of real user input per window (web contents id).
 *
 * Some IPCs only the user may cause (today: the portal test-data mark). The
 * renderer is the trusted hop but an agent can make it run code (an extension
 * tool, a renderer eval), so an IPC alone does not prove a person acted. Main
 * therefore watches the OS-level input the window's web contents receives
 * (`before-input-event` for keys, `input-event` for mouse and touch), which a
 * script in the page cannot synthesize, and a guarded IPC requires a recent
 * entry for its own sender.
 *
 * Only the host windows' contents are tracked here; no agent drives them with
 * `sendInputEvent` (that is used on portal views only, which are not tracked).
 */

import { app } from 'electron';

/** How long after a keypress or click the UI may still change a guarded setting. */
export const USER_INPUT_WINDOW_MS = 5_000;

const lastInputAt = new Map<number, number>();

export function recordUserInput(webContentsId: number, now: number = Date.now()): void {
  lastInputAt.set(webContentsId, now);
}

export function hasRecentUserInput(
  webContentsId: unknown,
  windowMs: number = USER_INPUT_WINDOW_MS,
  now: number = Date.now(),
): boolean {
  if (typeof webContentsId !== 'number') return false;
  const at = lastInputAt.get(webContentsId);
  return at !== undefined && now - at >= 0 && now - at <= windowMs;
}

/**
 * Like hasRecentUserInput, but spends the input: one keypress or click allows one
 * guarded change, so a script that fires several IPCs inside the window cannot
 * chain them on a single real input.
 */
export function consumeRecentUserInput(
  webContentsId: unknown,
  windowMs: number = USER_INPUT_WINDOW_MS,
  now: number = Date.now(),
): boolean {
  if (!hasRecentUserInput(webContentsId, windowMs, now)) return false;
  lastInputAt.delete(webContentsId as number);
  return true;
}

/** Tests only. */
export function __resetUserInputForTests(): void {
  lastInputAt.clear();
}

const KEY_INPUT_TYPES = new Set(['keyDown']);
const POINTER_INPUT_TYPES = new Set(['mouseDown', 'touchStart', 'pointerDown']);

let installed = false;

/** Track input on every web contents (called once from main startup). */
export function installUserInputRecency(): void {
  if (installed) return;
  installed = true;
  app.on('web-contents-created', (_event, contents) => {
    const id = contents.id;
    contents.on('before-input-event', ((_e: unknown, input: { type?: string }) => {
      if (input?.type && KEY_INPUT_TYPES.has(input.type)) recordUserInput(id);
    }) as never);
    (contents as unknown as { on: (event: string, cb: (e: unknown, input: { type?: string }) => void) => void }).on(
      'input-event',
      (_e, input) => {
        if (input?.type && POINTER_INPUT_TYPES.has(input.type)) recordUserInput(id);
      },
    );
    contents.once('destroyed', () => lastInputAt.delete(id));
  });
}
