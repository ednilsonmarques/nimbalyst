// @vitest-environment node
/**
 * F1.1: the per-item result reflects what was PERSISTED. ElectronDocumentService saves an item and then runs
 * steps after it (index refresh, observers) without isolating their exceptions, so an observer that throws
 * after the save used to make the writer report a saved write as failed. These run the real service (database
 * and sync manager mocked, as ElectronDocumentService.trackerSync.test.ts does) with the real writer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const h = vi.hoisted(() => ({
  rows: [] as any[],
  log: [] as string[],
  query: vi.fn(),
  failNextUpdate: false,
}));

vi.mock('../../../database/PGLiteDatabaseWorker', () => ({
  database: {
    query: h.query,
    runTransaction: async (statements: Array<{ sql: string; params: unknown[] }>) => {
      for (const statement of statements) await h.query(statement.sql, statement.params);
    },
  },
}));
vi.mock('../../TrackerSyncManager', () => ({
  syncTrackerItem: vi.fn(),
  unsyncTrackerItem: vi.fn(),
  isTrackerSyncActive: () => false,
  isTrackerSyncConfigured: () => false,
  trackerItemToPayload: (item: unknown) => item,
  onTrackerItemApplied: () => () => {},
  onTrackerSyncWorkspaceConnected: () => () => {},
  getTrackerItemForSync: async () => null,
}));
vi.mock('../../../utils/store', () => ({ getWorkspaceState: () => ({}), isAnalyticsEnabled: () => false }));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: vi.fn(), safeOn: vi.fn() }));
vi.mock('../../../../../../tracker-schema/src/TrackerDataModel', () => ({
  globalRegistry: {
    get: () => ({ sharing: 'personal', draftByDefault: false, fields: [] }),
    getForWorkspace: () => ({ sharing: 'personal', draftByDefault: false, fields: [] }),
    hasWorkspaceLayer: () => true,
  },
}));
vi.mock('../../tracker/localKeyAllocator', () => ({ assignLocalKeysToRows: vi.fn(async () => new Map<string, string>()) }));

import { ElectronDocumentService } from '../../ElectronDocumentService';
import { buildTeamFrontWriter, TeamFrontWriteUnconfirmedError, type FrontDocumentService, type TrackerWriteSteps } from '../teamFrontProposalWriter';
import { decideTeamFrontProposal, type TeamFrontDecisionDeps } from '../teamFrontProposalDecision';
import { TeamFrontProposalRegistry } from '../teamFrontProposals';
import { withFrontLock, withTeamFrontCreateLock } from '../teamMissions';

let workspace: string;
let service: ElectronDocumentService;

const steps: TrackerWriteSteps = {
  beforeWrite: async () => () => undefined,
  syncCreated: async () => ({ shared: false }),
  syncUpdated: async () => ({ shared: false }),
};

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function frontRow(id: string, status: string) {
  return {
    id, type: 'team-front', type_tags: ['team-front'],
    data: JSON.stringify({ title: 'Portal', status, description: 'State', priority: 'medium' }),
    workspace, document_path: '', line_number: null, created: new Date().toISOString(), updated: new Date().toISOString(),
    last_indexed: new Date().toISOString(), sync_status: 'local', archived: false, archived_at: null, source: 'native',
    source_ref: null, content: null, local_key: null, deleted_at: null,
  };
}

beforeEach(async () => {
  h.rows = [];
  h.log = [];
  h.failNextUpdate = false;
  h.query.mockReset();
  h.query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const q = norm(sql);
    h.log.push(q.split(' ').slice(0, 3).join(' '));
    if (q.includes('MIN(kanban_sort_order)')) return { rows: [{ min_key: null }] };
    if (q.startsWith('INSERT INTO tracker_items')) {
      h.rows.push({ ...frontRow(String(params[0]), 'active'), id: params[0], type: params[1], type_tags: params[2], data: params[3], workspace: params[4], sync_status: params[5] });
      return { rows: [] };
    }
    if (q.startsWith('UPDATE tracker_items SET data = $1')) {
      if (h.failNextUpdate) throw new Error('database is locked');
      const row = h.rows.find((r) => r.id === params[1]);
      row.data = params[0];
      return { rows: [row] };
    }
    if (q.startsWith('SELECT')) {
      const byId = params.find((p) => typeof p === 'string' && h.rows.some((r) => r.id === p));
      return { rows: byId ? h.rows.filter((r) => r.id === byId) : h.rows };
    }
    return { rows: [] };
  });
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'front-writer-real-'));
  service = new ElectronDocumentService(workspace);
});

afterEach(async () => {
  service.destroy();
  await fs.rm(workspace, { recursive: true, force: true });
});

const writerFor = (svc: unknown = service) => buildTeamFrontWriter(async (_w, fn) => fn(svc as FrontDocumentService), steps);
const storedStatus = (id: string) => JSON.parse(h.rows.find((r) => r.id === id).data).status;
const updates = () => h.log.filter((entry) => entry.startsWith('UPDATE tracker_items'));
const inserts = () => h.log.filter((entry) => entry.startsWith('INSERT INTO'));

describe('an observer that throws after the UPDATE (real ElectronDocumentService)', () => {
  it('a status change is reported as written with a warning, and the UPDATE ran exactly once', async () => {
    h.rows.push(frontRow('tfr_1', 'active'));
    service.watchTrackerItems(() => { throw new Error('observer exploded'); });
    const out = await writerFor().setFrontStatus({ workspacePath: workspace, frontId: 'tfr_1', status: 'paused' });
    expect(storedStatus('tfr_1')).toBe('paused');
    expect(out.followUpWarning).toMatch(/Saved, but a step after saving failed: observer exploded/);
    expect(out.syncWarning).toBeUndefined();
    expect(updates().filter((entry) => entry === 'UPDATE tracker_items SET')).toHaveLength(1);
  });

  it('a create is reported as written with the id the writer generated, a warning, and one INSERT', async () => {
    service.watchTrackerItems(() => { throw new Error('observer exploded'); });
    const out = await writerFor().createFront({ workspacePath: workspace, title: 'Billing', description: 'State', status: 'active' });
    expect(out.id).toMatch(/^tfr_/);
    expect(out.followUpWarning).toMatch(/Saved, but a step after saving failed: observer exploded/);
    expect(h.rows.map((r) => r.id)).toEqual([out.id]);
    expect(inserts()).toHaveLength(1);
  });

  it('with a healthy observer there is no warning (the normal path is unchanged)', async () => {
    h.rows.push(frontRow('tfr_1', 'active'));
    service.watchTrackerItems(() => undefined);
    expect(await writerFor().setFrontStatus({ workspacePath: workspace, frontId: 'tfr_1', status: 'closed' })).toEqual({});
    expect((await writerFor().createFront({ workspacePath: workspace, title: 'B', description: 'd', status: 'active' })).followUpWarning).toBeUndefined();
  });
});

describe('a genuine failure before persistence is still a failure', () => {
  it('a failing UPDATE rethrows the original error; the status is unchanged and nothing is retried', async () => {
    h.rows.push(frontRow('tfr_1', 'active'));
    h.failNextUpdate = true;
    await expect(writerFor().setFrontStatus({ workspacePath: workspace, frontId: 'tfr_1', status: 'paused' })).rejects.toThrow('database is locked');
    expect(storedStatus('tfr_1')).toBe('active');
  });

  it('a refusal by beforeWrite (not a team-front) is a failure and writes nothing', async () => {
    h.rows.push({ ...frontRow('bug_1', 'active'), type: 'bug', type_tags: ['bug'] });
    await expect(writerFor().setFrontStatus({ workspacePath: workspace, frontId: 'bug_1', status: 'paused' })).rejects.toThrow(/not a team-front/);
    expect(storedStatus('bug_1')).toBe('active');
    expect(updates()).toEqual([]);
  });

  it('a create that never reached the database is a failure', async () => {
    h.query.mockImplementation(async (sql: string) => {
      if (norm(sql).startsWith('INSERT INTO tracker_items')) throw new Error('disk full');
      if (norm(sql).includes('MIN(kanban_sort_order)')) return { rows: [{ min_key: null }] };
      return { rows: [] };
    });
    await expect(writerFor().createFront({ workspacePath: workspace, title: 'Billing', description: 'State', status: 'active' })).rejects.toThrow('disk full');
    expect(h.rows).toEqual([]);
  });

  it('an item that cannot be read back is reported as unconfirmed, with both causes, not as success', async () => {
    const svc = {
      createTrackerItem: async () => { throw new Error('observer exploded'); },
      updateTrackerItem: async () => { throw new Error('observer exploded'); },
      updateTrackerItemSyncStatus: async () => undefined,
      getTrackerItemById: async () => { throw new Error('database is locked'); },
    };
    await expect(writerFor(svc).createFront({ workspacePath: workspace, title: 'A', description: 'd', status: 'active' }))
      .rejects.toThrow(/could not be confirmed.*database is locked.*Check the Tracker/s);
    await expect(writerFor(svc).setFrontStatus({ workspacePath: workspace, frontId: 'tfr_1', status: 'paused' }))
      .rejects.toThrow(/observer exploded.*could not be confirmed/s);
    // a distinct error type, not a plain failure: the item may exist
    await expect(writerFor(svc).createFront({ workspacePath: workspace, title: 'A', description: 'd', status: 'active' })).rejects.toBeInstanceOf(TeamFrontWriteUnconfirmedError);
    await expect(writerFor(svc).setFrontStatus({ workspacePath: workspace, frontId: 'tfr_1', status: 'paused' })).rejects.toMatchObject({ itemId: 'tfr_1' });
  });

  it('an exception with the status NOT changed in the store is not turned into success', async () => {
    h.rows.push(frontRow('tfr_1', 'active'));
    const svc = {
      ...service,
      createTrackerItem: service.createTrackerItem.bind(service),
      updateTrackerItem: async () => { throw new Error('refused somewhere before saving'); },
      updateTrackerItemSyncStatus: async () => undefined,
      getTrackerItemById: service.getTrackerItemById.bind(service),
    };
    await expect(writerFor(svc).setFrontStatus({ workspacePath: workspace, frontId: 'tfr_1', status: 'paused' })).rejects.toThrow('refused somewhere before saving');
  });
});

describe('unconfirmed across the executor and the notice (advisor 49b904f1)', () => {
  function decideWith(svc: unknown, items: Array<Record<string, unknown>>) {
    const registry = new TeamFrontProposalRegistry();
    const proposal = registry.register({ rootSessionId: 'root', workspacePath: workspace, items: items as never });
    const delivered: Array<{ notice: string; results: any[] }> = [];
    const deps: TeamFrontDecisionDeps = {
      registry,
      ports: {
        listFronts: async () => h.rows.filter((r) => r.type === 'team-front').map((r) => ({ id: r.id, title: JSON.parse(r.data).title, status: JSON.parse(r.data).status, archived: false })),
        getFront: async (id) => { const r = h.rows.find((x) => x.id === id); return r ? { id: r.id, title: JSON.parse(r.data).title, type: r.type, status: JSON.parse(r.data).status, archived: false, description: null } : null; },
        findActiveMissionRoot: async () => null,
      },
      writer: writerFor(svc),
      readRoot: async () => ({ metadata: { teamMode: true }, agentRole: 'standard', workspacePath: workspace, isArchived: false }),
      withFrontLock,
      withCreateLock: withTeamFrontCreateLock,
      deliver: async ({ notice, results }) => { delivered.push({ notice, results }); return { card: true, notice: true }; },
    };
    return { proposal, delivered, run: (decisions: unknown[]) => decideTeamFrontProposal(deps, workspace, { proposalId: proposal.id, items: decisions }) };
  }

  it('a write that threw and cannot be read back is reported as unconfirmed (not failed), listed apart in the notice, never retried', async () => {
    h.rows.push(frontRow('tfr_1', 'active'));
    let creates = 0; let updates = 0;
    const svc = {
      createTrackerItem: async () => { creates++; throw new Error('observer exploded'); },
      updateTrackerItem: async () => { updates++; throw new Error('observer exploded'); },
      updateTrackerItemSyncStatus: async () => undefined,
      getTrackerItemById: async () => { throw new Error('database is locked'); },
    };
    const d = decideWith(svc, [
      { action: 'create', title: 'Billing', description: 'State', status: 'active' },
      { action: 'status', frontId: 'tfr_1', frontTitle: 'Portal', fromStatus: 'active', status: 'paused', activeMission: null },
    ]);
    const response = await d.run([{ index: 0, decision: 'approve' }, { index: 1, decision: 'approve' }]);
    expect(response).toMatchObject({ ok: true });
    const results = (response as { results: any[] }).results;
    expect(results.map((r) => r.result)).toEqual(['unconfirmed', 'unconfirmed']);
    expect(results[0]).toMatchObject({ code: 'write-unconfirmed', id: expect.stringMatching(/^tfr_/) });
    expect(results[1]).toMatchObject({ code: 'write-unconfirmed', id: 'tfr_1' });
    expect(results.some((r) => r.result === 'failed')).toBe(false);
    expect(creates).toBe(1);
    expect(updates).toBe(1);

    const { notice } = d.delivered[0];
    expect(notice).toMatch(/0 of 2 items written, 2 unconfirmed/);
    expect(notice).toContain('UNCONFIRMED; the write may or may not have been saved (item id "tfr_1")');
    expect(notice).not.toMatch(/: failed \(/);
    expect(notice).toContain('items marked UNCONFIRMED may have, and their outcome is unknown');
    expect(notice).toContain('the user must check the Tracker before you propose them');
    expect(notice).not.toContain('Only the items marked written changed anything');
    // the card row carries exactly what the widget reads
    expect(JSON.parse(JSON.stringify(d.delivered[0].results))[0]).toMatchObject({ index: 0, action: 'create', label: 'Billing', result: 'unconfirmed', code: 'write-unconfirmed' });
  });

  it('a genuinely failed write and a confirmed one keep their own results next to an unconfirmed one', async () => {
    h.rows.push(frontRow('tfr_1', 'active'));
    const ok = { ...service };
    const svc = {
      createTrackerItem: async () => { throw new Error('disk full'); },
      updateTrackerItem: service.updateTrackerItem.bind(service),
      updateTrackerItemSyncStatus: service.updateTrackerItemSyncStatus.bind(service),
      getTrackerItemById: async (id: string) => { if (id.startsWith('tfr_') && !h.rows.some((r) => r.id === id)) return null; return service.getTrackerItemById(id); },
    };
    void ok;
    const d = decideWith(svc, [
      { action: 'create', title: 'Billing', description: 'State', status: 'active' },
      { action: 'status', frontId: 'tfr_1', frontTitle: 'Portal', fromStatus: 'active', status: 'paused', activeMission: null },
    ]);
    const response = await d.run([{ index: 0, decision: 'approve' }, { index: 1, decision: 'approve' }]);
    const results = (response as { results: any[] }).results;
    expect(results.map((r) => r.result)).toEqual(['failed', 'written']);
    expect(d.delivered[0].notice).toContain('Only the items marked written changed anything');
    expect(d.delivered[0].notice).not.toContain('UNCONFIRMED');
  });
});
