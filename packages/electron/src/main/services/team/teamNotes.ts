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

export const TEAM_NOTE_TYPE = 'team-note';

/** Approximate ceiling for a note body; a note is a summary, not a report. */
export const TEAM_NOTE_BODY_MAX_CHARS = 600;

/** Default page size for listing team notes (active ones by default). */
export const TEAM_NOTE_LIST_DEFAULT_LIMIT = 20;

export const TEAM_NOTE_KINDS = ['decision', 'discovery', 'risk', 'pending', 'test', 'context'] as const;
export type TeamNoteKind = (typeof TEAM_NOTE_KINDS)[number];

/** Fields only the host writes. Agent-supplied values are dropped. */
export const TEAM_NOTE_PROVENANCE_FIELDS = ['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree'] as const;

export interface TeamNoteProvenance {
  sourceSession: string | null;
  teamRootSession: string | null;
  /** `coordinator` for a Team mode root, `standalone` for a session outside any team. */
  agentRole: 'coordinator' | 'standalone';
  branch: string | null;
  worktree: string | null;
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
    },
  };
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

/** Error text for an oversized body, or null when it fits. */
export function checkTeamNoteBody(body: unknown): string | null {
  if (typeof body !== 'string') return null;
  const length = body.replace(/\\n/g, '\n').trim().length;
  if (length <= TEAM_NOTE_BODY_MAX_CHARS) return null;
  return (
    `Team Note body is ${length} characters; the limit is ${TEAM_NOTE_BODY_MAX_CHARS}. ` +
    `Keep only the durable summary and point to the session, files or commit for the details.`
  );
}

/** Error text for a missing or unknown noteKind, or null when valid. */
export function checkTeamNoteKind(kind: unknown): string | null {
  if (typeof kind === 'string' && (TEAM_NOTE_KINDS as readonly string[]).includes(kind)) return null;
  return `Team Note needs fields.noteKind, one of: ${TEAM_NOTE_KINDS.join(', ')}.`;
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
