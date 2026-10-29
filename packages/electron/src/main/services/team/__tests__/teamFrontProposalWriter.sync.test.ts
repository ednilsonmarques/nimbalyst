// @vitest-environment node
/**
 * F1.1: an approved front is shared with the team the way the Tracker UI shares one
 * (team-front.yaml declares sharing: team). The writer runs the UI's own post-write steps
 * (trackerItemShareGate.ts: the real ones here, with the sync manager and policy mocked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({
  isTrackerSyncActive: vi.fn(() => true),
  isTrackerSyncConfigured: vi.fn(() => false),
  syncTrackerItem: vi.fn(async () => undefined),
  trackerItemToPayload: vi.fn((item: unknown) => item),
}));
vi.mock('../../TrackerSyncManager', () => sync);
const windows = vi.hoisted(() => ({ send: vi.fn(), found: true as boolean, destroyed: false as boolean }));
vi.mock('../../../window/WindowManager', () => ({
  findWindowByWorkspace: vi.fn(() => (windows.found ? { isDestroyed: () => windows.destroyed, webContents: { send: windows.send } } : null)),
}));
const analytics = vi.hoisted(() => ({ trackTrackerMutation: vi.fn() }));
vi.mock('../../ElectronDocumentService', () => analytics);
const engine = vi.hoisted(() => ({ encodeTrackerPayloadPlaintext: vi.fn() }));
vi.mock('@nimbalyst/tracker-engine', () => ({ ...engine, TrackerPayloadTooLargeError: class TrackerPayloadTooLargeError extends Error {} }));
vi.mock('../../TrackerPolicyService', () => ({
  getEffectiveTrackerSharingPolicy: vi.fn(() => ({ sharing: 'team' })),
  shouldSyncTrackerItem: vi.fn(() => true),
}));

import { decideTeamFrontProposal, type TeamFrontDecisionDeps } from '../teamFrontProposalDecision';
import { TeamFrontProposalRegistry } from '../teamFrontProposals';
import { buildTeamFrontWriter, type FrontDocumentService } from '../teamFrontProposalWriter';
import { withFrontLock, withTeamFrontCreateLock } from '../teamMissions';

const WS = '/ws/project';

function service() {
  const created: unknown[] = [];
  const pending: string[] = [];
  const saved: string[] = [];
  const svc: FrontDocumentService = {
    createTrackerItem: async (payload) => { created.push(payload); return { id: payload.id, type: payload.type, workspace: payload.workspace } as never; },
    updateTrackerItem: async (id, _updates, options) => {
      const item = { id, type: 'team-front', workspace: WS } as never;
      options?.beforeWrite?.(item);
      saved.push(id);
      return item;
    },
    updateTrackerItemSyncStatus: async (id) => { pending.push(id); },
    getTrackerItemById: async () => null,
  };
  return { svc, created, pending, saved, writer: buildTeamFrontWriter(async (_w, fn) => fn(svc)) };
}

beforeEach(() => {
  sync.isTrackerSyncActive.mockReset().mockReturnValue(true);
  sync.syncTrackerItem.mockReset().mockResolvedValue(undefined);
  sync.isTrackerSyncConfigured.mockReset().mockReturnValue(false);
});

describe('an approved create is shared like a Tracker UI create', () => {
  it('syncs the new shared front when sync is active', async () => {
    const s = service();
    const out = await s.writer.createFront({ workspacePath: WS, title: 'Billing', description: 'State', status: 'active' });
    expect(out.syncWarning).toBeUndefined();
    expect(sync.syncTrackerItem).toHaveBeenCalledTimes(1);
    expect(sync.syncTrackerItem).toHaveBeenCalledWith(expect.objectContaining({ id: out.id, type: 'team-front' }));
    expect(s.created).toHaveLength(1);
  });

  it('does not sync when the room is not connected (the UI path leaves it for the reconnect drain)', async () => {
    sync.isTrackerSyncActive.mockReturnValue(false);
    const s = service();
    const out = await s.writer.createFront({ workspacePath: WS, title: 'Billing', description: 'State', status: 'active' });
    expect(out.syncWarning).toBeUndefined();
    expect(sync.syncTrackerItem).not.toHaveBeenCalled();
  });

  it('reports a sync failure after a successful save, once, and never retries or creates again', async () => {
    sync.syncTrackerItem.mockRejectedValue(new Error('room unreachable'));
    const s = service();
    const out = await s.writer.createFront({ workspacePath: WS, title: 'Billing', description: 'State', status: 'active' });
    expect(out.id).toMatch(/^tfr_/);
    expect(out.syncWarning).toMatch(/Saved, but sharing it with the team did not complete: room unreachable/);
    expect(sync.syncTrackerItem).toHaveBeenCalledTimes(1);
    expect(s.created).toHaveLength(1);
  });
});

describe('an approved status change is shared like a Tracker UI edit', () => {
  it('pushes the saved front to its room, or marks it pending when the room is not connected', async () => {
    const s = service();
    expect(await s.writer.setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'paused' })).toEqual({});
    expect(sync.syncTrackerItem).toHaveBeenCalledTimes(1);
    sync.isTrackerSyncActive.mockReturnValue(false);
    await s.writer.setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'active' });
    expect(s.pending).toEqual(['tfr_1']);
  });

  it('runs the UI\'s room-size check before the save (a shared item the room would refuse)', async () => {
    sync.isTrackerSyncConfigured.mockReturnValue(true);
    const s = service();
    await s.writer.setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'paused' });
    expect(sync.isTrackerSyncConfigured).toHaveBeenCalledWith(WS);
    expect(engine.encodeTrackerPayloadPlaintext).toHaveBeenCalledTimes(1);
    expect(s.saved).toEqual(['tfr_1']);
    // the room refuses it: nothing is saved, nothing is synced
    const { TrackerPayloadTooLargeError } = await import('@nimbalyst/tracker-engine');
    engine.encodeTrackerPayloadPlaintext.mockImplementation(() => { throw new (TrackerPayloadTooLargeError as unknown as new (message: string) => Error)('too large'); });
    sync.syncTrackerItem.mockClear();
    await expect(s.writer.setFrontStatus({ workspacePath: WS, frontId: 'tfr_2', status: 'paused' })).rejects.toThrow('too large');
    expect(s.saved).toEqual(['tfr_1']);
    expect(sync.syncTrackerItem).not.toHaveBeenCalled();
  });

  it('reports a sync failure without throwing and without a second write', async () => {
    sync.syncTrackerItem.mockRejectedValue(new Error('room unreachable'));
    const s = service();
    const out = await s.writer.setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'closed' });
    expect(out.syncWarning).toMatch(/room unreachable/);
    expect(sync.syncTrackerItem).toHaveBeenCalledTimes(1);
  });
});

describe('the executor reports a sync failure per item and never retries', () => {
  it('marks the item written with its warning, in the result and the notice, and the write count stays one', async () => {
    const registry = new TeamFrontProposalRegistry();
    const proposal = registry.register({ rootSessionId: 'root', workspacePath: WS, items: [{ action: 'create', title: 'Billing', description: 'd', status: 'active' }] });
    sync.syncTrackerItem.mockRejectedValue(new Error('room unreachable'));
    const s = service();
    const delivered: string[] = [];
    const deps: TeamFrontDecisionDeps = {
      registry,
      ports: { listFronts: async () => [], getFront: async () => null, findActiveMissionRoot: async () => null },
      writer: s.writer,
      readRoot: async () => ({ metadata: { teamMode: true }, agentRole: 'standard', workspacePath: WS, isArchived: false }),
      withFrontLock,
      withCreateLock: withTeamFrontCreateLock,
      deliver: async ({ notice }) => { delivered.push(notice); return { card: true, notice: true }; },
    };
    const response = await decideTeamFrontProposal(deps, WS, { proposalId: proposal.id, items: [{ index: 0, decision: 'approve' }] });
    expect(response).toMatchObject({ ok: true, results: [{ result: 'written', syncWarning: expect.stringContaining('room unreachable') }] });
    expect(delivered[0]).toMatch(/team sharing did not complete \(the item is saved, nothing was retried\)/);
    expect(s.created).toHaveLength(1);
    expect(sync.syncTrackerItem).toHaveBeenCalledTimes(1);
    // a second submit repeats nothing
    expect(await decideTeamFrontProposal(deps, WS, { proposalId: proposal.id, items: [{ index: 0, decision: 'approve' }] })).toMatchObject({ ok: false, code: 'expired' });
    expect(s.created).toHaveLength(1);
  });
});

function lendingWriter(temporary: boolean) {
  const svc = service().svc;
  return buildTeamFrontWriter(async (_w, fn) => fn(svc, { temporary }));
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };

describe('a front written through a temporary service reaches the open Tracker list (fallback path)', () => {
  beforeEach(() => {
    windows.send.mockReset();
    windows.found = true;
    windows.destroyed = false;
    analytics.trackTrackerMutation.mockReset();
  });

  it('a create tells the project window with the change shape the Tracker listens for', async () => {
    const out = await lendingWriter(true).createFront({ workspacePath: WS, title: 'Billing', description: 'State', status: 'active' });
    expect(windows.send).toHaveBeenCalledTimes(1);
    const [channel, change] = windows.send.mock.calls[0];
    expect(channel).toBe('document-service:tracker-items-changed');
    expect(change).toMatchObject({ added: [expect.objectContaining({ id: out.id, type: 'team-front' })], updated: [], removed: [] });
    expect(change.timestamp).toBeInstanceOf(Date);
  });

  it('a status change tells it as an update', async () => {
    await lendingWriter(true).setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'paused' });
    expect(windows.send).toHaveBeenCalledTimes(1);
    expect(windows.send.mock.calls[0][1]).toMatchObject({ added: [], updated: [expect.objectContaining({ id: 'tfr_1' })], removed: [] });
  });

  it('the open window\'s own service already notifies its window: nothing extra is sent', async () => {
    await lendingWriter(false).createFront({ workspacePath: WS, title: 'Billing', description: 'State', status: 'active' });
    await lendingWriter(false).setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'paused' });
    expect(windows.send).not.toHaveBeenCalled();
  });

  it('no window, or a destroyed one, is fine: the write still succeeds', async () => {
    windows.found = false;
    expect(await lendingWriter(true).createFront({ workspacePath: WS, title: 'A', description: 'd', status: 'active' })).toMatchObject({ id: expect.stringMatching(/^tfr_/) });
    windows.found = true;
    windows.destroyed = true;
    await lendingWriter(true).setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'paused' });
    expect(windows.send).not.toHaveBeenCalled();
  });

  it('a failing notification never fails or repeats the write', async () => {
    windows.send.mockImplementation(() => { throw new Error('window gone'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = service();
    const writer = buildTeamFrontWriter(async (_w, fn) => fn(s.svc, { temporary: true }));
    const out = await writer.createFront({ workspacePath: WS, title: 'A', description: 'd', status: 'active' });
    expect(out.id).toMatch(/^tfr_/);
    expect(out.syncWarning).toBeUndefined();
    expect(s.created).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('analytics parity with the Tracker UI (no new event names)', () => {
  beforeEach(() => analytics.trackTrackerMutation.mockReset());

  it('a create is recorded as created, shared, view service; a status change as status_changed', async () => {
    const writer = lendingWriter(false);
    const out = await writer.createFront({ workspacePath: WS, title: 'Billing', description: 'State', status: 'active' });
    await writer.setFrontStatus({ workspacePath: WS, frontId: 'tfr_1', status: 'closed' });
    await settle();
    expect(analytics.trackTrackerMutation).toHaveBeenCalledTimes(2);
    expect(analytics.trackTrackerMutation).toHaveBeenNthCalledWith(1, { itemId: out.id, action: 'created', collaborationScope: 'shared', trackerType: 'team-front', view: 'service' });
    expect(analytics.trackTrackerMutation).toHaveBeenNthCalledWith(2, { itemId: 'tfr_1', action: 'status_changed', collaborationScope: 'shared', trackerType: 'team-front', view: 'service' });
  });

  it('a failing analytics call never fails the write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = service();
    const steps = {
      beforeWrite: async () => () => undefined,
      syncCreated: async () => ({ shared: true }),
      syncUpdated: async () => ({ shared: true }),
      track: () => { throw new Error('analytics down'); },
    };
    const writer = buildTeamFrontWriter(async (_w, fn) => fn(s.svc, { temporary: false }), steps);
    expect(await writer.createFront({ workspacePath: WS, title: 'A', description: 'd', status: 'active' })).toMatchObject({ id: expect.stringMatching(/^tfr_/) });
    expect(s.created).toHaveLength(1);
    warn.mockRestore();
  });
});
