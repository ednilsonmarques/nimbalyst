/**
 * Execution-time policy check shared by the main-run agent browser tools
 * (`portal_*` and `browser.*`). The MCP server already filters ListTools and
 * refuses CallTool by the session's scope and team role; this re-reads the same
 * frozen policy (sessionToolPolicy, the single source of truth) inside the
 * handler, so a handler reached any other way (the mobile voice path, the
 * extension test tool, a future caller) is held to the same rules, and a policy
 * that cannot be read runs nothing.
 */

import type { McpEndpointSelection } from '../mcpEndpointRouting';
import {
  isToolDeniedForSession,
  resolveSessionToolPolicy,
  sessionToolDenial,
} from '../sessionToolPolicy';

export const PORTAL_ENDPOINT: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst' };
export const BROWSER_ENDPOINT: McpEndpointSelection = { kind: 'extension', extensionShortName: 'browser' };

export interface AgentBrowserAccess {
  /** The refusal text, or null when the call may run. */
  denial: string | null;
  /**
   * The project the session belongs to, from its session record (never from a
   * transport parameter); null when the record names none (a fixed actor).
   */
  projectRoot: string | null;
}

/**
 * Whether `actor` (a session id; for a fixed actor, the calling session whose
 * policy applies) may run `toolName` on `endpoint`, and the project it belongs to.
 */
export async function resolveAgentBrowserAccess(
  actor: string,
  endpoint: McpEndpointSelection,
  toolName: string,
): Promise<AgentBrowserAccess> {
  let policy;
  try {
    policy = await resolveSessionToolPolicy(actor);
  } catch (err) {
    return { denial: err instanceof Error ? err.message : String(err), projectRoot: null };
  }
  if (isToolDeniedForSession(policy, endpoint, toolName)) {
    return {
      denial: sessionToolDenial(policy, endpoint, toolName).content[0].text.replace(/^Error: /, ''),
      projectRoot: policy.workspaceRoot,
    };
  }
  return { denial: null, projectRoot: policy.workspaceRoot };
}
