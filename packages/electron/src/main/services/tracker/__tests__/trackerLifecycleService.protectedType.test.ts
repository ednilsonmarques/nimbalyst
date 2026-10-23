// @vitest-environment node
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NIB.130: the Trackers settings archive and promote actions reach the schema
// writer through tracker_define_type's patch path, so they inherit its guard.
// The real handler runs here over a mocked schema service.
const { mockUpsertPatch, mockSafeHandle } = vi.hoisted(() => ({
  mockUpsertPatch: vi.fn(),
  mockSafeHandle: vi.fn(),
}));

vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: mockSafeHandle, safeOn: vi.fn(), safeOnce: vi.fn() }));
vi.mock('../../TrackerSchemaService', () => ({
  ensureWorkspaceTrackerSchemasLoaded: vi.fn(),
  upsertWorkspaceTrackerSchema: vi.fn(),
  upsertWorkspaceTrackerSchemaPatch: mockUpsertPatch,
  resetWorkspaceTrackerSchemaOverride: vi.fn(),
  previewWorkspaceTrackerSchemaChange: vi.fn(),
  deleteWorkspaceTrackerSchema: vi.fn(),
  getTrackerSchemaOwnershipDetails: vi.fn(async () => new Map()),
  writeThroughTeamTrackerSchemaEdit: vi.fn(async () => undefined),
  getAllTrackerSchemas: vi.fn(() => []),
  isBuiltinTrackerSchema: vi.fn(() => true),
  TrackerTypeExistsError: class extends Error {},
}));
// The lifecycle service imports the handler through the tracker tools barrel;
// hand it the real schema handler without loading the rest of the barrel.
vi.mock('../../../mcp/tools/trackerToolHandlers', async () => {
  const real = await import('../../../mcp/tools/trackerSchemaToolHandlers');
  return { handleTrackerDefineType: real.handleTrackerDefineType };
});
vi.mock('../trackerTypeDefStore', () => ({
  appendTrackerSchemaActivity: vi.fn(async (_ws: string, model: any) => model),
  materializeTrackerTypeDef: vi.fn(async () => undefined),
  removeTrackerTypeDef: vi.fn(),
}));
vi.mock('../../TrackerIdentityService', () => ({ getCurrentIdentity: vi.fn(() => ({ displayName: 'Test User' })) }));
vi.mock('../../TrackerNavigationService', () => ({ applyTrackerSharingChangeToNavigation: vi.fn() }));
vi.mock('../../TrackerSyncManager', () => ({ isTrackerSyncActive: vi.fn(() => false), syncTrackerItem: vi.fn() }));
vi.mock('../awaitServerIssueKey', () => ({ awaitServerIssueKey: vi.fn(async () => null) }));
vi.mock('../../../mcp/tools/trackerToolItemAccess', () => ({ getDocumentServiceForWorkspace: vi.fn(async () => ({ docService: null })) }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    isPackaged: false,
    getName: vi.fn(() => 'Nimbalyst'),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { promoteTrackerToTeam, setTrackerArchived } from '../trackerLifecycleService';

const ws = '/tmp/ws-lifecycle-protected';

beforeAll(() => {
  loadBuiltinTrackers();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertPatch.mockImplementation(async (_ws: string, patch: any) => ({
    model: { type: patch.type, sharing: 'personal', fields: [] },
    filePath: `${ws}/.nimbalyst/trackers/${patch.type}.patch.yaml`,
  }));
});

describe('the Trackers settings lifecycle actions on a protected type (NIB.130)', () => {
  for (const type of ['team-note', 'tool-manifest', 'team-front']) {
    it(`archiving ${type} is refused with the protected-type error and writes no patch`, async () => {
      await expect(setTrackerArchived(ws, type, true)).rejects.toThrow(`'${type}' is protected`);
      expect(mockUpsertPatch).not.toHaveBeenCalled();
    });

    it(`promoting ${type} writes no patch either`, async () => {
      await expect(promoteTrackerToTeam(ws, type)).rejects.toThrow();
      expect(mockUpsertPatch).not.toHaveBeenCalled();
    });
  }

  it('archiving a non-protected builtin still goes through the patch path', async () => {
    await setTrackerArchived(ws, 'bug', true);
    expect(mockUpsertPatch).toHaveBeenCalledWith(ws, expect.objectContaining({ type: 'bug', archived: true }), expect.any(Object));
  });
});
