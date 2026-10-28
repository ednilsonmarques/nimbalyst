// @vitest-environment node
/**
 * F1 S4, the documented limitation, made deterministic (test only, no product change):
 * the mission row is written by one INSERT and then READ BACK to confirm it. If that read
 * throws, the caller gets the error although the mission exists and holds the front.
 *
 * The REAL session store and the REAL SQL ports, on both engines. The failure is injected at
 * the SQL boundary the ports are built on (the same seam teamMissionConcurrency.test.ts uses to
 * hold work): the ports' `query` throws for the read-back statement, and only after the
 * store's own INSERT has run. Nothing in the product is hooked.
 *
 * What the contract promises, and what is asserted:
 *  - the caller gets the original error (not a refusal code, not a success);
 *  - the row is preserved: the mission exists, with the host marker and the front;
 *  - both locks (the session id and the front) are released, so nothing is stuck;
 *  - the next creation on the same front is refused with mission-active, and the same id with
 *    session-exists: the front is correctly occupied, nothing is duplicated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

import { PGlite } from '@electric-sql/pglite';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../../PGLiteSessionStore';
import { buildTeamMissionPorts } from '../teamMissionPorts';
import { TeamMissionError, createTeamMissionRoot, teamFrontLockCount, withSessionIdLock } from '../teamMissions';

type Backend = 'sqlite' | 'pglite';

const PG_DDL = `
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, path TEXT, workspace_id TEXT, is_archived BOOLEAN DEFAULT FALSE);
  CREATE TABLE ai_sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT, file_path TEXT, provider TEXT, model TEXT, session_type TEXT, mode TEXT, agent_role TEXT,
    created_by_session_id TEXT, title TEXT, worktree_id TEXT, parent_session_id TEXT,
    provider_session_id TEXT, draft_input TEXT, document_context JSONB, provider_config JSONB, has_been_named BOOLEAN,
    last_read_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_archived BOOLEAN DEFAULT FALSE, is_pinned BOOLEAN DEFAULT FALSE,
    branched_from_session_id TEXT, branch_point_message_id TEXT, branched_at TIMESTAMPTZ, metadata JSONB
  );
  CREATE TABLE tracker_items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, data JSONB NOT NULL, workspace TEXT NOT NULL,
    archived BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMPTZ
  );`;

const WS = '/ws/project';
const FRONT = 'front-a';
const deps = { policyFiles: () => [] as string[] };
const READ_BACK_SQL = 'SELECT metadata FROM ai_sessions WHERE id = $1 LIMIT 1';

describe.each<Backend>(['sqlite', 'pglite'])('the post-write re-read fails, on %s', (backend) => {
  let tmpDir: string;
  let db: SQLiteDatabase | PGlite;
  /** Set by the store's INSERT (through the create callback), read by the injected failure. */
  let inserted = false;
  let failReadBack = true;
  let readBackAttempts = 0;

  const query = (sql: string, params: unknown[] = []) => (db as { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }).query(sql, params);
  const store = () => createPGLiteSessionStore(db as never);

  /** The real ports; only the read-back statement is made to throw, and only once the row has been written. */
  const ports = () =>
    buildTeamMissionPorts(
      {
        query: async (sql, params) => {
          if (sql.trim() === READ_BACK_SQL) {
            readBackAttempts += 1;
            if (failReadBack && inserted) throw new Error('read-back failed: database is locked');
          }
          return query(sql, params as unknown[]);
        },
        engine: backend,
      },
      async (payload) => {
        await store().create(payload);
        inserted = true;
      },
    );

  const row = (id: string) => ({
    payload: { id, provider: 'claude-code', model: 'claude-code:opus', title: `Mission ${id}`, workspaceId: WS, agentRole: 'standard' as const, metadata: { teamMode: true } },
    request: { front: FRONT, goal: `Goal of ${id}` },
  });

  async function storedRows(): Promise<Array<{ id: string; metadata: Record<string, any> }>> {
    const { rows } = await query(`SELECT id, metadata FROM ai_sessions ORDER BY id`);
    return rows.map((r) => ({ id: r.id, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata }));
  }

  beforeEach(async () => {
    inserted = false;
    failReadBack = true;
    readBackAttempts = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nim-mission-reread-${backend}-`));
    if (backend === 'sqlite') {
      const sqlite = new SQLiteDatabase({
        dbDir: tmpDir,
        schemaDir: path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas'),
        slowQueryThresholdMs: 1000,
        sampleRate: 0,
      });
      await sqlite.initialize();
      db = sqlite;
    } else {
      const pg = new PGlite();
      await pg.exec(PG_DDL);
      db = pg;
    }
    await query(
      `INSERT INTO tracker_items (id, type, data, workspace, archived) VALUES ($1, 'team-front', $2::jsonb, $3, FALSE)`,
      [FRONT, JSON.stringify({ title: 'Front A', status: 'active', description: 'State' }), WS],
    );
  });

  afterEach(async () => {
    expect(teamFrontLockCount()).toBe(0);
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the caller gets the original error, the row is preserved and both locks are released', async () => {
    const outcome = await createTeamMissionRoot(row('mission-1'), ports(), deps).then(() => 'resolved', (e) => e);

    // The caller gets the error as it was: an ordinary exception, neither a success nor a refusal code.
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).not.toBeInstanceOf(TeamMissionError);
    expect((outcome as Error).message).toBe('read-back failed: database is locked');
    expect(readBackAttempts).toBe(1);

    // The mission exists: marker, front, goal, status.
    const rows = await storedRows();
    expect(rows.map((r) => r.id)).toEqual(['mission-1']);
    expect(rows[0].metadata).toMatchObject({
      teamMode: true,
      teamFront: FRONT,
      teamGoal: 'Goal of mission-1',
      teamMissionStatus: 'active',
      teamMissionVersion: 1,
    });

    // Both locks are free: the lock map is empty and the same keys can be taken again at once.
    expect(teamFrontLockCount()).toBe(0);
    expect(await withSessionIdLock('mission-1', async () => 'session lock free')).toBe('session lock free');
    expect(teamFrontLockCount()).toBe(0);
  });

  it('the next creation on the same front is refused with mission-active, naming the mission that exists', async () => {
    await createTeamMissionRoot(row('mission-1'), ports(), deps).catch(() => {});
    failReadBack = false; // the database is healthy again

    // A retry from the dialog uses a new session id.
    const retry = await createTeamMissionRoot(row('mission-2'), ports(), deps).then(() => 'resolved', (e) => e);
    expect(retry).toBeInstanceOf(TeamMissionError);
    expect((retry as TeamMissionError).code).toBe('mission-active');
    expect((retry as TeamMissionError).message).toContain('mission-1');

    // The same id is refused as an existing session; nothing is duplicated and nothing is overwritten.
    const sameId = await createTeamMissionRoot(row('mission-1'), ports(), deps).then(() => 'resolved', (e) => e);
    expect(sameId).toBeInstanceOf(TeamMissionError);
    expect((sameId as TeamMissionError).code).toBe('session-exists');

    const rows = await storedRows();
    expect(rows.map((r) => r.id)).toEqual(['mission-1']);
    expect(rows[0].metadata.teamMissionVersion).toBe(1);
    expect(teamFrontLockCount()).toBe(0);
  });

  it('a mission on another front is not held up by the failure', async () => {
    await query(
      `INSERT INTO tracker_items (id, type, data, workspace, archived) VALUES ($1, 'team-front', $2::jsonb, $3, FALSE)`,
      ['front-b', JSON.stringify({ title: 'Front B', status: 'active', description: 'State' }), WS],
    );
    await createTeamMissionRoot(row('mission-1'), ports(), deps).catch(() => {});
    failReadBack = false;

    await createTeamMissionRoot({ ...row('mission-b'), request: { front: 'front-b', goal: 'Goal B' } }, ports(), deps);
    expect((await storedRows()).map((r) => [r.id, r.metadata.teamFront])).toEqual([['mission-1', FRONT], ['mission-b', 'front-b']]);
  });

  it('archiving the mission that was written frees the front again (the way out)', async () => {
    await createTeamMissionRoot(row('mission-1'), ports(), deps).catch(() => {});
    failReadBack = false;
    await query(`UPDATE ai_sessions SET is_archived = TRUE WHERE id = 'mission-1'`);
    await createTeamMissionRoot(row('mission-2'), ports(), deps);
    expect((await storedRows()).map((r) => r.id)).toEqual(['mission-1', 'mission-2']);
  });
});
