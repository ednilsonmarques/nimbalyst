// @vitest-environment node
/**
 * F1 S3 on both row shapes the store reads: SQLite hands the metadata column back
 * as a raw JSON string, PGLite as a parsed object.
 *
 * T2: odd shapes of a metadata update (`__proto__`, a different casing, a nested
 *     `metadata`) never produce a top-level `teamFront`, own or inherited.
 * T3: the store's list exposes the mission keys only on a team root, and never the
 *     main-only ones (context, done criterion).
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

import { PGlite } from '@electric-sql/pglite';
import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';
import { projectSessionList } from '../../ipc/sessionListProjection';
import { readTeamSessionFields } from '@nimbalyst/runtime/ai/adapters/sessionStore';

type Backend = 'sqlite' | 'pglite';

const PG_DDL = `
  CREATE TABLE worktrees (id TEXT PRIMARY KEY, path TEXT, workspace_id TEXT, is_archived BOOLEAN DEFAULT FALSE);
  CREATE TABLE ai_sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT, provider TEXT, model TEXT, session_type TEXT, mode TEXT, agent_role TEXT,
    created_by_session_id TEXT, title TEXT, worktree_id TEXT, parent_session_id TEXT,
    provider_session_id TEXT, draft_input TEXT, document_context JSONB, provider_config JSONB, has_been_named BOOLEAN,
    last_read_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
    is_archived BOOLEAN DEFAULT FALSE, is_pinned BOOLEAN DEFAULT FALSE,
    branched_from_session_id TEXT, branch_point_message_id TEXT, branched_at TIMESTAMPTZ, metadata JSONB
  );`;

const MISSION = {
  teamFront: 'team-front_1',
  teamGoal: 'Ship F1',
  teamMissionStatus: 'active',
  teamMissionContext: 'Bootstrap block',
  teamDoneCriterion: 'S3 green',
  teamMissionVersion: 1,
};

describe.each<Backend>(['sqlite', 'pglite'])('mission keys on the %s row shape', (backend) => {
  let tmpDir: string;
  let db: SQLiteDatabase | PGlite;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nim-mission-${backend}-`));
    if (backend === 'sqlite') {
      const sqlite = new SQLiteDatabase({
        dbDir: tmpDir,
        schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
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

  const query = (sql: string, params: unknown[] = []) => (db as { query: (s: string, p?: unknown[]) => Promise<{ rows: any[] }> }).query(sql, params);
  const store = () => createPGLiteSessionStore(db as never);

  async function seed(id: string, metadata: Record<string, unknown>) {
    await query(
      `INSERT INTO ai_sessions (id, workspace_id, provider, session_type, agent_role, title, metadata) VALUES ($1, '/p', 'claude-code', 'session', 'standard', $1, $2::jsonb)`,
      [id, JSON.stringify(metadata)],
    );
  }

  async function stored(id: string): Promise<Record<string, any>> {
    const { rows } = await query(`SELECT metadata FROM ai_sessions WHERE id = $1`, [id]);
    const raw = rows[0].metadata;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  describe('T2: odd update shapes never produce a top-level teamFront', () => {
    const forgedShapes: Array<[string, () => Record<string, unknown>]> = [
      ['own __proto__ key (as JSON.parse builds it)', () => JSON.parse('{"__proto__":{"teamFront":"x"},"tags":["a"]}')],
      ['a __proto__ literal', () => ({ __proto__: { teamFront: 'x' }, tags: ['a'] }) as Record<string, unknown>],
      ['TeamFront casing', () => ({ TeamFront: 'x', tags: ['a'] })],
      ['TEAMFRONT casing', () => ({ TEAMFRONT: 'x', tags: ['a'] })],
      ['a nested metadata object', () => ({ metadata: { teamFront: 'x' }, tags: ['a'] })],
    ];

    it.each(forgedShapes)('%s, on a legacy root', async (_name, build) => {
      await seed('legacy', { teamMode: true });
      await store().updateMetadata('legacy', { metadata: build() });

      const md = await stored('legacy');
      expect(md.tags).toEqual(['a']);
      // Neither an own key nor one inherited through a polluted prototype.
      expect(md.teamFront).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(md, 'teamFront')).toBe(false);
      expect(({} as Record<string, unknown>).teamFront).toBeUndefined();
      expect(readTeamSessionFields(md)).toEqual({ teamMode: true });
    });

    it.each(forgedShapes)('%s, on a root that has a real front', async (_name, build) => {
      await seed('root', { teamMode: true, ...MISSION });
      await store().updateMetadata('root', { metadata: build() });

      const md = await stored('root');
      expect(md.teamFront).toBe('team-front_1');
      expect(Object.prototype.hasOwnProperty.call(md, 'teamFront')).toBe(true);
      expect(readTeamSessionFields(md)).toMatchObject({ teamFront: 'team-front_1' });
    });

    it('the list and get never show a front a forged update tried to add to a legacy root', async () => {
      await seed('legacy', { teamMode: true });
      for (const [, build] of forgedShapes) await store().updateMetadata('legacy', { metadata: build() });

      const [entry] = (await store().list('/p')).filter((s) => s.id === 'legacy');
      expect(entry.teamMode).toBe(true);
      expect(entry.teamFront).toBeUndefined();
      const session = await store().get('legacy');
      expect((session?.metadata as Record<string, unknown> | undefined)?.teamFront).toBeUndefined();
    });
  });

  describe('T3: list and projection on real stored rows', () => {
    it('exposes front, goal and status only on a team root, and never the context or done criterion', async () => {
      await seed('root', { teamMode: true, ...MISSION });
      await seed('legacy', { teamMode: true });
      // A root whose mission keys were stored before S3 (no host marker): untrusted, so a legacy root.
      const { teamMissionVersion: _marker, ...preS3 } = MISSION;
      await seed('preS3', { teamMode: true, ...preS3 });
      await seed('plain', { phase: 'x', ...MISSION });
      await seed('flagfalse', { teamMode: false, ...MISSION });
      await seed('member', { teamChild: { role: 'explorer', rootSessionId: 'root', depth: 1 }, ...MISSION });

      const listed = await store().list('/p');
      const byId = Object.fromEntries(listed.map((s) => [s.id, s as unknown as Record<string, unknown>]));

      expect(byId.root).toMatchObject({ teamMode: true, teamFront: 'team-front_1', teamGoal: 'Ship F1', teamMissionStatus: 'active' });
      expect(byId.root.teamMissionContext).toBeUndefined();
      expect(byId.root.teamDoneCriterion).toBeUndefined();

      for (const id of ['legacy', 'preS3', 'plain', 'flagfalse', 'member']) {
        for (const key of Object.keys(MISSION)) expect(byId[id][key], `${id} ${key}`).toBeUndefined();
      }
      expect(byId.legacy.teamMode).toBe(true);
      expect(byId.preS3.teamMode).toBe(true);
      expect(byId.root.teamMissionVersion).toBeUndefined();

      // The IPC projection carries the same three keys and nothing more.
      const projected = projectSessionList(listed, new Map());
      const projectedById = Object.fromEntries(projected.map((s) => [s.id, s as Record<string, unknown>]));
      expect(projectedById.root).toMatchObject({ teamFront: 'team-front_1', teamGoal: 'Ship F1', teamMissionStatus: 'active' });
      expect(projectedById.root.teamMissionContext).toBeUndefined();
      for (const id of ['legacy', 'preS3', 'plain', 'flagfalse', 'member']) {
        for (const key of Object.keys(MISSION)) expect(projectedById[id][key], `${id} ${key}`).toBeUndefined();
      }
    });

    it('main code still reads the context and done criterion from the stored row', async () => {
      await seed('root', { teamMode: true, ...MISSION });
      const md = await stored('root');
      expect(md.teamMissionContext).toBe('Bootstrap block');
      expect(md.teamDoneCriterion).toBe('S3 green');
      const session = await store().get('root');
      expect((session?.metadata as Record<string, unknown>).teamMissionContext).toBe('Bootstrap block');
      expect((session?.metadata as Record<string, unknown>).teamDoneCriterion).toBe('S3 green');
    });
  });
});
