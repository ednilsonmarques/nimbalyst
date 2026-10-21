/**
 * Main-frame navigation guard for app windows (NIB.85 stage d1).
 *
 * Every app window loads the preload and therefore exposes `electronAPI` to
 * whatever page it shows. If the page could be navigated to another origin
 * (a link the UI did not intercept, `location = ...`, a redirect), that page
 * would inherit the preload. This guard keeps app windows on the app's own
 * renderer: http(s) and mailto targets go to the system, everything else is
 * blocked and logged.
 *
 * Scope: web contents owned by a BrowserWindow. The embedded browser's
 * WebContentsView has no preload (and its own session) and must keep working
 * as before. It cannot be told apart by `getType()`: at run time (Electron 43)
 * the view's web contents also reports `window`, so ownership is checked at
 * navigation time against the BrowserWindows' own `webContents`. Only
 * main-frame navigations are policed; iframes (mockups, previews) are not.
 * `will-navigate` is not emitted for navigations the main process starts
 * itself (`loadURL`, `loadFile`, `reload()`), so window loading is unaffected.
 *
 * `nimbalyst:` links the UI did not intercept used to leave the app through the OS
 * protocol handler and re-enter it (second-instance / open-url -> handleDeepLink in
 * index.ts). They are now handed to that same handler directly (`routeAppUrl`),
 * with no capability the OS path lacked: same parser, same validation. Because the
 * OS path needed a user gesture (Chromium refuses to launch an external protocol
 * from a script-initiated navigation), routing requires recent user input on this
 * window; otherwise the navigation is blocked. Every other custom scheme is blocked.
 *
 * Complements windowOpenGuard.ts, which handles `window.open` / target=_blank.
 *
 * NOTE: a WebContentsView that ever carries the app preload would fall outside
 * this guard (it is not a BrowserWindow's own `webContents`) and would be covered
 * only by the IPC sender validator (security/ipcSenderValidator.ts). Today the
 * only such view is the embedded browser, which has no preload by design.
 */

import { app, shell, BrowserWindow } from 'electron';
import type { WebContents } from 'electron';

import { decideNavigation, type AppOriginConfig } from '../security/navigationPolicy';
import { getAppOriginConfig } from '../security/appOrigin';

export interface NavigationGuardDeps {
  openExternal: (url: string) => unknown;
  log: (message: string) => void;
  /**
   * Whether `contents` is the web contents of a BrowserWindow (as opposed to a
   * WebContentsView). Checked when a navigation happens. When omitted every
   * `window`-type web contents counts as owned (unit tests).
   */
  isOwnedByWindow?: (contents: WebContents) => boolean;
  /**
   * Runs a `nimbalyst:` deep link through the app's own handler. When omitted,
   * such links are blocked like any other custom scheme.
   */
  routeAppUrl?: (url: string, contents: WebContents) => unknown;
  /** Monotonic clock in ms for the user-input window (tests). Defaults to `performance.now`. */
  now?: () => number;
}

/** A routed deep link must follow user input on the window within this window of time. */
const USER_INPUT_WINDOW_MS = 3000;
const USER_INPUT_TYPES = new Set(['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap', 'touchStart', 'touchEnd', 'pointerDown', 'pointerUp']);

const MAX_LOGGED = 50;
const logged = new Set<string>();

function logBlocked(deps: NavigationGuardDeps, kind: string, url: string, decision: string): void {
  const key = `${kind}|${decision}|${url.slice(0, 200)}`;
  if (logged.has(key) || logged.size >= MAX_LOGGED) return;
  logged.add(key);
  deps.log(`[MAIN] Blocked ${kind} to ${url.slice(0, 200)} (${decision})`);
}

/**
 * Whether a webContents can be an app window at all. `getType()` is only a
 * coarse filter (`browserView` / `webview` are out); the embedded browser view
 * passes it, so `isOwnedByWindow` decides when a navigation happens.
 * `getLastWebPreferences()` is not used: it omits `preload` (Electron 43).
 */
function isWindowType(contents: WebContents): boolean {
  try {
    return contents.getType() === 'window';
  } catch {
    return false;
  }
}

/**
 * Attach the guard to one webContents. Returns false (and attaches nothing)
 * when it is not an app window.
 */
export function attachNavigationGuard(
  contents: WebContents,
  cfg: AppOriginConfig,
  deps: NavigationGuardDeps,
): boolean {
  if (!isWindowType(contents)) return false;

  const owned = (): boolean => {
    if (!deps.isOwnedByWindow) return true;
    try {
      return deps.isOwnedByWindow(contents);
    } catch {
      // Fail closed: if ownership cannot be determined, apply the policy. The
      // cost of being wrong is a blocked or externally-opened link in the
      // embedded browser; the cost of the opposite is an unguarded app window.
      return true;
    }
  };

  // Monotonic: a system clock change (NTP, manual, DST) must not widen or reopen the window.
  const now = deps.now ?? (() => performance.now());
  let lastUserInputAt = Number.NEGATIVE_INFINITY;
  contents.on('input-event', ((_event: unknown, input: { type?: string }) => {
    if (input && typeof input.type === 'string' && USER_INPUT_TYPES.has(input.type)) lastUserInputAt = now();
  }) as never);

  const handle = (kind: string) => (event: { preventDefault: () => void; url?: string }, positionalUrl?: string) => {
    if (!owned()) return;
    // Electron 43 passes the target on the event; the positional argument is the older form.
    const url = event.url ?? positionalUrl;
    if (typeof url !== 'string') return;
    const decision = decideNavigation(url, cfg);
    if (decision === 'allow') return;
    event.preventDefault();
    if (decision === 'app-route') {
      const recentInput = now() - lastUserInputAt <= USER_INPUT_WINDOW_MS;
      if (deps.routeAppUrl && recentInput) {
        logBlocked(deps, kind, url, 'routed in-app');
        try {
          void Promise.resolve(deps.routeAppUrl(url, contents)).catch(() => undefined);
        } catch {
          // the handler reports its own failures; the navigation stays cancelled
        }
      } else {
        logBlocked(deps, kind, url, deps.routeAppUrl ? 'app link without recent user input' : 'app link, no handler');
      }
      return;
    }
    if (decision === 'block-invite') {
      // Team invitations can be accepted without a prompt: only the OS path delivers them (NIB.98).
      logBlocked(deps, kind, url, 'invite links are not routed in-app');
      return;
    }
    logBlocked(deps, kind, url, decision);
    if (decision === 'open-external') {
      try {
        void Promise.resolve(deps.openExternal(url)).catch(() => undefined);
      } catch {
        // no handler for the scheme: the navigation is blocked either way
      }
    }
  };

  contents.on('will-navigate', handle('navigation') as never);
  contents.on('will-redirect', ((event: { preventDefault: () => void; isMainFrame?: boolean; url?: string }, url?: string) => {
    if (event.isMainFrame === false) return;
    handle('redirect')(event, url);
  }) as never);
  return true;
}

export function installNavigationGuard(options: { routeAppUrl?: NavigationGuardDeps['routeAppUrl'] } = {}): void {
  const cfg = getAppOriginConfig();
  const deps: NavigationGuardDeps = {
    openExternal: (url) => shell.openExternal(url),
    log: (message) => console.warn(message),
    isOwnedByWindow: (contents) =>
      BrowserWindow.getAllWindows().some((win) => !win.isDestroyed() && win.webContents === contents),
    routeAppUrl: options.routeAppUrl,
  };
  app.on('web-contents-created', (_event, contents) => {
    attachNavigationGuard(contents, cfg, deps);
  });
}
