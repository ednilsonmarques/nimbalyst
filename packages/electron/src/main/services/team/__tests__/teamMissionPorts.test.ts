// @vitest-environment node
/**
 * F1 S4: the SQL behind the mission creation ports, on both row shapes the main
 * reads (SQLite hands JSON columns back as text, PGLite as objects). The front is
 * resolved by item id in the session's workspace and a tombstone is not a front;
 * the active mission of a front is read from the roots themselves.
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
import { buildTeamMissionPorts } from '../teamMissionPorts';

type Backend = 'sqlite' | 'pglite';

const PG_DDL = `
  CREATE TABLE ai_sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT, model TEXT, session_type TEXT, mode TEXT, agent_role TEXT,
    created_by_session_id TEXT, title TEXT, worktree_id TEXT, parent_session_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_archived BOOLEAN DEFAULT FALSE, metadata JSONB
  );
  CREATE TABLE tracker_items (
    id TEXT PRIMARY KEY, type TEXT NOT NULL, data JSONB NOT NULL, workspace TEXT NOT NULL,
    archived BOOLEAN DEFAULT FALSE, deleted_at TIMESTAMPTZ
  );`;

const WS = '/ws/project';
const MARKED = { teamMode: true, teamFront: 'F1', teamGoal: 'g', teamMissionStatus: 'active', teamMissionVersion: 1 };

describe.each<Backend>(['sqlite', 'pglite'])('mission ports on the %s row shape', (backend) => {
  let tmpDir: string;
  let db: SQLiteDatabase | PGlite;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nim-mission-ports-${backend}-`));
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
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const engine = backend;
  const query = (sql: string, params: unknown[] = []) => (db as { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }).query(sql, params);
  const ports = () => buildTeamMissionPorts({ query: (sql, params) => query(sql, params as unknown[]), engine }, async () => {});

  async function seedFront(id: string, data: Record<string, unknown>, extra: { type?: string; workspace?: string; archived?: boolean; deleted?: boolean } = {}) {
    await query(
      `INSERT INTO tracker_items (id, type, data, workspace, archived, deleted_at) VALUES ($1, $2, $3::jsonb, $4, ${extra.archived ? 'TRUE' : 'FALSE'}, ${extra.deleted ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
      [id, extra.type ?? 'team-front', JSON.stringify(data), extra.workspace ?? WS],
    );
  }

  async function seedSession(id: string, metadata: Record<string, unknown>, archived = false, ws = WS) {
    await query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, session_type, agent_role, title, is_archived, metadata) VALUES ($1, $2, 'claude-code', 'session', 'standard', $3, ${archived ? 'TRUE' : 'FALSE'}, $4::jsonb)`,
      [id, ws, `Mission ${id}`, JSON.stringify(metadata)],
    );
  }

  describe('getFront', () => {
    it('reads an active front by item id in its workspace', async () => {
      await seedFront('F1', { title: 'Team Mode', status: 'active', description: 'State of the front' });
      expect(await ports().getFront('F1', WS)).toEqual({
        id: 'F1', title: 'Team Mode', type: 'team-front', status: 'active', archived: false, description: 'State of the front',
      });
    });

    it('reads the status and description from the nested customFields bag, too', async () => {
      await seedFront('F1', { title: 'Team Mode', customFields: { status: 'paused', description: 'Nested state' } });
      expect(await ports().getFront('F1', WS)).toMatchObject({ status: 'paused', description: 'Nested state' });
    });

    it('reports an archived item as archived and another type as that type', async () => {
      await seedFront('A', { title: 'Old', status: 'active' }, { archived: true });
      await seedFront('N', { title: 'A note', status: 'active' }, { type: 'team-note' });
      expect(await ports().getFront('A', WS)).toMatchObject({ archived: true });
      expect(await ports().getFront('N', WS)).toMatchObject({ type: 'team-note' });
    });

    it('does not find a missing id, a tombstone, or a front of another workspace', async () => {
      await seedFront('T', { title: 'Deleted', status: 'active' }, { deleted: true });
      await seedFront('O', { title: 'Elsewhere', status: 'active' }, { workspace: '/ws/other' });
      expect(await ports().getFront('missing', WS)).toBeNull();
      expect(await ports().getFront('T', WS)).toBeNull();
      expect(await ports().getFront('O', WS)).toBeNull();
    });

    it('is not an injection surface: the id is bound, never concatenated', async () => {
      await seedFront('F1', { title: 'Team Mode', status: 'active' });
      expect(await ports().getFront("F1' OR '1'='1", WS)).toBeNull();
    });
  });

  describe('findActiveMissionRoot', () => {
    it('finds the non-archived host mission root of the front', async () => {
      await seedSession('r1', MARKED);
      expect(await ports().findActiveMissionRoot('F1')).toEqual({ id: 'r1', title: 'Mission r1' });
    });

    it('ignores an archived root, a closed mission, a legacy root and a pre-S3 front without the host marker', async () => {
      await seedSession('archived', MARKED, true);
      await seedSession('closed', { ...MARKED, teamMissionStatus: 'closed' });
      await seedSession('legacy', { teamMode: true });
      const { teamMissionVersion: _marker, ...preS3 } = MARKED;
      await seedSession('preS3', preS3);
      expect(await ports().findActiveMissionRoot('F1')).toBeNull();
    });

    it('ignores a member that carries the key, another front, and a session that is not a team root', async () => {
      await seedSession('member', { ...MARKED, teamChild: { role: 'explorer', rootSessionId: 'r', depth: 1 } });
      await seedSession('other', { ...MARKED, teamFront: 'F2' });
      await seedSession('plain', { teamFront: 'F1', teamMissionVersion: 1 });
      expect(await ports().findActiveMissionRoot('F1')).toBeNull();
    });

    it('finds a root filed under another spelling of the workspace: the front id is the key', async () => {
      await seedSession('r1', MARKED, false, '/WS/Project/');
      expect(await ports().findActiveMissionRoot('F1')).toMatchObject({ id: 'r1' });
    });

    it('returns the oldest when more than one is active (a state the creation never produces)', async () => {
      await seedSession('r1', MARKED);
      await seedSession('r2', MARKED);
      expect((await ports().findActiveMissionRoot('F1'))?.id).toBe('r1');
    });

    it('is not an injection surface', async () => {
      await seedSession('r1', MARKED);
      expect(await ports().findActiveMissionRoot("F1' OR '1'='1")).toBeNull();
    });
  });

  describe('getSessionMetadata', () => {
    it('returns the parsed stored metadata, or null when there is no row', async () => {
      await seedSession('r1', MARKED);
      expect(await ports().getSessionMetadata('r1')).toEqual(MARKED);
      expect(await ports().getSessionMetadata('nope')).toBeNull();
    });
  });

  describe('sessionExists', () => {
    it('is true for a stored id and false otherwise', async () => {
      await seedSession('r1', MARKED);
      expect(await ports().sessionExists('r1')).toBe(true);
      expect(await ports().sessionExists('nope')).toBe(false);
    });
  });
});
