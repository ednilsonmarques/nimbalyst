/**
 * Team mode session metadata.
 *
 * A team root is a normal (agentRole 'standard') Claude Code session created
 * with `metadata.teamMode: true`. Every session created from inside the team
 * carries `metadata.teamChild` ({ role, rootSessionId, depth }). Both keys are
 * written only at creation and are immutable afterwards (the session store
 * drops them from every metadata update).
 */

/**
 * Member roles. `architect` prepares a task before anyone executes it: it
 * reads, reasons and delivers a Tool Manifest (toolManifest.ts); it runs
 * read-only, cannot ask the user, delegate or create tasks, and never
 * implements. Its defaults live in teamPolicy.ts (Opus, high, read forced) and
 * its extra tool denials in toolPolicy.ts (ARCHITECT_DENIED_TOOLS).
 *
 * `advisor` (UI: "Consultor Independente" / "Independent Advisor") gives a
 * second, independent opinion on the team's direction: the architect's plan,
 * the coordinator's strategy, the implementer's result and the reviewer's
 * verdict. It is not a second reviewer (the reviewer checks the change against
 * the plan; the advisor questions the plan and the conclusion themselves). Its
 * intellectual autonomy is wide, its operational authority is none: it runs
 * read-only like the architect (teamPolicy.ts: strong model, high effort, read
 * forced; toolPolicy.ts: ADVISOR_DENIED_TOOLS), is created only when the
 * coordinator explicitly decides to, and its opinion binds nobody. The role is
 * provider-agnostic by design: which provider and model run it is decided in
 * teamPolicy.ts alone (teamRoleProvider / teamRoleDefaultModel), never here.
 */
export type TeamRole = 'explorer' | 'implementer' | 'reviewer' | 'architect' | 'advisor' | 'other';

export const TEAM_ROLES: readonly TeamRole[] = ['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other'];

export const TEAM_MODE_METADATA_KEY = 'teamMode';
export const TEAM_CHILD_METADATA_KEY = 'teamChild';
/**
 * `metadata.teamBudget` on a team root: `{ authorized, extensions }`, the number
 * of sessions the user has authorized this team to create. Absent means the
 * initial budget. Written only by the host when the user continues the team.
 */
export const TEAM_BUDGET_METADATA_KEY = 'teamBudget';

/**
 * Transcript card shown in a team root when a creation is refused for budget.
 * Not an interactive prompt: it is answered only through the renderer's
 * `team:continue` IPC, never through respond_to_prompt, mobile or voice.
 */
export const TEAM_CHECKPOINT_TOOL_NAME = 'TeamCheckpoint';

/**
 * `promptOrigin` of the notice the host queues for the coordinator once the
 * user continues the team. The transcript shows a prompt of this origin as a
 * system status line (never as a user message), with this as its reminder kind.
 */
export const TEAM_CHECKPOINT_PROMPT_ORIGIN = 'team_checkpoint';

/**
 * `promptOrigin` of the host notice telling a coordinator that an architect's
 * Tool Manifest was stored as a tracker item (Phase 1B): a system status line
 * in the transcript, never a "You" message.
 */
export const TOOL_MANIFEST_PROMPT_ORIGIN = 'tool_manifest';

/**
 * `metadata.toolManifestRef` of a team root: a short pointer (item id, ref,
 * manifest id, architect session) to the team's current Tool Manifest. Written
 * only by the host (services/team/toolManifests.ts); creation-only for every
 * ordinary metadata write, never the manifest itself.
 */
export const TOOL_MANIFEST_REF_METADATA_KEY = 'toolManifestRef';

/**
 * Lifecycle keys of a team root (a mission): which front it works for, its goal,
 * its status, the bootstrap block and the done criterion. HOST-OWNED: written
 * only by the host with the root row (applyHostTeamRootLifecycle) and, for the
 * status, by the host when the mission closes. Every ordinary metadata write
 * drops them and a renderer create cannot carry them, so a note's `front` (copied
 * from `teamFront`) cannot be forged by choosing it at creation. Local to the
 * machine: they are not in the sync whitelists.
 */
export const TEAM_FRONT_METADATA_KEY = 'teamFront';
export const TEAM_GOAL_METADATA_KEY = 'teamGoal';
export const TEAM_MISSION_STATUS_METADATA_KEY = 'teamMissionStatus';
export const TEAM_MISSION_CONTEXT_METADATA_KEY = 'teamMissionContext';
export const TEAM_DONE_CRITERION_METADATA_KEY = 'teamDoneCriterion';

/** `teamMissionStatus`: `active` from creation, `closed` once the host closes the mission. */
export const TEAM_MISSION_STATUSES = ['active', 'closed'] as const;
export type TeamMissionStatus = (typeof TEAM_MISSION_STATUSES)[number];

/**
 * Longest mission a team member may be created with. A mission is one or two
 * plain sentences of focus, never a brief: the brief is the first prompt.
 */
export const TEAM_MISSION_MAX_LENGTH = 400;

export interface TeamChild {
  role: TeamRole;
  rootSessionId: string;
  /** Root is 0, its children 1, grandchildren 2. */
  depth: number;
  /**
   * The member's mission: what this particular session must do, set by the
   * coordinator at creation (`create_session.mission`) and immutable with the
   * rest of `teamChild`. Plain text, at most TEAM_MISSION_MAX_LENGTH
   * characters, whitespace collapsed. It reaches the member through its system
   * prompt as context, next to its role; it is never a permission: the scope
   * (toolScope), the role's denials, the model and the effort are decided by
   * their own policy and read none of this text. Absent on members created
   * before missions existed and on members created without one.
   */
  mission?: string;
}

/**
 * A mission as stored: trimmed, every run of whitespace (newlines included)
 * collapsed to one space. Undefined for anything that is not a non-blank
 * string. Length is not judged here: the creation path refuses an over-long
 * mission (teamPolicy.ts), and a reader never truncates what the host stored.
 */
export function normalizeTeamMission(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const mission = raw.replace(/\s+/g, ' ').trim();
  return mission ? mission : undefined;
}

export interface TeamContext {
  /** This session is a team root. */
  teamMode: boolean;
  /** This session was created inside a team. */
  teamChild: TeamChild | null;
}

export const NO_TEAM: TeamContext = Object.freeze({ teamMode: false, teamChild: null });

export function parseTeamRole(raw: unknown): TeamRole | null {
  return typeof raw === 'string' && (TEAM_ROLES as readonly string[]).includes(raw) ? (raw as TeamRole) : null;
}

export function parseTeamChild(raw: unknown): TeamChild | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const role = parseTeamRole(record.role);
  const rootSessionId = typeof record.rootSessionId === 'string' && record.rootSessionId ? record.rootSessionId : null;
  const depth = typeof record.depth === 'number' && Number.isInteger(record.depth) && record.depth > 0 ? record.depth : null;
  if (!role || !rootSessionId || depth === null) return null;
  // A malformed mission never invalidates the member: role, root and depth
  // are the policy; the mission is context and is simply absent.
  const mission = normalizeTeamMission(record.mission);
  return mission ? { role, rootSessionId, depth, mission } : { role, rootSessionId, depth };
}

/**
 * Team context of a session from its metadata. Meta-agents never take part:
 * they have their own orchestration persona and tool set.
 */
export function resolveTeamContext(
  metadata: Record<string, unknown> | null | undefined,
  agentRole?: string | null,
): TeamContext {
  if (!metadata || agentRole === 'meta-agent') return NO_TEAM;
  const teamChild = parseTeamChild(metadata[TEAM_CHILD_METADATA_KEY]);
  const teamMode = metadata[TEAM_MODE_METADATA_KEY] === true && !teamChild;
  if (!teamMode && !teamChild) return NO_TEAM;
  return { teamMode, teamChild };
}

export type TeamRootPresetId = 'standard' | 'large' | 'critical';

export interface TeamRootPreset {
  id: TeamRootPresetId;
  model: string;
  effortLevel: 'high' | 'max';
}

/**
 * Coordinator presets offered by "New Team mode session". Never the `-1m`
 * variants: those stay an explicit choice (they can bill usage credits).
 */
export const TEAM_ROOT_PRESETS: readonly TeamRootPreset[] = Object.freeze([
  { id: 'standard', model: 'claude-code:opus', effortLevel: 'high' },
  { id: 'large', model: 'claude-code:fable', effortLevel: 'high' },
  { id: 'critical', model: 'claude-code:fable', effortLevel: 'max' },
]);

/**
 * Directive of a team started with "Prepare with ECC Architect" (Phase 1C).
 * Stored as the root's creation-only `metadata.sessionDirective`, so it reaches
 * the coordinator through its system prompt: the renderer never creates the
 * architect, the coordinator does, under the Team Mode rules. The user asked
 * for the architect, which is why it is not optional here.
 */
export const ECC_ARCHITECT_FIRST_DIRECTIVE =
  'This team was started with "Prepare with ECC Architect": the user asked for the ECC Architect to prepare the task before anyone executes it, so the architect is not optional here, even for a task that looks trivial. Before any other member, delegation or implementation, create the architect (role `architect`, on its role defaults) as the first member, with the complete brief the Team Mode rules describe, and wait for its Tool Manifest. Then declare per that manifest, or diverge from it as the rules say, before creating anyone else. You remain the coordinator and the only authority: a manifest is a recommendation, never a decision or a permission, and nothing in it widens a scope.';

/**
 * Whether a Team mode coordinator runs at least at the recommended tier (any
 * Opus or Fable variant). Used only to warn: a user's manual choice always wins.
 */
export function isRecommendedTeamRootModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const separator = model.indexOf(':');
  const provider = separator === -1 ? '' : model.slice(0, separator);
  const variant = (separator === -1 ? model : model.slice(separator + 1)).toLowerCase();
  return provider === 'claude-code' && /^(opus|fable)(\b|-)/.test(variant);
}
