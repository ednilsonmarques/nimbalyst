// @vitest-environment node
/**
 * Team mode keys (metadata.teamMode / metadata.teamChild) are creation-only,
 * checked against a real better-sqlite3 backend like the ownership test in
 * PGLiteSessionStore.sqliteMetadata.test.ts.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

import { SQLiteDatabase } from '../../database/sqlite/SQLiteDatabase';
import { createPGLiteSessionStore } from '../PGLiteSessionStore';

let tmpDir: string;
let sqlite: SQLiteDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-team-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', '..', 'database', 'sqlite', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterEach(async () => {
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function metadataOf(id: string) {
  const { rows } = await sqlite.query<{ metadata: string }>(`SELECT metadata FROM ai_sessions WHERE id = $1`, [id]);
  return JSON.parse(rows[0].metadata);
}

it('keeps teamMode and teamChild out of reach of ordinary metadata writes', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { teamMode: true } });
  const teamChild = { role: 'explorer', rootSessionId: 'root', depth: 1 };
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', metadata: { teamChild } });

  await store.updateMetadata('root', { metadata: { teamMode: false, teamChild: { role: 'other', rootSessionId: 'x', depth: 1 }, phase: 'planning' } });
  await store.updateMetadata('child', { metadata: { teamChild: { role: 'implementer', rootSessionId: 'evil', depth: 1 }, tags: ['a'] } });

  expect(await metadataOf('root')).toMatchObject({ teamMode: true, phase: 'planning' });
  expect((await metadataOf('root')).teamChild).toBeUndefined();
  expect(await metadataOf('child')).toMatchObject({ teamChild, tags: ['a'] });
});

it('cannot turn a normal session into a team root after creation', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'plain', provider: 'claude-code', workspaceId: '/p', metadata: { phase: 'backlog' } });
  await store.updateMetadata('plain', { metadata: { teamMode: true } });
  expect((await metadataOf('plain')).teamMode).toBeUndefined();
});

it('a re-issued create keeps the stored team keys and cannot add new ones', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { teamMode: true } });
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { phase: 'implementing' } });
  expect(await metadataOf('root')).toMatchObject({ teamMode: true, phase: 'implementing' });

  await store.create({ id: 'plain', provider: 'claude-code', workspaceId: '/p', metadata: {} });
  await store.create({ id: 'plain', provider: 'claude-code', workspaceId: '/p', metadata: { teamMode: true } });
  expect((await metadataOf('plain')).teamMode).toBeUndefined();
});
