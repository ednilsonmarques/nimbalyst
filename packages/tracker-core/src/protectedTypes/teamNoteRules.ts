/**
 * Structural rules of the `team-note` tracker type (runtime TrackerPlugin
 * builtins/team-note.yaml), shared by every local write path: the app's agent
 * tools, the desktop Tracker UI and the IPC behind it, the host's own writes
 * and the offline CLI. They live in tracker-core so the CLI bundle carries the
 * same rule as the app (see protectedTrackerTypes.ts, the single entry the
 * write funnels call). Pure: callers decide how to refuse (throw, tool error).
 *
 * Not applied to incoming sync: refusing a remote row would break convergence.
 */

export const TEAM_NOTE_TYPE = 'team-note';
export const TEAM_NOTE_BODY_MAX_CHARS = 600;
export const TEAM_NOTE_KINDS = ['decision', 'discovery', 'risk', 'pending', 'test', 'context'] as const;
export const TEAM_NOTE_STATUSES = ['active', 'resolved', 'obsolete'] as const;
/** Set only by Nimbalyst from the calling agent session; never by hand. */
export const TEAM_NOTE_PROVENANCE_FIELDS = ['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree'] as const;

type Data = Record<string, unknown> | null | undefined;

/** Read a field from either storage shape (top level or the synced `customFields` bag). */
export function readTeamNoteField(data: Data, name: string): unknown {
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

function collectText(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  if (typeof record.text === 'string') out.push(record.text);
  if (Array.isArray(record.children)) for (const child of record.children) collectText(child, out);
  if (record.root) collectText(record.root, out);
}

/**
 * Visible length of a note body, whether it is markdown/plain text or a
 * rich-text (Lexical JSON) document as saved by the Tracker body editor.
 */
export function teamNoteBodyLength(body: unknown): number {
  if (body === null || body === undefined) return 0;
  let value: unknown = body;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return trimmed.replace(/\\n/g, '\n').length;
    try {
      value = JSON.parse(trimmed);
    } catch {
      return trimmed.length;
    }
  }
  if (typeof value === 'string') return value.trim().length;
  const parts: string[] = [];
  collectText(value, parts);
  return parts.join('').trim().length;
}

export function teamNoteBodyError(body: unknown): string | null {
  const length = teamNoteBodyLength(body);
  if (length <= TEAM_NOTE_BODY_MAX_CHARS) return null;
  return (
    `Team Note body is ${length} characters; the limit is ${TEAM_NOTE_BODY_MAX_CHARS}. ` +
    `Keep only the durable summary and point to the session, files or commit for the details.`
  );
}

export function teamNoteKindError(kind: unknown): string | null {
  if (typeof kind === 'string' && (TEAM_NOTE_KINDS as readonly string[]).includes(kind)) return null;
  return `Team Note needs noteKind, one of: ${TEAM_NOTE_KINDS.join(', ')}.`;
}

export function teamNoteStatusError(status: unknown): string | null {
  if (typeof status === 'string' && (TEAM_NOTE_STATUSES as readonly string[]).includes(status)) return null;
  return `Team Note status must be one of: ${TEAM_NOTE_STATUSES.join(', ')}.`;
}

export interface TeamNoteValidationOptions {
  mode: 'create' | 'update';
  /** Stored data before an update; required in update mode. */
  before?: Data;
  /** Only the host's agent path may set provenance on create. */
  allowProvenance?: boolean;
}

/**
 * Problems with a team-note's data as it is about to be stored (`after` is the
 * full merged data). Empty when valid. The body here is `data.description`; the
 * rich body column is checked separately with `teamNoteBodyError`.
 */
export function validateTeamNoteData(after: Data, options: TeamNoteValidationOptions): string[] {
  const errors: string[] = [];
  const kindError = teamNoteKindError(readTeamNoteField(after, 'noteKind'));
  if (kindError) errors.push(kindError);
  const status = readTeamNoteField(after, 'status');
  if (!isEmpty(status) || options.mode === 'update') {
    const statusError = teamNoteStatusError(status);
    if (statusError) errors.push(statusError);
  }
  const bodyError = teamNoteBodyError(readTeamNoteField(after, 'description'));
  if (bodyError) errors.push(bodyError);

  for (const field of TEAM_NOTE_PROVENANCE_FIELDS) {
    const next = readTeamNoteField(after, field);
    if (options.mode === 'create') {
      if (!options.allowProvenance && !isEmpty(next)) {
        errors.push(`${field} is set by Nimbalyst from the agent session and cannot be set by hand.`);
      }
      continue;
    }
    const previous = readTeamNoteField(options.before, field);
    const unchanged = (isEmpty(previous) && isEmpty(next)) || previous === next;
    // A top-level write that disagrees with the value every reader sees (the
    // nested customFields bag wins when present) is a change too.
    const top = after?.[field];
    const shadowed = !isEmpty(top) && top !== previous;
    if (!unchanged || shadowed) errors.push(`${field} records where the note came from and cannot be changed.`);
  }
  return errors;
}

/** Whether a write would turn an item into a team-note or a team-note into something else. */
export function teamNoteTypeChangeError(currentType: string, nextType: unknown, nextTypeTags: unknown): string | null {
  const isNote = currentType === TEAM_NOTE_TYPE;
  if (isNote && typeof nextType === 'string' && nextType !== TEAM_NOTE_TYPE) {
    return 'A team-note cannot change type. Mark it obsolete and create the new item instead.';
  }
  const becomesNote = (typeof nextType === 'string' && nextType === TEAM_NOTE_TYPE)
    || (Array.isArray(nextTypeTags) && nextTypeTags.includes(TEAM_NOTE_TYPE));
  if (!isNote && becomesNote) {
    return 'An item cannot be turned into a team-note; create a new note instead.';
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

export interface TeamNoteCreateOptions {
  /**
   * The provenance in `data` was filled by the host from the calling agent
   * session (the app's tracker_create, after its guard). A manual create (UI,
   * IPC, CLI) never carries any.
   */
  allowProvenance?: boolean;
}

/**
 * A team-note about to be created by any local writer: defaults the status,
 * refuses invalid structure, refuses hand-set provenance unless the host put
 * it there, and marks the origin through the tracker's existing
 * `createdByAgent` flag (an agent session when the host filled the provenance,
 * manual otherwise). Mutates `data`. No-op for other types.
 */
export function prepareTeamNoteCreate(
  type: string,
  data: Record<string, unknown>,
  body?: unknown,
  options: TeamNoteCreateOptions = {},
): void {
  if (type !== TEAM_NOTE_TYPE) return;
  const allowProvenance = options.allowProvenance === true;
  if (isEmpty(readTeamNoteField(data, 'status'))) data.status = 'active';
  const problems = validateTeamNoteData(data, { mode: 'create', allowProvenance });
  if (body !== undefined && body !== null) {
    const bodyProblem = teamNoteBodyError(body);
    if (bodyProblem) problems.push(bodyProblem);
  }
  fail(problems);
  data.createdByAgent = allowProvenance;
}

/** A team-note created outside the agent path (Tracker UI, IPC, CLI): no provenance, marked manual. */
export function prepareManualTeamNoteCreate(type: string, data: Record<string, unknown>, body?: unknown): void {
  prepareTeamNoteCreate(type, data, body, { allowProvenance: false });
}

/** Refuse a field update that breaks a team-note (or turns an item into one). */
export function assertTeamNoteUpdate(
  type: string,
  updates: Record<string, unknown>,
  before: Data,
  after: Data,
): void {
  const typeProblem = teamNoteTypeChangeError(type, updates.type, updates.typeTags);
  if (typeProblem) fail([typeProblem]);
  if (type !== TEAM_NOTE_TYPE) return;
  fail(validateTeamNoteData(after, { mode: 'update', before }));
}

/** Refuse a rich-body save that exceeds the team-note cap. No-op for other types. */
export function assertTeamNoteBody(type: string, body: unknown): void {
  if (type !== TEAM_NOTE_TYPE) return;
  const problem = teamNoteBodyError(body);
  if (problem) fail([problem]);
}
