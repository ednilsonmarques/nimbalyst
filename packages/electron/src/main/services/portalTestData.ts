/**
 * Portal test-data mark (F1.2).
 *
 * The user declares that a project's local previews hold test data only. Until
 * then an agent may observe a portal (open, navigate inside the preview,
 * screenshot, page info, scroll) but never click, type or evaluate in it. The
 * mark is:
 *
 *  - stored as `portalTestData` in the project's WorkspaceState (the app store
 *    under userData; never a file in the workspace, which an agent could edit);
 *  - set only by the UI, through `portal:set-test-data`: the IPC sender must be
 *    the window that is SHOWING that project (not one that merely lists it in
 *    its rail), that window must have received real user input a moment ago
 *    (userInputRecency, spent on use), and ENABLING it needs a native dialog
 *    owned by main (portalMarkConfirmation): only an explicit OK enables it, any
 *    other result or an error leaves it unchanged; turning it off needs none. No
 *    MCP tool, no tool argument and no BrowserSession channel writes it;
 *  - accompanied by a list of loopback ports the user declares
 *    (`portalInteractionPorts`, `portal:set-interaction-ports`: same gates, and
 *    the native dialog whenever a port is ADDED). With the mark on, an agent may
 *    interact only with nim-preview pages of the project and loopback pages on a
 *    declared port; any other localhost port is observe-only;
 *  - read by main on every click, type and evaluate (`assertAgentMayExerciseOn`),
 *    for the MCP `portal_*` tools, the main-run `browser.*` tools and the
 *    browser IPC when an agent actor is present. A worktree resolves to its
 *    parent project, and a missing project fails closed;
 *  - only about LOCAL previews: a `nim-preview` page is judged against the
 *    project whose root it serves, a loopback page against the project of the
 *    session (a portal against the project it was opened for). A page anywhere
 *    else is not gated by it, and the mark never grants anything there.
 *
 * The IPC answers with an error CODE, never UI text; the settings panel maps it
 * to an i18n key.
 */

import type { BrowserWindow } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { resolveWorkspacePathForPermissions } from './PermissionService';
import { findWorkspaceWindowMatch } from '../window/WindowManager';
import { consumeRecentUserInput } from './userInputRecency';
import { confirmPortalMark } from './portalMarkConfirmation';

export const PORTAL_TEST_DATA_GET = 'portal:get-test-data';
export const PORTAL_TEST_DATA_SET = 'portal:set-test-data';
export const PORTAL_INTERACTION_PORTS_SET = 'portal:set-interaction-ports';

/** Error codes the set channel can answer with (mapped to i18n keys by the settings panel). */
export type PortalTestDataErrorCode = 'invalidRequest' | 'notProjectWindow' | 'noUserInput' | 'notConfirmed';

export type PortalExerciseAction = 'click' | 'type' | 'evaluate';

async function resolveProject(workspacePath: string): Promise<string> {
  try {
    return await resolveWorkspacePathForPermissions(workspacePath);
  } catch {
    return workspacePath;
  }
}

/** Whether the project (a worktree counts as its parent) is marked as test data. */
export async function isPortalTestDataMarked(workspacePath: string | undefined): Promise<boolean> {
  if (!workspacePath) return false;
  const project = await resolveProject(workspacePath);
  const mark = (getWorkspaceState(project) as { portalTestData?: unknown }).portalTestData;
  return !!mark && typeof mark === 'object' && (mark as { enabled?: unknown }).enabled === true;
}

const MAX_PORTS = 20;

/** Ports as the user declares them: integers 1..65535, unique, sorted; null when anything is invalid. */
export function normalizePorts(input: unknown): number[] | null {
  if (!Array.isArray(input) || input.length > MAX_PORTS) return null;
  const ports = new Set<number>();
  for (const value of input) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) return null;
    ports.add(value);
  }
  return [...ports].sort((a, b) => a - b);
}

/** The loopback ports the user declared for the project (a worktree counts as its parent). */
export async function getInteractionPorts(workspacePath: string | undefined): Promise<number[]> {
  if (!workspacePath) return [];
  const project = await resolveProject(workspacePath);
  const stored = (getWorkspaceState(project) as { portalInteractionPorts?: unknown }).portalInteractionPorts;
  return normalizePorts(stored) ?? [];
}

/**
 * Throws unless the project is marked as test data. The message names the mark
 * exactly as the settings UI does (projectPermissions.portalTestData in
 * settings.json: section "Agent Browser Test Data", button "Mark as test data"),
 * so the agent can tell the user where to find it.
 */
export async function assertAgentMayExercise(
  workspacePath: string | undefined,
  action: PortalExerciseAction,
): Promise<void> {
  if (await isPortalTestDataMarked(workspacePath)) return;
  throw new Error(
    `Cannot ${action} in a portal: this project is not marked as test data. The user turns that on in Settings > Agent Permissions > "Agent Browser Test Data" > "Mark as test data"; agents cannot. Until then a local preview is observe-only.`,
  );
}

async function assertDeclaredPort(project: string | undefined, port: number, action: PortalExerciseAction): Promise<void> {
  if ((await getInteractionPorts(project)).includes(port)) return;
  throw new Error(
    `Cannot ${action} on localhost port ${port}: the user has not declared this port for agent interaction in this project. Declared ports are set in Settings > Agent Permissions > "Agent Browser Test Data" > "Ports agents may interact with"; agents cannot. Localhost pages on other ports are observe-only.`,
  );
}

/**
 * Whether a URL hostname (as WHATWG URL spells it) is this machine: `localhost`
 * and any `*.localhost` (with or without a trailing dot), all of 127.0.0.0/8,
 * `0.0.0.0`, `[::1]`, and IPv4-mapped loopback (`[::ffff:127.x.x.x]`, which URL
 * normalizes to `[::ffff:7f00:1]`).
 */
export function isLocalPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '[::1]') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return Number(v4[1]) === 127 && v4.slice(1).every((o) => Number(o) <= 255);
  const mappedHex = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (mappedHex) return (parseInt(mappedHex[1], 16) >> 8) === 127;
  const mappedDotted = /^\[::ffff:(\d{1,3})\.\d{1,3}\.\d{1,3}\.\d{1,3}\]$/.exec(host);
  return !!mappedDotted && Number(mappedDotted[1]) === 127;
}

/** The project root a `nim-preview://<hex root>/...` page serves, or null when the host does not decode. */
function nimPreviewRoot(parsed: URL): string | null {
  const host = parsed.host;
  if (!host || host.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(host)) return null;
  const root = Buffer.from(host, 'hex').toString('utf8');
  return root || null;
}

export interface ExerciseTarget {
  /** The page the session is on right now. */
  url: string;
  /** The project a portal was opened for (stored on the session); always gates. */
  boundProject?: string;
  /**
   * The project that OPENED the session (recorded at open time from the opening
   * session's record), never the current caller's: fixed actors serve several
   * callers, and a loopback page belongs to whoever opened it.
   */
  openedByProject?: string;
}

/**
 * The mark check for a click, type or evaluate by an agent actor, against the
 * right project and only for a local preview. Throws when it is refused.
 */
export async function assertAgentMayExerciseOn(target: ExerciseTarget, action: PortalExerciseAction): Promise<void> {
  let parsed: URL | null = null;
  try {
    parsed = new URL(target.url);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    // Not a page at all: nothing to protect, unless it is a portal (always gated by the mark).
    if (target.boundProject !== undefined) return assertAgentMayExercise(target.boundProject, action);
    return;
  }
  if (parsed.protocol === 'nim-preview:') {
    // Pages of the project's own files: the mark is enough, no port is involved.
    return assertAgentMayExercise(target.boundProject ?? nimPreviewRoot(parsed) ?? undefined, action);
  }
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLocalPreviewHost(parsed.hostname)) {
    const project = target.boundProject ?? target.openedByProject;
    await assertAgentMayExercise(project, action);
    // The mark is on; localhost pages still need a port the user declared. A URL without a
    // port uses the scheme default (80 / 443), which must be declared like any other.
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    return assertDeclaredPort(project, port, action);
  }
  // A portal is always gated by the mark; a page anywhere else keeps its pre-F1.2 behaviour:
  // the mark neither gates nor unlocks it.
  if (target.boundProject !== undefined) return assertAgentMayExercise(target.boundProject, action);
}

async function setMark(workspacePath: string, enabled: boolean): Promise<void> {
  const project = await resolveProject(workspacePath);
  updateWorkspaceState(project, (state) => {
    if (enabled) {
      (state as { portalTestData?: unknown }).portalTestData = { enabled: true, markedAt: Date.now() };
    } else {
      delete (state as { portalTestData?: unknown }).portalTestData;
    }
  });
}

async function setPorts(workspacePath: string, ports: number[]): Promise<void> {
  const project = await resolveProject(workspacePath);
  updateWorkspaceState(project, (state) => {
    if (ports.length > 0) (state as { portalInteractionPorts?: unknown }).portalInteractionPorts = ports;
    else delete (state as { portalInteractionPorts?: unknown }).portalInteractionPorts;
  });
}

type SenderLike = { id?: unknown } | null | undefined;

/**
 * The sender must be the window that SHOWS the project. A window keeps every rail
 * project referenced and may be displaying another one, so a window that merely
 * lists the project does not count (findWorkspaceWindowMatch reports `isActive`).
 */
async function senderProjectWindow(sender: SenderLike, workspacePath: string): Promise<BrowserWindow | null> {
  if (!sender || typeof sender.id !== 'number') return null;
  const project = await resolveProject(workspacePath);
  for (const candidate of new Set([project, workspacePath])) {
    const match = findWorkspaceWindowMatch(candidate);
    if (!match || match.isActive !== true) continue;
    const win = match.window as { isDestroyed?: () => boolean; webContents?: { id?: number } };
    if (win.isDestroyed?.()) continue;
    if (win.webContents?.id === sender.id) return match.window as BrowserWindow;
  }
  return null;
}

type Guarded =
  | { ok: true; project: string; window: BrowserWindow }
  | { ok: false; code: PortalTestDataErrorCode };

/**
 * The guards every change to the mark or its ports goes through: the sender is the
 * window showing the project and has had real user input a moment ago (spent).
 */
async function guardUserChange(event: { sender?: SenderLike }, workspacePath: string): Promise<Guarded> {
  const sender = event?.sender;
  const window = await senderProjectWindow(sender, workspacePath);
  if (!window) {
    logger.main.warn('[PortalTestData] Refused: the sender is not the window showing this project');
    return { ok: false, code: 'notProjectWindow' };
  }
  if (!consumeRecentUserInput(sender?.id)) {
    logger.main.warn('[PortalTestData] Refused: no recent user input in the sender window');
    return { ok: false, code: 'noUserInput' };
  }
  return { ok: true, project: await resolveProject(workspacePath), window };
}

/** Only an explicit OK counts; anything else, a throw included, is "no". */
async function userConfirms(info: Parameters<typeof confirmPortalMark>[0], window: BrowserWindow): Promise<boolean> {
  try {
    return (await confirmPortalMark(info, undefined, window)) === true;
  } catch {
    return false;
  }
}

export function registerPortalTestDataHandlers(): void {
  safeHandle(PORTAL_TEST_DATA_GET, async (_event, workspacePath: string) => {
    if (typeof workspacePath !== 'string' || !workspacePath) {
      return { success: false, code: 'invalidRequest' satisfies PortalTestDataErrorCode };
    }
    return {
      success: true,
      enabled: await isPortalTestDataMarked(workspacePath),
      ports: await getInteractionPorts(workspacePath),
    };
  });

  safeHandle(PORTAL_TEST_DATA_SET, async (event: { sender?: SenderLike }, workspacePath: string, enabled: boolean) => {
    if (typeof workspacePath !== 'string' || !workspacePath || typeof enabled !== 'boolean') {
      return { success: false, code: 'invalidRequest' satisfies PortalTestDataErrorCode };
    }
    const guard = await guardUserChange(event, workspacePath);
    if (!guard.ok) return { success: false, code: guard.code };
    // Enabling (off -> on) is the only change that widens what agents may do: main asks, natively.
    if (enabled && !(await isPortalTestDataMarked(workspacePath))) {
      const ports = await getInteractionPorts(workspacePath);
      if (!(await userConfirms({ kind: 'enable', projectPath: guard.project, ports }, guard.window))) {
        logger.main.info('[PortalTestData] Enabling the mark was not confirmed; unchanged');
        return { success: false, code: 'notConfirmed' satisfies PortalTestDataErrorCode };
      }
    }
    await setMark(workspacePath, enabled);
    logger.main.info(`[PortalTestData] Test-data mark ${enabled ? 'enabled' : 'disabled'} by the user`);
    return { success: true, enabled };
  });

  safeHandle(PORTAL_INTERACTION_PORTS_SET, async (event: { sender?: SenderLike }, workspacePath: string, requested: unknown) => {
    const ports = normalizePorts(requested);
    if (typeof workspacePath !== 'string' || !workspacePath || !ports) {
      return { success: false, code: 'invalidRequest' satisfies PortalTestDataErrorCode };
    }
    const guard = await guardUserChange(event, workspacePath);
    if (!guard.ok) return { success: false, code: guard.code };
    const current = await getInteractionPorts(workspacePath);
    // Removing ports, or leaving them as they are, narrows or keeps what agents may do: no dialog.
    if (ports.some((port) => !current.includes(port))) {
      if (!(await userConfirms({ kind: 'ports', projectPath: guard.project, ports }, guard.window))) {
        logger.main.info('[PortalTestData] Widening the interaction ports was not confirmed; unchanged');
        return { success: false, code: 'notConfirmed' satisfies PortalTestDataErrorCode };
      }
    }
    await setPorts(workspacePath, ports);
    logger.main.info(`[PortalTestData] Interaction ports set by the user: ${ports.join(', ') || '(none)'}`);
    return { success: true, ports };
  });
}
