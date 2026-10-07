/**
 * `metadata.teamMode` and `metadata.teamChild` are creation-only. The session
 * store drops them from every metadata update and keeps them when a create is
 * re-issued, so neither the renderer, an MCP tool, a provider nor sync can turn
 * a session into (or out of) a team after the fact.
 */

import {
  TEAM_CHILD_METADATA_KEY,
  TEAM_MODE_METADATA_KEY,
} from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { TEAM_PROVIDER } from './teamPolicy';

const CREATION_ONLY_KEYS = [TEAM_MODE_METADATA_KEY, TEAM_CHILD_METADATA_KEY] as const;

/** Drop the creation-only team keys from a metadata update. */
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
 * the host creates team members), and `teamMode` only as `true` on a Claude
 * Code session.
 */
export function sanitizeRendererCreateTeamMetadata(
  metadata: Record<string, unknown>,
  provider: string,
): Record<string, unknown> {
  if (!(TEAM_MODE_METADATA_KEY in metadata) && !(TEAM_CHILD_METADATA_KEY in metadata)) return metadata;
  const { [TEAM_CHILD_METADATA_KEY]: _child, [TEAM_MODE_METADATA_KEY]: teamMode, ...rest } = metadata;
  if (teamMode === true && provider === TEAM_PROVIDER) {
    return { ...rest, [TEAM_MODE_METADATA_KEY]: true };
  }
  if (teamMode !== undefined) {
    console.warn(`[team] Ignoring teamMode on a ${provider} session: Team mode supports ${TEAM_PROVIDER} only.`);
  }
  return rest;
}
