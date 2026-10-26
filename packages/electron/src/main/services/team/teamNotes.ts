/**
 * Team Notes: distilled, durable project memory stored as `team-note` tracker
 * items (see runtime TrackerPlugin builtins/team-note.yaml).
 *
 * The tracker owns persistence, sync, comments and UI. This module only adds
 * what a note needs on top of a plain tracker write:
 *   - provenance filled by the host from the calling session, never by the agent;
 *   - a write gate: team members suggest notes in their report, they never write;
 *   - a body cap, so a note stays a summary and never becomes a transcript.
 */

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { resolveTeamContext } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  TEAM_NOTE_PROVENANCE_FIELDS,
  teamNoteBodyError,
  teamNoteKindError,
  teamNoteStatusError,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/teamNoteRules';

// The structural rules (kinds, statuses, body cap, protected provenance) live in
// the runtime's teamNoteRules and apply to every tracker write path; this module
// adds only the agent-facing policy on top of them.
export {
  TEAM_NOTE_BODY_MAX_CHARS,
  TEAM_NOTE_HANDOFF_BODY_MAX_CHARS,
  TEAM_NOTE_KINDS,
  TEAM_NOTE_PROVENANCE_FIELDS,
  TEAM_NOTE_TYPE,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/teamNoteRules';

/** Default page size for listing team notes (active ones by default). */
export const TEAM_NOTE_LIST_DEFAULT_LIMIT = 20;

export interface TeamNoteProvenance {
  sourceSession: string | null;
  teamRootSession: string | null;
  /** `coordinator` for a Team mode root, `standalone` for a session outside any team. */
  agentRole: 'coordinator' | 'standalone';
  branch: string | null;
  worktree: string | null;
  /**
   * The team-front of the mission, read from the root session's `teamFront`
   * metadata (the coordinator is the root). Null for a standalone session and for
   * a root with no front.
   */
  front: string | null;
}

export type TeamNoteWriterDecision =
  | { allowed: true; provenance: TeamNoteProvenance }
  | { allowed: false; reason: string };

interface CallerSession {
  agentRole?: string | null;
  metadata?: Record<string, unknown> | null;
  worktreeId?: string | null;
  worktreePath?: string | null;
}

interface CallerWorktree {
  branch?: string | null;
  path?: string | null;
}

/**
 * Pure write decision for a caller. A team member (teamChild) never writes:
 * it suggests notes in its report and the coordinator decides. Everyone else
 * may write, and the provenance comes from the session, not from the agent.
 */
export function decideTeamNoteWriter(
  sessionId: string | undefined,
  session: CallerSession | null,
  worktree: CallerWorktree | null,
): TeamNoteWriterDecision {
  const context = resolveTeamContext(session?.metadata ?? null, session?.agentRole);
  if (context.teamChild) {
    return {
      allowed: false,
      reason:
        `Team members cannot write Team Notes. Add it to your final report under "Suggested notes" ` +
        `("- [KIND] title — short summary") and your coordinator will decide whether to record it.`,
    };
  }
  return {
    allowed: true,
    provenance: {
      sourceSession: sessionId ?? null,
      teamRootSession: context.teamMode && sessionId ? sessionId : null,
      agentRole: context.teamMode ? 'coordinator' : 'standalone',
      branch: worktree?.branch ?? null,
      worktree: worktree?.path ?? session?.worktreePath ?? null,
      front: context.teamMode ? missionFront(session?.metadata) : null,
    },
  };
}

/** The front a mission root recorded, or null: only a non-blank string counts. */
function missionFront(metadata: Record<string, unknown> | null | undefined): string | null {
  const front = metadata?.teamFront;
  return typeof front === 'string' && front.trim().length > 0 ? front.trim() : null;
}

/**
 * Reads the calling session (and its worktree) and decides. Fail-closed: if
 * the session cannot be read, the write is refused rather than recorded with
 * unverifiable provenance.
 */
export async function resolveTeamNoteWriter(
  sessionId: string | undefined,
  loadWorktree: (worktreeId: string) => Promise<CallerWorktree | null>,
): Promise<TeamNoteWriterDecision> {
  if (!sessionId) return decideTeamNoteWriter(undefined, null, null);
  let session: CallerSession | null;
  try {
    session = (await AISessionsRepository.get(sessionId)) as CallerSession | null;
  } catch (error) {
    console.error(`[team-notes] Could not read session ${sessionId}:`, error);
    return { allowed: false, reason: 'Could not verify the calling session, so the Team Note was not written. Try again.' };
  }
  let worktree: CallerWorktree | null = null;
  if (session?.worktreeId) {
    try {
      worktree = await loadWorktree(session.worktreeId);
    } catch {
      worktree = null; // Branch is best-effort context; the path still comes from the session.
    }
  }
  return decideTeamNoteWriter(sessionId, session, worktree);
}

/** Drop host-only provenance keys from an agent-supplied fields bag. */
export function stripTeamNoteProvenance(fields: unknown): Record<string, unknown> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
  const rest = { ...(fields as Record<string, unknown>) };
  for (const key of TEAM_NOTE_PROVENANCE_FIELDS) delete rest[key];
  return rest;
}

/**
 * Error text for an oversized body, or null when it fits (shared rule). The cap
 * depends on the kind (a handoff gets more); without a kind the strict cap applies.
 */
export function checkTeamNoteBody(body: unknown, kind?: unknown): string | null {
  return body === undefined || body === null ? null : teamNoteBodyError(body, kind);
}

/** Error text for a missing or unknown noteKind, or null when valid (shared rule). */
export function checkTeamNoteKind(kind: unknown): string | null {
  return teamNoteKindError(kind);
}

/** Error text for an unknown status, or null when absent or valid (shared rule). */
export function checkTeamNoteStatus(status: unknown): string | null {
  return status === undefined || status === null || status === '' ? null : teamNoteStatusError(status);
}

/** Compact one-line summary of a note for the coordinator's listing. */
export function formatTeamNoteSummary(item: {
  title?: string;
  status?: string;
  customFields?: Record<string, unknown>;
}, ref: string): string {
  const fields = item.customFields ?? {};
  const kind = typeof fields.noteKind === 'string' ? fields.noteKind.toUpperCase() : 'NOTE';
  const role = typeof fields.agentRole === 'string' ? fields.agentRole : null;
  const source = typeof fields.sourceSession === 'string' ? fields.sourceSession.slice(0, 8) : null;
  const origin = [role, source ? `session ${source}` : null].filter(Boolean).join(', ');
  return `- [${kind}] ${item.title ?? ''} (${item.status ?? 'no status'}) [ref: ${ref}]${origin ? ` · ${origin}` : ''}`;
}
