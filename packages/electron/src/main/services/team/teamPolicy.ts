/**
 * Team mode rules for child-session creation (MetaAgentService.createChildSessionInternal).
 *
 * Pure: no IO, so the rules are testable on their own and the orchestration
 * code only asks "is this caller in a team, and what does its role imply".
 */

import {
  TEAM_ROLES,
  parseTeamRole,
  resolveTeamContext,
  type TeamChild,
  type TeamRole,
} from '@nimbalyst/runtime/ai/server/providers/teamContext';

/** Team mode only runs on Claude Code in this phase. */
export const TEAM_PROVIDER = 'claude-code';

/** Default model for the read-heavy roles. */
export const TEAM_SONNET_MODEL = 'claude-code:sonnet';

export interface TeamCaller {
  rootSessionId: string;
  /** Depth of the caller itself: the root is 0. */
  depth: number;
}

/**
 * The team a caller belongs to, or null when it is not in one (in which case
 * child creation must behave exactly as before Team mode existed).
 */
export function resolveTeamCaller(
  callerSessionId: string,
  callerMetadata: unknown,
  callerAgentRole?: string | null,
): TeamCaller | null {
  const metadata = callerMetadata && typeof callerMetadata === 'object' && !Array.isArray(callerMetadata)
    ? (callerMetadata as Record<string, unknown>)
    : null;
  const context = resolveTeamContext(metadata, callerAgentRole);
  if (context.teamMode) return { rootSessionId: callerSessionId, depth: 0 };
  if (context.teamChild) return { rootSessionId: context.teamChild.rootSessionId, depth: context.teamChild.depth };
  return null;
}

/** Role requested for a team child: absent means `other`; anything unknown is refused. */
export function resolveRequestedTeamRole(raw: unknown): TeamRole {
  if (raw === undefined || raw === null || raw === '') return 'other';
  const role = parseTeamRole(raw);
  if (!role) {
    throw new Error(`Invalid role "${String(raw)}". Expected one of: ${TEAM_ROLES.join(', ')}`);
  }
  return role;
}

/** Explorer and reviewer run on Sonnet; implementer and other inherit the root's model. */
export function teamRoleDefaultModel(role: TeamRole, rootModel: string | null): string | null {
  if (role === 'explorer' || role === 'reviewer') return TEAM_SONNET_MODEL;
  return rootModel;
}

/**
 * Tool scope a role gets when the caller does not pass one. Explorer and
 * reviewer are read-only, implementer gets full tools; `other` has no role
 * default (the caller decides, as outside a team).
 */
export function teamRoleDefaultToolScope(role: TeamRole): 'read' | 'full' | undefined {
  if (role === 'explorer' || role === 'reviewer') return 'read';
  if (role === 'implementer') return 'full';
  return undefined;
}

export function buildTeamChild(team: TeamCaller, role: TeamRole): TeamChild {
  return { role, rootSessionId: team.rootSessionId, depth: team.depth + 1 };
}
