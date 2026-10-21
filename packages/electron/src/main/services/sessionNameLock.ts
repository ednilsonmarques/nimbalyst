import { resolveTeamContext } from '@nimbalyst/runtime/ai/server/providers/teamContext';

/**
 * Whether a session's name is locked: a team member that already has a title
 * keeps it, and its team root retitles it through send_prompt. An unnamed
 * member names itself once; sessions outside a team and missing sessions are
 * never locked.
 */
export function isSessionNameLocked(
  session: { hasBeenNamed?: boolean; metadata?: unknown; agentRole?: string | null } | null | undefined,
): boolean {
  if (!session?.hasBeenNamed) return false;
  return resolveTeamContext(session.metadata as Record<string, unknown> | undefined, session.agentRole).teamChild != null;
}
