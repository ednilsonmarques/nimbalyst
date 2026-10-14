/**
 * Team mode rules for child-session creation (MetaAgentService.createChildSessionInternal).
 *
 * Pure: no IO, so the rules are testable on their own and the orchestration
 * code only asks "is this caller in a team, and what does its role imply".
 */

import {
  TEAM_BUDGET_METADATA_KEY,
  TEAM_MISSION_MAX_LENGTH,
  TEAM_ROLES,
  normalizeTeamMission,
  parseTeamRole,
  resolveTeamContext,
  type TeamChild,
  type TeamRole,
} from '@nimbalyst/runtime/ai/server/providers/teamContext';

/** Team mode only runs on Claude Code in this phase. */
export const TEAM_PROVIDER = 'claude-code';

/** Default model for every team member but the architect and the advisor; the coordinator promotes one explicitly when needed. */
export const TEAM_SONNET_MODEL = 'claude-code:sonnet';

/**
 * Default model of the `architect`: it decides architecture, trade-offs and
 * risks for the whole team from a read-only seat, so it runs on Opus at high
 * effort. An explicit `model` from the coordinator still wins.
 */
export const TEAM_ARCHITECT_MODEL = 'claude-code:opus';

/**
 * Temporary default model of the `advisor` (Consultor Independente). A second
 * opinion is only worth having from a model at least as strong as the one it
 * questions (the architect runs on Opus), so it runs on Opus at high effort;
 * Fable stays an explicit promotion, as for every other role. This is a
 * default of this phase, not a property of the role: the advisor is
 * provider-agnostic, and running it on another provider later means changing
 * `teamRoleProvider` and this constant, nothing else (see teamRoleProvider).
 */
export const TEAM_ADVISOR_MODEL = 'claude-code:opus';

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
 * The provider a team role runs on. Every role runs on Claude Code in this
 * phase, and this is the one place that says so: the creation path refuses a
 * member whose resolved provider differs from its role's, and the role model
 * defaults below are identifiers of that provider. The `advisor` was designed
 * to run on a provider other than the rest of the team one day (an
 * independent second opinion is worth more from a different model family);
 * when that day comes, this function and `teamRoleDefaultModel` change for
 * that role, and no `role === 'advisor'` provider condition appears anywhere
 * else. Nothing about a role's scope, denials or prompt depends on its provider.
 */
export function teamRoleProvider(_role: TeamRole): string {
  return TEAM_PROVIDER;
}

/** Every role defaults to Sonnet, except the architect and the advisor (Opus). */
export function teamRoleDefaultModel(role: TeamRole): string {
  if (role === 'architect') return TEAM_ARCHITECT_MODEL;
  if (role === 'advisor') return TEAM_ADVISOR_MODEL;
  return TEAM_SONNET_MODEL;
}

/** Reviewers, architects and advisors think harder (high); every other role runs at medium. */
export function teamRoleDefaultEffort(role: TeamRole): 'medium' | 'high' {
  return role === 'reviewer' || role === 'architect' || role === 'advisor' ? 'high' : 'medium';
}

/**
 * Tool scope a role gets when the caller does not pass one. Explorer,
 * architect and advisor are read-only; reviewer reads and may run the
 * workspace's tests (`review`); implementer gets full tools; `other` has no
 * role default (the caller decides, as outside a team).
 */
export function teamRoleDefaultToolScope(role: TeamRole): 'read' | 'review' | 'full' | undefined {
  if (role === 'explorer' || role === 'architect' || role === 'advisor') return 'read';
  if (role === 'reviewer') return 'review';
  if (role === 'implementer') return 'full';
  return undefined;
}

/** Scopes that restrict a child and are stored in `metadata.toolScope`. */
export type StoredChildToolScope = 'read' | 'review' | 'write';

/**
 * The scope to store for a new child, or undefined for full access.
 *
 * - An architect is always `read`: it prepares work and never executes, so
 *   `full`, `write`, `review` or anything else is lowered to `read`.
 * - An advisor is always `read` too: it gives an opinion and never acts, so
 *   nothing a coordinator, a mission or a brief asks for widens it.
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
  if (role === 'architect' || role === 'advisor') return 'read';
  if (role === 'reviewer') return explicit === 'read' ? 'read' : 'review';
  const requested = explicit ?? (role ? teamRoleDefaultToolScope(role) : undefined);
  if (requested === undefined || requested === null || requested === 'full') return undefined;
  if (requested === 'read' || requested === 'review' || requested === 'write') return requested;
  return 'read';
}

/**
 * Mission requested for a team child: absent, null or blank means none; a
 * non-string or an over-long one is refused before any side effect. The text
 * is stored normalized (whitespace collapsed). Nothing here reads the mission
 * for policy: role, scope, model and effort are resolved by their own rules.
 */
export function resolveRequestedTeamMission(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw new Error('Invalid mission: expected plain text.');
  }
  const mission = normalizeTeamMission(raw);
  if (!mission) return undefined;
  if (mission.length > TEAM_MISSION_MAX_LENGTH) {
    throw new Error(
      `Mission too long (${mission.length} characters; at most ${TEAM_MISSION_MAX_LENGTH}). ` +
      'A mission is one or two sentences of focus; the details belong in the prompt.',
    );
  }
  return mission;
}

export function buildTeamChild(team: TeamCaller, role: TeamRole, mission?: string): TeamChild {
  const child: TeamChild = { role, rootSessionId: team.rootSessionId, depth: team.depth + 1 };
  return mission ? { ...child, mission } : child;
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
