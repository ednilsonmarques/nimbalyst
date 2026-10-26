/**
 * Protected tracker types: the one rule every local write funnel applies.
 *
 * `team-note`, `tool-manifest` and `team-front` carry host-owned provenance and
 * a body the team relies on, so the app's agent tools (MCP
 * tracker_create/update), the desktop UI and the IPC behind it, the host's own
 * persistence and the offline CLI (DirectGateway) must all refuse the same
 * writes. The structural rules live next to this file (teamNoteRules.ts,
 * toolManifestRules.ts, teamFrontRules.ts); this module is the single entry
 * those funnels call, so a new funnel or a new protected type is wired in one
 * place. Every funnel keeps its own policy on top (who may call it, provenance
 * filled from the calling session); none may do less than this.
 *
 * The same list also closes the schema side (`protectedTrackerSchemaChangeError`):
 * the schema of a protected type is the one Nimbalyst ships, so a patch or an
 * override of it is refused by every funnel that writes a type schema.
 *
 * Pure: no I/O. Each assert throws one Error carrying every problem, so a
 * refused write never reaches the database. Not applied to incoming sync:
 * refusing a remote row would break convergence.
 */
import {
  TEAM_NOTE_TYPE,
  assertTeamNoteBody,
  assertTeamNoteUpdate,
  prepareTeamNoteCreate,
  teamNoteTypeChangeError,
} from './teamNoteRules.js';
import {
  TEAM_FRONT_TYPE,
  assertTeamFrontBody,
  assertTeamFrontUpdate,
  prepareTeamFrontCreate,
  teamFrontTypeChangeError,
} from './teamFrontRules.js';
import {
  TOOL_MANIFEST_TYPE,
  assertToolManifestBody,
  assertToolManifestUpdate,
  prepareHostToolManifestCreate,
  prepareManualToolManifestCreate,
  toolManifestTypeChangeError,
} from './toolManifestRules.js';

/** Types nobody writes freely: provenance from the system, content from the flow. */
export const PROTECTED_TRACKER_TYPES: readonly string[] = Object.freeze([TEAM_NOTE_TYPE, TOOL_MANIFEST_TYPE, TEAM_FRONT_TYPE]);

export function isProtectedTrackerType(type: unknown): boolean {
  return typeof type === 'string' && PROTECTED_TRACKER_TYPES.includes(type);
}

/**
 * Why a type's schema may not be patched or overridden, or null when it may
 * (NIB.130). Every funnel that writes a type schema calls this with the type it
 * is about to write: the MCP `tracker_define_type`, the schema service's
 * upserts and the IPC behind the Trackers settings. Refusing the whole change
 * is deliberate: the rules above validate items by field name, so a protected
 * type whose fields, statuses, sharing or model were rewritten would be
 * validated against a contract it no longer has. Resetting an override back to
 * the shipped schema is not a change this refuses.
 */
export function protectedTrackerSchemaChangeError(type: unknown): string | null {
  if (!isProtectedTrackerType(type)) return null;
  return (
    `Tracker type '${type}' is protected: its schema (fields, statuses, sharing, model) is fixed by Nimbalyst ` +
    `and cannot be patched or overridden. Reset an existing override instead, or create a new custom type.`
  );
}

export interface ProtectedTrackerCreateOptions {
  /**
   * The host's own persistence (a Tool Manifest from an architect session).
   * Never a user, an agent tool or the CLI: only the host's dedicated path
   * sets it, and it is not part of any IPC or MCP payload.
   */
  hostOwned?: boolean;
  /**
   * The provenance in `data` was filled by the host from the calling agent
   * session (the app's tracker_create of a Team Note, after its guard). A
   * manual create (UI, IPC, CLI) never carries any. Only the app's agent tool
   * sets it, so it is also what tells an agent's `team-front` create (refused)
   * from the user's.
   */
  provenanceFromHost?: boolean;
  /**
   * The create comes from a writer an agent can reach without the host
   * identifying the session (the frontmatter of a file, a page tool). It grants
   * nothing: no provenance is accepted, and a `team-front` is refused, as for
   * the agent's own tracker_create.
   */
  agent?: boolean;
  /** The rich body saved with the item, when the caller has one (cap check). */
  body?: unknown;
  /** The type tags the caller wants on the item: a protected type is never a tag. */
  typeTags?: unknown;
}

function fail(problems: string[]): void {
  if (problems.length) throw new Error(problems.join(' '));
}

/** A protected type is always an item's primary type, never a tag on another item. */
export function protectedTrackerTypeTagError(type: string, typeTags: unknown): string | null {
  if (!Array.isArray(typeTags)) return null;
  const smuggled = typeTags.filter((tag) => isProtectedTrackerType(tag) && tag !== type);
  if (smuggled.length === 0) return null;
  return `${smuggled.join(', ')} can only be the primary type of an item, not a type tag.`;
}

/**
 * Defaults, refusals and marks for an item about to be created. Mutates
 * `data`. No-op for an unprotected type without protected tags.
 */
export function prepareProtectedTrackerCreate(
  type: string,
  data: Record<string, unknown>,
  options: ProtectedTrackerCreateOptions = {},
): void {
  const tagProblem = protectedTrackerTypeTagError(type, options.typeTags);
  if (tagProblem) fail([tagProblem]);
  if (type === TEAM_NOTE_TYPE) {
    prepareTeamNoteCreate(type, data, options.body, { allowProvenance: options.provenanceFromHost === true });
    return;
  }
  if (type === TOOL_MANIFEST_TYPE) {
    if (options.hostOwned === true) prepareHostToolManifestCreate(type, data);
    else prepareManualToolManifestCreate(type, data);
    return;
  }
  if (type === TEAM_FRONT_TYPE) {
    prepareTeamFrontCreate(type, data, options.body, {
      agent: options.provenanceFromHost === true || options.agent === true,
      hostOwned: options.hostOwned === true,
    });
  }
}

export interface ProtectedTrackerUpdateOptions {
  /**
   * The update comes from an agent session (the app's tracker_update). The UI,
   * the IPC and the CLI never set it. Today only a `team-front` tells the two
   * apart: an agent may update only its description.
   */
  agent?: boolean;
  /**
   * The host's own persistence (the writer of a front's `currentMission`).
   * Never a user, an agent tool or the CLI: only the host's dedicated path
   * sets it, and it is not part of any IPC or MCP payload.
   */
  hostOwned?: boolean;
  /**
   * The body the item will have after this write, when the funnel can see it
   * (`null` = empty). Only a `team-front` reads it, to refuse clearing the
   * description of a front that has no body. Leave it out when the body is
   * written by a separate path the funnel cannot see: the state is then not
   * judged on update (the rule prevents forgetting; it is not a security barrier).
   */
  storedBody?: unknown;
  /**
   * The funnel overwrites the body with the new description in the same write
   * (the MCP tracker_update, the offline CLI): `storedBody` is then the body that
   * will result, and a team-front's resulting pair is judged even when the
   * description stays empty. A funnel that keeps the body (the UI) leaves it out.
   */
  writesBody?: boolean;
}

/**
 * Refuse a field update that breaks a protected item, or turns an item into
 * one (or out of one). `updates` is what the caller asked for, `primaryType`
 * (or `type`) and `typeTags` included when the type changes; `before` is the
 * stored data; `after` the merged data about to be written.
 */
export function assertProtectedTrackerUpdate(
  currentType: string,
  updates: Record<string, unknown>,
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  options: ProtectedTrackerUpdateOptions = {},
): void {
  const normalized = { ...updates, type: updates.primaryType ?? updates.type };
  assertTeamNoteUpdate(currentType, normalized, before, after, { storedBody: options.storedBody });
  assertToolManifestUpdate(currentType, normalized, before, after);
  // The agent rule reads what the caller asked for, so it gets `updates` with the normalized type.
  assertTeamFrontUpdate(currentType, { ...updates, type: normalized.type }, before, after, options);
}

/**
 * Refuse a rich-body save the type does not allow (a cap, or any edit at all).
 * `item.description` is the item's stored description when the funnel can see
 * it: a team-front's body may not be emptied while its description is empty.
 * `item.noteKind` is a team-note's kind when the funnel can see it: a handoff
 * may carry a larger body than the other kinds.
 * No-op for other types.
 */
export function assertProtectedTrackerBody(
  type: string,
  body: unknown,
  item?: { description?: unknown; noteKind?: unknown },
): void {
  assertTeamNoteBody(type, body, item);
  assertToolManifestBody(type);
  assertTeamFrontBody(type, body, item);
}

/** Whether a write would change an item's protected nature, as a message, or null. */
export function protectedTrackerTypeChangeError(currentType: string, nextType: unknown, nextTypeTags: unknown): string | null {
  return teamNoteTypeChangeError(currentType, nextType, nextTypeTags)
    ?? toolManifestTypeChangeError(currentType, nextType, nextTypeTags)
    ?? teamFrontTypeChangeError(currentType, nextType, nextTypeTags);
}
