/**
 * Pure policies for the app's own renderer origin (NIB.85 stage d1).
 *
 * Two decisions share one definition of "the app's own pages":
 *  - `decideNavigation`: where a main-frame navigation of an app window may go.
 *  - `decideIpcSender`: whether an IPC message comes from the app's own page.
 *
 * The app's own pages are the dev-server origin (development) or files under
 * the renderer bundle directory (built / packaged), mirroring how
 * WindowManager and the auxiliary windows load their content.
 *
 * This is containment for navigation and for frames that are not the app's
 * page. It is not a boundary against script already running in the app's own
 * page: that script is the app origin.
 */

import * as path from 'path';
import { fileURLToPath } from 'url';
import { isInviteRoute } from '../../shared/inviteDeepLinks';

export interface AppOriginConfig {
  /** Origins (scheme + host + port) of http(s) pages that are the app. */
  origins: string[];
  /** Directories whose files (file: URLs) are the app. Absolute, normalized. */
  rendererDirs: string[];
}

export interface AppOriginInput {
  env: { ELECTRON_RENDERER_URL?: string; NODE_ENV?: string; VITE_PORT?: string };
  /** `app.getAppPath()`. */
  appPath: string;
  /**
   * `app.isPackaged`. A packaged build trusts only its own bundle directory:
   * the dev-server origin and an ELECTRON_RENDERER_URL override are
   * development / test hooks and are ignored. Defaults to false.
   */
  isPackaged?: boolean;
}

function normalizeDir(dir: string): string {
  return path.resolve(dir);
}

export function buildAppOriginConfig(input: AppOriginInput): AppOriginConfig {
  const origins = new Set<string>();
  const dirs = new Set<string>();
  const { env, appPath } = input;
  const dev = !input.isPackaged;

  if (dev && env.ELECTRON_RENDERER_URL) {
    try {
      const u = new URL(env.ELECTRON_RENDERER_URL);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        origins.add(u.origin);
      } else if (u.protocol === 'file:') {
        // Test harnesses point the renderer at a built index.html on disk.
        dirs.add(normalizeDir(path.dirname(fileURLToPath(u))));
      }
    } catch {
      // unparseable override: ignore, the other roots still apply
    }
  }

  if (dev && env.NODE_ENV === 'development') {
    origins.add(`http://localhost:${env.VITE_PORT || '5273'}`);
  }

  // Same locations WindowManager and the auxiliary windows load from.
  dirs.add(normalizeDir(path.join(appPath, 'out', 'renderer')));
  dirs.add(normalizeDir(path.join(appPath, '..', 'renderer')));

  return { origins: [...origins], rendererDirs: [...dirs] };
}

function isInsideDir(file: string, dir: string): boolean {
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const f = norm(path.resolve(file));
  const d = norm(dir);
  return f === d || f.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

export function isAppUrl(url: string, cfg: AppOriginConfig): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return cfg.origins.includes(parsed.origin);
  }
  if (parsed.protocol === 'file:') {
    let filePath: string;
    try {
      filePath = fileURLToPath(parsed);
    } catch {
      return false;
    }
    return cfg.rendererDirs.some((dir) => isInsideDir(filePath, dir));
  }
  return false;
}

/**
 * - `allow`: the app's own page.
 * - `open-external`: http(s) and mailto go to the system.
 * - `app-route`: a `nimbalyst:` deep link, handed to the app's own deep-link
 *   handler (what the OS used to do by re-launching the app with the URL).
 * - `block-invite`: a `nimbalyst:` team-invitation link. Never routed in-app
 *   (it can accept an invitation without a prompt); only the OS path delivers it.
 * - `block`: everything else (other custom schemes included).
 */
export type NavigationDecision = 'allow' | 'open-external' | 'app-route' | 'block-invite' | 'block';

// Same predicate as handleDeepLink / parseInviteDeepLink, on the URL as parsed and also on its
// percent-decoded host and path (extra blocking only: the handler itself does not decode them).
function isInviteLink(parsed: URL): boolean {
  if (isInviteRoute(parsed)) return true;
  try {
    return isInviteRoute({ host: decodeURIComponent(parsed.host).toLowerCase(), pathname: decodeURIComponent(parsed.pathname).toLowerCase() });
  } catch {
    return false;
  }
}

export function decideNavigation(url: string, cfg: AppOriginConfig): NavigationDecision {
  if (isAppUrl(url, cfg)) return 'allow';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'block';
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
    return 'open-external';
  }
  if (parsed.protocol === 'nimbalyst:') {
    return isInviteLink(parsed) ? 'block-invite' : 'app-route';
  }
  return 'block';
}

export interface IpcSenderInfo {
  hasFrame: boolean;
  isTopFrame: boolean;
  /** The sender is the web contents of one of the app's BrowserWindows. */
  inAppWindow: boolean;
  frameUrl: string;
}

export type IpcSenderReason = 'no-frame' | 'subframe' | 'not-app-window' | 'foreign-url';

export type IpcSenderDecision = { allowed: true } | { allowed: false; reason: IpcSenderReason };

export function decideIpcSender(info: IpcSenderInfo, cfg: AppOriginConfig): IpcSenderDecision {
  // A renderer message whose frame is unknown (destroyed or replaced before it was handled) is
  // rejected: nothing says it did not come from a subframe or a page that has already left.
  if (!info.hasFrame) return { allowed: false, reason: 'no-frame' };
  if (!info.isTopFrame) return { allowed: false, reason: 'subframe' };
  if (!info.inAppWindow) return { allowed: false, reason: 'not-app-window' };
  if (!isAppUrl(info.frameUrl, cfg)) return { allowed: false, reason: 'foreign-url' };
  return { allowed: true };
}
