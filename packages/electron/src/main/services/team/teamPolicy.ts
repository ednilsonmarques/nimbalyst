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

/**
 * The provider a team runs on by default: the coordinator's presets and every
 * role default below name models of it, unless a role says otherwise
 * (TEAM_ROLE_DEFAULTS). It is also the only provider whose turn applies the
 * team policy today (services/team/teamProviders.ts).
 */
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
 * Provider of the `advisor` (Consultor Independente). The role runs on a
 * provider other than the rest of the team: a second opinion from a
 * different model family shares fewer blind spots with the coordinator and
 * the architect (it lowers the correlation of errors; it guarantees nothing).
 * It is OpenAI Codex because the host keeps a Codex read member read-only
 * (teamMemberProviderReadiness in teamProviders.ts: the session-scoped MCP
 * server plus the restricted Codex thread), and a second opinion the host
 * could not keep read-only would not be worth having. This constant and
 * TEAM_ADVISOR_MODEL are the whole switch: nothing else about the role
 * (scope, denials, prompt, mission, UI, manifest) depends on the provider.
 * Never read the provider anywhere else to decide anything about the advisor.
 *
 * When this provider is unavailable (not enabled, not signed in, not
 * verifiable) the advisor is refused, explicitly, before any side effect: the
 * host never falls back to the team provider (teamMemberProviderRefusal). A
 * same-provider advisor is the coordinator's deliberate choice, by naming
 * `provider` (and a model of it) explicitly, and is then reported as such.
 */
export const TEAM_ADVISOR_PROVIDER = 'openai-codex';

/**
 * Default model of the `advisor`, an identifier of TEAM_ADVISOR_PROVIDER. A
 * second opinion is only worth having from a model at least as strong as the
 * one it questions (the architect runs on Opus), so it runs on Codex's
 * strongest listed model at high effort (codexModelCatalog.ts knows it; the
 * creation path refuses a model this build does not know).
 */
export const TEAM_ADVISOR_MODEL = 'openai-codex:gpt-6.1-sol';

/** The defaults a role carries: where it runs and with what authority. */
export interface TeamRoleDefaults {
  /** Provider the role runs on; every member of the role is created on it unless the coordinator names another one that passes the provider check. */
  readonly provider: string;
  /** Default model, an identifier of `provider`. */
  readonly model: string;
  readonly effort: 'medium' | 'high';
  /** Scope when the caller passes none; undefined means the caller decides (full by default). */
  readonly toolScope: 'read' | 'review' | 'full' | undefined;
}

/**
 * Role defaults in one table: provider, model, effort and scope per role. A
 * role is not a provider (the advisor is the same Consultor Independente on
 * any provider); the provider is a default of the role, configured here and
 * nowhere else. Every function below reads this table.
 */
export const TEAM_ROLE_DEFAULTS: Readonly<Record<TeamRole, TeamRoleDefaults>> = Object.freeze({
  explorer: Object.freeze({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'medium', toolScope: 'read' }),
  implementer: Object.freeze({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'medium', toolScope: 'full' }),
  reviewer: Object.freeze({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'high', toolScope: 'review' }),
  architect: Object.freeze({ provider: TEAM_PROVIDER, model: TEAM_ARCHITECT_MODEL, effort: 'high', toolScope: 'read' }),
  advisor: Object.freeze({ provider: TEAM_ADVISOR_PROVIDER, model: TEAM_ADVISOR_MODEL, effort: 'high', toolScope: 'read' }),
  other: Object.freeze({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'medium', toolScope: undefined }),
} as const satisfies Record<TeamRole, TeamRoleDefaults>);

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
 * The provider a team role runs on by default (TEAM_ROLE_DEFAULTS). A member
 * is created on it unless the coordinator names another provider explicitly,
 * and either way the creation path accepts only a provider that passes
 * `teamMemberProviderRefusal`: host-verified enforcement of the member's
 * scope and role policy, and availability. Nothing about a role's scope,
 * denials or prompt depends on its provider.
 */
export function teamRoleProvider(role: TeamRole): string {
  return TEAM_ROLE_DEFAULTS[role].provider;
}

/** Every role defaults to Sonnet, except the architect (Opus) and the advisor (Codex); always a model of the role's provider. */
export function teamRoleDefaultModel(role: TeamRole): string {
  return TEAM_ROLE_DEFAULTS[role].model;
}

/**
 * The checkout a new child runs in, decided by the host from the caller's
 * persisted session row, never from text the agent wrote (NIB.49): the
 * caller's worktree when it has one, the main checkout otherwise. Only a
 * request for a brand-new worktree of its own (spawn_session `useWorktree`)
 * opts out. create_session of a Team mode member and spawn_session both go
 * through here, so a member never lands in the main checkout while its team
 * works in a worktree.
 */
export function callerWorktreeRequest(
  callerWorktreeId: string | null | undefined,
  ownNewWorktree: boolean,
): { useWorktree: boolean; worktreeId: string | undefined } {
  if (ownNewWorktree) return { useWorktree: true, worktreeId: undefined };
  return { useWorktree: false, worktreeId: callerWorktreeId || undefined };
}

/**
 * The model a role gets on a given provider when the caller names the
 * provider but no model (NIB.46 item 7.6). On the role's own provider it is
 * the role default. For the advisor named onto the team provider (a same-
 * provider second opinion, a deliberate choice) it is the architect's model,
 * Opus: a second opinion must be at least as strong as what it questions,
 * never the caller's Sonnet or whatever the coordinator happens to run. Any
 * other provider: null, the provider's own default applies.
 */
export function teamRoleModelForProvider(role: TeamRole, provider: string | null | undefined): string | null {
  if (!provider || provider === teamRoleProvider(role)) return teamRoleDefaultModel(role);
  if (role === 'advisor' && provider === TEAM_PROVIDER) return TEAM_ARCHITECT_MODEL;
  return null;
}

/** Reviewers, architects and advisors think harder (high); every other role runs at medium. */
export function teamRoleDefaultEffort(role: TeamRole): 'medium' | 'high' {
  return TEAM_ROLE_DEFAULTS[role].effort;
}

/**
 * Tool scope a role gets when the caller does not pass one. Explorer,
 * architect and advisor are read-only; reviewer reads and may run the
 * workspace's tests (`review`); implementer gets full tools; `other` has no
 * role default (the caller decides, as outside a team).
 */
export function teamRoleDefaultToolScope(role: TeamRole): 'read' | 'review' | 'full' | undefined {
  return TEAM_ROLE_DEFAULTS[role].toolScope;
}

/** How a role is named in a provider refusal: the advisor by its UI name, so the message reads "Independent Advisor provider unavailable". */
function teamRoleProviderLabel(role: TeamRole): string {
  return role === 'advisor' ? 'Independent Advisor' : `Team member (${role})`;
}

/**
 * Whether a provider's turn is known to enforce a member's scope and role
 * policy; the reason when it is not, and its cause: `scope`/`policy` are
 * facts about the host's code (a role default pointing at such a provider is
 * a configuration error of teamPolicy.ts), `transport` is the user's setting
 * (the provider could restrict a thread on its other transport).
 */
export type TeamProviderReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: string; readonly cause?: 'scope' | 'policy' | 'transport' };

/**
 * Where a member's provider came from: the role default (nothing named), a
 * provider or model the caller named, or a model copied from the caller
 * (spawn_session inheritModel, an Actions launch). Only the wording of a
 * refusal depends on it; the rules do not.
 */
export type TeamMemberProviderOrigin = 'default' | 'explicit' | 'inherited';

export interface TeamMemberProviderRequest {
  /** The provider the member would be created on. */
  provider: string;
  origin: TeamMemberProviderOrigin;
}

/**
 * The provider a member creation asks for, from the creation arguments, before
 * anything is normalized or created: the one place both creation paths
 * (create_session and spawn_session) agree on, so a refusal can run first on
 * either. A named provider wins; else the prefix of a named or inherited
 * model (a bare, prefix-less model means the caller's provider); else the
 * role default.
 */
export function resolveTeamMemberProvider(input: {
  role: TeamRole;
  provider?: unknown;
  model?: unknown;
  /** The model was copied from the caller rather than chosen (inheritModel). */
  modelInherited?: boolean;
  callerProvider: string | null;
}): TeamMemberProviderRequest {
  if (typeof input.provider === 'string' && input.provider) {
    return { provider: input.provider, origin: 'explicit' };
  }
  if (typeof input.model === 'string' && input.model) {
    const separator = input.model.indexOf(':');
    const prefix = separator > 0 ? input.model.slice(0, separator) : null;
    const provider = prefix ?? input.callerProvider ?? teamRoleProvider(input.role);
    return { provider, origin: input.modelInherited ? 'inherited' : 'explicit' };
  }
  return { provider: teamRoleProvider(input.role), origin: 'default' };
}

export interface TeamMemberProviderCheck extends TeamMemberProviderRequest {
  role: TeamRole;
  /** Provider of the calling session; it is available by construction (the caller is running on it). */
  callerProvider: string | null;
  /** Host-verified enforcement for `provider` at the member's scope (teamProviders.ts). */
  readiness: TeamProviderReadiness;
  /**
   * Whether `provider` is enabled for this workspace, when it had to be looked
   * up: null when the host could not verify it (then the member is refused:
   * unverified is unavailable, never assumed).
   */
  enabled: boolean | null;
  /**
   * Whether the user is signed in to `provider`, when it had to be looked up
   * (a provider other than the caller's): null when the host could not
   * verify it, which refuses the member like a missing sign-in. Undefined
   * when no check applies (the caller's own provider).
   */
  authenticated?: boolean | null;
  /**
   * The model named for the member, when one was, and whether this build
   * knows it for `provider`: null when the provider has no static catalog to
   * check against (the model is validated at its first turn instead).
   */
  model?: { id: string; known: boolean | null };
  /**
   * The provider's CLI version as the host could learn it before creating the
   * member, and the minimum this integration needs (NIB.46 item 7.8). Absent
   * when no version check applies to the provider; a null `version` means the
   * host could not learn it, which refuses the member like a missing sign-in.
   */
  cliVersion?: { version: string | null; minimum: string; supported: boolean | null };
}

/**
 * Why a member may not be created on a provider, or null when it may. Pure;
 * MetaAgentService throws it before any side effect, so no session row, no
 * workstream, no worktree and no prompt exist for a refused member.
 *
 * Fail-closed, never a fallback: a provider that does not enforce the
 * member's scope and role policy is refused whatever was asked for, and a
 * provider that is not available is refused rather than replaced by the
 * caller's. Running the member on another provider is the coordinator's (or
 * the user's) explicit choice, taken by calling again; the host never makes
 * it. The message says what was refused, why, that nothing was created and
 * that no fallback happened, so the coordinator reports it as such.
 */
export function teamMemberProviderRefusal(check: TeamMemberProviderCheck): string | null {
  const label = teamRoleProviderLabel(check.role);
  const defaultProvider = teamRoleProvider(check.role);
  const origin = check.origin === 'explicit'
    ? 'requested explicitly'
    : check.origin === 'inherited'
      ? 'inherited from the caller\'s model (inheritModel)'
      : 'the role default';
  const onDefault = `create it on the role default (${defaultProvider}), and say in your report that the member ran on that provider`;
  const readinessCause = check.readiness.ready ? null : check.readiness.cause ?? null;
  const retryOnDefault = check.origin === 'explicit'
    ? `omit provider and model to ${onDefault}`
    : check.origin === 'inherited'
      ? `omit inheritModel (and model) to ${onDefault}`
      : readinessCause === 'transport'
        ? `the default provider of the ${label} (${check.provider}) is configured on a transport that cannot keep a Team mode member read-only; the user may switch that provider's transport setting, and until then report to the user that the ${label}'s default provider is unavailable`
        : 'this is a configuration error of the role defaults (teamPolicy.ts); report it to the user';
  const noFallback = (retry: string) => `No session was created and no fallback to another provider was applied: ${retry}.`;
  // A refused role default is the role's own default provider being
  // unavailable: the host substitutes nothing; a member on another provider
  // is the caller's explicit, deliberate choice (provider and model named).
  const defaultUnavailable = check.origin === 'default'
    ? `the default provider of the ${label} is unavailable, so report it to the user as it is; running the ${check.role} on another provider is a deliberate choice you may only make by naming provider and model explicitly (when the user asked for or authorized it), and you must then report that the member ran on that provider`
    : null;
  if (!check.readiness.ready) {
    return `${label} provider unavailable: ${check.provider} (${origin}) ${check.readiness.reason}, so the ${check.role} cannot run on it. ${noFallback(retryOnDefault)}`;
  }
  if (check.model && check.model.known === false) {
    return `${label} model unavailable: ${check.model.id} is not a model of ${check.provider} this build knows, so the ${check.role} cannot be created on it. ${noFallback(`name a model of ${check.provider} this build knows, or omit the model to get the provider's default`)}`;
  }
  if (check.callerProvider !== null && check.provider === check.callerProvider) return null;
  if (check.enabled === false) {
    return `${label} provider unavailable: ${check.provider} (${origin}) is not enabled in this app's AI provider settings for this workspace. ${noFallback(`the user may enable ${check.provider} in the AI provider settings; ${defaultUnavailable ?? 'or you may name explicitly (provider and model) an enabled provider that enforces the member\'s scope; a member on another provider than asked is the caller\'s choice, never the host\'s'}`)}`;
  }
  if (check.enabled !== true) {
    return `${label} provider unavailable: ${check.provider} (${origin}) could not be verified as available (its settings were not readable). ${noFallback(defaultUnavailable ? `try again; otherwise ${defaultUnavailable}` : 'try again, or report it to the user')}`;
  }
  if (check.authenticated === false) {
    return `${label} provider unavailable: ${check.provider} (${origin}) is enabled but the user is not signed in to it. ${noFallback(`the user may sign in to ${check.provider} (its own login, never a key you configure); ${defaultUnavailable ?? 'or you may create the member on the role default'}`)}`;
  }
  if (check.authenticated === null) {
    return `${label} provider unavailable: ${check.provider} (${origin}) could not be verified as signed in. ${noFallback(defaultUnavailable ? `try again; otherwise ${defaultUnavailable}` : 'try again, or report it to the user')}`;
  }
  if (check.cliVersion && check.cliVersion.supported !== true) {
    const detail = check.cliVersion.version
      ? `its CLI is version ${check.cliVersion.version}, older than the minimum ${check.cliVersion.minimum} this integration was verified with`
      : `its CLI version could not be verified (minimum ${check.cliVersion.minimum})`;
    return `${label} provider unavailable: ${check.provider} (${origin}) ${detail}. ${noFallback(`the user may update ${check.provider} (nothing is installed or updated automatically); ${defaultUnavailable ?? 'or you may create the member on the role default'}`)}`;
  }
  return null;
}

/**
 * Whether a member's provider differs from the team root's: `diverse` when
 * the two differ, `same` when they are equal, null when either is unknown.
 * This is the whole notion of provider diversity: nothing is stored (every
 * session row has its provider), it is read when reported. A diverse advisor
 * is a second opinion from another model family; a same-provider one is
 * still an independent opinion (own session, context and instructions), only
 * not independent by provider, and must never be reported as such.
 */
export type { TeamProviderDiversity } from '@nimbalyst/runtime/ai/server/providers/teamProviderDiversity.mjs';
export { teamProviderDiversity } from '@nimbalyst/runtime/ai/server/providers/teamProviderDiversity.mjs';

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

/** Longest title the team root may give a member through send_prompt (the same cap update_session_meta applies to a name). */
export const TEAM_MEMBER_TITLE_MAX_LENGTH = 100;

/**
 * Title the team root asks for when it reuses a member: plain, non-blank text of
 * at most TEAM_MEMBER_TITLE_MAX_LENGTH characters once whitespace is collapsed,
 * and never a child-completion notification (the same recursion guard spawn
 * applies). Refused before any side effect.
 */
export function resolveRequestedMemberTitle(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('Invalid title: expected plain text.');
  }
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) {
    throw new Error('Invalid title: it is blank.');
  }
  if (title.length > TEAM_MEMBER_TITLE_MAX_LENGTH) {
    throw new Error(`Title too long (${title.length} characters; at most ${TEAM_MEMBER_TITLE_MAX_LENGTH}). Name the member's current task in a few words.`);
  }
  if (title.startsWith('[Child Session Update]')) {
    throw new Error('Refusing a title that begins with "[Child Session Update]".');
  }
  return title;
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
