/**
 * renderer_eval and Team mode (F1.1 S3b, NIB.186). renderer_eval runs JavaScript
 * in the user's renderer, which holds the user's own authority (the IPC that
 * decides a front proposal included). A Team mode session, the root or any
 * member, never gets it, on any provider: the extension-dev server asks this
 * guard with the session its connection was configured for.
 *
 * Fail closed: when the connection names a session and that session cannot be
 * resolved (no row, or the read fails after one retry), the call is refused.
 * A connection that names NO session at all (a direct dev connection with no
 * `aiSessionId` on its URL, which no Nimbalyst-built session config produces)
 * keeps today's behaviour; the development-mode gate still applies to it.
 */

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { resolveTeamContext } from '@nimbalyst/runtime/ai/server/providers/teamContext';

export const RENDERER_EVAL_TEAM_REFUSAL =
  'renderer_eval is not available to Team mode sessions (the coordinator and its members): it runs in the app renderer with the user\'s own authority.';
export const RENDERER_EVAL_UNVERIFIED_REFUSAL =
  'renderer_eval was refused because the calling session could not be verified. Try again.';

type SessionRow = { metadata?: unknown; agentRole?: string | null } | null | undefined;
type SessionReader = (sessionId: string) => Promise<SessionRow>;

const defaultReader: SessionReader = (sessionId) => AISessionsRepository.get(sessionId) as Promise<SessionRow>;

/** The reason renderer_eval must be refused for this connection's session, or null when it may proceed. */
export async function rendererEvalSessionRefusal(
  sessionId: string | undefined,
  readSession: SessionReader = defaultReader,
): Promise<string | null> {
  if (!sessionId) return null;
  let row: SessionRow;
  try {
    row = await readSession(sessionId).catch(() => readSession(sessionId));
  } catch {
    return RENDERER_EVAL_UNVERIFIED_REFUSAL;
  }
  if (!row) return RENDERER_EVAL_UNVERIFIED_REFUSAL;
  const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : null;
  const team = resolveTeamContext(metadata, row.agentRole);
  return team.teamMode || team.teamChild ? RENDERER_EVAL_TEAM_REFUSAL : null;
}
