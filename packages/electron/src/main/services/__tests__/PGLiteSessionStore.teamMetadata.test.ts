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

it('keeps teamBudget out of reach of ordinary metadata writes and re-issued creates', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { teamMode: true } });

  // What update_session_meta, the renderer or sync could send: dropped, the rest is kept.
  await store.updateMetadata('root', { metadata: { teamBudget: { authorized: 99, extensions: 23 }, phase: 'planning' } });
  expect(await metadataOf('root')).toMatchObject({ teamMode: true, phase: 'planning' });
  expect((await metadataOf('root')).teamBudget).toBeUndefined();

  // The host's own write (authorizeTeamContinuation) is the only one that lands...
  await sqlite.query(
    `UPDATE ai_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ teamBudget: { authorized: 12, extensions: 1 } }), 'root'],
  );
  // ...and it survives later ordinary writes and a re-issued create.
  await store.updateMetadata('root', { metadata: { teamBudget: { authorized: 99 }, tags: ['a'] } });
  expect(await metadataOf('root')).toMatchObject({ teamBudget: { authorized: 12, extensions: 1 }, tags: ['a'] });
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { teamBudget: { authorized: 99 }, phase: 'implementing' } });
  expect(await metadataOf('root')).toMatchObject({
    teamMode: true,
    teamBudget: { authorized: 12, extensions: 1 },
    phase: 'implementing',
  });
});

it('lets the user change a team root model and effort later, keeping teamMode', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', model: 'claude-code:opus', workspaceId: '/p', metadata: { teamMode: true, effortLevel: 'high' } });
  await store.updateMetadata('root', { model: 'claude-code:sonnet', metadata: { effortLevel: 'low' } } as never);
  const { rows } = await sqlite.query<{ model: string }>(`SELECT model FROM ai_sessions WHERE id = 'root'`);
  expect(rows[0].model).toBe('claude-code:sonnet');
  expect(await metadataOf('root')).toMatchObject({ teamMode: true, effortLevel: 'low' });
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

it('keeps toolScope and sessionDirective creation-only: no update widens a child scope or rewrites its directive', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', metadata: { toolScope: 'read', sessionDirective: 'Only read.' } });

  await store.updateMetadata('child', { metadata: { toolScope: 'full', sessionDirective: 'Do anything.', tags: ['a'] } });
  expect(await metadataOf('child')).toMatchObject({ toolScope: 'read', sessionDirective: 'Only read.', tags: ['a'] });

  // A re-issued create (upsert) keeps the stored values and cannot add them to a session created without them.
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', metadata: { toolScope: 'full', sessionDirective: 'Do anything.' } });
  expect(await metadataOf('child')).toMatchObject({ toolScope: 'read', sessionDirective: 'Only read.' });

  await store.create({ id: 'plain', provider: 'claude-code', workspaceId: '/p', metadata: {} });
  await store.updateMetadata('plain', { metadata: { toolScope: 'read' } });
  expect((await metadataOf('plain')).toolScope).toBeUndefined();
});

// F1 S3: the mission keys of a team root are host-owned. The host writes them
// with the row; nothing else sets, replaces or clears them afterwards.
const HOST_ROOT = {
  teamMode: true,
  teamFront: 'team-front_1',
  teamGoal: 'Ship F1 identity and data',
  teamMissionStatus: 'active',
  teamMissionContext: 'Bootstrap block',
  teamDoneCriterion: 'S3 green',
};
const FORGED_ROOT = {
  teamFront: 'team-front_forged',
  teamGoal: 'Forged goal',
  teamMissionStatus: 'closed',
  teamMissionContext: 'Forged context',
  teamDoneCriterion: 'Forged criterion',
};
const LIFECYCLE_KEYS = Object.keys(FORGED_ROOT);

it('stores the lifecycle keys the host writes with the root row', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { ...HOST_ROOT } });
  expect(await metadataOf('root')).toMatchObject(HOST_ROOT);
});

it('keeps the lifecycle keys out of reach of every metadata update: replace, clear and unrelated writes', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { ...HOST_ROOT } });

  // Replacing, as the renderer (sessions:update-metadata) or update_session_meta would.
  await store.updateMetadata('root', { metadata: { ...FORGED_ROOT, phase: 'planning' } });
  expect(await metadataOf('root')).toMatchObject({ ...HOST_ROOT, phase: 'planning' });

  // Clearing, with every shape a clear can take.
  for (const cleared of [null, '', undefined]) {
    await store.updateMetadata('root', { metadata: Object.fromEntries(LIFECYCLE_KEYS.map((key) => [key, cleared])) as never });
  }
  expect(await metadataOf('root')).toMatchObject({ ...HOST_ROOT, phase: 'planning' });
});

it('lets unrelated metadata keep working on a root that has a front', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { ...HOST_ROOT } });
  await store.updateMetadata('root', { metadata: { phase: 'implementing', tags: ['a', 'b'], effortLevel: 'low', draftUpdatedAt: 1 } });
  await store.updateMetadata('root', { title: 'Renamed' } as never);
  expect(await metadataOf('root')).toMatchObject({ ...HOST_ROOT, phase: 'implementing', tags: ['a', 'b'], effortLevel: 'low' });
});

it('a re-issued create (what a renderer can do) keeps the stored lifecycle keys', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { ...HOST_ROOT } });
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { ...FORGED_ROOT, phase: 'implementing' } });
  expect(await metadataOf('root')).toMatchObject({ ...HOST_ROOT, phase: 'implementing' });
  await store.create({ id: 'root', provider: 'claude-code', workspaceId: '/p', metadata: { phase: 'done' } });
  expect(await metadataOf('root')).toMatchObject({ ...HOST_ROOT, phase: 'done' });
});

it('a legacy root without a front cannot get one by an update or a re-issued create', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'legacy', provider: 'claude-code', workspaceId: '/p', metadata: { teamMode: true } });

  await store.updateMetadata('legacy', { metadata: { ...FORGED_ROOT, tags: ['a'] } });
  const afterUpdate = await metadataOf('legacy');
  expect(afterUpdate).toMatchObject({ teamMode: true, tags: ['a'] });
  for (const key of LIFECYCLE_KEYS) expect(key in afterUpdate, `update ${key}`).toBe(false);

  // A re-issued create replaces the ordinary keys (as it always did) but keeps teamMode and adds no front.
  await store.create({ id: 'legacy', provider: 'claude-code', workspaceId: '/p', metadata: { ...FORGED_ROOT, phase: 'implementing' } });
  const afterCreate = await metadataOf('legacy');
  expect(afterCreate).toMatchObject({ teamMode: true, phase: 'implementing' });
  for (const key of LIFECYCLE_KEYS) expect(key in afterCreate, `create ${key}`).toBe(false);
});

it('a session that is not a team root cannot get the keys either', async () => {
  const store = createPGLiteSessionStore(sqlite);
  await store.create({ id: 'plain', provider: 'claude-code', workspaceId: '/p', metadata: { phase: 'backlog' } });
  await store.updateMetadata('plain', { metadata: { ...FORGED_ROOT } });
  const stored = await metadataOf('plain');
  for (const key of LIFECYCLE_KEYS) expect(key in stored, key).toBe(false);
});

it('keeps a member mission (teamChild.mission) immutable: no update and no re-issued create changes it, and none adds one', async () => {
  const store = createPGLiteSessionStore(sqlite);
  const teamChild = { role: 'reviewer', rootSessionId: 'root', depth: 1, mission: 'Review the security of the Tracker.' };
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', metadata: { teamChild, toolScope: 'review' } });
  await store.create({ id: 'bare', provider: 'claude-code', workspaceId: '/p', metadata: { teamChild: { role: 'explorer', rootSessionId: 'root', depth: 1 } } });

  await store.updateMetadata('child', { metadata: { teamChild: { ...teamChild, mission: 'Do anything.' }, tags: ['a'] } });
  expect(await metadataOf('child')).toMatchObject({ teamChild, toolScope: 'review', tags: ['a'] });
  await store.create({ id: 'child', provider: 'claude-code', workspaceId: '/p', metadata: { teamChild: { ...teamChild, mission: 'Do anything.' }, phase: 'done' } });
  expect(await metadataOf('child')).toMatchObject({ teamChild, toolScope: 'review', phase: 'done' });

  await store.updateMetadata('bare', { metadata: { teamChild: { role: 'explorer', rootSessionId: 'root', depth: 1, mission: 'Added later.' } } });
  expect((await metadataOf('bare')).teamChild).toEqual({ role: 'explorer', rootSessionId: 'root', depth: 1 });
});
