/**
 * Pure helpers of the "new mission" dialog (F1 S5): what the front picker shows,
 * how the typed text is measured and sent, and which message a refusal of the
 * main gets. No business rule lives here: the main (services/team/teamMissions.ts)
 * validates the front, the limits and the one-active-mission-per-front rule again
 * on every request; this only decides how the dialog presents them.
 */

import { TEAM_ROOT_PRESETS, type TeamRootPreset } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import type {
  TeamMissionClientErrorCode,
  TeamMissionErrorCode,
  TeamMissionRequestPayload,
} from '../../../shared/teamMission';
import type { CreateTeamMissionInput } from '../../store/actions/sessionHistoryActions';

/**
 * The input of the create action for a mission: the user's request on the Standard coordinator
 * preset (Opus, high), as the ECC Architect action uses. Null when there is no Standard preset:
 * the caller must refuse, never fall back to another preset (a different model, maybe a costlier one).
 */
export function buildTeamMissionCreateInput(
  teamMission: TeamMissionRequestPayload,
  presets: readonly TeamRootPreset[] = TEAM_ROOT_PRESETS,
): CreateTeamMissionInput | null {
  const standard = presets.find((preset) => preset.id === 'standard');
  if (!standard) return null;
  return { teamMission, model: standard.model, effortLevel: standard.effortLevel, launchSource: 'session_history' };
}

export type TeamFrontStatusKind = 'active' | 'paused' | 'closed' | 'unknown';

/** One static key per status the dialog knows, and a fallback for anything else. */
const STATUS_LABEL_KEYS: Record<TeamFrontStatusKind, string> = {
  active: 'teamMissionDialog.status.active',
  paused: 'teamMissionDialog.status.paused',
  closed: 'teamMissionDialog.status.closed',
  unknown: 'teamMissionDialog.status.unknown',
};

export function teamFrontStatusLabelKey(status: TeamFrontStatusKind): string {
  return Object.prototype.hasOwnProperty.call(STATUS_LABEL_KEYS, status) ? STATUS_LABEL_KEYS[status] : STATUS_LABEL_KEYS.unknown;
}

export interface TeamFrontOption {
  /** The item id of the front: what `teamMission.front` carries. */
  id: string;
  title: string;
  status: TeamFrontStatusKind;
  /** Only an active front can take a new mission (decision NIB.168). */
  selectable: boolean;
}

const TEAM_FRONT_TYPE = 'team-front';
const KNOWN_STATUSES: readonly string[] = ['active', 'paused', 'closed'];

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Read a field the way the main does (S4 getFront): the synced `customFields` bag first, then the item. */
function readField(item: Record<string, unknown>, name: string): unknown {
  const bag = item.customFields;
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    const nested = (bag as Record<string, unknown>)[name];
    if (nested !== undefined) return nested;
  }
  return item[name];
}

/**
 * The options of the front picker, from the tracker items of type `team-front`.
 * Archived items are left out (the main refuses them); paused, closed and
 * status-less fronts stay in the list, disabled, with their status visible.
 * Active fronts come first; the original order is kept inside each group.
 */
export function toTeamFrontOptions(items: unknown): TeamFrontOption[] {
  if (!Array.isArray(items)) return [];
  const options: TeamFrontOption[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (item.type !== undefined && item.type !== TEAM_FRONT_TYPE) continue;
    if (item.archived === true) continue;
    const id = text(item.id);
    if (!id) continue;
    const rawStatus = readField(item, 'status');
    const status: TeamFrontStatusKind =
      typeof rawStatus === 'string' && KNOWN_STATUSES.includes(rawStatus) ? (rawStatus as TeamFrontStatusKind) : 'unknown';
    options.push({
      id,
      title: text(readField(item, 'title'))?.trim() ?? id,
      status,
      selectable: status === 'active',
    });
  }
  return [...options.filter((o) => o.selectable), ...options.filter((o) => !o.selectable)];
}

export interface FieldUsage {
  /** Length of the trimmed text: what the main measures against the limit. */
  used: number;
  over: boolean;
  blank: boolean;
}

export function fieldUsage(value: string, max: number): FieldUsage {
  const used = value.trim().length;
  return { used, over: used > max, blank: used === 0 };
}

/**
 * The explicit `teamMission` payload field: the front id and the text exactly as
 * typed (the main trims and validates). The done criterion is left out only when
 * the field is empty. Nothing else can ride along: the main refuses unknown keys.
 */
export function buildTeamMissionRequest(input: {
  front: string;
  goal: string;
  doneCriterion: string;
}): TeamMissionRequestPayload {
  return {
    front: input.front,
    goal: input.goal,
    ...(input.doneCriterion !== '' ? { doneCriterion: input.doneCriterion } : {}),
  };
}

/** Refusals that mean what the dialog showed was out of date: reload the fronts. */
export const TEAM_MISSION_REFRESH_CODES: readonly TeamMissionErrorCode[] = [
  'front-unavailable',
  'front-not-found',
  'mission-active',
];

const GENERIC_ERROR_KEY = 'teamMissionDialog.errors.generic';
const ERROR_KEY_BY_CODE: Record<TeamMissionErrorCode | TeamMissionClientErrorCode, string> = {
  'invalid-request': 'teamMissionDialog.errors.invalidRequest',
  'not-a-team-root': 'teamMissionDialog.errors.notATeamRoot',
  'session-exists': 'teamMissionDialog.errors.sessionExists',
  'front-not-found': 'teamMissionDialog.errors.frontNotFound',
  'front-unavailable': 'teamMissionDialog.errors.frontUnavailable',
  'mission-active': 'teamMissionDialog.errors.missionActive',
  'no-workspace': 'teamMissionDialog.errors.noWorkspace',
  'remote-host': 'teamMissionDialog.errors.remoteHost',
  'preset-unavailable': 'teamMissionDialog.errors.presetUnavailable',
};

/**
 * After which outcomes the dialog looks for the mission that occupies the front: the front is taken
 * (mission-active), or the outcome is unknown (no code at all: the write may have happened).
 */
export function shouldLookUpActiveMission(errorCode: string | undefined): boolean {
  return errorCode === undefined || errorCode === 'mission-active';
}

/** How many found missions the dialog lists before saying there are more. */
export const MAX_LISTED_ACTIVE_MISSIONS = 5;

/** The short form of a session id shown next to the goal. */
export function shortMissionId(id: string): string {
  return id.slice(0, 8);
}

/** One static key per text of the active-mission lookup (the JSON has exactly these, no more). */
export const TEAM_MISSION_LOOKUP_KEYS = {
  heading: 'teamMissionDialog.activeMission.heading',
  headingMany: 'teamMissionDialog.activeMission.headingMany',
  open: 'teamMissionDialog.activeMission.open',
  noGoal: 'teamMissionDialog.activeMission.noGoal',
  none: 'teamMissionDialog.activeMission.none',
  noneAfterFailure: 'teamMissionDialog.activeMission.noneAfterFailure',
  failed: 'teamMissionDialog.activeMission.failed',
  openFailed: 'teamMissionDialog.activeMission.openFailed',
  looking: 'teamMissionDialog.activeMission.looking',
  more: 'teamMissionDialog.activeMission.more',
} as const;

/** The i18n key (namespace `agent`) of the message for an error code; the generic one when unknown or absent. */
export function teamMissionErrorKey(code: string | undefined): string {
  if (code === undefined || !Object.prototype.hasOwnProperty.call(ERROR_KEY_BY_CODE, code)) return GENERIC_ERROR_KEY;
  return ERROR_KEY_BY_CODE[code as keyof typeof ERROR_KEY_BY_CODE];
}
