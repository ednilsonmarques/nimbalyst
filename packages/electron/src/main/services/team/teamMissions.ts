/**
 * Creating a mission (F1 S4): the one place where a new Team mode root gets its
 * mission keys.
 *
 * A mission is a team root that works for a front (a `team-front` tracker item)
 * with a goal. The renderer states the intention in the explicit `teamMission`
 * field of `sessions:create` (never in the session metadata); this module
 * decides. It validates the request, checks that the front exists and can take a
 * mission, refuses a second active mission on the same front, assembles the
 * bootstrap block, writes the mission keys through `applyHostTeamRootLifecycle`
 * and inserts the row, all under a lock per session id and per front so two
 * creations cannot both pass the check.
 *
 * The authority on "a front has an active mission" is the roots themselves: a
 * non-archived mission root (one carrying the host marker, see
 * `isHostMissionRoot`) whose `teamFront` is the front and whose status is not
 * `closed`. Archiving the root, or the host closing the mission (F2), frees the
 * front. A root that merely has a `teamFront` stored without the marker was
 * written before the keys were host-owned and counts for nothing.
 *
 * The lock lives in this process, which is enough: the main process is the only
 * creator of team roots (renderer `sessions:create`; the headless node store has
 * its own database and never creates a team root) and it owns the single
 * database worker. Roots created without `teamMission` are legacy roots and do
 * not take part (NIB.135).
 */

import * as path from 'path';
import type { CreateSessionPayload } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { isHostMissionRoot } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { TEAM_FRONT_TYPE } from '@nimbalyst/tracker-core';
import {
  TEAM_MISSION_GOAL_MAX_CHARS,
  TEAM_MISSION_DONE_CRITERION_MAX_CHARS,
  type TeamMissionErrorCode,
} from '../../../shared/teamMission';
import { applyHostTeamRootLifecycle } from './teamSessionMetadata';
import { buildTeamMissionContext, detectPolicyFiles } from './teamMissionContext';

/** The id of a tracker item is at most this long (and made of the characters below). */
export const TEAM_MISSION_FRONT_ID_MAX_CHARS = 128;
// The goal/done-criterion limits and the error codes are shared with the renderer's creation
// dialog (shared/teamMission.ts): one source, re-exported here so every import keeps working.
export { TEAM_MISSION_GOAL_MAX_CHARS, TEAM_MISSION_DONE_CRITERION_MAX_CHARS } from '../../../shared/teamMission';
export type { TeamMissionErrorCode } from '../../../shared/teamMission';

const FRONT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const REQUEST_KEYS: readonly string[] = ['front', 'goal', 'doneCriterion'];

/** A refusal the caller can show: a stable code and a message that says what to do. Never an unexpected failure. */
export class TeamMissionError extends Error {
  constructor(readonly code: TeamMissionErrorCode, message: string) {
    super(message);
    this.name = 'TeamMissionError';
  }
}

export interface TeamMissionRequest {
  /** The item id of the `team-front` (not an issue key, a local number or a URN). */
  front: string;
  goal: string;
  doneCriterion?: string;
}

function invalid(message: string): never {
  throw new TeamMissionError('invalid-request', message);
}

function boundedText(value: unknown, name: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null) {
    if (required) invalid(`teamMission.${name} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') invalid(`teamMission.${name} must be a string.`);
  const text = value.trim();
  if (!text) {
    if (required) invalid(`teamMission.${name} must not be blank.`);
    return undefined;
  }
  if (text.length > max) invalid(`teamMission.${name} is ${text.length} characters; the limit is ${max}.`);
  if (CONTROL_CHARS.test(text.replace(/[\t\n\r]/g, ' '))) invalid(`teamMission.${name} contains control characters.`);
  return text;
}

/**
 * The shape of the explicit payload field. A closed contract: only `front`,
 * `goal` and `doneCriterion`; any other key (the context, a status, a marker) is
 * refused rather than ignored, so nothing can ride along.
 */
export function parseTeamMissionRequest(raw: unknown): TeamMissionRequest {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('teamMission must be an object with a front and a goal.');
  }
  const record = raw as Record<string, unknown>;
  const extraKeys = Object.keys(record).filter((key) => !REQUEST_KEYS.includes(key));
  if (extraKeys.length > 0) invalid(`teamMission has unknown keys: ${extraKeys.join(', ')}.`);

  const front = boundedText(record.front, 'front', TEAM_MISSION_FRONT_ID_MAX_CHARS, true) as string;
  if (!FRONT_ID_PATTERN.test(front)) {
    invalid('teamMission.front must be the id of a team-front item (letters, digits, "-", "_" and "."), not a title or a reference.');
  }
  const goal = boundedText(record.goal, 'goal', TEAM_MISSION_GOAL_MAX_CHARS, true) as string;
  const doneCriterion = boundedText(record.doneCriterion, 'doneCriterion', TEAM_MISSION_DONE_CRITERION_MAX_CHARS, false);
  return { front, goal, ...(doneCriterion ? { doneCriterion } : {}) };
}

/** What the host reads of a front item. */
export interface TeamFrontRecord {
  id: string;
  title: string;
  type: string;
  status: string | null;
  archived: boolean;
  description: string | null;
}

/** The persistence the creation needs; the SQL implementation is teamMissionPorts.ts. */
export interface TeamMissionPorts {
  sessionExists(sessionId: string): Promise<boolean>;
  /** The stored metadata of a session, or null when there is no such row (read back after the insert). */
  getSessionMetadata(sessionId: string): Promise<Record<string, unknown> | null>;
  /** The item with this id in this workspace, or null (missing, a tombstone, or another workspace). */
  getFront(frontId: string, workspaceId: string): Promise<TeamFrontRecord | null>;
  /** The non-archived host mission root of the front whose mission is not closed, if any. */
  findActiveMissionRoot(frontId: string): Promise<{ id: string; title: string | null } | null>;
  createSession(payload: CreateSessionPayload): Promise<void>;
}

export interface TeamMissionDeps {
  /** Policy files present at the workspace root (existence only). */
  policyFiles?: (workspaceId: string) => string[];
}

// ---------------------------------------------------------------------------
// The locks. A mission creation takes two, always in this order: the SESSION id
// first (the renderer chooses it, and the insert is an upsert that keeps the
// first row, so two creations with one id must not both pass the "does it
// exist" check), then the FRONT (keyed by the front's item id, a primary key
// that already implies the workspace). One fixed order for every caller means
// no cycle, so no deadlock. Every `sessions:create` takes the session lock, a
// plain (legacy) one included (withSessionIdLock), so a legacy create and a
// mission create with one id serialise; only a mission takes the front lock.
// Creations on other sessions and fronts never wait. Released on every outcome.
// The post-insert check in createTeamMissionRoot keeps the guarantee from
// depending on lock coverage alone.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

/** Locks currently held or queued (for tests: it must be zero when nothing is running). */
export function teamFrontLockCount(): number {
  return locks.size;
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  // `previous` is a tail that never rejects, so the task runs after every earlier one has settled.
  const run = previous.then(task);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

/**
 * Run `task` after every earlier task on the same session id has settled. What
 * `sessions:create` wraps its insert in, mission or not. An id that is not a
 * non-empty string (the renderer sent none) has nothing to serialise on: the task
 * just runs, as it always did.
 */
export function withSessionIdLock<T>(sessionId: unknown, task: () => Promise<T>): Promise<T> {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return task();
  return withLock(`session:${sessionId}`, task);
}

/** Session lock, then front lock: the only order in which these are ever taken. */
function withMissionLocks<T>(sessionId: string, frontId: string, task: () => Promise<T>): Promise<T> {
  return withSessionIdLock(sessionId, () => withLock(`front:${frontId}`, task));
}

function frontUnavailableReason(front: TeamFrontRecord): string | null {
  if (front.type !== TEAM_FRONT_TYPE) return 'it is not a team-front';
  if (front.archived) return 'it is archived';
  if (front.status === null) return 'it has no status';
  if (front.status !== 'active') return `its status is "${front.status}"; set it to active first`;
  return null;
}

export interface CreateTeamMissionRootInput {
  /** The root row as `sessions:create` built it: metadata already through the renderer sanitizer. */
  payload: CreateSessionPayload;
  /** The raw `teamMission` field of the request. */
  request: unknown;
}

/**
 * Create a mission root, or refuse with a `TeamMissionError`.
 *
 * What is guaranteed:
 * - Every refusal raised before the insert (request, front, active mission, id)
 *   and a failing insert write nothing: the row is one statement, done after all
 *   the checks.
 * - A success means the stored row carries the host marker and this front (it is
 *   read back after the insert).
 *
 * What is not:
 * - If the read-back itself fails, the caller gets that error although the row may
 *   exist and hold the front; a retry then meets `mission-active`.
 * - If a writer outside the session lock took the id first, the call is refused
 *   (`session-exists`), but the upsert has already applied its ordinary columns
 *   (title, model, provider, ...) to that row; only the team keys are kept as stored.
 *   Nothing is rolled back.
 */
export async function createTeamMissionRoot(
  input: CreateTeamMissionRootInput,
  ports: TeamMissionPorts,
  deps: TeamMissionDeps = {},
): Promise<void> {
  const request = parseTeamMissionRequest(input.request);
  const { payload } = input;
  // The renderer chooses the session id and names the workspace: both must be real strings.
  if (typeof payload.id !== 'string' || !payload.id.trim()) invalid('A mission needs a session id.');
  if (typeof payload.workspaceId !== 'string' || !payload.workspaceId.trim()) invalid('A mission needs a workspace.');

  // Only a brand-new coordinator root can be a mission: a team root (teamMode,
  // after the renderer sanitizer), created by the user (not by a session), in the
  // standard role. Checked before any port is touched.
  const isTeamRoot = payload.metadata?.teamMode === true;
  const isStandardRole = (payload.agentRole ?? 'standard') === 'standard';
  if (!isTeamRoot || payload.createdBySessionId || !isStandardRole) {
    throw new TeamMissionError('not-a-team-root', 'A mission can only be started on a new Team mode session created by the user.');
  }

  await withMissionLocks(payload.id, request.front, async () => {
    if (await ports.sessionExists(payload.id)) {
      throw new TeamMissionError('session-exists', `Session ${payload.id} already exists; a mission starts only on a new session.`);
    }

    const front = await ports.getFront(request.front, payload.workspaceId);
    if (!front) {
      throw new TeamMissionError(
        'front-not-found',
        `No team-front with id "${request.front}" exists in this workspace. Create the front in the Tracker and pass its item id (not its issue key).`,
      );
    }
    const unavailable = frontUnavailableReason(front);
    if (unavailable) {
      throw new TeamMissionError('front-unavailable', `Front "${front.title}" (${front.id}) cannot take a new mission: ${unavailable}.`);
    }

    const active = await ports.findActiveMissionRoot(front.id);
    if (active) {
      throw new TeamMissionError(
        'mission-active',
        `Front "${front.title}" (${front.id}) already has an active mission (session ${active.id}${active.title ? `, "${active.title}"` : ''}); close or archive it, or choose another front.`,
      );
    }

    const context = buildTeamMissionContext({
      workspaceName: path.basename(payload.workspaceId) || payload.workspaceId,
      policyFiles: (deps.policyFiles ?? detectPolicyFiles)(payload.workspaceId),
      goal: request.goal,
      doneCriterion: request.doneCriterion,
      front: { id: front.id, title: front.title, status: front.status, description: front.description },
    });
    const lifecycle = applyHostTeamRootLifecycle(payload.metadata ?? {}, {
      front: front.id,
      goal: request.goal,
      context,
      doneCriterion: request.doneCriterion,
    });
    if (!lifecycle.applied) throw new TeamMissionError('not-a-team-root', lifecycle.reason);

    await ports.createSession({ ...payload, metadata: lifecycle.metadata });

    // The insert is an upsert that keeps an existing row's team keys. If a writer that does not
    // take the session lock got this id in between, the stored row is not the mission we meant to
    // create: read it back and refuse rather than report a mission that does not exist. This only
    // refuses; it does not undo what the upsert already wrote to that row's ordinary columns.
    const stored = await ports.getSessionMetadata(payload.id);
    if (!isHostMissionRoot(stored) || stored.teamFront !== front.id) {
      throw new TeamMissionError(
        'session-exists',
        `Session ${payload.id} was created by something else at the same moment, so the mission was not started. Try again.`,
      );
    }
  });
}
