/**
 * The PGLite-era Database Browser handlers (NIB.85 stage c): executeQuery must
 * go through the engine-enforced read-only path, and getTableData must quote
 * the table identifier instead of interpolating it raw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handlers = new Map<string, (...args: any[]) => Promise<any>>();
const queryReadOnly = vi.fn();
const query = vi.fn();

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (...args: any[]) => Promise<any>) => {
    handlers.set(channel, fn);
  },
}));
vi.mock('../../database/initialize', () => ({
  database: {
    query: (...args: unknown[]) => query(...args),
    queryReadOnly: (...args: unknown[]) => queryReadOnly(...args),
  },
}));
vi.mock('../../database/reclaimClaudeCodeRawLog', () => ({
  previewReclaimClaudeCodeRawLog: vi.fn(),
  reclaimClaudeCodeRawLog: vi.fn(),
}));

import { registerDatabaseBrowserHandlers } from '../DatabaseBrowserHandlers';

describe('PGLite Database Browser handlers', () => {
  beforeEach(() => {
    handlers.clear();
    queryReadOnly.mockReset();
    query.mockReset();
    registerDatabaseBrowserHandlers();
  });

  it('executeQuery runs through queryReadOnly with a 30 s bound, never database.query', async () => {
    queryReadOnly.mockResolvedValue({ rows: [{ x: 1 }] });
    const res = await handlers.get('database:executeQuery')!({}, 'SELECT 1 AS x');
    expect(res).toEqual({ success: true, rows: [{ x: 1 }], rowCount: 1 });
    expect(queryReadOnly).toHaveBeenCalledWith('SELECT 1 AS x', [], 30_000);
    expect(query).not.toHaveBeenCalled();
  });

  it('executeQuery still rejects a non-SELECT before touching the database', async () => {
    const res = await handlers.get('database:executeQuery')!({}, 'DROP TABLE ai_sessions');
    expect(res.success).toBe(false);
    expect(queryReadOnly).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('executeQuery surfaces an engine rejection as an error result', async () => {
    queryReadOnly.mockRejectedValue(new Error('cannot execute INSERT in a read-only transaction'));
    const res = await handlers.get('database:executeQuery')!({}, 'SELECT 1; INSERT INTO t VALUES (1)');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/read-only/);
  });

  it('getTableData quotes the table identifier and doubles embedded quotes', async () => {
    query.mockResolvedValue({ rows: [{ count: '0' }] });
    await handlers.get('database:getTableData')!({}, 'ai_sessions"; DROP TABLE x; --', 10, 0);
    const sqls = query.mock.calls.map((c) => c[0] as string);
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) {
      expect(sql).toContain('"ai_sessions""; DROP TABLE x; --"');
      expect(sql).not.toMatch(/FROM ai_sessions/);
    }
  });

  it('getTableData keeps a plain table name working', async () => {
    query.mockResolvedValue({ rows: [{ count: '3' }] });
    const res = await handlers.get('database:getTableData')!({}, 'ai_sessions', 5, 0);
    expect(res.success).toBe(true);
    expect(query.mock.calls[0][0]).toBe('SELECT COUNT(*) as count FROM "ai_sessions"');
  });

  it('getTableSchema binds the table name as a parameter (no interpolation)', async () => {
    query.mockResolvedValue({ rows: [] });
    await handlers.get('database:getTableSchema')!({}, `x'; DROP TABLE y; --`);
    expect(query.mock.calls[0][0]).not.toContain('DROP TABLE');
    expect(query.mock.calls[0][1]).toEqual([`x'; DROP TABLE y; --`]);
  });
});
