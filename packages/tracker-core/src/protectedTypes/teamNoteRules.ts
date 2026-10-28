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

import { normalizeRelationshipValue } from '../trackerRelationships.js';

export const TEAM_NOTE_TYPE = 'team-note';
/** Body cap of every kind but a handoff: a note is a summary, never a transcript. */
export const TEAM_NOTE_BODY_MAX_CHARS = 600;
/** A handoff carries the state a new coordinator starts from, so it gets a larger body. */
export const TEAM_NOTE_HANDOFF_BODY_MAX_CHARS = 2500;
export const TEAM_NOTE_KINDS = ['decision', 'discovery', 'risk', 'pending', 'test', 'context', 'handoff'] as const;
export const TEAM_NOTE_STATUSES = ['active', 'resolved', 'obsolete'] as const;
/**
 * Set only by Nimbalyst from the calling agent session; never by hand. `front`
 * is the team-front the mission belongs to (a relationship; compared by target).
 */
export const TEAM_NOTE_PROVENANCE_FIELDS = ['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree', 'front'] as const;
/** Provenance fields that hold a relationship: compared by their targets, never by shape. */
const TEAM_NOTE_RELATIONSHIP_PROVENANCE_FIELDS: readonly string[] = ['front'];
/** A pending item or a handoff without a concrete next step is a note nobody can act on. */
export const TEAM_NOTE_NEXT_ACTION_KINDS = ['pending', 'handoff'] as const;
export const TEAM_NOTE_HANDOFF_RESULTS = ['completed', 'partial', 'abandoned'] as const;
/** Structured fields that only mean something on a handoff; refused on every other kind. */
export const TEAM_NOTE_HANDOFF_ONLY_FIELDS = ['result', 'commits', 'pendings', 'relatedNotes'] as const;

/** Body cap for a kind. An unknown or missing kind gets the strict one. */
export function teamNoteBodyLimit(kind: unknown): number {
  if (kind === 'handoff') return TEAM_NOTE_HANDOFF_BODY_MAX_CHARS;
  return TEAM_NOTE_BODY_MAX_CHARS;
}

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

/**
 * Visible length of a body as the content column stores it: the markdown text
 * or a rich document JSON-encoded, so a plain body arrives as a JSON-quoted
 * string. Used for a stored body; a payload body goes through `teamNoteBodyLength`.
 */
export function teamNoteStoredBodyLength(body: unknown): number {
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'string') return teamNoteBodyLength(parsed);
      } catch {
        // Not a JSON-quoted string: a plain text that starts with a quote.
      }
    }
  }
  return teamNoteBodyLength(body);
}

function bodyLimitError(length: number, kind: unknown): string | null {
  const limit = teamNoteBodyLimit(kind);
  if (length <= limit) return null;
  return (
    `Team Note body is ${length} characters; the limit is ${limit}. ` +
    `Keep only the durable summary and point to the session, files or commit for the details.`
  );
}

export function teamNoteBodyError(body: unknown, kind?: unknown): string | null {
  return bodyLimitError(teamNoteBodyLength(body), kind);
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
  /**
   * The rich body as stored (the content column), when the funnel can see it
   * (`null` = empty). On update it is judged against the cap of the RESULTING kind
   * when the write changes the kind: a handoff that becomes a decision may not
   * keep a body the decision cap would refuse. Not judged when the kind is
   * unchanged (an unrelated edit of an old oversized note is not held up by it).
   */
  storedBody?: unknown;
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
  const kind = readTeamNoteField(after, 'noteKind');
  const bodyError = teamNoteBodyError(readTeamNoteField(after, 'description'), kind);
  if (bodyError) errors.push(bodyError);
  if (
    options.mode === 'update'
    && options.storedBody !== undefined
    && options.storedBody !== null
    && readTeamNoteField(options.before, 'noteKind') !== kind
  ) {
    const storedError = bodyLimitError(teamNoteStoredBodyLength(options.storedBody), kind);
    if (storedError) errors.push(storedError);
  }
  errors.push(...relationshipShapeProblems(after));
  if (!kindError) errors.push(...kindFieldProblems(after, kind as string, options));

  for (const field of TEAM_NOTE_PROVENANCE_FIELDS) {
    const next = readTeamNoteField(after, field);
    const relationship = TEAM_NOTE_RELATIONSHIP_PROVENANCE_FIELDS.includes(field);
    if (options.mode === 'create') {
      if (!options.allowProvenance && !(relationship ? isEmptyRelationship(next) : isEmpty(next))) {
        errors.push(`${field} is set by Nimbalyst from the agent session and cannot be set by hand.`);
      }
      continue;
    }
    const previous = readTeamNoteField(options.before, field);
    // A top-level write that disagrees with the value every reader sees (the
    // nested customFields bag wins when present) is a change too.
    const top = after?.[field];
    let unchanged: boolean;
    let shadowed: boolean;
    if (relationship) {
      // The funnels canonicalize and nest relationship values, so the same target
      // arrives as an id, an object or a list: compare targets, never shapes.
      unchanged = sameRelationshipTargets(previous, next);
      shadowed = !isEmptyRelationship(top) && !sameRelationshipTargets(top, previous);
    } else {
      unchanged = (isEmpty(previous) && isEmpty(next)) || previous === next;
      shadowed = !isEmpty(top) && top !== previous;
    }
    if (!unchanged || shadowed) errors.push(`${field} records where the note came from and cannot be changed.`);
  }
  return errors;
}

/** Relationship fields a note carries since the team lifecycle: front (one target), pendings and relatedNotes. */
const RELATIONSHIP_FIELDS_SHAPE_CHECKED = ['front', 'pendings', 'relatedNotes'] as const;

/** One stored target: a non-blank id, or an object naming one (`itemId`, or `id` as the funnels read it). */
function isRelationshipEntry(entry: unknown): boolean {
  if (typeof entry === 'string') return entry.trim().length > 0;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const object = entry as Record<string, unknown>;
  const id = typeof object.itemId === 'string' ? object.itemId : typeof object.id === 'string' ? object.id : '';
  return id.trim().length > 0;
}

/**
 * Whether a value is something a relationship field can hold: nothing at all
 * (absent, null, an empty string, an empty list), one target, or a list of
 * targets. A number, a boolean, an empty object or a list with such entries is
 * not: the funnels' normalization would read it as "no target" and store the
 * garbage under a field that looks empty.
 */
function isRelationshipShaped(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  if (Array.isArray(value)) return value.every(isRelationshipEntry);
  return isRelationshipEntry(value);
}

/** The shape problems of the note's relationship fields, in either storage shape and as a top-level shadow. */
function relationshipShapeProblems(after: Data): string[] {
  const errors: string[] = [];
  for (const field of RELATIONSHIP_FIELDS_SHAPE_CHECKED) {
    const values = [readTeamNoteField(after, field), after?.[field]];
    if (!values.every(isRelationshipShaped)) {
      errors.push(`${field} must be empty or a relationship (an item id, or a list of them).`);
    } else if (field === 'front' && values.some((value) => relationshipTargets(value).length > 1)) {
      errors.push('front must be empty or a relationship to one item.');
    }
  }
  return errors;
}

function relationshipTargets(value: unknown): string[] {
  return normalizeRelationshipValue(value).map((entry) => entry.itemId).sort();
}

function isEmptyRelationship(value: unknown): boolean {
  return relationshipTargets(value).length === 0;
}

function sameRelationshipTargets(a: unknown, b: unknown): boolean {
  const left = relationshipTargets(a);
  const right = relationshipTargets(b);
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** A field value that says nothing: absent, blank, an empty list, or a relationship with no target. */
function isBlankField(name: string, value: unknown): boolean {
  if (isEmpty(value)) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0 || (name === 'pendings' || name === 'relatedNotes' ? isEmptyRelationship(value) : false);
  return name === 'pendings' || name === 'relatedNotes' ? isEmptyRelationship(value) : false;
}

/**
 * The rules that depend on the note's kind: a pending item or a handoff needs a
 * concrete next step, a handoff carries its result, and the handoff-only fields
 * mean nothing anywhere else.
 */
function kindFieldProblems(after: Data, kind: string, options: TeamNoteValidationOptions): string[] {
  const errors: string[] = [];

  if ((TEAM_NOTE_NEXT_ACTION_KINDS as readonly string[]).includes(kind)) {
    const next = readTeamNoteField(after, 'nextAction');
    if (isBlankField('nextAction', next) || typeof next !== 'string') {
      // On create always. On update only when the write is what takes it away or what
      // makes the note need it: a pending note from before nextAction existed keeps
      // accepting every unrelated edit.
      let judged = options.mode === 'create';
      if (!judged) {
        const previousKind = readTeamNoteField(options.before, 'noteKind');
        const previousNext = readTeamNoteField(options.before, 'nextAction');
        judged = previousKind !== kind || !isBlankField('nextAction', previousNext);
      }
      if (judged) {
        errors.push(`A ${kind} Team Note needs nextAction: the concrete next step, in one or two lines (set it as fields.nextAction).`);
      }
    }
  }

  if (kind === 'handoff') {
    const result = readTeamNoteField(after, 'result');
    if (typeof result !== 'string' || !(TEAM_NOTE_HANDOFF_RESULTS as readonly string[]).includes(result)) {
      errors.push(`A handoff Team Note's result must be one of: ${TEAM_NOTE_HANDOFF_RESULTS.join(', ')}.`);
    }
    const commits = readTeamNoteField(after, 'commits');
    if (!isEmpty(commits) && (!Array.isArray(commits) || commits.some((entry) => typeof entry !== 'string'))) {
      errors.push('A handoff Team Note\'s commits must be a list of strings.');
    }
  } else {
    for (const field of TEAM_NOTE_HANDOFF_ONLY_FIELDS) {
      if (!isBlankField(field, readTeamNoteField(after, field))) {
        errors.push(`${field} is only for notes of kind handoff.`);
      }
    }
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
    const bodyProblem = teamNoteBodyError(body, readTeamNoteField(data, 'noteKind'));
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
  options: { storedBody?: unknown } = {},
): void {
  const typeProblem = teamNoteTypeChangeError(type, updates.type, updates.typeTags);
  if (typeProblem) fail([typeProblem]);
  if (type !== TEAM_NOTE_TYPE) return;
  fail(validateTeamNoteData(after, { mode: 'update', before, storedBody: options.storedBody }));
}

/**
 * Refuse a rich-body save that exceeds the team-note cap for its kind.
 * `item.noteKind` is the note's kind when the funnel can see it; without it the
 * strict 600 applies. No-op for other types.
 */
export function assertTeamNoteBody(type: string, body: unknown, item?: { noteKind?: unknown }): void {
  if (type !== TEAM_NOTE_TYPE) return;
  const problem = teamNoteBodyError(body, item?.noteKind);
  if (problem) fail([problem]);
}
