/**
 * `portal_*` -- the agent's view of the project's local preview, executed in
 * main as a thin first-party MCP surface over BrowserSessionService (no second
 * engine, no renderer hop).
 *
 *  - The actor is the MCP connection's session id; no id, no execution.
 *  - open takes a workspace file (main builds the nim-preview URL, scoped to the
 *    registered workspace roots) or a loopback dev-server URL. Nothing else.
 *  - A portal is bound to the origin it opened on; navigation, redirects and
 *    frames cannot leave it (BrowserSessionService). Subresources and fetches
 *    are not restricted.
 *  - click, type and evaluate need the user-only test-data mark of the project;
 *    scroll and the observation tools do not.
 *  - The caller's tool scope and team role are re-checked here at execution
 *    (agentBrowserPolicy), on top of the server's ListTools/CallTool filter.
 *  - There is no tool, and no argument, that writes the mark.
 */

import { BrowserSessionService } from '../../services/BrowserSessionService';
import { assertAgentMayExerciseOn, type PortalExerciseAction } from '../../services/portalTestData';
import { buildPreviewUrlForFile, captureScreenshotToFile, registerWorktreeRoot } from '../../services/BrowserAgentFiles';
import { resolveAgentBrowserAccess, PORTAL_ENDPOINT } from './agentBrowserPolicy';

type McpToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };

import { isPortalToolName, PORTAL_TOOL_NAMES, portalToolSchemas } from './portalToolSchemas';

export { isPortalToolName, PORTAL_TOOL_NAMES, portalToolSchemas };

const ok = (data: unknown): McpToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  isError: false,
});
const fail = (message: string): McpToolResult => ({
  content: [{ type: 'text', text: `Error: ${message}` }],
  isError: true,
});

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A loopback http(s) dev-server URL; throws for anything else. */
function parseLoopbackUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('portal_open only opens the project\'s local preview: a workspace file (filePath) or a loopback dev server (http://localhost, 127.0.0.1 or [::1])');
  }
  return parsed.toString();
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface PortalToolContext {
  /** MCP connection session id; undefined = unattributed call (refused). */
  sessionId: string | undefined;
  workspacePath: string | undefined;
}

/** The portal `id` for `actor`, or a throw that reads like "no such portal" for anything else. */
function requirePortal(service: BrowserSessionService, id: unknown, actor: string): string {
  const sessionId = str(id);
  if (!sessionId) throw new Error('sessionId is required (the id portal_open returned)');
  service.assertAccess(sessionId, actor);
  if (service.getBoundOrigin(sessionId) === undefined) throw new Error(`No portal: ${sessionId}`);
  return sessionId;
}

/** The project a portal was opened for (stored on the session when it opened). */
function portalProject(service: BrowserSessionService, sessionId: string): string {
  const project = service.getProjectPath(sessionId);
  if (!project) throw new Error(`Portal ${sessionId} has no project on record`);
  return project;
}

/** The mark (and, on a localhost page, a declared port) for the page the portal is on now. */
function gate(service: BrowserSessionService, sessionId: string, action: PortalExerciseAction): Promise<void> {
  return assertAgentMayExerciseOn(
    {
      url: service.getCurrentUrl(sessionId) ?? '',
      boundProject: portalProject(service, sessionId),
      openedByProject: service.getOpenedByProject(sessionId),
    },
    action,
  );
}

export async function handlePortalTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  ctx: PortalToolContext,
): Promise<McpToolResult> {
  if (!isPortalToolName(toolName)) return fail(`Unknown portal tool: ${toolName}`);
  const actor = ctx.sessionId;
  if (!actor) return fail('portal calls must be attributed to an MCP session; this call had no session id');
  const input = args ?? {};

  const access = await resolveAgentBrowserAccess(actor, PORTAL_ENDPOINT, toolName);
  if (access.denial) return fail(access.denial);
  // The project of a portal is the one the CALLING session's record names, never
  // the transport's workspace parameter: files, mark and screenshots all follow it.
  const sessionProject = access.projectRoot;

  const service = BrowserSessionService.getInstance();
  try {
    switch (toolName) {
      case 'portal_open': {
        const filePath = str(input.filePath);
        const rawUrl = str(input.url);
        if (!filePath === !rawUrl) throw new Error('Give exactly one of filePath or url');
        if (!sessionProject) throw new Error('This session has no project on record to open a portal for');
        // A member in a worktree: its root is served only once WorktreeStore vouches for it.
        if (filePath) await registerWorktreeRoot(sessionProject);
        const url = filePath
          ? await buildPreviewUrlForFile(filePath, sessionProject, { confineToRoot: true })
          : parseLoopbackUrl(rawUrl);
        const sessionId = `agent-portal:${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const width = num(input.width);
        const height = num(input.height);
        const state = service.createSession({
          sessionId,
          url,
          headless: true,
          viewport: width !== undefined && height !== undefined ? { width, height } : undefined,
          ownerSessionId: actor,
          confineToOrigin: true,
          projectPath: sessionProject,
          openedByProject: sessionProject,
        });
        return ok({ sessionId, url, origin: service.getBoundOrigin(sessionId), state });
      }
      case 'portal_list':
        return ok({
          sessionIds: service.listSessions(actor).filter((id) => service.getBoundOrigin(id) !== undefined),
        });
      case 'portal_navigate': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        const raw = str(input.url);
        if (!raw) throw new Error('url is required');
        let target = raw;
        try {
          target = new URL(raw, service.getState(sessionId)?.url).toString();
        } catch {
          // left as given: the service refuses what is not an allowed URL
        }
        service.navigate(sessionId, target);
        return ok({ sessionId, navigatingTo: target });
      }
      case 'portal_close': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        service.destroySession(sessionId);
        return ok({ closed: sessionId });
      }
      case 'portal_screenshot': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        const project = portalProject(service, sessionId);
        const path = await captureScreenshotToFile(service, sessionId, project, str(input.label) || undefined);
        return ok({ path });
      }
      case 'portal_page_info': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        return ok(await service.getPageInfo(sessionId));
      }
      case 'portal_scroll': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        await service.scroll(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          index: num(input.index),
          dx: num(input.dx),
          dy: num(input.dy),
        });
        return ok({ scrolled: true });
      }
      case 'portal_click': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        await gate(service, sessionId, 'click');
        await service.click(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          index: num(input.index),
          x: num(input.x),
          y: num(input.y),
        });
        return ok({ clicked: true });
      }
      case 'portal_type': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        if (typeof input.text !== 'string') throw new Error('text is required');
        await gate(service, sessionId, 'type');
        await service.type(sessionId, {
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          index: num(input.index),
          text: input.text,
          clear: input.clear === true,
        });
        return ok({ typed: true });
      }
      case 'portal_evaluate': {
        const sessionId = requirePortal(service, input.sessionId, actor);
        if (typeof input.script !== 'string') throw new Error('script is required');
        await gate(service, sessionId, 'evaluate');
        return ok({ result: await service.evaluate(sessionId, input.script) });
      }
      default:
        return fail(`Unknown portal tool: ${toolName}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
