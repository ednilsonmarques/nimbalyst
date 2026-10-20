// @vitest-environment node
/**
 * `test:query-db` must not exist outside an unpackaged E2E run, and where it
 * exists it must be read-only. The guard is checked with fake environments;
 * the read-only behaviour is checked through the real handler against
 * throwaway databases in the OS temp directory (never the user's database):
 * the real `SQLiteDatabase.queryReadOnly`, and a PGlite instance driven the
 * same way the PGLite worker's `queryReadOnly` drives it (READ ONLY
 * transaction plus a local statement timeout).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PGlite } from '@electric-sql/pglite';

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>();

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
    handlers.set(channel, handler);
  }),
}));

// The default environment reads `app.isPackaged`; model a shipped build.
vi.mock('electron', () => ({ app: { isPackaged: true } }));

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import {
  TEST_QUERY_DB_CHANNEL,
  isAllowedTestQuery,
  isTestQueryDbAllowed,
  registerTestQueryDbHandler,
  type ReadOnlyQueryable,
} from '../testQueryDbHandler';

const SCHEMA_DIR = path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas');
const E2E = { isPackaged: false, env: { PLAYWRIGHT: '1' } };

/** A database whose write path must never be used by the channel. */
function guarded(queryReadOnly: ReadOnlyQueryable['queryReadOnly']) {
  const query = vi.fn(() => {
    throw new Error('test:query-db must not call database.query');
  });
  return { db: { queryReadOnly, query }, query };
}

function channel() {
  const handler = handlers.get(TEST_QUERY_DB_CHANNEL);
  if (!handler) throw new Error('test:query-db is not registered');
  return (sql: unknown, params?: unknown[]) => handler({}, sql, params) as Promise<any>;
}

beforeEach(() => handlers.clear());

describe('test:query-db registration guard', () => {
  it('is not registered in a normal (packaged) run, whatever the environment says', () => {
    const { db } = guarded(vi.fn());
    for (const env of [
      {},
      { PLAYWRIGHT: '1' },
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test' },
      { PLAYWRIGHT_TEST: 'true' },
      { NODE_ENV: 'development', PLAYWRIGHT: '1', PLAYWRIGHT_TEST: 'true' },
    ]) {
      expect(registerTestQueryDbHandler(db, { isPackaged: true, env })).toBe(false);
    }
    expect(handlers.has(TEST_QUERY_DB_CHANNEL)).toBe(false);
  });

  it('is not registered by the default environment of a shipped build', () => {
    const { db } = guarded(vi.fn());
    const previous = process.env.PLAYWRIGHT;
    process.env.PLAYWRIGHT = '1';
    try {
      expect(registerTestQueryDbHandler(db)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.PLAYWRIGHT;
      else process.env.PLAYWRIGHT = previous;
    }
    expect(handlers.has(TEST_QUERY_DB_CHANNEL)).toBe(false);
  });

  it('ignores NODE_ENV and other test flags in an unpackaged run without the E2E harness', () => {
    for (const env of [
      {},
      { NODE_ENV: 'development' },
      { NODE_ENV: 'test' },
      { PLAYWRIGHT_TEST: 'true' },
      { PLAYWRIGHT: 'true' },
      { PLAYWRIGHT: '0' },
      { PLAYWRIGHT: '' },
    ]) {
      expect(isTestQueryDbAllowed({ isPackaged: false, env })).toBe(false);
    }
  });

  it('fails closed when packaging cannot be determined', () => {
    expect(isTestQueryDbAllowed({ isPackaged: undefined, env: { PLAYWRIGHT: '1' } })).toBe(false);
  });

  it('is registered in an unpackaged E2E run (PLAYWRIGHT=1)', () => {
    const { db } = guarded(vi.fn());
    expect(registerTestQueryDbHandler(db, E2E)).toBe(true);
    expect(handlers.has(TEST_QUERY_DB_CHANNEL)).toBe(true);
  });

  it('routes every call to queryReadOnly with the given params', async () => {
    const queryReadOnly = vi.fn().mockResolvedValue({ rows: [{ x: 1 }] });
    const { db, query } = guarded(queryReadOnly);
    registerTestQueryDbHandler(db, E2E);
    await expect(channel()('SELECT $1::int AS x', [1])).resolves.toEqual({ rows: [{ x: 1 }] });
    expect(queryReadOnly).toHaveBeenCalledWith('SELECT $1::int AS x', [1]);
    expect(query).not.toHaveBeenCalled();
  });

  it('accepts the statements the E2E specs send', () => {
    for (const sql of [
      'SELECT content FROM ai_agent_messages WHERE session_id=$1 AND direction=$2 ORDER BY id',
      'SELECT data FROM shell_tracking_coverage WHERE session_id=$1',
      '  -- note\n  select 1',
      '/* lead */ WITH t AS (SELECT 1) SELECT * FROM t',
    ]) {
      expect(isAllowedTestQuery(sql)).toBe(true);
    }
  });

  it('refuses anything that is not a plain SELECT or WITH, before the database sees it', async () => {
    for (const sql of [
      `INSERT INTO t VALUES (1)`,
      `UPDATE t SET x = 1`,
      `DELETE FROM t`,
      `CREATE TABLE t (x int)`,
      `ALTER TABLE t ADD COLUMN y int`,
      `DROP TABLE t`,
      `VACUUM INTO '/tmp/copy.sqlite'`,
      `ATTACH DATABASE 'x' AS y`,
      `PRAGMA query_only = OFF`,
      `SELECT 1; VACUUM INTO 'x'`,
      `/* SELECT */ DELETE FROM t`,
      `-- SELECT\nDELETE FROM t`,
      `/* unterminated SELECT`,
      `SET TRANSACTION READ WRITE`,
      `COMMIT`,
    ]) {
      expect(isAllowedTestQuery(sql), sql).toBe(false);
    }
    const queryReadOnly = vi.fn();
    const { db } = guarded(queryReadOnly);
    registerTestQueryDbHandler(db, E2E);
    await expect(channel()(`DELETE FROM t`)).resolves.toEqual({ error: expect.stringMatching(/only SELECT or WITH/) });
    expect(queryReadOnly).not.toHaveBeenCalled();
  });

  it('refuses a missing or non-string statement without touching the database', async () => {
    const queryReadOnly = vi.fn();
    const { db } = guarded(queryReadOnly);
    registerTestQueryDbHandler(db, E2E);
    for (const sql of [undefined, '', 42, { sql: 'SELECT 1' }]) {
      await expect(channel()(sql)).resolves.toEqual({ error: expect.stringMatching(/non-empty string/) });
    }
    expect(queryReadOnly).not.toHaveBeenCalled();
  });
});

describe('test:query-db is read-only (SQLite backend, temp database)', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;
  let query: ReturnType<typeof vi.fn>;

  const count = () =>
    (sqlite.getRawHandle()!.prepare('SELECT COUNT(*) AS c FROM ai_sessions').get() as { c: number }).c;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-test-query-db-'));
    const dbDir = path.join(tmp, 'sqlite-db');
    fs.mkdirSync(dbDir, { recursive: true });
    sqlite = new SQLiteDatabase({ dbDir, schemaDir: SCHEMA_DIR });
    await sqlite.initialize();
    sqlite.getRawHandle()!
      .prepare('INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)')
      .run('s1', 'claude', 'Auth refactor');
    const guardedDb = guarded((sql, params) => sqlite.queryReadOnly(sql, params));
    query = guardedDb.query;
    registerTestQueryDbHandler(guardedDb.db, E2E);
  });

  afterEach(async () => {
    try { await sqlite.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    expect(query).not.toHaveBeenCalled();
  });

  it('allows a simple SELECT', async () => {
    await expect(channel()('SELECT 1 AS x')).resolves.toMatchObject({ rows: [{ x: 1 }] });
    await expect(channel()('SELECT title FROM ai_sessions WHERE id = ?', ['s1'])).resolves.toMatchObject({
      rows: [{ title: 'Auth refactor' }],
    });
  });

  it.each([
    ['INSERT', `INSERT INTO ai_sessions(id, provider) VALUES ('x', 'y')`],
    ['INSERT OR REPLACE', `INSERT OR REPLACE INTO ai_sessions(id, provider) VALUES ('s1', 'y')`],
    ['UPDATE', `UPDATE ai_sessions SET title = 'mutated' WHERE id = 's1'`],
    ['DELETE', `DELETE FROM ai_sessions`],
    ['CREATE', `CREATE TABLE evil (x INTEGER)`],
    ['ALTER', `ALTER TABLE ai_sessions ADD COLUMN evil TEXT`],
    ['DROP', `DROP TABLE ai_sessions`],
  ])('refuses %s', async (_label, sql) => {
    const result = await channel()(sql);
    expect(result).toEqual({ error: expect.any(String) });
    expect(count()).toBe(1);
    const title = sqlite.getRawHandle()!.prepare('SELECT title FROM ai_sessions WHERE id = ?').get('s1') as { title: string };
    expect(title.title).toBe('Auth refactor');
  });

  it.each([
    ['a write hidden behind a comment', `/* read */ DELETE FROM ai_sessions`],
    ['lower case', `delete from ai_sessions`],
    ['a CTE ending in a write', `WITH t AS (SELECT 1) DELETE FROM ai_sessions`],
    ['a second statement after a SELECT', `SELECT 1; DELETE FROM ai_sessions`],
    ['ATTACH', `ATTACH DATABASE ':memory:' AS other`],
  ])('refuses %s', async (_label, sql) => {
    const result = await channel()(sql);
    expect(result).toEqual({ error: expect.any(String) });
    expect(count()).toBe(1);
  });

  it('refuses VACUUM INTO (no copy of the database is written)', async () => {
    const copy = path.join(tmp, 'copy.sqlite');
    const result = await channel()(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
    expect(result).toEqual({ error: expect.any(String) });
    expect(fs.existsSync(copy)).toBe(false);
  });

  it('leaves SELECT-shaped writes to the engine, which refuses them', async () => {
    // Passes the channel's statement check, so only PRAGMA query_only stops it.
    const sql = `WITH t AS (SELECT 1) DELETE FROM ai_sessions`;
    expect(isAllowedTestQuery(sql)).toBe(true);
    await expect(channel()(sql)).resolves.toEqual({ error: expect.not.stringMatching(/only SELECT or WITH/) });
    expect(count()).toBe(1);
  });

  it('cannot switch read-only off for a later call', async () => {
    await channel()('PRAGMA query_only = OFF');
    await expect(channel()(`DELETE FROM ai_sessions`)).resolves.toEqual({ error: expect.any(String) });
    expect(count()).toBe(1);
  });
});

describe('test:query-db is read-only (PGlite, temp database)', () => {
  let pg: PGlite;
  let dataDir: string;
  let query: ReturnType<typeof vi.fn>;

  const count = async () => (await pg.query<{ c: number }>('SELECT COUNT(*)::int AS c FROM ai_sessions')).rows[0].c;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-test-query-db-pg-'));
    pg = new PGlite({ dataDir });
    await pg.waitReady;
    await pg.exec(`CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
    await pg.exec(`CREATE SEQUENCE evil_seq`);
    await pg.query(`INSERT INTO ai_sessions (id, title) VALUES ($1, $2)`, ['s1', 'Auth refactor']);
  });

  afterAll(async () => {
    if (pg) await pg.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Same steps as PGLiteDatabaseWorker's worker-side queryReadOnly.
    const guardedDb = guarded((sql, params) =>
      pg.transaction(async (tx) => {
        await tx.exec('SET TRANSACTION READ ONLY');
        await tx.exec(`SET LOCAL statement_timeout = '5000'`);
        return await tx.query(sql, params);
      }),
    );
    query = guardedDb.query;
    registerTestQueryDbHandler(guardedDb.db, E2E);
  });

  afterEach(() => expect(query).not.toHaveBeenCalled());

  it('allows a simple SELECT', async () => {
    await expect(channel()('SELECT title FROM ai_sessions WHERE id = $1', ['s1'])).resolves.toMatchObject({
      rows: [{ title: 'Auth refactor' }],
    });
  });

  it.each([
    ['INSERT', `INSERT INTO ai_sessions (id, title) VALUES ('x', 'y')`],
    ['UPDATE', `UPDATE ai_sessions SET title = 'mutated'`],
    ['DELETE', `DELETE FROM ai_sessions`],
    ['CREATE', `CREATE TABLE evil (x int)`],
    ['ALTER', `ALTER TABLE ai_sessions ADD COLUMN evil text`],
    ['DROP', `DROP TABLE ai_sessions`],
    ['SELECT INTO', `SELECT * INTO evil_copy FROM ai_sessions`],
    ['a data-modifying CTE', `WITH d AS (DELETE FROM ai_sessions RETURNING *) SELECT * FROM d`],
    ['a sequence write through SELECT', `SELECT nextval('evil_seq')`],
    ['a second statement after a SELECT', `SELECT 1; DELETE FROM ai_sessions`],
    ['switching the transaction to read write', `SET TRANSACTION READ WRITE`],
  ])('refuses %s', async (_label, sql) => {
    const result = await channel()(sql);
    expect(result).toEqual({ error: expect.any(String) });
    expect(await count()).toBe(1);
    expect((await pg.query(`SELECT to_regclass('evil_copy') AS t`)).rows[0]).toEqual({ t: null });
  });

  it.each([
    ['SELECT INTO', `SELECT * INTO evil_copy FROM ai_sessions`],
    ['a data-modifying CTE', `WITH d AS (DELETE FROM ai_sessions RETURNING *) SELECT * FROM d`],
    ['a sequence write through SELECT', `SELECT nextval('evil_seq')`],
    ['a large object write through SELECT', `SELECT lo_create(0)`],
  ])('leaves %s to the READ ONLY transaction, which refuses it', async (_label, sql) => {
    expect(isAllowedTestQuery(sql)).toBe(true);
    const result = await channel()(sql);
    expect(result).toEqual({ error: expect.stringMatching(/read-only transaction/) });
    expect(await count()).toBe(1);
  });

  it('cannot lift the statement timeout for a later call', async () => {
    await channel()(`SELECT set_config('statement_timeout', '0', true)`);
    const after = await channel()(`SELECT current_setting('statement_timeout') AS t`);
    expect(after.rows[0].t).toBe('5s');
  });

  it('keeps a session advisory lock taken through the channel (not a write; recorded)', async () => {
    // Advisory locks do not write data, so READ ONLY allows them; a
    // transaction-scoped one ends with the call, a session-scoped one would
    // outlive it. Record what the engine does so a change is noticed.
    const result = await channel()(`SELECT pg_advisory_lock(424242)`);
    const held = await pg.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242`,
    );
    if (!('error' in result)) await pg.query(`SELECT pg_advisory_unlock(424242)`);
    expect({ refused: 'error' in result, held: held.rows[0].n }).toEqual({ refused: false, held: 1 });
  });

  it('cannot make a later call writable', async () => {
    await channel()('SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE');
    await channel()('COMMIT');
    await expect(channel()(`DELETE FROM ai_sessions`)).resolves.toEqual({ error: expect.any(String) });
    expect(await count()).toBe(1);
  });
});
