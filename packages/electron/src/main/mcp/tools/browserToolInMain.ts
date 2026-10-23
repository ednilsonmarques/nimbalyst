/**
 * Agent `browser.*` tools, executed in main.
 *
 * Until F1.2 the renderer ran these tools (extensions/browser aiTools) and sent
 * an actor token back through the browser IPC. A hop that dropped the token
 * would have been read as the user's own UI, and main cannot tell the two
 * apart: the same renderer sends both. Here main runs the whole tool, with the
 * actor taken from the MCP connection (or a fixed actor for the extension-test
 * and mobile-voice paths), so there is no hop to drop it and the browser IPC
 * only ever sees the user's UI.
 *
 * Behaviour matches the renderer tools they replace: agent-owned sessions, an
 * explicit sessionId required, a fresh agent partition, the idle reaper. On top:
 * the scope and team-role policy is re-checked here, and click / type /
 * evaluate need the project's user-only test-data mark.
 */

import { BrowserSessionService } from '../../services/BrowserSessionService';
import { EXTENSION_DEV_TEST_ACTOR } from '../../services/BrowserAuthority';
import { assertAgentMayExerciseOn, type PortalExerciseAction } from '../../services/portalTestData';
import { buildPreviewUrlForFile, captureScreenshotToFile } from '../../services/BrowserAgentFiles';
import { resolveAgentBrowserAccess, BROWSER_ENDPOINT } from './agentBrowserPolicy';

/** Tools whose names start like this never reach the renderer. */
const BROWSER_TOOL_PATTERN = /^browser[._]/;

export function isBrowserToolName(toolName: string): boolean {
  return BROWSER_TOOL_PATTERN.test(toolName);
}

export interface MainBrowserToolContext {
  /** MCP session id, or a fixed actor (`extension-dev-test`, `mobile-voice`). */
  actor: string;
  workspacePath: string | undefined;
  /**
   * The session whose scope and team-role policy applies, when it is not the
   * actor itself. `extension_test_ai_tool` runs as the fixed actor
   * `extension-dev-test` (no session record of its own), so it passes the
   * CALLING session here; without one that actor is refused.
   */
  policySessionId?: string;
}

export interface MainBrowserToolResult {
  success: boolean;
  message?: string;
  data?: unknown;
  error?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const KNOWN = new Set([
  'open_session', 'open_local_preview', 'list_sessions', 'close_session', 'navigate', 'reload', 'go_back',
  'go_forward', 'get_page_info', 'click', 'type', 'scroll', 'evaluate', 'screenshot',
]);

const target = (a: Record<string, unknown>) => ({
  selector: typeof a.selector === 'string' ? a.selector : undefined,
  index: num(a.index),
});

export async function runBrowserToolInMain(
  toolName: string,
  args: Record<string, unknown> | undefined,
  ctx: MainBrowserToolContext,
): Promise<MainBrowserToolResult> {
  const action = toolName.replace(BROWSER_TOOL_PATTERN, '');
  if (!isBrowserToolName(toolName) || !KNOWN.has(action)) {
    return { success: false, error: `Unknown browser tool: ${toolName}` };
  }
  if (ctx.actor === EXTENSION_DEV_TEST_ACTOR && !ctx.policySessionId) {
    return { success: false, error: 'extension_test_ai_tool runs browser tools only on behalf of a known calling session; this call had none' };
  }
  const access = await resolveAgentBrowserAccess(ctx.policySessionId ?? ctx.actor, BROWSER_ENDPOINT, `browser.${action}`);
  if (access.denial) return { success: false, error: access.denial };
  // The acting project: the session record's, else (a fixed actor) the call's workspace.
  const actorProject = access.projectRoot ?? ctx.workspacePath;

  const a = args ?? {};
  const service = BrowserSessionService.getInstance();
  // A fixed actor serves many callers; each caller gets its own owner key, so
  // callers never see each other's sessions. mobile-voice has no caller id on its
  // path, so it keeps the single shared owner (the opening project still binds
  // the mark below).
  const actor =
    ctx.actor === EXTENSION_DEV_TEST_ACTOR && ctx.policySessionId ? `${ctx.actor}:${ctx.policySessionId}` : ctx.actor;
  // The mark gates click / type / evaluate on a LOCAL preview (nim-preview or loopback), judged
  // against the page the session is on now; a portal against the project it was opened for.
  const gate = (id: string, what: PortalExerciseAction) =>
    assertAgentMayExerciseOn(
      { url: service.getCurrentUrl(id) ?? '', boundProject: service.getProjectPath(id), openedByProject: service.getOpenedByProject(id) },
      what,
    );
  // An agent must name the session it drives: it only ever reaches sessions it
  // owns, so there is no "current" session or editor to default to.
  const owned = (): string => {
    const id = str(a.sessionId);
    if (!id) {
      throw new Error(
        'sessionId is required. Pass the id returned by browser.open_session / browser.open_local_preview (see browser.list_sessions for the sessions you own).',
      );
    }
    service.assertAccess(id, actor);
    return id;
  };

  try {
    switch (action) {
      case 'open_session': {
        const url = str(a.url);
        if (!url) return { success: false, error: 'url is required' };
        const sessionId = str(a.sessionId) || `agent-browser:${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const width = num(a.width);
        const height = num(a.height);
        const state = service.createSession({
          sessionId,
          url,
          headless: a.headless !== false,
          viewport: width !== undefined && height !== undefined ? { width, height } : undefined,
          ownerSessionId: actor,
          openedByProject: actorProject,
        });
        return { success: true, message: `Opened browser session ${sessionId}`, data: { sessionId, state } };
      }
      case 'open_local_preview': {
        const filePath = str(a.filePath);
        if (!filePath) return { success: false, error: 'filePath is required' };
        const url = await buildPreviewUrlForFile(filePath, ctx.workspacePath);
        const sessionId = `agent-preview:${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const state = service.createSession({ sessionId, url, headless: a.headless !== false, ownerSessionId: actor, openedByProject: actorProject });
        return { success: true, message: `Preview opened for ${filePath}`, data: { sessionId, url, state } };
      }
      case 'list_sessions':
        return { success: true, data: { sessionIds: service.listSessions(actor) } };
      case 'close_session': {
        const id = owned();
        service.destroySession(id);
        return { success: true, message: `Closed ${id}` };
      }
      case 'navigate': {
        const id = owned();
        service.navigate(id, str(a.url));
        return { success: true, message: `Navigating to ${str(a.url)}` };
      }
      case 'reload':
        service.reload(owned());
        return { success: true };
      case 'go_back':
        service.goBack(owned());
        return { success: true };
      case 'go_forward':
        service.goForward(owned());
        return { success: true };
      case 'get_page_info':
        return { success: true, data: await service.getPageInfo(owned()) };
      case 'scroll':
        await service.scroll(owned(), { ...target(a), dx: num(a.dx), dy: num(a.dy) });
        return { success: true };
      case 'screenshot': {
        const id = owned();
        if (!ctx.workspacePath) return { success: false, error: 'No workspace open; cannot save screenshot.' };
        const path = await captureScreenshotToFile(service, id, ctx.workspacePath, str(a.label) || undefined);
        return { success: true, message: `Screenshot saved to ${path}`, data: { path } };
      }
      case 'click': {
        const id = owned();
        await gate(id, 'click');
        await service.click(id, { ...target(a), x: num(a.x), y: num(a.y) });
        return { success: true };
      }
      case 'type': {
        const id = owned();
        await gate(id, 'type');
        await service.type(id, { ...target(a), text: String(a.text ?? ''), clear: a.clear === true });
        return { success: true };
      }
      case 'evaluate': {
        const id = owned();
        await gate(id, 'evaluate');
        const result = await service.evaluate(id, String(a.script ?? ''));
        return { success: true, data: { result } };
      }
      default:
        return { success: false, error: `Unknown browser tool: ${toolName}` };
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
