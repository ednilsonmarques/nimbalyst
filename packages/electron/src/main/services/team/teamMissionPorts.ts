/**
 * The SQL behind the mission creation (teamMissions.ts), written against a small
 * `query` so it runs on both row shapes the main reads: PGLite hands JSON columns
 * back as objects, SQLite as text. No DDL, no write other than the session insert
 * the caller passes in.
 */

import { isHostMissionRoot } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { readTeamFrontField } from '@nimbalyst/tracker-core';
import type { CreateSessionPayload } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { DatabaseEngine } from '../../database/PGLiteDatabaseWorker';
import { jsonKeyExpr } from '../../database/jsonKeyExpr';
import { parseJsonObjectColumn } from '../../utils/jsonColumn';
import { sameWorkspaceIdentity } from '../../utils/workspaceIdentity';
import { fromDbBoolean } from '../tracker/trackerDbValue';
import type { TeamFrontRecord, TeamMissionPorts } from './teamMissions';

export interface TeamMissionSql {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  /** The active engine (a function so it is read when needed, not at import). */
  engine: DatabaseEngine | (() => DatabaseEngine);
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function buildTeamMissionPorts(
  sql: TeamMissionSql,
  createSession: (payload: CreateSessionPayload) => Promise<void>,
): TeamMissionPorts {
  const engine = () => (typeof sql.engine === 'function' ? sql.engine() : sql.engine);
  return {
    async sessionExists(sessionId) {
      const { rows } = await sql.query(`SELECT id FROM ai_sessions WHERE id = $1 LIMIT 1`, [sessionId]);
      return rows.length > 0;
    },

    async getSessionMetadata(sessionId) {
      const { rows } = await sql.query(`SELECT metadata FROM ai_sessions WHERE id = $1 LIMIT 1`, [sessionId]);
      return rows[0] ? parseJsonObjectColumn(rows[0].metadata) : null;
    },

    async getFront(frontId, workspaceId): Promise<TeamFrontRecord | null> {
      // By item id only. A tombstone is a row, not an absence (deleted_at), and an
      // item of another workspace is "not found", never revealed.
      const { rows } = await sql.query(
        `SELECT id, type, data, workspace, archived FROM tracker_items WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
        [frontId],
      );
      const row = rows[0];
      if (!row || !sameWorkspaceIdentity(row.workspace, workspaceId)) return null;
      const data = parseJsonObjectColumn(row.data);
      const status = readTeamFrontField(data, 'status');
      return {
        id: row.id,
        type: row.type,
        title: nonBlank(readTeamFrontField(data, 'title')) ?? row.id,
        status: nonBlank(status),
        archived: fromDbBoolean(row.archived),
        description: nonBlank(readTeamFrontField(data, 'description')),
      };
    },

    async findActiveMissionRoot(frontId) {
      // Not filtered by workspace: the front id is a primary key of the tracker, so it
      // already names one workspace, and a root filed under another spelling of that
      // path must still hold the front. The JSON predicate narrows the scan; the exact
      // rule (host marker, not a member, not closed) is applied to the parsed metadata.
      const { rows } = await sql.query(
        `SELECT id, title, metadata FROM ai_sessions
          WHERE ${jsonKeyExpr(engine(), 'metadata', 'teamFront')} = $1
            AND (is_archived = FALSE OR is_archived IS NULL)
          ORDER BY created_at ASC, id ASC`,
        [frontId],
      );
      for (const row of rows) {
        const metadata = parseJsonObjectColumn(row.metadata);
        if (!isHostMissionRoot(metadata) || metadata.teamFront !== frontId || metadata.teamMissionStatus === 'closed') continue;
        return { id: row.id, title: nonBlank(row.title) };
      }
      return null;
    },

    createSession,
  };
}
