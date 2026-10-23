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

  describe('a team-front (the user creates fronts through the UI or IPC)', () => {
    const front = { id: 'team-front_1', type: 'team-front', title: 'Team Mode', status: 'active', priority: 'medium', workspace: '/ws', description: 'Estado. Autoridade: ESTADO.md.' };
    const insertedData = () => {
      const statements = (db.runTransaction.mock.calls[0] as unknown as [Array<{ sql: string; params: unknown[] }>])[0];
      const insert = statements.find((statement) => statement.sql.includes('INSERT INTO tracker_items'))!;
      return JSON.parse(insert.params[3] as string);
    };

    it('is stored active and manual, with no mission', async () => {
      db.runTransaction.mockClear();
      await createNativeTrackerItem(front, dependencies);
      expect(db.runTransaction).toHaveBeenCalledTimes(1);
      const data = insertedData();
      expect(data).toMatchObject({ title: 'Team Mode', status: 'active', createdByAgent: false, description: 'Estado. Autoridade: ESTADO.md.' });
      expect(data.currentMission).toBeUndefined();
    });

    it('refuses a hand-set currentMission, a status outside the three and a state over 2,000 characters, before any write', async () => {
      for (const [bad, message] of [
        [{ ...front, customFields: { currentMission: 'root-1' } }, /currentMission is set by Nimbalyst/],
        [{ ...front, status: 'to-do' }, /status must be one of: active, paused, closed/],
        [{ ...front, description: 'd'.repeat(2001) }, /limit is 2000/],
        [{ ...front, content: 'b'.repeat(2001) }, /limit is 2000/],
      ] as Array<[typeof front, RegExp]>) {
        db.runTransaction.mockClear();
        await expect(createNativeTrackerItem(bad, dependencies), String(message)).rejects.toThrow(message);
        expect(db.runTransaction).not.toHaveBeenCalled();
      }
    });

    describe('its state is a description or a body (the quick-create popup sends the body as `content`)', () => {
      const { description: _omit, ...noState } = front;
      const refused = /A team-front needs its state: write a description or a body\./;

      it('is refused with neither, with only whitespace, and with an empty rich document, before any write', async () => {
        const emptyDoc = { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: ' ' }] }] } };
        for (const payload of [
          noState,
          { ...noState, description: '   ' },
          { ...noState, content: '  \n ' },
          { ...noState, description: ' ', content: ' ' },
          { ...noState, content: emptyDoc },
        ]) {
          db.runTransaction.mockClear();
          await expect(createNativeTrackerItem(payload as any, dependencies), JSON.stringify(payload)).rejects.toThrow(refused);
          expect(db.runTransaction).not.toHaveBeenCalled();
        }
      });

      it('is accepted with only a body, as markdown or as a rich document, and stored without a description', async () => {
        for (const content of ['Estado no corpo.', { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Estado.' }] }] } }]) {
          db.runTransaction.mockClear();
          await createNativeTrackerItem({ ...noState, content } as any, dependencies);
          expect(db.runTransaction).toHaveBeenCalledTimes(1);
          expect(insertedData().description).toBeUndefined();
        }
      });

      it('is accepted with only a description', async () => {
        db.runTransaction.mockClear();
        await createNativeTrackerItem({ ...noState, description: 'Só a descrição.' } as any, dependencies);
        expect(db.runTransaction).toHaveBeenCalledTimes(1);
        expect(insertedData().description).toBe('Só a descrição.');
      });

      it('keeps the cap on both', async () => {
        await expect(createNativeTrackerItem({ ...noState, description: 'd'.repeat(2001) } as any, dependencies)).rejects.toThrow(/limit is 2000/);
        await expect(createNativeTrackerItem({ ...noState, content: 'b'.repeat(2001) } as any, dependencies)).rejects.toThrow(/limit is 2000/);
      });
    });

    it('only the host-owned path may write currentMission', async () => {
      db.runTransaction.mockClear();
      await createNativeTrackerItem({ ...front, customFields: { currentMission: 'root-1' } }, dependencies, { hostOwned: true });
      expect(insertedData().currentMission).toBe('root-1');
    });
  });

  it('the host-owned path still refuses incomplete provenance', async () => {
    db.runTransaction.mockClear();
    await expect(createNativeTrackerItem({ ...payload, customFields: { manifestId: 'M-1' } }, dependencies, { hostOwned: true }))
      .rejects.toThrow(/teamRootSessionId must name the session/);
    expect(db.runTransaction).not.toHaveBeenCalled();
  });
});
