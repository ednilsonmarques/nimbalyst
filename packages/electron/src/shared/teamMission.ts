/**
 * The contract of the `teamMission` field of `sessions:create` that both sides
 * must agree on: the limits the main process enforces and the codes it refuses
 * with. Pure and dependency-free so the renderer (the creation dialog) and the
 * main (services/team/teamMissions.ts, which re-exports these) read ONE source.
 * The rules themselves (what a valid front is, one active mission per front)
 * live in the main only.
 */

/** A mission goal is one or two plain sentences. */
export const TEAM_MISSION_GOAL_MAX_CHARS = 400;
export const TEAM_MISSION_DONE_CRITERION_MAX_CHARS = 400;

/**
 * Why the main refused a mission: a stable code, never an unexpected failure. The array is the
 * single list; the type is derived from it, so a code cannot exist in one and not the other.
 */
export const TEAM_MISSION_ERROR_CODES = [
  'invalid-request',
  'not-a-team-root',
  'session-exists',
  'front-not-found',
  'front-unavailable',
  'mission-active',
] as const;
export type TeamMissionErrorCode = (typeof TEAM_MISSION_ERROR_CODES)[number];

/** Failures that never reach the main (no local workspace, a remote machine selected, no Standard preset). */
export const TEAM_MISSION_CLIENT_ERROR_CODES = ['no-workspace', 'remote-host', 'preset-unavailable'] as const;
export type TeamMissionClientErrorCode = (typeof TEAM_MISSION_CLIENT_ERROR_CODES)[number];

/** The explicit payload field: what the user states. The main validates and decides everything else. */
export interface TeamMissionRequestPayload {
  /** The item id of the `team-front` (not an issue key, a local number or a URN). */
  front: string;
  goal: string;
  doneCriterion?: string;
}
