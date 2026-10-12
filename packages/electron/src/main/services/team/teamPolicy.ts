/**
 * Team mode rules for child-session creation (MetaAgentService.createChildSessionInternal).
 *
 * Pure: no IO, so the rules are testable on their own and the orchestration
 * code only asks "is this caller in a team, and what does its role imply".
 */

import {
  TEAM_BUDGET_METADATA_KEY,
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
 * Tool scope a role gets when the caller does not pass one. Explorer is
 * read-only; reviewer reads and may run the workspace's tests (`review`);
 * implementer gets full tools; `other` has no role default (the caller
 * decides, as outside a team).
 */
export function teamRoleDefaultToolScope(role: TeamRole): 'read' | 'review' | 'full' | undefined {
  if (role === 'explorer') return 'read';
  if (role === 'reviewer') return 'review';
  if (role === 'implementer') return 'full';
  return undefined;
}

/** Scopes that restrict a child and are stored in `metadata.toolScope`. */
export type StoredChildToolScope = 'read' | 'review' | 'write';

/**
 * The scope to store for a new child, or undefined for full access.
 *
 * - A reviewer never gets more than `review`: `full`, `write` or anything else
 *   is lowered to `review`; only an explicit `read` (stricter) is kept.
 * - Otherwise an explicit scope wins over the role default; `full` means no
 *   restriction.
 * - Fail closed: an unrecognized value is stored as `read`, never widened to
 *   full access.
 */
export function resolveChildToolScopeRequest(
  explicit: unknown,
  role: TeamRole | undefined,
): StoredChildToolScope | undefined {
  if (role === 'reviewer') return explicit === 'read' ? 'read' : 'review';
  const requested = explicit ?? (role ? teamRoleDefaultToolScope(role) : undefined);
  if (requested === undefined || requested === null || requested === 'full') return undefined;
  if (requested === 'read' || requested === 'review' || requested === 'write') return requested;
  return 'read';
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
  /**
   * Real sessions a team may create before its first checkpoint, archived ones
   * included. Not a lifetime ceiling: the user may extend it (budgetExtension).
   */
  budget: 8,
  /** Sessions added each time the user continues the team at a checkpoint. */
  budgetExtension: 4,
});

export interface TeamUsage {
  /** Every descendant session of the root, archived included. */
  total: number;
  /** Descendants running, waiting for input, or holding a pending/executing queued prompt. */
  active: number;
}

/**
 * Sessions a team root is authorized to create, from its metadata. A root
 * without the key (every root created before checkpoints existed) or with a
 * malformed one gets the initial budget, never less.
 */
export function resolveAuthorizedTeamBudget(rootMetadata: unknown): number {
  const metadata = rootMetadata && typeof rootMetadata === 'object' && !Array.isArray(rootMetadata)
    ? (rootMetadata as Record<string, unknown>)
    : null;
  const stored = metadata?.[TEAM_BUDGET_METADATA_KEY];
  const authorized = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? (stored as Record<string, unknown>).authorized
    : undefined;
  return typeof authorized === 'number' && Number.isSafeInteger(authorized) && authorized > TEAM_LIMITS.budget
    ? authorized
    : TEAM_LIMITS.budget;
}

/** The team has created every session it is authorized to: it is at a checkpoint. */
export function isTeamBudgetExhausted(usage: TeamUsage, authorizedBudget: number): boolean {
  return usage.total >= authorizedBudget;
}

/** `metadata.teamBudget` after the user continues a team authorized for `authorizedBudget`. */
export function extendedTeamBudget(authorizedBudget: number): { authorized: number; extensions: number } {
  const authorized = authorizedBudget + TEAM_LIMITS.budgetExtension;
  return {
    authorized,
    extensions: Math.round((authorized - TEAM_LIMITS.budget) / TEAM_LIMITS.budgetExtension),
  };
}

/** The checkpoint action's name when no UI language is known (the English label). */
export const DEFAULT_CONTINUE_ACTION_LABEL = 'Continue team';

/** A creation refused because the team is at its checkpoint; carries what the user is shown. */
export class TeamBudgetReachedError extends Error {
  constructor(message: string, readonly total: number, readonly authorized: number) {
    super(message);
    this.name = 'TeamBudgetReachedError';
  }
}

/**
 * Why a new member may not be created, or null when it may. Pure; MetaAgentService throws it.
 * `authorizedBudget` is the root's own (resolveAuthorizedTeamBudget).
 * `continueActionLabel` is the name of the checkpoint action as the user sees
 * it (the UI language), so the coordinator points the user to a button that exists.
 */
export function teamSpawnRefusal(
  team: TeamCaller,
  usage: TeamUsage,
  authorizedBudget: number = TEAM_LIMITS.budget,
  continueActionLabel: string = DEFAULT_CONTINUE_ACTION_LABEL,
): string | null {
  if (team.depth + 1 > TEAM_LIMITS.maxDepth) {
    return `Team depth limit reached: this session is at depth ${team.depth} and team members may nest at most ${TEAM_LIMITS.maxDepth} levels below the team root. Do the work yourself or report back to your coordinator.`;
  }
  if (isTeamBudgetExhausted(usage, authorizedBudget)) {
    // Keep the "Team budget reached: this team" opening: scripts/team-pilot-report.mjs matches it.
    return `Team budget reached: this team has already created ${usage.total}/${authorizedBudget} sessions, which is its checkpoint. Only the user can authorize more, with the "${continueActionLabel}" action now shown in the coordinator's transcript; no tool and no session can. Coordinator: stop here, tell the user the team reached its checkpoint and ask them to continue the team, naming the action exactly as "${continueActionLabel}". Do not change a member's role, do the work yourself or skip the independent review to get around it. Team member: report this to your coordinator.`;
  }
  if (usage.active >= TEAM_LIMITS.maxActive) {
    return `Team limit: ${usage.active}/${TEAM_LIMITS.maxActive} sessions are already active in this team. Wait for a member to finish (its report arrives automatically) before delegating more.`;
  }
  return null;
}
