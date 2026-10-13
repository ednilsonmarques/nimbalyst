/**
 * Protected tracker types: the one rule every local write funnel applies.
 *
 * `team-note` and `tool-manifest` carry host-owned provenance and a body the
 * team relies on, so the app's agent tools (MCP tracker_create/update), the
 * desktop UI and the IPC behind it, the host's own persistence and the offline
 * CLI (DirectGateway) must all refuse the same writes. The structural rules
 * live next to this file (teamNoteRules.ts, toolManifestRules.ts); this module
 * is the single entry those funnels call, so a new funnel or a new protected
 * type is wired in one place. Every funnel keeps its own policy on top (who may
 * call it, provenance filled from the calling session); none may do less than
 * this.
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
  TOOL_MANIFEST_TYPE,
  assertToolManifestBody,
  assertToolManifestUpdate,
  prepareHostToolManifestCreate,
  prepareManualToolManifestCreate,
  toolManifestTypeChangeError,
} from './toolManifestRules.js';

/** Types nobody writes freely: provenance from the system, content from the flow. */
export const PROTECTED_TRACKER_TYPES: readonly string[] = Object.freeze([TEAM_NOTE_TYPE, TOOL_MANIFEST_TYPE]);

export function isProtectedTrackerType(type: unknown): boolean {
  return typeof type === 'string' && PROTECTED_TRACKER_TYPES.includes(type);
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
   * manual create (UI, IPC, CLI) never carries any.
   */
  provenanceFromHost?: boolean;
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
  }
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
): void {
  const normalized = { ...updates, type: updates.primaryType ?? updates.type };
  assertTeamNoteUpdate(currentType, normalized, before, after);
  assertToolManifestUpdate(currentType, normalized, before, after);
}

/** Refuse a rich-body save the type does not allow (a cap, or any edit at all). No-op for other types. */
export function assertProtectedTrackerBody(type: string, body: unknown): void {
  assertTeamNoteBody(type, body);
  assertToolManifestBody(type);
}

/** Whether a write would change an item's protected nature, as a message, or null. */
export function protectedTrackerTypeChangeError(currentType: string, nextType: unknown, nextTypeTags: unknown): string | null {
  return teamNoteTypeChangeError(currentType, nextType, nextTypeTags)
    ?? toolManifestTypeChangeError(currentType, nextType, nextTypeTags);
}
