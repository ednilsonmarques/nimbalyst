/**
 * Structural rules of the `team-front` tracker type (runtime TrackerPlugin
 * builtins/team-front.yaml), shared by every local write path: the app's agent
 * tools, the desktop Tracker UI and the IPC behind it, the host's own writes
 * and the offline CLI. They live in tracker-core so the CLI bundle carries the
 * same rule as the app (see protectedTrackerTypes.ts, the single entry the
 * write funnels call). Pure: callers decide how to refuse (throw, tool error).
 *
 * A front is a permanent area of work (a "Team Mode", a "Portal"): its title,
 * its status and its description (the state of the front, with the document
 * that has precedence) belong to the user. It is never created by an agent:
 * the user defines the fronts in the Tracker UI, or with the offline nim CLI
 * (DirectGateway; with the app open, nim goes through the agent tools). The
 * coordinator may keep the state current, so an agent may update the
 * description and nothing else. `currentMission` (the one active mission of the
 * front) is a projection the host writes; nobody else sets it.
 *
 * Not applied to incoming sync: refusing a remote row would break convergence.
 */
import { teamNoteStoredBodyLength } from './teamNoteRules.js';

export const TEAM_FRONT_TYPE = 'team-front';
/** The state of the front (description) and a rich body, in visible characters. */
export const TEAM_FRONT_DESCRIPTION_MAX_CHARS = 2000;
export const TEAM_FRONT_STATUSES = ['active', 'paused', 'closed'] as const;
/** Written only by Nimbalyst (the host's own persistence); never by the user or an agent. */
export const TEAM_FRONT_HOST_FIELDS = ['currentMission'] as const;
/** The only fields an agent (the coordinator) may update. */
export const TEAM_FRONT_AGENT_EDITABLE_FIELDS = ['description'] as const;

export const TEAM_FRONT_AGENT_CREATE_ERROR =
  'A team-front is created by the user in the Tracker UI (or the offline nim CLI), never by an agent or tracker_create. ' +
  'Ask the user to create it; you may then keep its description current.';

/** The refusal of an agent's update: it names every key it refused. */
export function teamFrontAgentUpdateError(refusedKeys: readonly string[]): string {
  return (
    `An agent may update only the description of a team-front; refused: ${refusedKeys.join(', ')}. ` +
    `The title and status are the user's, currentMission is Nimbalyst's.`
  );
}

type Data = Record<string, unknown> | null | undefined;

/** Read a field from either storage shape (top level or the synced `customFields` bag). */
export function readTeamFrontField(data: Data, name: string): unknown {
  const nested = data?.customFields;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && name in nested) {
    const value = (nested as Record<string, unknown>)[name];
    if (value !== undefined) return value;
  }
  return data?.[name];
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export function teamFrontTitleError(title: unknown): string | null {
  if (typeof title === 'string' && title.trim().length > 0) return null;
  return 'Team Front needs a title.';
}

export function teamFrontStatusError(status: unknown): string | null {
  if (typeof status === 'string' && (TEAM_FRONT_STATUSES as readonly string[]).includes(status)) return null;
  return `Team Front status must be one of: ${TEAM_FRONT_STATUSES.join(', ')}.`;
}

export const TEAM_FRONT_STATE_ERROR = 'A team-front needs its state: write a description or a body.';

/**
 * Visible length of a front's body as any funnel carries it: markdown text (the
 * create payload, the CLI), a rich-text document, or the stored column, which is
 * either of those JSON-encoded (a JSON-quoted string, or a document as text).
 */
export function teamFrontBodyLength(body: unknown): number {
  return teamNoteStoredBodyLength(body);
}

function descriptionLength(description: unknown): number {
  return typeof description === 'string' ? description.trim().length : 0;
}

/** The state of a front is its description or its body; at least one must say something. */
export function teamFrontStateError(description: unknown, body: unknown): string | null {
  if (descriptionLength(description) > 0 || teamFrontBodyLength(body) > 0) return null;
  return TEAM_FRONT_STATE_ERROR;
}

/** The description is the state of the front, and so is a rich body saved with it. */
export function teamFrontBodyError(body: unknown): string | null {
  const length = teamFrontBodyLength(body);
  if (length <= TEAM_FRONT_DESCRIPTION_MAX_CHARS) return null;
  return (
    `Team Front description is ${length} characters; the limit is ${TEAM_FRONT_DESCRIPTION_MAX_CHARS}. ` +
    `Keep the goal, the situation and the pointers, and name the document that has precedence.`
  );
}

export interface TeamFrontValidationOptions {
  mode: 'create' | 'update';
  /** Stored data before an update; required in update mode. */
  before?: Data;
  /** The host's own persistence: the only writer of currentMission. */
  hostOwned?: boolean;
  /**
   * The body the item will have. On create, what the payload carries (absent =
   * none). On update, the body as stored, when the funnel can see it (`null` =
   * visible and empty); `undefined` = the funnel cannot see it, and the state is
   * not judged (the rule prevents forgetting, it is not a security barrier).
   */
  body?: unknown;
  /**
   * On update: the funnel writes the body together with the description (it
   * overwrites the stored body with the new description). The resulting pair is
   * then judged whether or not the description's length changed: a front whose
   * state is only its body must not lose it to an empty description.
   */
  writesBody?: boolean;
}

/**
 * Problems with a front's data as it is about to be stored (`after` is the full
 * merged data). Empty when valid. Who may write what (agent restrictions) is
 * `assertTeamFrontUpdate`'s: this is the structure every writer meets.
 */
export function validateTeamFrontData(after: Data, options: TeamFrontValidationOptions): string[] {
  const errors: string[] = [];
  const titleError = teamFrontTitleError(readTeamFrontField(after, 'title'));
  if (titleError) errors.push(titleError);
  const status = readTeamFrontField(after, 'status');
  if (!isEmpty(status) || options.mode === 'update') {
    const statusError = teamFrontStatusError(status);
    if (statusError) errors.push(statusError);
  }
  const bodyError = teamFrontBodyError(readTeamFrontField(after, 'description'));
  if (bodyError) errors.push(bodyError);

  // The state: a description or a body. On create always judged. On update only
  // when the funnel can see the resulting body and the write touches the state: it
  // cleared the description, or it writes the body together with the description
  // (so an empty description would overwrite a body that was the state). An
  // unrelated edit of a front that already lacks a state (one synced from an
  // older peer) is not held up by it.
  const description = readTeamFrontField(after, 'description');
  const touchesDescription = options.mode === 'create'
    || options.writesBody === true
    || descriptionLength(description) !== descriptionLength(readTeamFrontField(options.before, 'description'));
  if (touchesDescription && (options.mode === 'create' || options.body !== undefined)) {
    const stateError = teamFrontStateError(description, options.body);
    if (stateError) errors.push(stateError);
  }

  for (const field of TEAM_FRONT_HOST_FIELDS) {
    if (options.hostOwned) continue;
    const next = readTeamFrontField(after, field);
    const message = `${field} is set by Nimbalyst when a mission starts or ends and cannot be set by hand.`;
    if (options.mode === 'create') {
      if (!isEmpty(next)) errors.push(message);
      continue;
    }
    const previous = readTeamFrontField(options.before, field);
    const unchanged = (isEmpty(previous) && isEmpty(next)) || previous === next;
    // A top-level write that disagrees with the value every reader sees (the
    // nested customFields bag wins when present) is a change too.
    const top = after?.[field];
    const shadowed = !isEmpty(top) && top !== previous;
    if (!unchanged || shadowed) errors.push(message);
  }
  return errors;
}

/** Whether a write would turn an item into a team-front or a team-front into something else. */
export function teamFrontTypeChangeError(currentType: string, nextType: unknown, nextTypeTags: unknown): string | null {
  const isFront = currentType === TEAM_FRONT_TYPE;
  if (isFront && typeof nextType === 'string' && nextType !== TEAM_FRONT_TYPE) {
    return 'A team-front cannot change type.';
  }
  const becomesFront = (typeof nextType === 'string' && nextType === TEAM_FRONT_TYPE)
    || (Array.isArray(nextTypeTags) && nextTypeTags.includes(TEAM_FRONT_TYPE));
  if (!isFront && becomesFront) {
    return 'An item cannot be turned into a team-front; the user creates fronts.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry points for the tracker write funnels. Each throws a single Error with
// every problem, so a refused write never reaches the database.
// ---------------------------------------------------------------------------

function fail(problems: string[]): void {
  if (problems.length) throw new Error(problems.join(' '));
}

export interface TeamFrontCreateOptions {
  /**
   * The create comes from an agent session (the app's tracker_create, which
   * passes `provenanceFromHost`): always refused. A manual create (UI, IPC,
   * CLI) never sets it.
   */
  agent?: boolean;
  /** The host's own persistence: the only writer of currentMission. */
  hostOwned?: boolean;
}

/**
 * A team-front about to be created by a local writer: refuses an agent,
 * defaults the status, refuses invalid structure and a hand-set currentMission,
 * and marks the item as created by hand. Mutates `data`. No-op for other types.
 */
export function prepareTeamFrontCreate(
  type: string,
  data: Record<string, unknown>,
  body?: unknown,
  options: TeamFrontCreateOptions = {},
): void {
  if (type !== TEAM_FRONT_TYPE) return;
  if (options.agent === true) fail([TEAM_FRONT_AGENT_CREATE_ERROR]);
  if (isEmpty(readTeamFrontField(data, 'status'))) data.status = 'active';
  const problems = validateTeamFrontData(data, { mode: 'create', hostOwned: options.hostOwned === true, body });
  if (body !== undefined && body !== null) {
    const bodyProblem = teamFrontBodyError(body);
    if (bodyProblem) problems.push(bodyProblem);
  }
  fail(problems);
  data.createdByAgent = false;
}

/** A team-front created outside the agent path (Tracker UI, IPC, CLI). */
export function prepareManualTeamFrontCreate(type: string, data: Record<string, unknown>, body?: unknown): void {
  prepareTeamFrontCreate(type, data, body, { agent: false });
}

export interface TeamFrontUpdateOptions {
  /**
   * The update comes from an agent session (the app's tracker_update). An agent
   * may update only the description; `hostOwned` never relaxes that.
   */
  agent?: boolean;
  /** The host's own persistence: the only writer of currentMission. */
  hostOwned?: boolean;
  /**
   * The body the item will have after this write, when the funnel can see it
   * (`null` = empty). Lets the rule refuse an update that clears the description
   * of a front with no body. A funnel that cannot see it leaves this out and the
   * state is not judged on update: the accepted gap.
   */
  storedBody?: unknown;
  /**
   * The funnel overwrites the body with the new description in the same write
   * (the MCP tracker_update, the offline CLI). `storedBody` is then the body that
   * will result, and the pair is judged even when the description stays empty.
   */
  writesBody?: boolean;
}

/** Arguments an agent's tracker_update may carry for a front: the item and the description. */
const AGENT_ALLOWED_UPDATE_KEYS = new Set<string>(['id', 'type', 'primaryType', 'typeTags', 'fields', ...TEAM_FRONT_AGENT_EDITABLE_FIELDS]);
/** Fields the tracker itself may not have changed behind an agent's back, whatever the arguments say. */
const AGENT_PROTECTED_FIELDS = ['title', 'status', ...TEAM_FRONT_HOST_FIELDS] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Problems with what an agent asked for: anything but the description of this
 * item. One problem, naming every refused key (an argument, `fields.<name>`, or
 * a stored title/status/currentMission that moved whatever the arguments said).
 */
function agentUpdateProblems(updates: Record<string, unknown>, before: Data, after: Data): string[] {
  const refused: string[] = [];
  const refuse = (key: string) => { if (!refused.includes(key)) refused.push(key); };
  for (const key of Object.keys(updates)) {
    if (updates[key] === undefined) continue;
    if (!AGENT_ALLOWED_UPDATE_KEYS.has(key)) refuse(key);
  }
  if (updates.primaryType !== undefined && updates.primaryType !== TEAM_FRONT_TYPE) refuse('primaryType');
  if (updates.typeTags !== undefined) {
    if (!Array.isArray(updates.typeTags) || updates.typeTags.some((tag) => tag !== TEAM_FRONT_TYPE)) refuse('typeTags');
  }
  if (updates.fields !== undefined) {
    const fields = updates.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      refuse('fields');
    } else {
      for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (!(TEAM_FRONT_AGENT_EDITABLE_FIELDS as readonly string[]).includes(key)) refuse(`fields.${key}`);
      }
    }
  }
  // Whatever the arguments said, the stored title and status must not move.
  for (const field of AGENT_PROTECTED_FIELDS) {
    // Already named as an argument: no need to name the stored effect again.
    if (refused.includes(field) || refused.includes(`fields.${field}`)) continue;
    const top = after?.[field];
    if (!sameValue(readTeamFrontField(before, field), readTeamFrontField(after, field))
      || (!isEmpty(top) && !sameValue(top, readTeamFrontField(before, field)))) {
      refuse(field);
    }
  }
  return refused.length ? [teamFrontAgentUpdateError(refused)] : [];
}

/**
 * Refuse a field update that breaks a team-front (or turns an item into one).
 * `updates` is what the caller asked for, `before` the stored data, `after` the
 * merged data about to be written. With `options.agent`, only the description
 * may change.
 */
export function assertTeamFrontUpdate(
  type: string,
  updates: Record<string, unknown>,
  before: Data,
  after: Data,
  options: TeamFrontUpdateOptions = {},
): void {
  const typeProblem = teamFrontTypeChangeError(type, updates.type, updates.typeTags);
  if (typeProblem) fail([typeProblem]);
  if (type !== TEAM_FRONT_TYPE) return;
  const problems: string[] = [];
  if (options.agent === true) problems.push(...agentUpdateProblems(updates, before, after));
  problems.push(...validateTeamFrontData(after, {
    mode: 'update',
    before,
    hostOwned: options.hostOwned === true,
    body: options.storedBody,
    writesBody: options.writesBody === true,
  }));
  fail(problems);
}

/**
 * Refuse a rich-body save that exceeds the team-front cap, or that empties the
 * body of a front whose description is empty too. `item` is the stored item the
 * funnel can see: when it is given AT ALL the state is judged, and a missing
 * `item.description` reads as empty, so a caller cannot skip the check by
 * leaving the key out. Only a funnel that sees no item (the body is written
 * apart from it) is judged on the cap alone. No-op for other types.
 */
export function assertTeamFrontBody(type: string, body: unknown, item?: { description?: unknown }): void {
  if (type !== TEAM_FRONT_TYPE) return;
  const problems: string[] = [];
  const capProblem = teamFrontBodyError(body);
  if (capProblem) problems.push(capProblem);
  if (item) {
    const stateProblem = teamFrontStateError(item.description, body);
    if (stateProblem) problems.push(stateProblem);
  }
  fail(problems);
}
