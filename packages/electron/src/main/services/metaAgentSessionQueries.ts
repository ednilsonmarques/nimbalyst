/**
 * The workspace-scoped `ai_sessions` reads the meta-agent tools run, split out
 * of `MetaAgentService` so the SQL (and the spawn ceilings it enforces) sits in
 * one small module rather than inside the orchestration flow.
 *
 * Every query here is keyed by the workspace a session is STORED under, which
 * is not always the spelling the caller arrived with — see
 * `utils/workspaceIdentity` (https://github.com/nimbalyst/nimbalyst/issues/1551).
 */

import { database as databaseWorker } from '../database/PGLiteDatabaseWorker';
import { TEAM_BUDGET_METADATA_KEY, resolveTeamContext } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  TeamBudgetReachedError,
  extendedTeamBudget,
  isTeamBudgetExhausted,
  resolveAuthorizedTeamBudget,
  teamSpawnRefusal,
  type TeamCaller,
  type TeamUsage,
} from './team/teamPolicy';

/** Controllable "max parallel" limit: children currently running. */
const MAX_IN_FLIGHT = 4;
/** Non-controllable ceiling on children ever created by one parent. */
const LIFETIME_BACKSTOP = 50;

export async function getSessionStatusRow(sessionId: string, workspaceId: string): Promise<any | null> {
  const { rows } = await databaseWorker.query<any>(
    `SELECT id, title, provider, model, status, last_activity, updated_at, created_by_session_id, agent_role
       FROM ai_sessions
       WHERE id = $1 AND workspace_id = $2
       LIMIT 1`,
    [sessionId, workspaceId]
  );
  return rows[0] || null;
}

export async function getSpawnedSessionRows(metaSessionId: string, workspaceId: string): Promise<any[]> {
  const { rows } = await databaseWorker.query<any>(
    `SELECT id, title, provider, model, status, last_activity, created_at, updated_at, worktree_id, agent_role, created_by_session_id
       FROM ai_sessions
       WHERE workspace_id = $1
         AND created_by_session_id = $2
         AND (is_archived = FALSE OR is_archived IS NULL)
       ORDER BY created_at DESC`,
    [workspaceId, metaSessionId]
  );
  return rows;
}

/**
 * Two independent gates on how many children a parent can spawn.
 *
 * `MAX_IN_FLIGHT` counts only children currently active (running /
 * waiting_for_input). A finished child frees a slot, so a parent may spawn an
 * unbounded TOTAL over its lifetime as long as it does not exceed this many at
 * once — that is the intended behavior.
 *
 * `LIFETIME_BACKSTOP` bounds ALL children ever created (any status,
 * non-archived). An in-flight count alone does NOT bound SEQUENTIAL re-spawn
 * runaways: a completion-wakeup re-drives the parent, a weak model spawns
 * another child, the child settles in milliseconds, so the in-flight count
 * stays ~0 and never fires. This backstop catches that loop without imposing a
 * low lifetime cap on normal use. Mirrors the created_by_session_id query in
 * `getSpawnedSessionRows`.
 */
export async function assertChildSpawnCapacity(workspaceId: string, metaSessionId: string): Promise<void> {
  // SUM(CASE ...) rather than COUNT(*) FILTER (...) so the aggregate is
  // portable across both PGLite and better-sqlite3 (see DATABASE.md).
  const { rows } = await databaseWorker.query<{ in_flight: string; total: string }>(
    `SELECT
         SUM(CASE WHEN status IN ('running', 'waiting_for_input') THEN 1 ELSE 0 END)::text AS in_flight,
         COUNT(*)::text AS total
       FROM ai_sessions
       WHERE workspace_id = $1
         AND created_by_session_id = $2
         AND (is_archived = FALSE OR is_archived IS NULL)`,
    [workspaceId, metaSessionId]
  );

  const inFlightCount = Number(rows[0]?.in_flight ?? '0');
  const totalCount = Number(rows[0]?.total ?? '0');
  if (inFlightCount >= MAX_IN_FLIGHT) {
    throw new Error(
      `Too many child sessions running at once (${inFlightCount}/${MAX_IN_FLIGHT} in flight). ` +
      `Wait for a spawned session to finish before spawning more.`
    );
  }
  if (totalCount >= LIFETIME_BACKSTOP) {
    throw new Error(
      `Meta-agent lifetime spawn backstop reached (${LIFETIME_BACKSTOP} total children spawned by this parent); refusing to spawn more`
    );
  }
}

/**
 * Size and activity of a Team mode team: every session descending from the
 * root through created_by_session_id (children, grandchildren), archived ones
 * included because the budget is for the team's whole life. "Active" also
 * counts a session that is idle but holds a pending/executing queued prompt:
 * a member created a moment ago has not started its first turn yet.
 *
 * Not filtered by workspace: the root id alone identifies the team, and members
 * filed under another spelling of the workspace path (#1551) must still count.
 * UNION (not UNION ALL) keeps a malformed creator cycle from recursing forever.
 */
export async function getTeamUsage(rootSessionId: string): Promise<TeamUsage> {
  const { rows } = await databaseWorker.query<{ total: string | null; active: string | null }>(
    `WITH RECURSIVE team_tree(id) AS (
         SELECT id FROM ai_sessions WHERE created_by_session_id = $1
       UNION
         SELECT s.id FROM ai_sessions s JOIN team_tree t ON s.created_by_session_id = t.id
     )
     SELECT
         COUNT(*)::text AS total,
         SUM(CASE WHEN s.status IN ('running', 'waiting_for_input')
                    OR EXISTS (
                      SELECT 1 FROM queued_prompts q
                       WHERE q.session_id = s.id AND q.status IN ('pending', 'executing')
                    )
                  THEN 1 ELSE 0 END)::text AS active
       FROM team_tree t
       JOIN ai_sessions s ON s.id = t.id`,
    [rootSessionId]
  );
  return {
    total: Number(rows[0]?.total ?? '0') || 0,
    active: Number(rows[0]?.active ?? '0') || 0,
  };
}

/** SQLite hands whole JSON columns back as text; PGLite as objects. */
function parseMetadataColumn(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

async function getTeamRootRow(
  rootSessionId: string,
): Promise<{ metadata: Record<string, unknown> | null; agentRole: string | null } | null> {
  const { rows } = await databaseWorker.query<{ metadata: unknown; agent_role: string | null }>(
    `SELECT metadata, agent_role FROM ai_sessions WHERE id = $1 LIMIT 1`,
    [rootSessionId],
  );
  if (!rows[0]) return null;
  return { metadata: parseMetadataColumn(rows[0].metadata), agentRole: rows[0].agent_role ?? null };
}

/** Sessions the root is authorized to create: its stored budget, or the initial one. */
export async function getTeamAuthorizedBudget(rootSessionId: string): Promise<number> {
  return resolveAuthorizedTeamBudget((await getTeamRootRow(rootSessionId))?.metadata);
}

/**
 * Team mode gate, run before any side effect of a child creation. Complements
 * (does not replace) assertChildSpawnCapacity, which still applies per creator.
 * A team at its checkpoint is refused with TeamBudgetReachedError.
 * `continueActionLabel`: the checkpoint action's name in the UI language.
 */
export async function assertTeamSpawnCapacity(team: TeamCaller, continueActionLabel?: string): Promise<void> {
  // Depth needs no query; refuse it before touching the database.
  const depthRefusal = teamSpawnRefusal(team, { total: 0, active: 0 });
  if (depthRefusal) throw new Error(depthRefusal);
  const usage = await getTeamUsage(team.rootSessionId);
  const authorized = await getTeamAuthorizedBudget(team.rootSessionId);
  const refusal = teamSpawnRefusal(team, usage, authorized, continueActionLabel);
  if (!refusal) return;
  if (isTeamBudgetExhausted(usage, authorized)) throw new TeamBudgetReachedError(refusal, usage.total, authorized);
  throw new Error(refusal);
}

export type TeamContinuationResult =
  | { extended: true; total: number; previousAuthorized: number; authorized: number }
  | { extended: false; reason: 'not-a-team-root' | 'not-at-checkpoint'; total?: number; authorized?: number };

/**
 * The user continues a team: its root may create `budgetExtension` more
 * sessions. The only writer of `metadata.teamBudget` (ordinary metadata writes
 * drop the key), and reachable only from the renderer's `team:continue` IPC.
 *
 * Extends only a team root that has reached its checkpoint, so authorizations
 * cannot be stockpiled and a repeated click is a no-op. Callers hold the team's
 * spawn lock so the read and the write cannot interleave with a creation.
 */
export async function authorizeTeamContinuation(rootSessionId: string): Promise<TeamContinuationResult> {
  const root = await getTeamRootRow(rootSessionId);
  if (!root || !resolveTeamContext(root.metadata, root.agentRole).teamMode) {
    return { extended: false, reason: 'not-a-team-root' };
  }
  const previousAuthorized = resolveAuthorizedTeamBudget(root.metadata);
  const usage = await getTeamUsage(rootSessionId);
  if (!isTeamBudgetExhausted(usage, previousAuthorized)) {
    return { extended: false, reason: 'not-at-checkpoint', total: usage.total, authorized: previousAuthorized };
  }
  const next = extendedTeamBudget(previousAuthorized);
  // Same merge as OWNER_METADATA_MERGE_SQL (`metadata || $1` is translated for SQLite).
  await databaseWorker.query(
    `UPDATE ai_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ [TEAM_BUDGET_METADATA_KEY]: next }), rootSessionId],
  );
  return { extended: true, total: usage.total, previousAuthorized, authorized: next.authorized };
}
