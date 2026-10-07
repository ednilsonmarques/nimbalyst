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
