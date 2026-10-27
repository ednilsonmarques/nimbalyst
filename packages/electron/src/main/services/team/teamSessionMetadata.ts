/**
 * `metadata.teamMode` and `metadata.teamChild` are creation-only. The session
 * store drops them from every metadata update and keeps them when a create is
 * re-issued, so neither the renderer, an MCP tool, a provider nor sync can turn
 * a session into (or out of) a team after the fact. `teamChild.mission` (the
 * member's mission) travels inside `teamChild`, so it is immutable by the same
 * rule and a renderer create can never carry one.
 *
 * The mission keys of a team root (`teamFront`, `teamGoal`, `teamMissionStatus`,
 * `teamMissionContext`, `teamDoneCriterion`, TEAM_ROOT_LIFECYCLE_KEYS) are
 * host-owned the same way: creation-only for the store and dropped by the renderer
 * create sanitizer. Their only creation-time writer is `applyHostTeamRootLifecycle`
 * below, so the `front` a team note copies from a root cannot be chosen by the
 * renderer. They never travel through sync.
 *
 * `metadata.teamBudget` gets the same protection for a different reason: it is
 * the user's authorization to continue a team past a checkpoint. Its only
 * writer is `authorizeTeamContinuation` (metaAgentSessionQueries), which merges
 * it with its own statement, so no session can raise its own budget.
 *
 * `metadata.toolManifestRef` (Phase 1B) is the team root's pointer to its
 * current Tool Manifest item. Its only writer is `recordToolManifestRef`
 * (services/team/toolManifests.ts), with its own statement: no session can
 * point its team at another manifest.
 *
 * `metadata.toolScope` and `metadata.sessionDirective` are creation-only for
 * the same reason the provider freezes them on the first turn: they are the
 * policy the creator set. A child must not widen its own scope, and nothing
 * may rewrite a directive after the fact. Both are written with the row
 * (MetaAgentService.createChildSessionInternal, the extension session broker,
 * a renderer create) and never updated.
 */

import {
  TEAM_BUDGET_METADATA_KEY,
  TEAM_CHILD_METADATA_KEY,
  TEAM_DONE_CRITERION_METADATA_KEY,
  TEAM_FRONT_METADATA_KEY,
  TEAM_GOAL_METADATA_KEY,
  TEAM_MISSION_CONTEXT_METADATA_KEY,
  TEAM_MISSION_STATUS_METADATA_KEY,
  TEAM_MODE_METADATA_KEY,
  TOOL_MANIFEST_REF_METADATA_KEY,
} from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { SESSION_DIRECTIVE_KEY } from '../extensionSessions/sessionOwnership';
import { isRecommendedTeamRootModel } from './teamPolicy';

/** `metadata.toolScope`: a child's capability scope (see toolPolicy.ts). */
export const TOOL_SCOPE_METADATA_KEY = 'toolScope';

/**
 * The mission keys of a team root (F1 S3). Host-owned: the host writes them with
 * the root row (`applyHostTeamRootLifecycle`) and, for the status, when it closes
 * the mission; nothing else sets, replaces or clears them. A team note's `front`
 * is copied from `teamFront` (teamNotes.ts), so this is what makes that source
 * trustworthy. Local to the machine: none is in a sync whitelist.
 */
export const TEAM_ROOT_LIFECYCLE_KEYS = [
  TEAM_FRONT_METADATA_KEY,
  TEAM_GOAL_METADATA_KEY,
  TEAM_MISSION_STATUS_METADATA_KEY,
  TEAM_MISSION_CONTEXT_METADATA_KEY,
  TEAM_DONE_CRITERION_METADATA_KEY,
] as const;

export const CREATION_ONLY_KEYS = [
  TEAM_MODE_METADATA_KEY,
  TEAM_CHILD_METADATA_KEY,
  TEAM_BUDGET_METADATA_KEY,
  TOOL_SCOPE_METADATA_KEY,
  SESSION_DIRECTIVE_KEY,
  TOOL_MANIFEST_REF_METADATA_KEY,
  ...TEAM_ROOT_LIFECYCLE_KEYS,
] as const;

/** Drop the creation-only team and policy keys from a metadata update. */
export function stripCreationOnlyTeamMetadata<T extends Record<string, unknown> | undefined>(metadata: T): T {
  if (!metadata || !CREATION_ONLY_KEYS.some((key) => key in metadata)) return metadata;
  const rest = { ...(metadata as Record<string, unknown>) };
  for (const key of CREATION_ONLY_KEYS) delete rest[key];
  return rest as T;
}

/**
 * A re-issued create (upsert) must not change a session's team keys: keep the
 * stored ones and ignore whatever the new payload says about them.
 */
export function preserveStoredTeamMetadata(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!stored) return incoming;
  const merged = stripCreationOnlyTeamMetadata(incoming);
  const next = { ...merged };
  for (const key of CREATION_ONLY_KEYS) {
    if (key in stored) next[key] = stored[key];
  }
  return next;
}

/**
 * Metadata a renderer may set when creating a session: never `teamChild` (only
 * the host creates team members) nor `teamBudget` (a new team starts at the
 * initial budget), and `teamMode` only as `true`.
 *
 * The UI only offers the recommended coordinator presets, but the core does not
 * enforce them: a Team mode root on any other model is kept (and logged) so
 * advanced/API callers are not locked in. Strong policy in the UX, not in the core.
 */
export function sanitizeRendererCreateTeamMetadata(
  metadata: Record<string, unknown>,
  model: string | null | undefined,
): Record<string, unknown> {
  if (!CREATION_ONLY_KEYS.some((key) => key in metadata)) return metadata;
  const {
    [TEAM_CHILD_METADATA_KEY]: _child,
    [TEAM_BUDGET_METADATA_KEY]: _budget,
    [TOOL_MANIFEST_REF_METADATA_KEY]: _manifestRef,
    [TEAM_MODE_METADATA_KEY]: teamMode,
    ...withLifecycle
  } = metadata;
  // The mission keys are host-owned: a renderer create never carries them, not
  // even on a team root. The host adds them after this (applyHostTeamRootLifecycle).
  const rest = { ...withLifecycle };
  for (const key of TEAM_ROOT_LIFECYCLE_KEYS) delete rest[key];
  if (teamMode !== true) return rest;
  if (!isRecommendedTeamRootModel(model)) {
    console.warn(`[team] Team mode session created on ${model ?? 'an unknown model'}, outside the recommended presets (Opus or Fable).`);
  }
  return { ...rest, [TEAM_MODE_METADATA_KEY]: true };
}

/** What the host knows about the mission it is creating a root for. */
export interface TeamRootLifecycleInput {
  /** The id of the `team-front` item the mission works for. Validated by the caller (S4), not here. */
  front: string;
  /** The mission's goal. */
  goal: string;
  /** The bootstrap block the host assembled (capped by the caller). Omitted when empty. */
  context?: string;
  /** The done criterion. Omitted when empty. */
  doneCriterion?: string;
}

export type HostTeamRootLifecycleResult =
  | { applied: true; metadata: Record<string, unknown> }
  | { applied: false; metadata: Record<string, unknown>; reason: string };

function trimmedNonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The single host entry that gives a team root its mission keys, called by the
 * main process while it assembles a root's creation metadata (after
 * `sanitizeRendererCreateTeamMetadata`, whatever the renderer sent). Nothing else
 * writes these keys at creation, and ordinary metadata writes drop them.
 *
 * Only a team root gets them: `teamMode` must already be exactly `true`
 * (a renderer cannot add the keys to a plain session or a member). The status
 * starts `active`; the caller cannot choose it. Any lifecycle key already in
 * `metadata` is discarded first, so a forged value never survives, applied or
 * not. A refusal carries the reason and the metadata without the keys, so the
 * caller decides what to do with it instead of a silent drop.
 *
 * It does not check that the front exists or is unique per mission, and does not
 * cap `context`: those are the creation flow's rules (S4).
 */
export function applyHostTeamRootLifecycle(
  metadata: Record<string, unknown>,
  lifecycle: TeamRootLifecycleInput,
): HostTeamRootLifecycleResult {
  const base = { ...metadata };
  for (const key of TEAM_ROOT_LIFECYCLE_KEYS) delete base[key];

  if (metadata[TEAM_MODE_METADATA_KEY] !== true) {
    return { applied: false, metadata: base, reason: 'The mission keys are written only on a Team mode root (teamMode: true).' };
  }
  const front = trimmedNonBlank(lifecycle?.front);
  const goal = trimmedNonBlank(lifecycle?.goal);
  if (!front || !goal) {
    return { applied: false, metadata: base, reason: 'A mission needs a non-empty front and goal.' };
  }
  const context = trimmedNonBlank(lifecycle.context);
  const doneCriterion = trimmedNonBlank(lifecycle.doneCriterion);
  return {
    applied: true,
    metadata: {
      ...base,
      [TEAM_FRONT_METADATA_KEY]: front,
      [TEAM_GOAL_METADATA_KEY]: goal,
      [TEAM_MISSION_STATUS_METADATA_KEY]: 'active',
      ...(context ? { [TEAM_MISSION_CONTEXT_METADATA_KEY]: context } : {}),
      ...(doneCriterion ? { [TEAM_DONE_CRITERION_METADATA_KEY]: doneCriterion } : {}),
    },
  };
}
