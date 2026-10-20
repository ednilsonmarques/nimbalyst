/**
 * Verifies the SELECT-only contract of `SQLiteDatabase.queryReadOnly`.
 *
 * The MCP `database_query` tool and the `extension:database:query` IPC both
 * route through this method, so the engine-level rejection of writes is the
 * security boundary — the prefix check in those handlers is defense in depth.
 *
 * Pairs with the existing PGLite-side test in
 * `packages/electron/src/main/database/__tests__/queryReadOnly.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SQLiteDatabase } from '../SQLiteDatabase';

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schemas');

describe('SQLiteDatabase.queryReadOnly', () => {
  let tmp: string;
  let sqlite: SQLiteDatabase;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-readonly-'));
    const dbDir = path.join(tmp, 'sqlite-db');
    fs.mkdirSync(dbDir, { recursive: true });
    sqlite = new SQLiteDatabase({ dbDir, schemaDir: SCHEMA_DIR });
    await sqlite.initialize();
    const handle = sqlite.getRawHandle()!;
    handle.prepare('INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)').run('s1', 'claude', 'Auth refactor');
    handle.prepare('INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)').run('s2', 'openai', 'Tracker fix');
  });

  afterEach(async () => {
    try { await sqlite.close(); } catch { /* ignore */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips a trivial SELECT', async () => {
    const result = await sqlite.queryReadOnly<{ x: number }>('SELECT 1 AS x');
    expect(result.rows).toEqual([{ x: 1 }]);
  });

  it('returns rows for SELECT against a real table', async () => {
    const result = await sqlite.queryReadOnly<{ id: string; title: string }>(
      'SELECT id, title FROM ai_sessions ORDER BY id',
    );
    expect(result.rows).toEqual([
      { id: 's1', title: 'Auth refactor' },
      { id: 's2', title: 'Tracker fix' },
    ]);
  });

  it('rejects INSERT under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`INSERT INTO ai_sessions(id, provider) VALUES ('x', 'y')`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
  });

  it('rejects UPDATE under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`UPDATE ai_sessions SET title = 'mutated' WHERE id = 's1'`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
    // And the data wasn't actually mutated.
    const row = sqlite
      .getRawHandle()!
      .prepare('SELECT title FROM ai_sessions WHERE id = ?')
      .get('s1') as { title: string };
    expect(row.title).toBe('Auth refactor');
  });

  it('rejects DELETE under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`DELETE FROM ai_sessions WHERE id = 's1'`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
  });

  it('rejects DROP TABLE under query_only=ON', async () => {
    await expect(
      sqlite.queryReadOnly(`DROP TABLE ai_sessions`),
    ).rejects.toThrow(/non-SELECT|readonly|attempt to write/i);
  });

  describe('statements that query_only does not stop (NIB.84)', () => {
    it('rejects VACUUM INTO and leaves no file behind', async () => {
      const target = path.join(tmp, 'vacuum-copy.sqlite');
      await expect(
        sqlite.queryReadOnly(`VACUUM INTO '${target.replace(/\\/g, '/')}'`),
      ).rejects.toThrow(/non-SELECT|read-only|readonly/i);
      expect(fs.existsSync(target)).toBe(false);
    });

    it('rejects a bare VACUUM', async () => {
      await expect(sqlite.queryReadOnly('VACUUM')).rejects.toThrow(/non-SELECT|read-only|readonly/i);
    });

    it('rejects ATTACH and leaves no file behind', async () => {
      const target = path.join(tmp, 'attached.sqlite');
      await expect(
        sqlite.queryReadOnly(`ATTACH DATABASE '${target.replace(/\\/g, '/')}' AS evil`),
      ).rejects.toThrow(/non-SELECT|read-only|readonly/i);
      expect(fs.existsSync(target)).toBe(false);
      const dbs = sqlite.getRawHandle()!.prepare('PRAGMA database_list').all() as Array<{ name: string }>;
      expect(dbs.map((d) => d.name)).not.toContain('evil');
    });

    it('rejects DETACH', async () => {
      await expect(sqlite.queryReadOnly('DETACH DATABASE evil')).rejects.toThrow(/non-SELECT|read-only|readonly/i);
    });

    it('rejects INSERT ... RETURNING without writing', async () => {
      await expect(
        sqlite.queryReadOnly(`INSERT INTO ai_sessions(id, provider) VALUES ('r', 'y') RETURNING id`),
      ).rejects.toThrow();
      const row = sqlite.getRawHandle()!.prepare('SELECT id FROM ai_sessions WHERE id = ?').get('r');
      expect(row).toBeUndefined();
    });

    it('rejects PRAGMA query_only = OFF and keeps the connection read-only', async () => {
      await expect(sqlite.queryReadOnly('PRAGMA query_only = OFF')).rejects.toThrow(/non-SELECT|read-only|readonly/i);
    });

    it.each([
      'PRAGMA user_version = 7',
      'PRAGMA foreign_keys = OFF',
      'PRAGMA busy_timeout = 1',
      'PRAGMA journal_mode = DELETE',
      'PRAGMA wal_checkpoint(TRUNCATE)',
      'PRAGMA wal_checkpoint',
    ])('rejects state-changing pragma: %s', async (pragma) => {
      await expect(sqlite.queryReadOnly(pragma)).rejects.toThrow(/non-SELECT|read-only|readonly/i);
    });

    describe('post-review: PRAGMA allowlist and other state-changing statements', () => {
      const REJECT = /non-SELECT|read-only|readonly|more than one|one statement|not authorized/i;

      it('rejects PRAGMA max_page_count(1) and a normal write still works afterwards', async () => {
        await expect(sqlite.queryReadOnly('PRAGMA max_page_count(1)')).rejects.toThrow(REJECT);
        await sqlite.query(`INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)`, ['after-mpc', 'claude', 'M']);
        const row = sqlite.getRawHandle()!.prepare('SELECT id FROM ai_sessions WHERE id = ?').get('after-mpc');
        expect(row).toBeDefined();
      });

      it('rejects PRAGMA locking_mode(EXCLUSIVE) and the connection keeps its locking mode', async () => {
        const before = sqlite.getRawHandle()!.pragma('locking_mode', { simple: true });
        await expect(sqlite.queryReadOnly('PRAGMA locking_mode(EXCLUSIVE)')).rejects.toThrow(REJECT);
        expect(sqlite.getRawHandle()!.pragma('locking_mode', { simple: true })).toBe(before);
      });

      it('rejects a PRAGMA behind leading ";", whitespace and comments', async () => {
        for (const sql of [
          ';PRAGMA busy_timeout=1',
          ' ; ;  PRAGMA busy_timeout=1',
          '/* c */ PRAGMA busy_timeout=1',
          '-- c\nPRAGMA busy_timeout=1',
          ';-- c\n/* d */;PRAGMA locking_mode(EXCLUSIVE)',
        ]) {
          await expect(sqlite.queryReadOnly(sql), sql).rejects.toThrow(REJECT);
        }
        expect(sqlite.getRawHandle()!.pragma('busy_timeout', { simple: true })).not.toBe(1);
      });

      it('allows only the read forms of the allowlisted PRAGMAs', async () => {
        for (const sql of [
          'PRAGMA table_info("ai_sessions")',
          'pragma table_xinfo(ai_sessions)',
          ';PRAGMA index_list("ai_sessions")',
          '/* c */ PRAGMA database_list',
        ]) {
          await expect(sqlite.queryReadOnly(sql), sql).resolves.toBeDefined();
        }
        for (const sql of [
          'PRAGMA table_info = 1',
          'PRAGMA database_list = x',
          'PRAGMA user_version',
          'PRAGMA page_count',
        ]) {
          await expect(sqlite.queryReadOnly(sql), sql).rejects.toThrow(REJECT);
        }
      });

      it('SELECT * FROM pragma_max_page_count(1) is rejected and does not set the limit', async () => {
        const before = sqlite.getRawHandle()!.pragma('max_page_count', { simple: true });
        // Observed on better-sqlite3 13.0.1: the argument of a table-valued
        // pragma is a schema name, so this fails with "unknown database '1'"
        // and cannot set anything. The safe outcome is a rejection.
        await expect(sqlite.queryReadOnly('SELECT * FROM pragma_max_page_count(1)')).rejects.toThrow();
        expect(sqlite.getRawHandle()!.pragma('max_page_count', { simple: true })).toBe(before);
        await sqlite.query(`INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)`, ['after-tv', 'claude', 'T']);
        expect(sqlite.getRawHandle()!.prepare('SELECT id FROM ai_sessions WHERE id = ?').get('after-tv')).toBeDefined();
      });

      it("rejects a multi-statement 'SELECT 1; VACUUM INTO' and leaves no file", async () => {
        const target = path.join(tmp, 'multi-copy.sqlite');
        await expect(
          sqlite.queryReadOnly(`SELECT 1; VACUUM INTO '${target.replace(/\\/g, '/')}'`),
        ).rejects.toThrow(REJECT);
        expect(fs.existsSync(target)).toBe(false);
      });

      // The statement is a plain read to our checks (reader && readonly, no
      // PRAGMA), so it is the engine that refuses it: SQLite has extension
      // loading disabled on this connection and answers SQLITE_ERROR
      // "not authorized" before it looks up any library. Asserting that exact
      // message (not just "throws") proves loading is refused as such, rather
      // than failing later because the file 'x' does not exist.
      it.each([
        "SELECT load_extension('x')",
        "SELECT load_extension('x', 'entry_point')",
        "SELECT load_extension('C:/Windows/System32/kernel32.dll')",
      ])('refuses %s with the engine "not authorized" error', async (sql) => {
        await expect(sqlite.queryReadOnly(sql)).rejects.toThrow(/not authorized/i);
        await expect(sqlite.queryReadOnly(sql)).rejects.not.toThrow(/no such file|cannot open|not found/i);
      });

      it.each([
        'SELECT 1; PRAGMA busy_timeout=1',
        'SELECT 1; PRAGMA locking_mode(EXCLUSIVE)',
        'WITH x AS (SELECT 1) SELECT * FROM x; PRAGMA busy_timeout=1',
      ])('rejects trailing statement %s and leaves busy_timeout and locking_mode unchanged', async (sql) => {
        const h = sqlite.getRawHandle()!;
        const before = { busy: h.pragma('busy_timeout', { simple: true }), lock: h.pragma('locking_mode', { simple: true }) };
        await expect(sqlite.queryReadOnly(sql), sql).rejects.toThrow(/more than one statement|non-SELECT/i);
        expect({ busy: h.pragma('busy_timeout', { simple: true }), lock: h.pragma('locking_mode', { simple: true }) }).toEqual(before);
      });

      it.each([
        'CREATE TEMP TABLE nib_tmp(a)',
        'REINDEX',
        'ANALYZE',
        'SAVEPOINT nib_sp',
        'BEGIN',
        'BEGIN IMMEDIATE',
      ])('rejects %s', async (sql) => {
        await expect(sqlite.queryReadOnly(sql)).rejects.toThrow(REJECT);
        const temp = sqlite.getRawHandle()!.prepare("SELECT name FROM sqlite_temp_master WHERE name = 'nib_tmp'").get();
        expect(temp).toBeUndefined();
        expect(sqlite.getRawHandle()!.inTransaction).toBe(false);
      });
    });

    describe('fail-closed PRAGMA / EXPLAIN spellings (reviewer B1, B2)', () => {
      const REJECT = /non-SELECT|read-only|readonly|more than one|one statement|not authorized/i;
      const state = () => {
        const h = sqlite.getRawHandle()!;
        return { busy: h.pragma('busy_timeout', { simple: true }), lock: h.pragma('locking_mode', { simple: true }) };
      };

      it.each([
        ['quoted name', 'PRAGMA "busy_timeout"=1'],
        ['bracketed name with argument', 'PRAGMA [locking_mode](EXCLUSIVE)'],
        ['backtick name', 'PRAGMA `busy_timeout`=1'],
        ['comment instead of whitespace', 'PRAGMA/**/busy_timeout=1'],
        ['line comment instead of whitespace', 'PRAGMA--c\nbusy_timeout=1'],
        ['quoted schema', 'PRAGMA "main".busy_timeout=1'],
        ['EXPLAIN prefix', 'EXPLAIN PRAGMA locking_mode(EXCLUSIVE)'],
        ['EXPLAIN QUERY PLAN prefix', 'EXPLAIN QUERY PLAN PRAGMA busy_timeout=1'],
        ['lowercase explain', 'explain pragma busy_timeout=1'],
        ['tab after pragma', 'PRAGMA\tbusy_timeout=1'],
        ['comment before EXPLAIN', '/* c */ EXPLAIN PRAGMA busy_timeout=1'],
        ['plain EXPLAIN of a SELECT', 'EXPLAIN SELECT 1'],
        ['quoted allowlisted name', 'PRAGMA "table_info"("ai_sessions")'],
        ['quoted name after schema', 'PRAGMA main."table_info"("ai_sessions")'],
        ['two arguments', 'PRAGMA table_info(a, b)'],
        ['trailing statement', 'PRAGMA table_info(ai_sessions); PRAGMA busy_timeout=1'],
      ])('rejects %s and leaves busy_timeout and locking_mode unchanged', async (_label, sql) => {
        const before = state();
        await expect(sqlite.queryReadOnly(sql), sql).rejects.toThrow(REJECT);
        expect(state()).toEqual(before);
      });

      it('keeps the unquoted allowlisted forms with a quoted argument working', async () => {
        const before = state();
        const a = await sqlite.queryReadOnly<{ name: string }>('PRAGMA table_info("ai_sessions")');
        expect(a.rows.map((r) => r.name)).toContain('id');
        const b = await sqlite.queryReadOnly<{ name: string }>('PRAGMA main.table_info("ai_sessions")');
        expect(b.rows.map((r) => r.name)).toContain('id');
        const c = await sqlite.queryReadOnly<{ name: string }>('PRAGMA main . table_info(ai_sessions)');
        expect(c.rows.length).toBeGreaterThan(0);
        expect(state()).toEqual(before);
      });

      it('rejects a long run of adjacent comments quickly (no exponential backtracking)', async () => {
        const hostile = 'PRAGMA table_info(x)' + '/**/'.repeat(40) + 'x';
        const t0 = performance.now();
        await expect(sqlite.queryReadOnly(hostile)).rejects.toThrow();
        expect(performance.now() - t0).toBeLessThan(500);
      });

      it('still accepts a legitimate comment between tokens', async () => {
        const r = await sqlite.queryReadOnly<{ name: string }>(
          'PRAGMA /* the table */ main /* schema */ . table_info /* arg */ ("ai_sessions") -- done',
        );
        expect(r.rows.map((x) => x.name)).toContain('id');
        const s = await sqlite.queryReadOnly<{ x: number }>('/* lead */ SELECT /* mid */ 1 AS x');
        expect(s.rows).toEqual([{ x: 1 }]);
      });

      it('does not treat identifiers that merely start with "pragma" as a PRAGMA statement', async () => {
        const r = await sqlite.queryReadOnly<{ x: number }>('SELECT 1 AS x');
        expect(r.rows).toEqual([{ x: 1 }]);
        await expect(sqlite.queryReadOnly('pragmatic')).rejects.toThrow();
      });
    });

    it('keeps SELECT, WITH and PRAGMA table_info working', async () => {
      expect((await sqlite.queryReadOnly<{ x: number }>('SELECT 1 AS x')).rows).toEqual([{ x: 1 }]);
      const withRes = await sqlite.queryReadOnly<{ n: number }>('WITH t AS (SELECT 2 AS n) SELECT n FROM t');
      expect(withRes.rows).toEqual([{ n: 2 }]);
      const info = await sqlite.queryReadOnly<{ name: string }>('PRAGMA table_info("ai_sessions")');
      expect(info.rows.map((r) => r.name)).toContain('id');
      const pc = await sqlite.queryReadOnly<{ page_count: number }>('SELECT page_count FROM pragma_page_count');
      expect(pc.rows.length).toBe(1);
    });

    it('still clears query_only after a rejected statement', async () => {
      await expect(sqlite.queryReadOnly('VACUUM')).rejects.toThrow();
      await sqlite.query(`INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)`, ['post', 'claude', 'P']);
      const row = sqlite.getRawHandle()!.prepare('SELECT id FROM ai_sessions WHERE id = ?').get('post');
      expect(row).toBeDefined();
    });
  });

  it('clears query_only=ON after a successful read so subsequent writes succeed', async () => {
    await sqlite.queryReadOnly('SELECT COUNT(*) FROM ai_sessions');
    // A regular write through .query should work now.
    await sqlite.query(
      `INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)`,
      ['after-read', 'claude', 'After'],
    );
    const row = sqlite
      .getRawHandle()!
      .prepare('SELECT id FROM ai_sessions WHERE id = ?')
      .get('after-read') as { id: string } | undefined;
    expect(row?.id).toBe('after-read');
  });

  it('clears query_only=ON after a failed read so subsequent writes succeed', async () => {
    await expect(
      sqlite.queryReadOnly(`UPDATE ai_sessions SET title = 'no'`),
    ).rejects.toThrow();
    // PRAGMA query_only must be reset in `finally` -- subsequent writes work.
    await sqlite.query(
      `INSERT INTO ai_sessions(id, provider, title) VALUES (?, ?, ?)`,
      ['recovered', 'claude', 'OK'],
    );
    const row = sqlite
      .getRawHandle()!
      .prepare('SELECT id FROM ai_sessions WHERE id = ?')
      .get('recovered') as { id: string } | undefined;
    expect(row?.id).toBe('recovered');
  });
});
