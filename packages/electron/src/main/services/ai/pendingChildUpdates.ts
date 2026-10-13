import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';

/**
 * Drop a child's still-pending `[Child Session Update]` rows from its parent's
 * prompt queue.
 *
 * Two callers, same need. The takeover path uses it because the user has gone
 * to the child directly and the parent should stop being told about it at all.
 * The notification path uses it to supersede: a child that cycles
 * idle -> running -> idle emits a fresh `session:completed` each cycle, and the
 * signature dedup in MetaAgentService only collapses duplicates *within* a
 * single child turn. Without superseding, the parent accrues one row per cycle
 * per child, all of them snapshots of the same child, and only the newest still
 * true by the time the parent reads it.
 *
 * Matching is by rendered header rather than by `document_context` provenance
 * on purpose: a JSON sub-extraction (`data->'key'`) returns a parsed object on
 * PGLite and a JSON string on SQLite, and both backends are live during the
 * migration. Plain SQL `LIKE` behaves identically on each.
 */
export async function deletePendingChildUpdates(
  parentSessionId: string,
  childSessionId: string,
): Promise<void> {
  await databaseWorker.query(
    `DELETE FROM queued_prompts
     WHERE session_id = $1
       AND status = 'pending'
       AND prompt LIKE '[Child Session Update]%'
       AND prompt LIKE $2`,
    [parentSessionId, `%(${childSessionId})%`],
  );
}

/**
 * Phase 1B: drop a child's still-pending `[Tool Manifest]` notices from its
 * parent's queue. A newer manifest of the same architect makes them stale and
 * the new notice says what superseded what: supersede, never append. The
 * notice names the architect session in both UI languages.
 */
export async function deletePendingToolManifestNotices(
  parentSessionId: string,
  childSessionId: string,
): Promise<void> {
  await databaseWorker.query(
    `DELETE FROM queued_prompts
     WHERE session_id = $1
       AND status = 'pending'
       AND prompt LIKE '[Tool Manifest]%'
       AND prompt LIKE $2`,
    [parentSessionId, `%${childSessionId}%`],
  );
}
