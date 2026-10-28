// @vitest-environment node
/**
 * F1 S4, integration: the REAL session store (`create`, with its upsert and the
 * creation-only rules) behind the REAL SQL ports, on both engines, with creations
 * started together. The concurrency of the lock is proven with fake ports in
 * teamMissionCreate.test.ts and the SQL in teamMissionPorts.test.ts; this closes
 * the gap between them.
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
const deps = { policyFiles: () => [] as string[] };

describe.each<Backend>(['sqlite', 'pglite'])('real store + real ports on %s', (backend) => {
  let tmpDir: string;
  let db: SQLiteDatabase | PGlite;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nim-mission-conc-${backend}-`));
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
    for (const id of ['front-a', 'front-b']) {
      await query(
        `INSERT INTO tracker_items (id, type, data, workspace, archived) VALUES ($1, 'team-front', $2::jsonb, $3, FALSE)`,
        [id, JSON.stringify({ title: `Front ${id}`, status: 'active', description: 'State' }), WS],
      );
    }
  });

  // Registered after the database teardown below on purpose: hooks run in reverse order, so this runs first.
  // The lock map in teamMissions.ts is module-global; a test that fails with a gate still held must not
  // leave a lock taken for the next one, nor close the database under parked work.
  const openGates: Array<() => void> = [];
  const releaseOpenGates = async () => {
    for (const release of openGates.splice(0)) release();
    for (let i = 0; i < 200 && teamFrontLockCount() > 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await releaseOpenGates();
    expect(teamFrontLockCount()).toBe(0);
  });

  const query = (sql: string, params: unknown[] = []) => (db as { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }).query(sql, params);
  const store = () => createPGLiteSessionStore(db as never);
  const ports = () => buildTeamMissionPorts({ query: (sql, params) => query(sql, params as unknown[]), engine: backend }, (payload) => store().create(payload));
  const row = (id: string, front: string) => ({
    payload: { id, provider: 'claude-code', model: 'claude-code:opus', title: `Mission ${id}`, workspaceId: WS, agentRole: 'standard' as const, metadata: { teamMode: true } },
    request: { front, goal: `Goal of ${id}` },
  });

  async function storedRows(): Promise<Array<{ id: string; metadata: Record<string, any> }>> {
    const { rows } = await query(`SELECT id, metadata FROM ai_sessions ORDER BY id`);
    return rows.map((r) => ({ id: r.id, metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata }));
  }

  it('two creations started together on one front: exactly one row, the other refused', async () => {
    const results = await Promise.allSettled([
      createTeamMissionRoot(row('mission-1', 'front-a'), ports(), deps),
      createTeamMissionRoot(row('mission-2', 'front-a'), ports(), deps),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    const reason = (results[1] as PromiseRejectedResult).reason as TeamMissionError;
    expect(reason).toBeInstanceOf(TeamMissionError);
    expect(reason.code).toBe('mission-active');
    expect(reason.message).toContain('mission-1');

    const rows = await storedRows();
    expect(rows.map((r) => r.id)).toEqual(['mission-1']);
    expect(rows[0].metadata).toMatchObject({ teamMode: true, teamFront: 'front-a', teamMissionStatus: 'active', teamMissionVersion: 1 });
    expect(teamFrontLockCount()).toBe(0);
  });

  it('five at once on one front, plus one on another front: two rows in all', async () => {
    const results = await Promise.allSettled([
      ...['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => createTeamMissionRoot(row(id, 'front-a'), ports(), deps)),
      createTeamMissionRoot(row('other', 'front-b'), ports(), deps),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rows = await storedRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.metadata.teamFront).sort()).toEqual(['front-a', 'front-b']);
    expect(teamFrontLockCount()).toBe(0);
  });

  it('the same session id on two fronts: one row carrying the winner\'s front, the other refused (the upsert would have hidden it)', async () => {
    const results = await Promise.allSettled([
      createTeamMissionRoot(row('same-id', 'front-a'), ports(), deps),
      createTeamMissionRoot(row('same-id', 'front-b'), ports(), deps),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(((results[1] as PromiseRejectedResult).reason as TeamMissionError).code).toBe('session-exists');
    const rows = await storedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.teamFront).toBe('front-a');
    expect(teamFrontLockCount()).toBe(0);
  });

  describe('a plain (legacy) create and a mission create with the same session id', () => {
    const legacy = () => ({
      id: 'same-id', provider: 'claude-code', model: 'claude-code:opus', title: 'Legacy', workspaceId: WS, agentRole: 'standard' as const,
      metadata: { teamMode: true },
    });
    /** What sessions:create does for a create without teamMission. */
    const legacyCreate = () => withSessionIdLock('same-id', () => store().create(legacy()));
    const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
    const settle = async () => { for (let i = 0; i < 25; i++) await tick(); };
    const gate = () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => { release = resolve; });
      openGates.push(release);
      return { promise, release };
    };

    /** Ports whose id check returns, then holds the mission before its insert. */
    function heldAfterIdCheck(held: Promise<void>, state: { reached: boolean }) {
      const p = ports();
      const check = p.sessionExists;
      p.sessionExists = async (id) => { const exists = await check(id); state.reached = true; await held; return exists; };
      return p;
    }

    it('mission held inside its check/insert while a legacy create with the same id arrives: the legacy create waits; one valid mission row', async () => {
      const held = gate();
      const state = { reached: false };
      const mission = createTeamMissionRoot(row('same-id', 'front-a'), heldAfterIdCheck(held.promise, state), deps).then(() => 'ok', (e) => e);
      for (let i = 0; i < 200 && !state.reached; i++) await tick();
      expect(state.reached).toBe(true);

      let legacyDone = false;
      const legacyResult = legacyCreate().then(() => { legacyDone = true; }, (e) => e);
      await settle();
      expect(legacyDone).toBe(false);
      expect(await storedRows()).toEqual([]); // nothing written by anyone yet

      held.release();
      expect(await mission).toBe('ok');
      await legacyResult;
      const rows = await storedRows();
      expect(rows).toHaveLength(1);
      // The mission row is the one that exists; the late legacy create is a re-issue and the store keeps the mission keys.
      expect(rows[0].metadata).toMatchObject({ teamMode: true, teamFront: 'front-a', teamMissionVersion: 1, teamMissionStatus: 'active' });
      expect(teamFrontLockCount()).toBe(0);
    });

    it('legacy create first, held inside its insert: the mission waits, then is refused with session-exists; the row stays a legacy root', async () => {
      const held = gate();
      let inside = false;
      const legacyResult = withSessionIdLock('same-id', async () => { inside = true; await held.promise; await store().create(legacy()); }).then(() => 'ok', (e) => e);
      for (let i = 0; i < 200 && !inside; i++) await tick();
      expect(inside).toBe(true);

      const missionPorts = ports();
      const exists = vi.spyOn(missionPorts, 'sessionExists');
      const mission = createTeamMissionRoot(row('same-id', 'front-a'), missionPorts, deps).then(() => 'ok', (e) => e);
      await settle();
      expect(exists).not.toHaveBeenCalled(); // the mission has not even checked: it waits for the id

      held.release();
      expect(await legacyResult).toBe('ok');
      const outcome = await mission;
      expect(outcome).toBeInstanceOf(TeamMissionError);
      expect((outcome as TeamMissionError).code).toBe('session-exists');
      const rows = await storedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ teamMode: true });
      expect(teamFrontLockCount()).toBe(0);
    });

    it('a legacy writer that does NOT take the lock still cannot make the mission report a success it does not have', async () => {
      const held = gate();
      const state = { reached: false };
      const mission = createTeamMissionRoot(row('same-id', 'front-a'), heldAfterIdCheck(held.promise, state), deps).then(() => 'ok', (e) => e);
      for (let i = 0; i < 200 && !state.reached; i++) await tick();
      expect(state.reached).toBe(true);

      await store().create(legacy()); // lock-free: lands between the mission's check and its insert
      held.release();

      const outcome = await mission;
      expect(outcome).toBeInstanceOf(TeamMissionError);
      expect((outcome as TeamMissionError).code).toBe('session-exists');
      const rows = await storedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({ teamMode: true });
      expect(teamFrontLockCount()).toBe(0);
    });

    it('a legacy create on a new id is unchanged: it runs at once and writes its row', async () => {
      await withSessionIdLock('fresh', () => store().create({ ...legacy(), id: 'fresh' }));
      expect((await storedRows()).map((r) => r.id)).toEqual(['fresh']);
      expect(teamFrontLockCount()).toBe(0);
    });

    it('a failing legacy create releases the id for the mission that was waiting', async () => {
      const failing = withSessionIdLock('same-id', async () => { throw new Error('disk full'); }).then(() => 'ok', (e) => e);
      const mission = createTeamMissionRoot(row('same-id', 'front-a'), ports(), deps).then(() => 'ok', (e) => e);
      expect(((await failing) as Error).message).toBe('disk full');
      expect(await mission).toBe('ok');
      expect((await storedRows()).map((r) => r.metadata.teamFront)).toEqual(['front-a']);
      expect(teamFrontLockCount()).toBe(0);
    });
  });

  it('an archived mission frees the front for the next creation', async () => {
    await createTeamMissionRoot(row('mission-1', 'front-a'), ports(), deps);
    await query(`UPDATE ai_sessions SET is_archived = TRUE WHERE id = 'mission-1'`);
    await createTeamMissionRoot(row('mission-2', 'front-a'), ports(), deps);
    expect((await storedRows()).map((r) => r.id)).toEqual(['mission-1', 'mission-2']);
  });
});
