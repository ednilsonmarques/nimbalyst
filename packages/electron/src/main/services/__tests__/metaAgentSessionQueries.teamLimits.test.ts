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
import { assertTeamSpawnCapacity, getTeamUsage } from '../metaAgentSessionQueries';

let tmpDir: string;
let sqlite: SQLiteDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-teamq-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
  db.current = sqlite as never;
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
