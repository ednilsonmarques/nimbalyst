// @vitest-environment node
/**
 * Migration 0052: team-note joins the revision-recorded tracker types, so
 * edits of a Team Note keep a history (the 0047 triggers read this table).
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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

import { SQLiteDatabase } from '../SQLiteDatabase';

let tmpDir: string;
let sqlite: SQLiteDatabase;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-revtypes-'));
  sqlite = new SQLiteDatabase({
    dbDir: tmpDir,
    schemaDir: path.resolve(__dirname, '..', 'schemas'),
    slowQueryThresholdMs: 1000,
    sampleRate: 0,
  });
  await sqlite.initialize();
});

afterEach(async () => {
  await sqlite.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

it('records team-note revisions alongside the existing knowledge kinds', async () => {
  const { rows } = await sqlite.query<{ type: string }>(`SELECT type FROM tracker_revision_types ORDER BY type`);
  const types = rows.map((row) => row.type);
  expect(types).toContain('team-note');
  for (const existing of ['source', 'capture', 'citation', 'claim']) expect(types).toContain(existing);
  expect(types).not.toContain('task');
});
