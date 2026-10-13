/**
 * Tool Manifest guard for tracker_create / tracker_update (Phase 1B). Runs
 * before the generic tracker write. A `tool-manifest` item is written only by
 * the host when an architect session completes (services/team/toolManifests.ts),
 * so tracker_create of one is always refused, and tracker_update may do one
 * thing: the coordinator of the team the manifest belongs to accepts it
 * (status `accepted`, nothing else). Members never write; a divergence is a
 * Team Note, never an edit; the body, title, provenance and version link are
 * immutable (toolManifestRules.ts covers every other write path too).
 */

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { resolveTeamContext } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  TOOL_MANIFEST_HAND_CREATE_ERROR,
  TOOL_MANIFEST_TYPE,
  readToolManifestField,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/toolManifestRules';

interface ToolError {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

function refuse(text: string): ToolError {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

const ACCEPT_ONLY =
  'A Tool Manifest is only ever accepted: tracker_update may set its status to accepted and nothing else ' +
  '(the body, title, provenance and version link are the architect\'s and Nimbalyst\'s). ' +
  'Record a divergence as a Team Note instead of editing the manifest.';

/** Keys an accept may carry; `typeTags`/`primaryType` are tolerated only when they keep the type. */
const ALLOWED_UPDATE_KEYS = new Set(['id', 'status', 'fields', 'typeTags', 'primaryType']);
const ALLOWED_FIELD_KEYS = new Set(['status']);

function mentionsToolManifest(args: any): boolean {
  return args?.primaryType === TOOL_MANIFEST_TYPE
    || (Array.isArray(args?.typeTags) && args.typeTags.includes(TOOL_MANIFEST_TYPE));
}

export function isToolManifestCreate(args: any): boolean {
  return args?.type === TOOL_MANIFEST_TYPE || mentionsToolManifest(args);
}

/** tracker_create of a tool-manifest: always refused, whoever calls. */
export function guardToolManifestCreate(): ToolError {
  return refuse(TOOL_MANIFEST_HAND_CREATE_ERROR);
}

interface ManifestItemLike {
  type: string;
  status?: string | null;
  customFields?: Record<string, unknown> | null;
}

/**
 * Guard a tracker_update that touches a tool-manifest: the item is one, or the
 * call would turn an item into one. Returns an error result, or null when the
 * call is the team's coordinator accepting the manifest.
 */
export async function guardToolManifestUpdate(
  args: any,
  item: ManifestItemLike,
  sessionId: string | undefined,
): Promise<ToolError | null> {
  const isManifest = item.type === TOOL_MANIFEST_TYPE;
  if (!isManifest && !mentionsToolManifest(args)) return null;
  if (!isManifest) {
    return refuse('An item cannot be turned into a tool-manifest; only Nimbalyst writes them, from an architect session.');
  }
  if (args.primaryType !== undefined && args.primaryType !== TOOL_MANIFEST_TYPE) {
    return refuse('A tool-manifest cannot change type.');
  }
  if (Array.isArray(args.typeTags) && args.typeTags.some((tag: unknown) => tag !== TOOL_MANIFEST_TYPE)) {
    return refuse('A tool-manifest cannot change type.');
  }

  // Who is calling: only the coordinator of the team the manifest belongs to.
  if (!sessionId) return refuse('Only the coordinator of the team that received this manifest can accept it.');
  let session: { agentRole?: string | null; metadata?: Record<string, unknown> | null } | null;
  try {
    session = (await AISessionsRepository.get(sessionId)) as typeof session;
  } catch (error) {
    console.error(`[tool-manifest] Could not read session ${sessionId}:`, error);
    return refuse('Could not verify the calling session, so the Tool Manifest was not changed. Try again.');
  }
  const context = resolveTeamContext(session?.metadata ?? null, session?.agentRole);
  if (context.teamChild) {
    return refuse('Team members cannot change a Tool Manifest. Report to your coordinator; it decides.');
  }
  const owner = readToolManifestField(item as unknown as Record<string, unknown>, 'teamRootSessionId');
  if (!context.teamMode || owner !== sessionId) {
    return refuse('Only the coordinator of the team that received this manifest can accept it.');
  }

  // What is asked: status accepted, nothing else.
  for (const key of Object.keys(args)) {
    if (args[key] === undefined) continue;
    if (!ALLOWED_UPDATE_KEYS.has(key)) return refuse(ACCEPT_ONLY);
  }
  if (args.fields !== undefined) {
    if (!args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)) return refuse(ACCEPT_ONLY);
    for (const key of Object.keys(args.fields)) {
      if (args.fields[key] === undefined) continue;
      if (!ALLOWED_FIELD_KEYS.has(key)) return refuse(ACCEPT_ONLY);
    }
  }
  // A status travels in two places, the top-level argument and the fields bag,
  // and the write merges the bag last: every value present must say `accepted`.
  const requested = [args.status, args.fields?.status].filter((value: unknown) => value !== undefined);
  if (requested.length === 0 || requested.some((value: unknown) => value !== 'accepted')) return refuse(ACCEPT_ONLY);
  if (item.status === 'superseded') {
    return refuse('This Tool Manifest is superseded; the current manifest is the newest one. Accept that one instead.');
  }
  return null;
}
