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

/** Default model for every team member; the coordinator promotes one explicitly when needed. */
export const TEAM_SONNET_MODEL = 'claude-code:sonnet';

export { TEAM_ROOT_PRESETS, isRecommendedTeamRootModel } from '@nimbalyst/runtime/ai/server/providers/teamContext';

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

/**
 * Every role defaults to Sonnet. Kept per role so a role can get its own
 * default later without touching the caller.
 */
export function teamRoleDefaultModel(_role: TeamRole): string {
  return TEAM_SONNET_MODEL;
}

/** Reviewers think harder (high); every other role runs at medium. */
export function teamRoleDefaultEffort(role: TeamRole): 'medium' | 'high' {
  return role === 'reviewer' ? 'high' : 'medium';
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

/** Runtime-enforced Team mode limits. SDK sub-agents are not sessions and never count. */
export const TEAM_LIMITS = Object.freeze({
  /** Members nest at most this many levels below the root (root 0, children 1, grandchildren 2). */
  maxDepth: 2,
  /** Real sessions of one team that may be active at once (running, waiting, or with a queued prompt). */
  maxActive: 3,
  /** Real sessions one team may ever create, archived ones included. */
  budget: 8,
});

export interface TeamUsage {
  /** Every descendant session of the root, archived included. */
  total: number;
  /** Descendants running, waiting for input, or holding a pending/executing queued prompt. */
  active: number;
}

/** Why a new member may not be created, or null when it may. Pure; MetaAgentService throws it. */
export function teamSpawnRefusal(team: TeamCaller, usage: TeamUsage): string | null {
  if (team.depth + 1 > TEAM_LIMITS.maxDepth) {
    return `Team depth limit reached: this session is at depth ${team.depth} and team members may nest at most ${TEAM_LIMITS.maxDepth} levels below the team root. Do the work yourself or report back to your coordinator.`;
  }
  if (usage.total >= TEAM_LIMITS.budget) {
    return `Team budget reached: this team has already created ${usage.total}/${TEAM_LIMITS.budget} sessions. Integrate the results you have, or ask the user before going further.`;
  }
  if (usage.active >= TEAM_LIMITS.maxActive) {
    return `Team limit: ${usage.active}/${TEAM_LIMITS.maxActive} sessions are already active in this team. Wait for a member to finish (its report arrives automatically) before delegating more.`;
  }
  return null;
}
