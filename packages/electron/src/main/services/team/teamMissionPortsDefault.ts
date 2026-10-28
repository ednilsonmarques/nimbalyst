/**
 * The mission creation ports bound to the app's database and session repository.
 * Kept apart from teamMissionPorts.ts so the SQL can be tested without the
 * database worker.
 */

import { AISessionsRepository } from '@nimbalyst/runtime';
import { database } from '../../database/PGLiteDatabaseWorker';
import { buildTeamMissionPorts } from './teamMissionPorts';
import type { TeamMissionPorts } from './teamMissions';

export function defaultTeamMissionPorts(): TeamMissionPorts {
  return buildTeamMissionPorts(
    { query: (sql, params) => database.query(sql, params), engine: () => database.getEngine() },
    (payload) => AISessionsRepository.create(payload),
  );
}
