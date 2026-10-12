// @vitest-environment node
/**
 * Team usage counted over the delegation tree against a real better-sqlite3
 * backend (the recursive CTE, ::text casts and EXISTS must run there).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../test-stubs/privateUserData')).testApp.getPath,
    getName: vi.fn(() => 'test-app'),
    getVersion: vi.fn(() => '1.0.0'),
    on: vi.fn(),
  },
}));

const db = vi.hoisted(() => ({ current: null as null | { query: (sql: string, params?: unknown[]) => Promise<unknown> } }));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { query: (sql: string, params?: unknown[]) => db.current!.query(sql, params) },
}));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  assertTeamSpawnCapacity,
  authorizeTeamContinuation,
  getTeamAuthorizedBudget,
  getTeamUsage,
} from '../metaAgentSessionQueries';
import { TeamBudgetReachedError } from '../team/teamPolicy';

let tmpDir: string;
let sqlite: SQLiteDatabase;

async function openDatabase() {
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
  db.current = sqlite as never;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-teamq-'));
  await openDatabase();
});

afterEach(async () => {
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function session(id: string, createdBy: string | null, extra: { status?: string; archived?: boolean; workspace?: string } = {}) {
  await sqlite.query(
    `INSERT INTO ai_sessions (id, provider, workspace_id, created_by_session_id, status, is_archived) VALUES ($1, 'claude-code', $2, $3, $4, $5)`,
    [id, extra.workspace ?? '/p', createdBy, extra.status ?? 'idle', extra.archived ? 1 : 0],
  );
}

async function queued(id: string, sessionId: string, status: string) {
  await sqlite.query(`INSERT INTO queued_prompts (id, session_id, prompt, status) VALUES ($1, $2, 'x', $3)`, [id, sessionId, status]);
}

describe('getTeamUsage', () => {
  it('is zero for a team with no members', async () => {
    await session('root', null);
    expect(await getTeamUsage('root')).toEqual({ total: 0, active: 0 });
  });

  it('counts children and grandchildren, archived included, and nothing outside the tree', async () => {
    await session('root', null);
    await session('c1', 'root');
    await session('c2', 'root', { archived: true });
    await session('g1', 'c1', { workspace: '/p-other-spelling' });
    await session('otherRoot', null);
    await session('stranger', 'otherRoot', { status: 'running' });
    expect(await getTeamUsage('root')).toEqual({ total: 3, active: 0 });
  });

  it('counts as active: running, waiting, and idle members holding a pending or executing prompt', async () => {
    await session('root', null);
    await session('running', 'root', { status: 'running' });
    await session('waiting', 'root', { status: 'waiting_for_input' });
    await session('justCreated', 'root');
    await queued('q1', 'justCreated', 'pending');
    await session('draining', 'running');
    await queued('q2', 'draining', 'executing');
    await session('done', 'root');
    await queued('q3', 'done', 'completed');
    await session('errored', 'root', { status: 'error' });
    expect(await getTeamUsage('root')).toEqual({ total: 6, active: 4 });
  });

  it('survives a malformed creator cycle', async () => {
    await session('a', null);
    await session('b', 'a');
    await sqlite.query(`UPDATE ai_sessions SET created_by_session_id = 'b' WHERE id = 'a'`);
    expect((await getTeamUsage('a')).total).toBe(2);
  });
});

describe('assertTeamSpawnCapacity', () => {
  it('refuses depth beyond 2 without querying the tree', async () => {
    await expect(assertTeamSpawnCapacity({ rootSessionId: 'root', depth: 2 })).rejects.toThrow(/Team depth limit reached/);
  });

  it('refuses the 9th session, archived ones counted', async () => {
    await session('root', null);
    for (let i = 0; i < 8; i++) await session(`m${i}`, 'root', { archived: i < 4 });
    await expect(assertTeamSpawnCapacity({ rootSessionId: 'root', depth: 0 })).rejects.toThrow(/8\/8/);
  });

  it('refuses a 4th active session and allows one once a member settles', async () => {
    await session('root', null);
    await session('a', 'root', { status: 'running' });
    await session('b', 'root', { status: 'running' });
    await session('c', 'root');
    await queued('qc', 'c', 'pending');
    await expect(assertTeamSpawnCapacity({ rootSessionId: 'root', depth: 0 })).rejects.toThrow(/3\/3/);
    await sqlite.query(`UPDATE ai_sessions SET status = 'idle' WHERE id = 'a'`);
    await expect(assertTeamSpawnCapacity({ rootSessionId: 'root', depth: 0 })).resolves.toBeUndefined();
  });
});

/** A session with a metadata blob, as the store writes it. */
async function sessionWithMetadata(id: string, createdBy: string | null, metadata: unknown, agentRole = 'standard') {
  await sqlite.query(
    `INSERT INTO ai_sessions (id, provider, workspace_id, created_by_session_id, status, is_archived, agent_role, metadata)
     VALUES ($1, 'claude-code', '/p', $2, 'idle', 0, $3, $4)`,
    [id, createdBy, agentRole, JSON.stringify(metadata)],
  );
}

async function metadataOf(id: string) {
  const { rows } = await sqlite.query<{ metadata: string }>(`SELECT metadata FROM ai_sessions WHERE id = $1`, [id]);
  return JSON.parse(rows[0].metadata);
}

const ROOT = { rootSessionId: 'root', depth: 0 };
const members = async (from: number, to: number, extra: { archived?: boolean } = {}) => {
  for (let i = from; i < to; i++) await session(`m${i}`, 'root', extra);
};

describe('team checkpoint (authorizeTeamContinuation)', () => {
  it('a team starts authorized for 8, and a root created before checkpoints (no key) too', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await session('legacy', null);
    expect(await getTeamAuthorizedBudget('root')).toBe(8);
    expect(await getTeamAuthorizedBudget('legacy')).toBe(8);
    expect(await getTeamAuthorizedBudget('missing')).toBe(8);
  });

  it('at 8/8 the creation is refused as a checkpoint, carrying the numbers the user is shown', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await members(0, 8);
    const error = await assertTeamSpawnCapacity(ROOT).catch((e) => e);
    expect(error).toBeInstanceOf(TeamBudgetReachedError);
    expect(error).toMatchObject({ total: 8, authorized: 8 });
    expect(String(error.message)).toContain('Only the user can authorize more');
  });

  it('the active limit is not a checkpoint', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    for (const id of ['a', 'b', 'c']) await session(id, 'root', { status: 'running' });
    const error = await assertTeamSpawnCapacity(ROOT).catch((e) => e);
    expect(error).not.toBeInstanceOf(TeamBudgetReachedError);
    expect(String(error.message)).toMatch(/3\/3/);
  });

  it('continuing at 8/8 authorizes 12, keeps the rest of the metadata, and creation passes again', async () => {
    await sessionWithMetadata('root', null, { teamMode: true, phase: 'implementing', tags: ['x'] });
    await members(0, 8);
    expect(await authorizeTeamContinuation('root')).toEqual({ extended: true, total: 8, previousAuthorized: 8, authorized: 12 });
    expect(await metadataOf('root')).toEqual({
      teamMode: true, phase: 'implementing', tags: ['x'], teamBudget: { authorized: 12, extensions: 1 },
    });
    expect(await getTeamAuthorizedBudget('root')).toBe(12);
    await expect(assertTeamSpawnCapacity(ROOT)).resolves.toBeUndefined();
  });

  it('a new checkpoint happens at 12/12, and a second continuation authorizes 16', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await members(0, 8);
    await authorizeTeamContinuation('root');
    await members(8, 11);
    await expect(assertTeamSpawnCapacity(ROOT)).resolves.toBeUndefined();
    await members(11, 12);
    const error = await assertTeamSpawnCapacity(ROOT).catch((e) => e);
    expect(error).toBeInstanceOf(TeamBudgetReachedError);
    expect(error).toMatchObject({ total: 12, authorized: 12 });
    expect(String(error.message)).toMatch(/12\/12/);

    expect(await authorizeTeamContinuation('root')).toEqual({ extended: true, total: 12, previousAuthorized: 12, authorized: 16 });
    expect((await metadataOf('root')).teamBudget).toEqual({ authorized: 16, extensions: 2 });
    await expect(assertTeamSpawnCapacity(ROOT)).resolves.toBeUndefined();
  });

  it('does nothing before the checkpoint, so authorizations cannot be stockpiled and a second click is a no-op', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await members(0, 7);
    expect(await authorizeTeamContinuation('root')).toEqual({ extended: false, reason: 'not-at-checkpoint', total: 7, authorized: 8 });
    expect((await metadataOf('root')).teamBudget).toBeUndefined();

    await members(7, 8);
    expect((await authorizeTeamContinuation('root')).extended).toBe(true);
    expect(await authorizeTeamContinuation('root')).toEqual({ extended: false, reason: 'not-at-checkpoint', total: 8, authorized: 12 });
    expect((await metadataOf('root')).teamBudget).toEqual({ authorized: 12, extensions: 1 });
  });

  it('only a team root can be continued: not a member, a plain session, a meta-agent or a missing id', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await members(0, 8);
    await sessionWithMetadata('member', 'root', { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } });
    await sessionWithMetadata('plain', null, { phase: 'planning' });
    await sessionWithMetadata('meta', null, { teamMode: true }, 'meta-agent');
    for (const id of ['member', 'plain', 'meta', 'missing']) {
      expect(await authorizeTeamContinuation(id), id).toEqual({ extended: false, reason: 'not-a-team-root' });
    }
    expect((await metadataOf('member')).teamBudget).toBeUndefined();
    expect(await getTeamAuthorizedBudget('root')).toBe(8);
  });

  it('the authorization belongs to its own root', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await sessionWithMetadata('otherRoot', null, { teamMode: true });
    await members(0, 8);
    await authorizeTeamContinuation('root');
    expect(await getTeamAuthorizedBudget('root')).toBe(12);
    expect(await getTeamAuthorizedBudget('otherRoot')).toBe(8);
  });

  it('finished and archived members and grandchildren still count toward the total', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await members(0, 4, { archived: true });
    await members(4, 6);
    await session('g1', 'm4');
    await session('g2', 'm4', { archived: true });
    expect(await getTeamUsage('root')).toEqual({ total: 8, active: 0 });
    await expect(assertTeamSpawnCapacity(ROOT)).rejects.toBeInstanceOf(TeamBudgetReachedError);
    // A member is refused at the same checkpoint as its root.
    await expect(assertTeamSpawnCapacity({ rootSessionId: 'root', depth: 1 })).rejects.toBeInstanceOf(TeamBudgetReachedError);

    await authorizeTeamContinuation('root');
    await session('g3', 'm5');
    expect(await getTeamUsage('root')).toEqual({ total: 9, active: 0 });
    await expect(assertTeamSpawnCapacity({ rootSessionId: 'root', depth: 1 })).resolves.toBeUndefined();
  });

  it('continuing leaves the active and the depth limits where they were', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await members(0, 8);
    await authorizeTeamContinuation('root');
    await sqlite.query(`UPDATE ai_sessions SET status = 'running' WHERE id IN ('m0', 'm1', 'm2')`);
    await expect(assertTeamSpawnCapacity(ROOT)).rejects.toThrow(/3\/3 sessions are already active/);
    await expect(assertTeamSpawnCapacity({ rootSessionId: 'root', depth: 2 })).rejects.toThrow(/Team depth limit reached/);
  });

  it('the authorization survives a restart', async () => {
    await sessionWithMetadata('root', null, { teamMode: true });
    await members(0, 8);
    await authorizeTeamContinuation('root');
    await sqlite.close();
    await openDatabase();
    expect(await getTeamAuthorizedBudget('root')).toBe(12);
    await expect(assertTeamSpawnCapacity(ROOT)).resolves.toBeUndefined();
  });
});
