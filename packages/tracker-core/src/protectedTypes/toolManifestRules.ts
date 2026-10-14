/**
 * Structural rules of the `tool-manifest` tracker type (runtime TrackerPlugin
 * builtins/tool-manifest.yaml), shared by every local write path: the host's
 * own persistence (the only creator), the app's agent tools, the desktop
 * Tracker UI and the IPC behind it, and the offline CLI. They live in
 * tracker-core so the CLI bundle carries the same rule as the app (see
 * protectedTrackerTypes.ts, the single entry the write funnels call).
 * Pure: callers decide how to refuse (throw, tool error).
 *
 * A stored manifest is the architect's output with host provenance. Nobody
 * creates one by hand or through tracker_create; nobody edits its body, its
 * title, its provenance or the link to the version it replaces. The only
 * lifecycle is draft -> accepted -> superseded (and draft -> superseded when a
 * newer manifest arrives before the coordinator accepted this one).
 *
 * Not applied to incoming sync: refusing a remote row would break convergence.
 */

import { normalizeRelationshipValue } from '../trackerRelationships.js';

export const TOOL_MANIFEST_TYPE = 'tool-manifest';
export const TOOL_MANIFEST_STATUSES = ['draft', 'accepted', 'superseded'] as const;
export type ToolManifestStatus = (typeof TOOL_MANIFEST_STATUSES)[number];

/** Set only by Nimbalyst from the architect session, its team and the parsed manifest; never by an agent or by hand. */
export const TOOL_MANIFEST_PROVENANCE_FIELDS = [
  'manifestId',
  'declaredManifestId',
  'manifestVersion',
  'teamRootSessionId',
  'architectSessionId',
  'generatedByRole',
  'model',
  'confidence',
  'contentHash',
] as const;

/** Everything a stored manifest keeps as produced: the provenance, the link to the version it replaces, the title and the body. */
export const TOOL_MANIFEST_IMMUTABLE_FIELDS = [
  ...TOOL_MANIFEST_PROVENANCE_FIELDS,
  'supersedes',
  'title',
  'description',
] as const;

/**
 * Immutable fields that hold a relationship. Their stored shape differs by
 * writer (the host stores target ids; the tracker canonicalizes them to
 * `{ itemId }` objects on its next write), so they are compared by their
 * target ids, never by shape: the same targets in another shape is no change,
 * while another target, one more or one fewer is a change and is refused.
 */
export const TOOL_MANIFEST_RELATIONSHIP_FIELDS = ['supersedes'] as const;

export const TOOL_MANIFEST_HAND_CREATE_ERROR =
  'Tool Manifests are written by Nimbalyst when an architect session completes with a valid manifest; ' +
  'they cannot be created by hand or through tracker_create.';

export const TOOL_MANIFEST_BODY_ERROR =
  "The body of a Tool Manifest is the architect's output and is never edited; " +
  'ask the architect for a new version, which supersedes this one.';

const MANIFEST_ID = /^M-[1-9]\d*$/;

type Data = Record<string, unknown> | null | undefined;

/** Read a field from either storage shape (top level or the synced `customFields` bag). */
export function readToolManifestField(data: Data, name: string): unknown {
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

/** The target ids a stored relationship value names, in a shape-independent order. */
function relationshipTargets(value: unknown): string[] {
  return normalizeRelationshipValue(value).map((entry) => entry.itemId).sort();
}

/** Entries of a raw relationship value that name no target: normalization drops them silently. */
function relationshipEntriesWithoutTarget(value: unknown): number {
  const list: unknown[] = Array.isArray(value) ? value : value == null ? [] : [value];
  return list.filter((entry) => {
    if (typeof entry === 'string') return entry === '';
    if (!entry || typeof entry !== 'object') return true;
    const object = entry as Record<string, unknown>;
    const id = typeof object.itemId === 'string' ? object.itemId : typeof object.id === 'string' ? object.id : '';
    return id === '';
  }).length;
}

/**
 * Equality for an immutable field: a relationship by its targets, anything
 * else by value. A relationship value with entries that name no target is not
 * the same link in another shape; it is compared as it is, so such a value
 * never passes as "no targets".
 */
function sameImmutableValue(field: string, a: unknown, b: unknown): boolean {
  if ((TOOL_MANIFEST_RELATIONSHIP_FIELDS as readonly string[]).includes(field)) {
    if (relationshipEntriesWithoutTarget(a) > 0 || relationshipEntriesWithoutTarget(b) > 0) return sameValue(a, b);
    return sameValue(relationshipTargets(a), relationshipTargets(b));
  }
  return sameValue(a, b);
}

/**
 * A top-level write that disagrees with the value every reader sees (the
 * nested `customFields` bag wins when present): an attempt to rewrite the
 * field in the other storage shape, refused like a change. The same targets
 * of a relationship in another shape do not disagree.
 */
function shadowed(data: Data, name: string, effective: unknown): boolean {
  const top = data?.[name];
  return top !== undefined && !sameImmutableValue(name, top, effective);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (isEmpty(a) && isEmpty(b)) return true;
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function toolManifestStatusError(status: unknown): string | null {
  if (typeof status === 'string' && (TOOL_MANIFEST_STATUSES as readonly string[]).includes(status)) return null;
  return `Tool Manifest status must be one of: ${TOOL_MANIFEST_STATUSES.join(', ')}.`;
}

/**
 * Lifecycle: draft -> accepted, draft -> superseded, accepted -> superseded.
 * A superseded manifest stays superseded (the newest manifest is the current
 * one) and nothing returns to draft.
 */
export function toolManifestStatusTransitionError(from: unknown, to: unknown): string | null {
  const invalid = toolManifestStatusError(to);
  if (invalid) return invalid;
  if (isEmpty(from) || from === to) return null;
  if (from === 'superseded') return 'A superseded Tool Manifest stays superseded; the current manifest is the newest one.';
  if (to === 'draft') return 'A Tool Manifest never returns to draft.';
  return null;
}

export interface ToolManifestValidationOptions {
  mode: 'create' | 'update';
  /** Stored data before an update; required in update mode. */
  before?: Data;
  /** Only the host's own persistence may create a manifest. */
  hostOwned?: boolean;
}

/**
 * Problems with a manifest's data as it is about to be stored (`after` is the
 * full merged data). Empty when valid.
 */
export function validateToolManifestData(after: Data, options: ToolManifestValidationOptions): string[] {
  if (options.mode === 'create') {
    if (!options.hostOwned) return [TOOL_MANIFEST_HAND_CREATE_ERROR];
    const errors: string[] = [];
    const id = readToolManifestField(after, 'manifestId');
    if (typeof id !== 'string' || !MANIFEST_ID.test(id)) errors.push('manifestId must be M-<n>.');
    const status = readToolManifestField(after, 'status');
    if (!isEmpty(status)) {
      const statusError = toolManifestStatusError(status);
      if (statusError) errors.push(statusError);
    }
    for (const field of ['teamRootSessionId', 'architectSessionId'] as const) {
      const value = readToolManifestField(after, field);
      if (typeof value !== 'string' || !value.trim()) errors.push(`${field} must name the session.`);
    }
    if (readToolManifestField(after, 'generatedByRole') !== 'architect') errors.push('generatedByRole must be architect.');
    return errors;
  }

  const errors: string[] = [];
  const transition = toolManifestStatusTransitionError(
    readToolManifestField(options.before, 'status'),
    readToolManifestField(after, 'status'),
  );
  if (transition) errors.push(transition);
  for (const field of TOOL_MANIFEST_IMMUTABLE_FIELDS) {
    const previous = readToolManifestField(options.before, field);
    if (sameImmutableValue(field, previous, readToolManifestField(after, field)) && !shadowed(after, field, previous)) continue;
    errors.push(
      field === 'description'
        ? TOOL_MANIFEST_BODY_ERROR
        : `${field} is set by Nimbalyst from the architect session and cannot be changed.`,
    );
  }
  return errors;
}

/** Whether a write would turn an item into a tool-manifest or a tool-manifest into something else. */
export function toolManifestTypeChangeError(currentType: string, nextType: unknown, nextTypeTags: unknown): string | null {
  const isManifest = currentType === TOOL_MANIFEST_TYPE;
  if (isManifest && typeof nextType === 'string' && nextType !== TOOL_MANIFEST_TYPE) {
    return 'A tool-manifest cannot change type.';
  }
  const becomesManifest = (typeof nextType === 'string' && nextType === TOOL_MANIFEST_TYPE)
    || (Array.isArray(nextTypeTags) && nextTypeTags.includes(TOOL_MANIFEST_TYPE));
  if (!isManifest && becomesManifest) {
    return 'An item cannot be turned into a tool-manifest; only Nimbalyst writes them, from an architect session.';
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

/** A tool-manifest created outside the host's own persistence (UI, IPC, imports): always refused. No-op for other types. */
export function prepareManualToolManifestCreate(type: string, _data: Record<string, unknown>): void {
  if (type !== TOOL_MANIFEST_TYPE) return;
  fail([TOOL_MANIFEST_HAND_CREATE_ERROR]);
}

/**
 * A tool-manifest created by the host (services/team/toolManifests.ts):
 * defaults the status and refuses incomplete provenance. Mutates `data`.
 * No-op for other types.
 */
export function prepareHostToolManifestCreate(type: string, data: Record<string, unknown>): void {
  if (type !== TOOL_MANIFEST_TYPE) return;
  if (isEmpty(readToolManifestField(data, 'status'))) data.status = 'draft';
  fail(validateToolManifestData(data, { mode: 'create', hostOwned: true }));
  // The architect (an agent session) produced it; the tracker's existing flag says so.
  data.createdByAgent = true;
}

/** Refuse a field update that breaks a tool-manifest (or turns an item into one). */
export function assertToolManifestUpdate(
  type: string,
  updates: Record<string, unknown>,
  before: Data,
  after: Data,
): void {
  const typeProblem = toolManifestTypeChangeError(type, updates.type, updates.typeTags);
  if (typeProblem) fail([typeProblem]);
  if (type !== TOOL_MANIFEST_TYPE) return;
  fail(validateToolManifestData(after, { mode: 'update', before }));
}

/** Refuse any rich-body save on a tool-manifest: the body is the architect's output. No-op for other types. */
export function assertToolManifestBody(type: string): void {
  if (type !== TOOL_MANIFEST_TYPE) return;
  fail([TOOL_MANIFEST_BODY_ERROR]);
}
