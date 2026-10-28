import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import type { TrackerItemEnvelope, TrackerItemPayload } from '@nimbalyst/runtime/sync';
import { SQLiteDatabase } from '../../../database/sqlite/SQLiteDatabase';
import { TrackerPGLiteStore } from '../TrackerPGLiteStore';

/**
 * F1 S1, G-sync condition 4: a peer that does not know a tracker type (an older
 * app receiving a `team-front`, or any type a newer peer defined) must store the
 * item it is sent, keep every field it does not recognize, and mark the row
 * synced, with no error. Receiving never consults the schema registry; this
 * fixes that, so the F1 types and fields can reach an older peer without
 * breaking its sync.
 */
const WORKSPACE = '/ws/shared';

function envelope(itemId: string, syncId = 1): TrackerItemEnvelope {
  return {
    itemId,
    syncId,
    encryptedPayload: 'encrypted',
    iv: 'iv',
    updatedAt: 1_700_000_000_000 + syncId,
    deletedAt: null,
    orgKeyFingerprint: null,
  };
}

function payload(overrides: Partial<TrackerItemPayload> = {}): TrackerItemPayload {
  return {
    itemId: 'future-1',
    primaryType: 'future-type',
    archived: false,
    bodyVersion: 0,
    fields: { title: 'From a newer peer', status: 'a-status-no-schema-lists', unknownScalar: 'kept', unknownObject: { nested: [1, 2, 3] } },
    labels: {},
    comments: [],
    activity: [],
    system: {},
    ...overrides,
  };
}

type Db = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

function parseData(value: unknown): Record<string, any> {
  return typeof value === 'string' ? JSON.parse(value) : (value as Record<string, any>);
}

async function readRow(db: Db, id: string) {
  const result = await db.query<{ type: string; data: unknown; sync_status: string; sync_id: unknown }>(
    'SELECT type, data, sync_status, sync_id FROM tracker_items WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  return row && { ...row, data: parseData(row.data), sync_id: row.sync_id == null ? null : Number(row.sync_id) };
}

async function expectUnknownTypeStored(db: Db, store: TrackerPGLiteStore) {
  // The registry this process runs with has neither type: a peer without them.
  expect(globalRegistry.get('future-type')).toBeUndefined();
  expect(globalRegistry.get('team-front')).toBeUndefined();

  // An unknown primaryType with unknown extra fields is stored without error.
  await expect(store.applyRemoteItem(envelope('future-1'), payload())).resolves.not.toThrow();
  const first = await readRow(db, 'future-1');
  expect(first).toBeDefined();
  expect(first!.type).toBe('future-type');
  expect(first!.sync_status).toBe('synced');
  expect(first!.sync_id).toBe(1);
  expect(first!.data.title).toBe('From a newer peer');
  // The fields no schema here knows are kept, in the synced customFields bag.
  expect(first!.data.customFields).toMatchObject({ unknownScalar: 'kept', unknownObject: { nested: [1, 2, 3] } });

  // Read back through the store: the item surfaces with its type and extras.
  const item = await store.getTrackerItem('future-1');
  expect(item?.type).toBe('future-type');
  expect(item?.customFields?.unknownScalar).toBe('kept');
  expect(item?.customFields?.unknownObject).toEqual({ nested: [1, 2, 3] });

  // A later update from the peer, still unknown, replaces the values and keeps the row synced.
  await store.applyRemoteItem(
    envelope('future-1', 2),
    payload({ fields: { title: 'Renamed by the peer', status: 'another-status', unknownScalar: 'kept v2', laterExtra: true } }),
  );
  const second = await readRow(db, 'future-1');
  expect(second!.sync_status).toBe('synced');
  expect(second!.sync_id).toBe(2);
  expect(second!.data.title).toBe('Renamed by the peer');
  expect(second!.data.customFields).toMatchObject({ unknownScalar: 'kept v2', laterExtra: true });
}

async function expectTeamFrontShapedItemStored(db: Db, store: TrackerPGLiteStore) {
  expect(globalRegistry.get('team-front')).toBeUndefined();
  await store.applyRemoteItem(
    envelope('front-1'),
    payload({
      itemId: 'front-1',
      primaryType: 'team-front',
      fields: { title: 'Team Mode', status: 'paused', description: 'Estado. Autoridade: ESTADO.md.', currentMission: 'root-1' },
    }),
  );
  const row = await readRow(db, 'front-1');
  expect(row!.type).toBe('team-front');
  expect(row!.sync_status).toBe('synced');
  expect(row!.data).toMatchObject({ title: 'Team Mode', status: 'paused' });
  expect(JSON.stringify(row!.data)).toContain('root-1');
  const item = await store.getTrackerItem('front-1');
  expect(item?.type).toBe('team-front');
  expect(item?.customFields?.currentMission).toBe('root-1');
}

describe('receiving an unknown tracker type and unknown fields (PGLite)', () => {
  let db: PGlite;
  let store: TrackerPGLiteStore;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE TABLE tracker_items (
        id TEXT PRIMARY KEY,
        issue_number INTEGER,
        issue_key TEXT,
        type TEXT NOT NULL,
        data JSONB NOT NULL,
        workspace TEXT NOT NULL,
        document_path TEXT,
        line_number INTEGER,
        content JSONB,
        archived BOOLEAN NOT NULL DEFAULT FALSE,
        source TEXT DEFAULT 'inline',
        source_ref TEXT,
        type_tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        sync_status TEXT DEFAULT 'local',
        sync_id BIGINT,
        body_version INTEGER NOT NULL DEFAULT 0,
        deleted_at TIMESTAMPTZ,
        created TIMESTAMPTZ DEFAULT NOW(),
        updated TIMESTAMPTZ DEFAULT NOW(),
        last_indexed TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX idx_tracker_workspace_issue_key
        ON tracker_items(workspace, issue_key) WHERE issue_key IS NOT NULL;
    `);
    store = new TrackerPGLiteStore(db as any, WORKSPACE);
  });

  afterEach(async () => {
    await db.close();
  });

  it('stores the item, keeps the unknown fields and marks the row synced', async () => {
    await expectUnknownTypeStored(db as any, store);
  });

  it('stores a team-front-shaped item for a registry that does not have the type', async () => {
    await expectTeamFrontShapedItemStored(db as any, store);
  });
});

describe('receiving an unknown tracker type and unknown fields (SQLite)', () => {
  let tmpDir: string;
  let db: SQLiteDatabase;
  let store: TrackerPGLiteStore;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-tracker-unknown-'));
    db = new SQLiteDatabase({
      dbDir: tmpDir,
      schemaDir: path.resolve(__dirname, '..', '..', '..', 'database', 'sqlite', 'schemas'),
      slowQueryThresholdMs: 1000,
      sampleRate: 0,
    });
    await db.initialize();
    store = new TrackerPGLiteStore(db as any, WORKSPACE);
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores the item, keeps the unknown fields and marks the row synced', async () => {
    await expectUnknownTypeStored(db as any, store);
  });

  it('stores a team-front-shaped item for a registry that does not have the type', async () => {
    await expectTeamFrontShapedItemStored(db as any, store);
  });
});
