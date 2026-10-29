/**
 * The read-only tracker ports behind front proposals (F1.1), bound to the app's
 * database. The two lookups the mission creation already has (getFront,
 * findActiveMissionRoot) are reused as they are; listFronts is the one new read
 * (D2 compares a proposed title with every non-archived team-front). Nothing
 * here writes: the SQL is SELECT only.
 */

import { TEAM_FRONT_TYPE, readTeamFrontField } from '@nimbalyst/tracker-core';
import { database } from '../../database/PGLiteDatabaseWorker';
import { parseJsonObjectColumn } from '../../utils/jsonColumn';
import { sameWorkspaceIdentity } from '../../utils/workspaceIdentity';
import { fromDbBoolean } from '../tracker/trackerDbValue';
import { defaultTeamMissionPorts } from './teamMissionPortsDefault';
import type { TeamFrontListEntry, TeamFrontProposalPorts } from './teamFrontProposals';

export interface TeamFrontListSql {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export async function listTeamFronts(sql: TeamFrontListSql, workspaceId: string): Promise<TeamFrontListEntry[]> {
  const { rows } = await sql.query(
    `SELECT id, data, workspace, archived FROM tracker_items WHERE type = $1 AND deleted_at IS NULL`,
    [TEAM_FRONT_TYPE],
  );
  const fronts: TeamFrontListEntry[] = [];
  for (const row of rows) {
    if (!sameWorkspaceIdentity(row.workspace, workspaceId)) continue;
    const data = parseJsonObjectColumn(row.data);
    const title = readTeamFrontField(data, 'title');
    const status = readTeamFrontField(data, 'status');
    fronts.push({
      id: row.id,
      title: typeof title === 'string' ? title : row.id,
      status: typeof status === 'string' && status ? status : null,
      archived: fromDbBoolean(row.archived),
    });
  }
  return fronts;
}

export function defaultTeamFrontProposalPorts(): TeamFrontProposalPorts {
  const missionPorts = defaultTeamMissionPorts();
  return {
    getFront: (frontId, workspaceId) => missionPorts.getFront(frontId, workspaceId),
    findActiveMissionRoot: (frontId) => missionPorts.findActiveMissionRoot(frontId),
    listFronts: (workspaceId) => listTeamFronts({ query: (sql, params) => database.query(sql, params) }, workspaceId),
  };
}
