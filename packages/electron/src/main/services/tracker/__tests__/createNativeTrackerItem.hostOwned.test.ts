// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  query: vi.fn(async (sql: string) => (sql.startsWith('SELECT * FROM tracker_items')
    ? { rows: [{ id: 'tool-manifest_1', type: 'tool-manifest', data: '{}', workspace: '/ws', updated: new Date().toISOString() }] }
    : { rows: [] })),
  runTransaction: vi.fn(async () => {}),
}));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: db }));
vi.mock('../../TrackerIdentityService', () => ({ getCurrentIdentity: () => ({}) }));
vi.mock('@nimbalyst/tracker-schema', () => ({ globalRegistry: { get: () => ({ creatable: true, fields: [] }) } }));
vi.mock('../../TrackerPolicyService', () => ({
  getEffectiveTrackerSharingPolicy: () => ({ sharing: 'personal' }),
  getInitialTrackerSyncStatus: () => 'local',
}));
vi.mock('../trackerCreationReceipt', () => ({
  creationRequestHash: () => 'h',
  getCreationReceipt: async () => null,
  withCreationLock: async (_w: string, _id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../trackerBodySnapshot', () => ({ initialTrackerBodyCache: () => ({ sql: '', params: [] }) }));
vi.mock('../trackerRelationshipIndexStore', () => ({
  reindexItemRelationshipsAfterWrite: async () => {},
  trackerRowUpdatedToIso: () => new Date().toISOString(),
}));

import { createNativeTrackerItem } from '../createNativeTrackerItem';

const dependencies = {
  assignLocalKeysFrom: async () => {},
  rowToTrackerItem: (row: any) => ({ id: row.id, type: row.type, title: 'M-1', status: 'draft' }) as any,
  notify: vi.fn(),
};
const payload = {
  id: 'tool-manifest_1', type: 'tool-manifest', title: 'M-1: x', status: 'draft', priority: 'medium', workspace: '/ws',
  description: 'body',
  customFields: { manifestId: 'M-1', teamRootSessionId: 'root-1', architectSessionId: 'arch-1', generatedByRole: 'architect', manifestVersion: '1', contentHash: 'h' },
};

describe('native creation of a tool-manifest', () => {
  it('through the ordinary path (UI, IPC) is refused before any write', async () => {
    db.runTransaction.mockClear();
    await expect(createNativeTrackerItem(payload, dependencies)).rejects.toThrow(/written by Nimbalyst when an architect session completes/);
    expect(db.runTransaction).not.toHaveBeenCalled();
    expect(dependencies.notify).not.toHaveBeenCalled();
  });

  it('through the host-owned path is written with its provenance, status draft and the agent origin', async () => {
    db.runTransaction.mockClear();
    const created = await createNativeTrackerItem(payload, dependencies, { hostOwned: true });
    expect(created.id).toBe('tool-manifest_1');
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    const statements = (db.runTransaction.mock.calls[0] as unknown as [Array<{ sql: string; params: unknown[] }>])[0];
    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO tracker_items'))!;
    const data = JSON.parse(insert.params[3] as string);
    expect(data).toMatchObject({ title: 'M-1: x', status: 'draft', manifestId: 'M-1', teamRootSessionId: 'root-1', architectSessionId: 'arch-1', generatedByRole: 'architect', createdByAgent: true, description: 'body' });
    expect(insert.params[1]).toBe('tool-manifest');
  });

  it('a team-note through the ordinary path (UI, IPC) is stored manual, active and without provenance; hand-set provenance is refused', async () => {
    db.runTransaction.mockClear();
    const note = { id: 'team-note_1', type: 'team-note', title: 'Decision', status: 'active', priority: 'medium', workspace: '/ws', description: 'short', customFields: { noteKind: 'decision' } };
    await createNativeTrackerItem(note, dependencies);
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    const statements = (db.runTransaction.mock.calls[0] as unknown as [Array<{ sql: string; params: unknown[] }>])[0];
    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO tracker_items'))!;
    const data = JSON.parse(insert.params[3] as string);
    expect(data).toMatchObject({ title: 'Decision', status: 'active', noteKind: 'decision', createdByAgent: false });
    expect(data.sourceSession).toBeUndefined();
    db.runTransaction.mockClear();
    await expect(createNativeTrackerItem({ ...note, customFields: { noteKind: 'decision', sourceSession: 'forged', agentRole: 'coordinator' } }, dependencies))
      .rejects.toThrow(/sourceSession is set by Nimbalyst from the agent session/);
    expect(db.runTransaction).not.toHaveBeenCalled();
  });

  it('the host-owned path still refuses incomplete provenance', async () => {
    db.runTransaction.mockClear();
    await expect(createNativeTrackerItem({ ...payload, customFields: { manifestId: 'M-1' } }, dependencies, { hostOwned: true }))
      .rejects.toThrow(/teamRootSessionId must name the session/);
    expect(db.runTransaction).not.toHaveBeenCalled();
  });
});
