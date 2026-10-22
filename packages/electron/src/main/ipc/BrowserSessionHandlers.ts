/**
 * IPC handlers for BrowserSessionService.
 *
 * Channels:
 *   browser-session:create        -> { sessionId, url, partition? } => state
 *   browser-session:destroy       -> { sessionId } => void
 *   browser-session:attach        -> { sessionId, bounds }
 *   browser-session:detach        -> { sessionId }
 *   browser-session:set-bounds    -> { sessionId, bounds }
 *   browser-session:navigate      -> { sessionId, url }
 *   browser-session:reload        -> { sessionId }
 *   browser-session:go-back       -> { sessionId }
 *   browser-session:go-forward    -> { sessionId }
 *   browser-session:screenshot    -> { sessionId } => { imageBase64 }
 *   browser-session:get-state     -> { sessionId } => state | null
 *
 * Event (main -> renderer, broadcast to host window of the session):
 *   browser-session:state-changed -> state
 *   browser-session:external-nav  -> { sessionId, url }
 *
 * The renderer drives the lifecycle: the browser editor component owns a
 * placeholder div, observes its bounding rect, and calls attach + set-bounds
 * as it appears / resizes. Detach + destroy happen on unmount.
 */

import { BrowserWindow } from 'electron';
import { relative, isAbsolute, resolve, join } from 'path';
import { mkdir, realpath, writeFile } from 'fs/promises';
import {
  BrowserSessionService,
  type BrowserSessionBounds,
  type BrowserNavigationState,
} from '../services/BrowserSessionService';
import {
  encodeNimPreviewUrl,
  getNimPreviewWorkspaceRoots,
  previewPathsEqual,
  previewPathInsideRoot,
} from '../protocols/nimPreviewProtocol';
import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';

export const BROWSER_TRANSCRIPT_IMAGE_DIRNAME = 'transcript-images';

/**
 * Who is calling. The user's own UI sends no `actorSessionId` and keeps full
 * control. An AI session's calls arrive with the id main handed to the tool path
 * (extensionToolHandler -> AIToolContext.aiSessionId) and are confined to the
 * sessions that AI session owns. Enforcement is here and in the service, so a
 * renderer that forgets to check cannot widen an agent's reach.
 */
interface ActorPayload {
  actorSessionId?: string | null;
}

interface CreatePayload extends ActorPayload {
  sessionId: string;
  url: string;
  partition?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
}

interface BoundsPayload extends ActorPayload {
  sessionId: string;
  bounds: BrowserSessionBounds;
}

interface SessionIdPayload extends ActorPayload {
  sessionId: string;
}

interface NavigatePayload extends ActorPayload {
  sessionId: string;
  url: string;
}

type Authorization = { ok: true; actor: string | undefined } | { ok: false; error: string };

/**
 * Read the caller identity. Absent/null means the user's UI. Anything else must
 * be a non-empty string: a malformed actor is refused rather than treated as
 * the user, so garbage cannot widen access.
 */
function readActor(payload: ActorPayload | undefined): { ok: true; actor: string | undefined } | { ok: false; error: string } {
  const raw = payload?.actorSessionId;
  if (raw === undefined || raw === null) return { ok: true, actor: undefined };
  if (typeof raw === 'string' && raw.length > 0) return { ok: true, actor: raw };
  return { ok: false, error: 'Invalid actorSessionId' };
}

/** Caller identity plus access to `payload.sessionId`; refusals read like "no such session". */
function authorize(service: BrowserSessionService, payload: SessionIdPayload): Authorization {
  const who = readActor(payload);
  if (!who.ok) return who;
  try {
    service.assertAccess(payload.sessionId, who.actor);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, actor: who.actor };
}

export function getBrowserTranscriptImageDir(workspacePath: string): string {
  return join(resolve(workspacePath), '.nimbalyst', BROWSER_TRANSCRIPT_IMAGE_DIRNAME);
}

/**
 * Resolve a caller-supplied workspace path to a registered open workspace.
 * Accepted: a path equal to or inside a root the app registered for an open
 * workspace window, or the exact path of a known worktree whose project is
 * registered. Returns the normalised path, or null when it is neither (or does
 * not exist, or resolves out of its root through a link).
 */
export async function resolveRegisteredWorkspace(workspacePath: string): Promise<string | null> {
  const candidate = resolve(workspacePath);
  const roots = getNimPreviewWorkspaceRoots();

  const root = roots.find((r) => previewPathInsideRoot(r, candidate));
  if (root) {
    try {
      const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
      return previewPathInsideRoot(realRoot, realCandidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  const projectPath = await lookupWorktreeProjectPath(candidate);
  if (!projectPath) return null;
  const project = resolve(projectPath);
  if (!roots.some((r) => previewPathInsideRoot(r, project))) return null;
  try {
    await realpath(candidate);
  } catch {
    return null;
  }
  return candidate;
}

async function lookupWorktreeProjectPath(workspacePath: string): Promise<string | null> {
  try {
    const { getDatabase } = await import('../database/initialize');
    const { createWorktreeStore } = await import('../services/WorktreeStore');
    const worktree = await createWorktreeStore(getDatabase()).getByPath(workspacePath);
    return worktree?.projectPath ?? null;
  } catch (err) {
    logger.main.warn(
      `[BrowserSessionHandlers] worktree lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

function broadcastState(state: BrowserNavigationState): void {
  // Broadcast to all renderer windows. The renderer-side central listener
  // filters by sessionId so unrelated windows ignore the event cheaply.
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('browser-session:state-changed', state);
  }
}

function broadcastExternalNav(payload: { sessionId: string; url: string }): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('browser-session:external-nav', payload);
  }
}

let listenersWired = false;

export function registerBrowserSessionHandlers(): void {
  const service = BrowserSessionService.getInstance();

  if (!listenersWired) {
    service.on('state-changed', broadcastState);
    service.on('external-navigation-requested', broadcastExternalNav);
    listenersWired = true;
  }

  safeHandle('browser-session:create', async (_event, payload: CreatePayload) => {
    if (!payload?.sessionId || !payload?.url) {
      return { success: false, error: 'sessionId and url are required' };
    }
    const who = readActor(payload);
    if (!who.ok) return { success: false, error: who.error };
    try {
      const state = service.createSession({
        sessionId: payload.sessionId,
        url: payload.url,
        partition: payload.partition,
        headless: payload.headless,
        viewport: payload.viewport,
        ownerSessionId: who.actor,
      });
      return { success: true, state };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.main.warn(`[BrowserSessionHandlers] create failed: ${message}`);
      return { success: false, error: message };
    }
  });

  safeHandle('browser-session:destroy', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    service.destroySession(payload.sessionId);
    return { success: true };
  });

  safeHandle('browser-session:attach', async (event, payload: BoundsPayload) => {
    if (!payload?.sessionId || !payload?.bounds) {
      return { success: false, error: 'sessionId and bounds are required' };
    }
    const hostWindow = BrowserWindow.fromWebContents(event.sender);
    if (!hostWindow || hostWindow.isDestroyed()) {
      return { success: false, error: 'Host window not available' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    try {
      service.attachToWindow(payload.sessionId, hostWindow, payload.bounds);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  safeHandle('browser-session:detach', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    service.detachFromWindow(payload.sessionId);
    return { success: true };
  });

  safeHandle('browser-session:set-bounds', async (_event, payload: BoundsPayload) => {
    if (!payload?.sessionId || !payload?.bounds) {
      return { success: false, error: 'sessionId and bounds are required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    service.setBounds(payload.sessionId, payload.bounds);
    return { success: true };
  });

  safeHandle('browser-session:navigate', async (_event, payload: NavigatePayload) => {
    if (!payload?.sessionId || !payload?.url) {
      return { success: false, error: 'sessionId and url are required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    try {
      service.navigate(payload.sessionId, payload.url);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  safeHandle('browser-session:reload', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    try {
      service.reload(payload.sessionId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('browser-session:go-back', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    try {
      service.goBack(payload.sessionId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('browser-session:go-forward', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    try {
      service.goForward(payload.sessionId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle('browser-session:screenshot', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    try {
      const buffer = await service.captureScreenshot(payload.sessionId);
      return {
        success: true,
        imageBase64: buffer.toString('base64'),
        mimeType: 'image/png',
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Encode a workspace-relative or absolute filesystem path into a
   // `nim-preview://` URL the browser session can navigate to. Rejects paths
   // outside any registered workspace root so the renderer can't trick us
   // into building a URL we'd refuse to serve at request time.
  safeHandle(
    'browser-session:build-preview-url',
    async (_event, payload: { filePath: string; workspacePath?: string }) => {
      if (!payload?.filePath) {
        return { success: false, error: 'filePath is required' };
      }
      if (!isAbsolute(payload.filePath)) {
        return { success: false, error: 'filePath must be absolute' };
      }
      const resolvedFile = resolve(payload.filePath);
      const roots = getNimPreviewWorkspaceRoots();
      let matchedRoot: string | null = null;
      if (payload.workspacePath) {
        const candidate = resolve(payload.workspacePath);
        // Match against the registered root (not the caller's spelling) so the
        // encoded root always equals an allowlisted entry, even when drive
        // letter or path casing differs on Windows (issue #612).
        const registered = roots.find((r) => previewPathsEqual(r, candidate));
        if (registered && previewPathInsideRoot(registered, resolvedFile)) {
          matchedRoot = registered;
        }
      }
      if (!matchedRoot) {
        for (const root of roots) {
          if (previewPathInsideRoot(root, resolvedFile)) {
            matchedRoot = root;
            break;
          }
        }
      }
      if (!matchedRoot) {
        return { success: false, error: 'File is not under any active workspace root' };
      }
      const rel = relative(matchedRoot, resolvedFile);
      return {
        success: true,
        url: encodeNimPreviewUrl(matchedRoot, rel),
      };
    },
  );

  safeHandle('browser-session:get-state', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    // A session the caller does not own looks the same as one that does not exist.
    const auth = authorize(service, payload);
    return { success: true, state: auth.ok ? service.getState(payload.sessionId) : null };
  });

  safeHandle('browser-session:list-sessions', async (_event, payload?: ActorPayload) => {
    const who = readActor(payload);
    if (!who.ok) return { success: false, error: who.error };
    return { success: true, sessionIds: service.listSessions(who.actor) };
  });

  // Capture a screenshot and write it to a PNG file under the workspace,
  // returning the absolute path. Used by the agent screenshot tool so large
  // base64 blobs never travel through the renderer or the tool result.
  safeHandle(
    'browser-session:screenshot-to-file',
    async (
      _event,
      payload: { sessionId: string; workspacePath: string; label?: string } & ActorPayload,
    ) => {
      if (!payload?.sessionId || !payload?.workspacePath) {
        return { success: false, error: 'sessionId and workspacePath are required' };
      }
      if (!isAbsolute(payload.workspacePath)) {
        return { success: false, error: 'workspacePath must be absolute' };
      }
      const auth = authorize(service, payload);
      if (!auth.ok) return { success: false, error: auth.error };
      try {
        // The caller names the workspace, so it is only trusted once it is a
        // registered open workspace (or a worktree of one). Nothing is
        // captured or written otherwise.
        const workspace = await resolveRegisteredWorkspace(payload.workspacePath);
        if (!workspace) {
          return { success: false, error: 'workspacePath is not a registered open workspace' };
        }
        const buffer = await service.captureScreenshot(payload.sessionId);
        // Persist transcript-linked screenshots in a durable .nimbalyst
        // subdirectory instead of the transient browser-shots path.
        const dir = getBrowserTranscriptImageDir(workspace);
        const realWorkspace = await realpath(workspace);
        // A `.nimbalyst` that is a link leaving the workspace must not become
        // the write target (checked before mkdir, which would follow it).
        const realNimbalyst = await realpath(join(workspace, '.nimbalyst')).catch(() => null);
        if (realNimbalyst && !previewPathInsideRoot(realWorkspace, realNimbalyst)) {
          return { success: false, error: '.nimbalyst resolves outside the workspace' };
        }
        await mkdir(dir, { recursive: true });
        if (!previewPathInsideRoot(realWorkspace, await realpath(dir))) {
          return { success: false, error: 'Screenshot directory resolves outside the workspace' };
        }
        const safeLabel = (payload.label || payload.sessionId)
          .replace(/[^a-zA-Z0-9_-]+/g, '-')
          .slice(0, 60);
        const filePath = join(dir, `${safeLabel}-${Date.now()}.png`);
        await writeFile(filePath, buffer);
        return { success: true, path: filePath };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // ---- Interaction (agentic control) ----

  safeHandle(
    'browser-session:evaluate',
    async (_event, payload: { sessionId: string; script: string } & ActorPayload) => {
      if (!payload?.sessionId || typeof payload?.script !== 'string') {
        return { success: false, error: 'sessionId and script are required' };
      }
      const auth = authorize(service, payload);
      if (!auth.ok) return { success: false, error: auth.error };
      try {
        const result = await service.evaluate(payload.sessionId, payload.script);
        return { success: true, result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  safeHandle('browser-session:get-page-info', async (_event, payload: SessionIdPayload) => {
    if (!payload?.sessionId) {
      return { success: false, error: 'sessionId is required' };
    }
    const auth = authorize(service, payload);
    if (!auth.ok) return { success: false, error: auth.error };
    try {
      const info = await service.getPageInfo(payload.sessionId);
      return { success: true, info };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  safeHandle(
    'browser-session:click',
    async (
      _event,
      payload: { sessionId: string; selector?: string; index?: number; x?: number; y?: number } & ActorPayload,
    ) => {
      if (!payload?.sessionId) {
        return { success: false, error: 'sessionId is required' };
      }
      const auth = authorize(service, payload);
      if (!auth.ok) return { success: false, error: auth.error };
      try {
        await service.click(payload.sessionId, payload);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  safeHandle(
    'browser-session:type',
    async (
      _event,
      payload: { sessionId: string; selector?: string; index?: number; text: string; clear?: boolean } & ActorPayload,
    ) => {
      if (!payload?.sessionId || typeof payload?.text !== 'string') {
        return { success: false, error: 'sessionId and text are required' };
      }
      const auth = authorize(service, payload);
      if (!auth.ok) return { success: false, error: auth.error };
      try {
        await service.type(payload.sessionId, payload);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  safeHandle(
    'browser-session:scroll',
    async (
      _event,
      payload: { sessionId: string; selector?: string; index?: number; dx?: number; dy?: number } & ActorPayload,
    ) => {
      if (!payload?.sessionId) {
        return { success: false, error: 'sessionId is required' };
      }
      const auth = authorize(service, payload);
      if (!auth.ok) return { success: false, error: auth.error };
      try {
        await service.scroll(payload.sessionId, payload);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  logger.main.info('[BrowserSessionHandlers] handlers registered');
}
