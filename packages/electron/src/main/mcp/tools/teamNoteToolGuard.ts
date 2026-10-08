/**
 * Team Note guard for tracker_create / tracker_update. Runs before the generic
 * tracker write and either refuses the call or rewrites `args` in place so the
 * host-owned provenance is set and the agent's copy of it is dropped. Other
 * tracker types never reach this module.
 */

import {
  TEAM_NOTE_TYPE,
  checkTeamNoteBody,
  checkTeamNoteKind,
  resolveTeamNoteWriter,
  stripTeamNoteProvenance,
} from '../../services/team/teamNotes';

interface ToolError {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

function refuse(text: string): ToolError {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

async function loadWorktree(worktreeId: string): Promise<{ branch: string; path: string } | null> {
  const { getDatabase } = await import('../../database/initialize');
  const db = getDatabase();
  if (!db) return null;
  const { createWorktreeStore } = await import('../../services/WorktreeStore');
  const worktree = await createWorktreeStore(db).get(worktreeId);
  return worktree ? { branch: worktree.branch, path: worktree.path } : null;
}

function mentionsTeamNote(args: any): boolean {
  return args?.primaryType === TEAM_NOTE_TYPE || (Array.isArray(args?.typeTags) && args.typeTags.includes(TEAM_NOTE_TYPE));
}

/** A fields-bag description is the body too; move it so the cap sees it. */
function liftFieldsDescription(args: any): void {
  if (args.fields && typeof args.fields === 'object' && args.fields.description !== undefined && args.description === undefined) {
    args.description = args.fields.description;
    delete args.fields.description;
  }
}

export function isTeamNoteCreate(args: any): boolean {
  return args?.type === TEAM_NOTE_TYPE || mentionsTeamNote(args);
}

/** Guard a tracker_create of a team note. Returns an error result, or null after rewriting args. */
export async function guardTeamNoteCreate(args: any, sessionId: string | undefined): Promise<ToolError | null> {
  if (args.type !== TEAM_NOTE_TYPE) {
    return refuse(`${TEAM_NOTE_TYPE} can only be the primary type of an item, not a type tag.`);
  }
  liftFieldsDescription(args);
  const bodyError = checkTeamNoteBody(args.description);
  if (bodyError) return refuse(bodyError);
  const kindError = checkTeamNoteKind(args.fields?.noteKind);
  if (kindError) return refuse(kindError);

  const writer = await resolveTeamNoteWriter(sessionId, loadWorktree);
  if (!writer.allowed) return refuse(writer.reason);

  const provenance = Object.fromEntries(Object.entries(writer.provenance).filter(([, value]) => value !== null));
  args.fields = { ...stripTeamNoteProvenance(args.fields), ...provenance };
  return null;
}

/**
 * Guard a tracker_update that touches a team note: the item is one, or the call
 * would turn an item into one. Returns an error result, or null after rewriting args.
 */
export async function guardTeamNoteUpdate(
  args: any,
  itemType: string,
  sessionId: string | undefined,
): Promise<ToolError | null> {
  const isNote = itemType === TEAM_NOTE_TYPE;
  if (!isNote && !mentionsTeamNote(args)) return null;
  if (!isNote) {
    return refuse(`An item cannot be turned into a ${TEAM_NOTE_TYPE}; create a new note instead.`);
  }
  if (args.primaryType !== undefined && args.primaryType !== TEAM_NOTE_TYPE) {
    return refuse(`A ${TEAM_NOTE_TYPE} cannot change type. Mark it obsolete and create the new item instead.`);
  }

  const writer = await resolveTeamNoteWriter(sessionId, loadWorktree);
  if (!writer.allowed) return refuse(writer.reason);

  liftFieldsDescription(args);
  if (args.description !== undefined) {
    const bodyError = checkTeamNoteBody(args.description);
    if (bodyError) return refuse(bodyError);
  }
  if (args.fields && typeof args.fields === 'object') {
    if (args.fields.noteKind !== undefined) {
      const kindError = checkTeamNoteKind(args.fields.noteKind);
      if (kindError) return refuse(kindError);
    }
    // Provenance records where the note came from; an update never rewrites it.
    args.fields = stripTeamNoteProvenance(args.fields);
  }
  return null;
}
