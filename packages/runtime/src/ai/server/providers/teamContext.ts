/**
 * Team mode session metadata.
 *
 * A team root is a normal (agentRole 'standard') Claude Code session created
 * with `metadata.teamMode: true`. Every session created from inside the team
 * carries `metadata.teamChild` ({ role, rootSessionId, depth }). Both keys are
 * written only at creation and are immutable afterwards (the session store
 * drops them from every metadata update).
 */

export type TeamRole = 'explorer' | 'implementer' | 'reviewer' | 'other';

export const TEAM_ROLES: readonly TeamRole[] = ['explorer', 'implementer', 'reviewer', 'other'];

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

export interface TeamChild {
  role: TeamRole;
  rootSessionId: string;
  /** Root is 0, its children 1, grandchildren 2. */
  depth: number;
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
  return { role, rootSessionId, depth };
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
