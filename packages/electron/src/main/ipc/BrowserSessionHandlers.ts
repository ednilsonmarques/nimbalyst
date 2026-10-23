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
import { isAbsolute } from 'path';
import {
  BrowserSessionService,
  type BrowserSessionBounds,
  type BrowserNavigationState,
} from '../services/BrowserSessionService';
import { logger } from '../utils/logger';
import { resolveCaller } from '../services/BrowserAuthority';
import { assertAgentMayExerciseOn, type PortalExerciseAction } from '../services/portalTestData';
import {
  BROWSER_TRANSCRIPT_IMAGE_DIRNAME,
  buildPreviewUrlForFile,
  captureScreenshotToFile,
  getBrowserTranscriptImageDir,
  resolveRegisteredWorkspace,
} from '../services/BrowserAgentFiles';
import { safeHandle } from '../utils/ipcRegistry';

// The file helpers moved to BrowserAgentFiles (shared with the main-run agent
// browser tools); re-exported so existing importers keep working.
export { BROWSER_TRANSCRIPT_IMAGE_DIRNAME, getBrowserTranscriptImageDir, resolveRegisteredWorkspace };

/**
 * Who is calling (decided by BrowserAuthority). The user's own UI sends no
 * `actorSessionId` and keeps full control. An agent's calls carry the actor
 * token main minted for that tool call (extensionToolHandler); the token
 * resolves to the AI session id, and the agent is confined to the sessions that
 * id owns. A bare session id or any other value is refused, never read as the
 * user. Enforcement is here and in the service, so a renderer that forgets to
 * check cannot widen an agent's reach.
 */
interface ActorPayload {
  /** The user's UI omits it; an agent passes the main-issued token. */
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

type Authorization = { ok: true; actor: string | undefined; workspacePath?: string } | { ok: false; error: string };

const readActor = (payload: ActorPayload | undefined) => resolveCaller(payload?.actorSessionId);

/** Caller identity plus access to `payload.sessionId`; refusals read like "no such session". */
function authorize(service: BrowserSessionService, payload: SessionIdPayload): Authorization {
  const who = readActor(payload);
  if (!who.ok) return who;
  try {
    service.assertAccess(payload.sessionId, who.actor);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, actor: who.actor, workspacePath: who.workspacePath };
}

/**
 * An agent actor (a main-issued token) may click, type or evaluate only in a
 * project the user marked as test data. The user's own UI (no actor) is never
 * gated. A token minted without a project fails closed.
 */
async function gateAgentExercise(
  service: BrowserSessionService,
  sessionId: string,
  auth: Authorization,
  action: PortalExerciseAction,
): Promise<string | null> {
  if (!auth.ok || auth.actor === undefined) return null;
  try {
    // Only a LOCAL preview is gated (see portalTestData.assertAgentMayExerciseOn).
    await assertAgentMayExerciseOn(
      { url: service.getCurrentUrl(sessionId) ?? '', boundProject: service.getProjectPath(sessionId), openedByProject: service.getOpenedByProject(sessionId) },
      action,
    );
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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
        openedByProject: who.actor === undefined ? undefined : who.workspacePath,
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
      try {
        return { success: true, url: buildPreviewUrlForFile(payload.filePath, payload.workspacePath) };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
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
        const filePath = await captureScreenshotToFile(service, payload.sessionId, payload.workspacePath, payload.label);
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
      const refused = await gateAgentExercise(service, payload.sessionId, auth, 'evaluate');
      if (refused) return { success: false, error: refused };
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
      const refused = await gateAgentExercise(service, payload.sessionId, auth, 'click');
      if (refused) return { success: false, error: refused };
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
      const refused = await gateAgentExercise(service, payload.sessionId, auth, 'type');
      if (refused) return { success: false, error: refused };
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
