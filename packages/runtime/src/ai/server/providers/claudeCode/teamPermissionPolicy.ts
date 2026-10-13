/**
 * Team-context pre-authorization of first-party host tools (Phase 1A.1).
 *
 * A user who starts a Team root has already asked for a coordinator that
 * creates members within the Team Mode limits and reads what they report.
 * Asking that user to click "Allow" on every create_session and every
 * get_session_result (22 clicks in the first pilot) buys no safety: the limits
 * (budget, depth, active count, role, provider, scope) are enforced by
 * MetaAgentService on the call itself, and the reads change nothing. So, inside
 * a team, these calls are pre-authorized by the team context, under conditions
 * checked on the call's own arguments:
 *
 * - create_session: only the root, and only within the role defaults: the call
 *   carries nothing but role, title, prompt and a scope no wider than the
 *   role's own. Any other key (provider, model, effort, worktree, an internal
 *   flag) is the user's click.
 * - send_prompt, get_session_result, get_session_status, list_queued_prompts:
 *   only when the target session belongs to this team (the root or one of its
 *   members); send_prompt only from the root.
 * - run_project_tests: only a member with the review scope. The runner executes
 *   the workspace's own `npm test`, so any session that can edit package.json
 *   would otherwise turn it into an unprompted command.
 *
 * Everything else keeps the permission flow it has today: Bash, Write/Edit
 * under 'ask', commits (the proposal widget confirms), spawn_session (it may
 * create worktrees), external MCP servers, configuration and trust tools,
 * respond_to_prompt (a coordinator answering a member's permission prompt
 * would be an escalation), SDK teammates (they share the leader's session id),
 * and any session outside a team. The scope deny lists run before any of this,
 * in the PreToolUse guard and in disallowedTools, so nothing here reaches a
 * tool the scope withholds.
 *
 * Fail-closed: no team context, a context that could not be read, or a target
 * that could not be confirmed as the team's own means no pre-authorization,
 * that is, the prompt the user sees today.
 */
import { MCP_HOST } from '../../services/mcpTopology';
import { TEAM_ROLES, type TeamRole } from '../teamContext';
import { isToolDeniedForScope, type ChildToolScope } from './toolPolicy';

export interface TeamPermissionContext {
  /** The session is a team root (the coordinator). */
  teamMode: boolean;
  /** The session's team role when it is a member; null for a root or outside a team. */
  role: TeamRole | null;
  /** The frozen tool scope; `full` for a root. */
  scope: ChildToolScope;
  /** The session itself. */
  sessionId: string;
  /** The team's root: the session itself for a root, `teamChild.rootSessionId` for a member. */
  rootSessionId: string | null;
}

export interface TeamPermissionRequest {
  /** The tool call's arguments, as the model sent them. */
  input?: unknown;
  /** Set when an SDK teammate (sharing the leader's session id) made the call: never pre-authorized. */
  teammateName?: string | null;
  /** For a targeted tool: whether `input.sessionId` was confirmed to be this team's root or one of its members. */
  targetInTeam?: boolean | null;
}

const host = (tool: string): string => `mcp__${MCP_HOST}__${tool}`;

/** Only the coordinator: acting on its own members is the team's policy in action, bounded by MetaAgentService. */
export const TEAM_ROOT_PREAUTHORIZED_TOOLS: readonly string[] = [host('create_session'), host('send_prompt')];

/** Any team session: reads of the team's own sessions and queue. */
export const TEAM_PREAUTHORIZED_READ_TOOLS: readonly string[] = [
  host('get_session_result'),
  host('get_session_status'),
  host('list_spawned_sessions'),
  host('list_queued_prompts'),
];

/** The reviewer's own instrument: `npm test` of the workspace, no command, no shell, inside the workspace (projectTestRunner). */
export const TEAM_PREAUTHORIZED_TEST_TOOLS: readonly string[] = [host('run_project_tests')];

/** Tools whose `sessionId` argument names another session: pre-authorized only for a session of the same team. */
export const TEAM_TARGETED_TOOLS: readonly string[] = [
  host('send_prompt'),
  host('get_session_result'),
  host('get_session_status'),
  host('list_queued_prompts'),
];

/** The scope each role gets by default (mirrors teamPolicy.ts in the host). */
export const TEAM_ROLE_DEFAULT_SCOPES: Readonly<Record<TeamRole, ChildToolScope>> = Object.freeze({
  explorer: 'read',
  architect: 'read',
  reviewer: 'review',
  implementer: 'full',
  other: 'full',
});

const SCOPE_ORDER: readonly ChildToolScope[] = ['read', 'review', 'write', 'full'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The only keys a pre-authorized create_session may carry; anything else is the user's click. */
export const CREATE_SESSION_PREAUTHORIZED_KEYS: readonly string[] = ['role', 'title', 'prompt', 'toolScope'];

/**
 * A create_session call that stays within the role defaults: an allowlist of
 * keys (role, title, prompt, toolScope), a known role, and a scope no wider
 * than the role's own. A provider (even claude-code: it switches the role's
 * model default off), a model, an effort, a worktree or any internal flag the
 * dispatch would pass through makes the call the user's click.
 */
export function createSessionWithinDefaults(input: unknown): boolean {
  if (!isRecord(input)) return false;
  for (const key of Object.keys(input)) {
    if (!CREATE_SESSION_PREAUTHORIZED_KEYS.includes(key)) return false;
  }
  const role = input.role;
  if (typeof role !== 'string' || !(TEAM_ROLES as readonly string[]).includes(role)) return false;
  if (input.title !== undefined && typeof input.title !== 'string') return false;
  if (input.prompt !== undefined && typeof input.prompt !== 'string') return false;
  if (input.toolScope !== undefined) {
    if (typeof input.toolScope !== 'string' || !(SCOPE_ORDER as readonly string[]).includes(input.toolScope)) return false;
    const requested = SCOPE_ORDER.indexOf(input.toolScope as ChildToolScope);
    const byDefault = SCOPE_ORDER.indexOf(TEAM_ROLE_DEFAULT_SCOPES[role as TeamRole]);
    if (requested > byDefault) return false;
  }
  return true;
}

/**
 * Why the team context pre-authorizes `toolName` for this session and this
 * call, or null when it does not (the normal permission flow then applies).
 */
export function teamPreauthorizationReason(
  toolName: string,
  context: TeamPermissionContext | null | undefined,
  request: TeamPermissionRequest = {},
): string | null {
  if (!context || request.teammateName) return null;
  const isRoot = context.teamMode && context.role === null;
  const isMember = context.role !== null;
  if (!isRoot && !isMember) return null;
  if (TEAM_TARGETED_TOOLS.includes(toolName) && request.targetInTeam !== true) return null;

  if (TEAM_PREAUTHORIZED_READ_TOOLS.includes(toolName)) {
    return isRoot ? 'team root reading its own team' : `team ${context.role} reading its own team`;
  }
  if (TEAM_PREAUTHORIZED_TEST_TOOLS.includes(toolName)) {
    if (!isMember || context.scope !== 'review') return null;
    // Defense in depth: a scope that withholds the tool is never pre-authorized, whatever the role.
    if (isToolDeniedForScope(context.scope, toolName, [], context.role)) return null;
    return `team ${context.role} (review) running the workspace test command`;
  }
  if (TEAM_ROOT_PREAUTHORIZED_TOOLS.includes(toolName)) {
    if (!isRoot) return null;
    if (toolName === host('create_session')) {
      return createSessionWithinDefaults(request.input)
        ? 'team root creating a member within the role defaults and the Team Mode limits'
        : null;
    }
    return 'team root following up one of its own members';
  }
  return null;
}
