// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NIB.130: tracker_define_type must refuse every patch or override of a
// protected type before anything is written, and keep serving every other
// type. The schema service is mocked so each test can prove "nothing reached
// it"; the service's own guard is covered in TrackerSchemaService.customTypes.test.ts.
const {
  mockUpsertWorkspaceTrackerSchema,
  mockUpsertWorkspaceTrackerSchemaPatch,
  mockWriteThroughTeamTrackerSchemaEdit,
  mockMaterializeTrackerTypeDef,
  mockAppendTrackerSchemaActivity,
  mockIsBuiltin,
  mockApplyPredicatesInProcess,
} = vi.hoisted(() => ({
  mockApplyPredicatesInProcess: vi.fn(),
  mockUpsertWorkspaceTrackerSchema: vi.fn(),
  mockUpsertWorkspaceTrackerSchemaPatch: vi.fn(),
  mockWriteThroughTeamTrackerSchemaEdit: vi.fn(async () => undefined),
  mockMaterializeTrackerTypeDef: vi.fn(async () => undefined),
  mockAppendTrackerSchemaActivity: vi.fn(async (_ws: string, model: any) => model),
  mockIsBuiltin: vi.fn((type: string) => ['task', 'bug', 'team-note', 'tool-manifest', 'team-front'].includes(type)),
}));

vi.mock('../../../services/TrackerSchemaService', () => {
  class MockTrackerTypeExistsError extends Error {
    readonly code = 'TRACKER_TYPE_EXISTS';
  }
  return {
    ensureWorkspaceTrackerSchemasLoaded: vi.fn(),
    upsertWorkspaceTrackerSchema: mockUpsertWorkspaceTrackerSchema,
    upsertWorkspaceTrackerSchemaPatch: mockUpsertWorkspaceTrackerSchemaPatch,
    resetWorkspaceTrackerSchemaOverride: vi.fn(),
    previewWorkspaceTrackerSchemaChange: vi.fn(),
    deleteWorkspaceTrackerSchema: vi.fn(),
    getTrackerSchemaOwnershipDetails: vi.fn(async () => new Map()),
    writeThroughTeamTrackerSchemaEdit: mockWriteThroughTeamTrackerSchemaEdit,
    getAllTrackerSchemas: vi.fn(() => []),
    isBuiltinTrackerSchema: mockIsBuiltin,
    applyWorkspacePredicateRegistryInProcess: mockApplyPredicatesInProcess,
    TrackerTypeExistsError: MockTrackerTypeExistsError,
  };
});
vi.mock('../../../services/tracker/trackerTypeDefStore', () => ({
  appendTrackerSchemaActivity: mockAppendTrackerSchemaActivity,
  materializeTrackerTypeDef: mockMaterializeTrackerTypeDef,
  removeTrackerTypeDef: vi.fn(),
}));
vi.mock('../../../services/TrackerIdentityService', () => ({ getCurrentIdentity: vi.fn(() => ({ displayName: 'Test User' })) }));
vi.mock('../../../services/TrackerNavigationService', () => ({ applyTrackerSharingChangeToNavigation: vi.fn() }));
vi.mock('../../../services/TrackerSyncManager', () => ({ isTrackerSyncActive: vi.fn(() => false), syncTrackerItem: vi.fn() }));
vi.mock('../../../services/tracker/awaitServerIssueKey', () => ({ awaitServerIssueKey: vi.fn(async () => null) }));
vi.mock('../trackerToolItemAccess', () => ({ getDocumentServiceForWorkspace: vi.fn(async () => ({ docService: null })) }));
vi.mock('../../../database/initialize', () => ({ getDatabase: () => null }));
vi.mock('electron', async () => ({
  app: {
    getPath: (await import('../../../../../test-stubs/privateUserData')).testApp.getPath,
    isPackaged: false,
    getName: vi.fn(() => 'Nimbalyst'),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PredicateDefinition } from '@nimbalyst/tracker-schema';
import { handleTrackerDefineType } from '../trackerSchemaToolHandlers';
import { readWorkspacePredicateRegistry } from '../../../services/tracker/trackerPredicateRegistryFile';

const verb = (id: string): PredicateDefinition => ({
  id, label: id, subjectKinds: ['*'], valueShape: 'entity', direction: 'directed',
});

const PROTECTED = ['team-note', 'tool-manifest', 'team-front'] as const;
const ws = '/tmp/ws';

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

function expectNothingWritten(): void {
  expect(mockUpsertWorkspaceTrackerSchemaPatch).not.toHaveBeenCalled();
  expect(mockUpsertWorkspaceTrackerSchema).not.toHaveBeenCalled();
  expect(mockWriteThroughTeamTrackerSchemaEdit).not.toHaveBeenCalled();
  expect(mockMaterializeTrackerTypeDef).not.toHaveBeenCalled();
  expect(mockAppendTrackerSchemaActivity).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUpsertWorkspaceTrackerSchemaPatch.mockImplementation(async (_ws: string, patch: any) => ({
    model: { type: patch.type, sharing: patch.sharing ?? 'personal', fields: [] },
    filePath: `/tmp/ws/.nimbalyst/trackers/${patch.type}.patch.yaml`,
  }));
  mockUpsertWorkspaceTrackerSchema.mockImplementation(async (_ws: string, schema: any) => ({
    model: { type: schema.type, sharing: schema.sharing ?? 'personal', fields: [] },
    filePath: `/tmp/ws/.nimbalyst/trackers/${schema.type}.yaml`,
  }));
});

describe('tracker_define_type on a protected type (NIB.130)', () => {
  const patches = (type: string): Array<[string, Record<string, unknown>]> => [
    ['a field', { type, fields: [{ name: 'extra', set: { type: 'string' } }] }],
    ['a status option', { type, fields: [{ name: 'status', options: { set: [{ value: 'sneaky', label: 'Sneaky' }] } }] }],
    ['removing a field', { type, fields: [{ name: 'title', remove: true }] }],
    ['the sharing', { type, sharing: 'personal' }],
    ['the model (roles)', { type, roles: { workflowStatus: 'priority' } }],
    ['creatable', { type, creatable: false }],
    ['archiving the type', { type, archived: true }],
    ['a cosmetic change (icon, color, labels)', { type, icon: 'bolt', color: '#000000', displayName: 'Renamed' }],
  ];

  for (const type of PROTECTED) {
    it(`refuses every patch of ${type}, with a clear error, before anything is written`, async () => {
      for (const [label, patch] of patches(type)) {
        const result = await handleTrackerDefineType({ patch }, ws);
        expect(result.isError, `${type}: ${label}`).toBe(true);
        expect(text(result), `${type}: ${label}`).toContain(`'${type}' is protected`);
        expect(text(result), `${type}: ${label}`).toMatch(/cannot be patched or overridden/);
      }
      expectNothingWritten();
    });

    it(`refuses a full schema and the flat arguments for ${type} too`, async () => {
      const full = await handleTrackerDefineType({ schema: { type, displayName: 'X', fields: [{ name: 'title', type: 'string' }] } }, ws);
      expect(full.isError).toBe(true);
      expect(text(full)).toContain(`'${type}' is protected`);
      const flat = await handleTrackerDefineType({ type, displayName: 'X', fields: [{ name: 'title', type: 'string' }] }, ws);
      expect(flat.isError).toBe(true);
      expect(text(flat)).toContain(`'${type}' is protected`);
      expectNothingWritten();
    });

    it(`refuses a patch of ${type} even with overwrite and confirmDestructive, and with promoteExistingItems`, async () => {
      const result = await handleTrackerDefineType(
        { patch: { type, sharing: 'team' }, overwrite: true, confirmDestructive: true, promoteExistingItems: true },
        ws,
      );
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(`'${type}' is protected`);
      expectNothingWritten();
    });
  }
});

describe('the protected-type refusal comes before ANY effect, the vocabulary included', () => {
  let workspacePath: string;
  beforeEach(() => { workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-protected-vocab-')); });
  afterEach(() => { fs.rmSync(workspacePath, { recursive: true, force: true }); });

  for (const type of PROTECTED) {
    it(`${type}: a patch with predicates fails and leaves the predicate registry unchanged`, async () => {
      // A verb already in the registry: neither added to nor removed from by the refused call.
      await handleTrackerDefineType({ predicates: [verb('made-by')] }, workspacePath);
      mockApplyPredicatesInProcess.mockClear();
      const before = readWorkspacePredicateRegistry(workspacePath);
      expect(before?.map((p) => p.id)).toEqual(['made-by']);

      const added = await handleTrackerDefineType({ patch: { type, icon: 'x' }, predicates: [verb('in-market')] }, workspacePath);
      expect(added.isError).toBe(true);
      expect(text(added)).toContain(`'${type}' is protected`);
      // No "Already applied before this error" note: nothing was applied.
      expect(text(added)).not.toContain('Already applied');

      const removed = await handleTrackerDefineType(
        { patch: { type, icon: 'x' }, removePredicates: ['made-by'], confirmDestructive: true },
        workspacePath,
      );
      expect(removed.isError).toBe(true);
      expect(text(removed)).not.toContain('Already applied');

      expect(readWorkspacePredicateRegistry(workspacePath)).toEqual(before);
      expect(mockApplyPredicatesInProcess).not.toHaveBeenCalled();
      expectNothingWritten();
    });
  }

  it('a full schema or flat arguments of a protected type with predicates fail the same way', async () => {
    for (const args of [
      { schema: { type: 'team-front', displayName: 'X', fields: [] }, predicates: [verb('in-market')] },
      { type: 'team-note', displayName: 'X', fields: [], predicates: [verb('in-market')] },
    ]) {
      const result = await handleTrackerDefineType(args, workspacePath);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('is protected');
    }
    expect(readWorkspacePredicateRegistry(workspacePath) ?? []).toEqual([]);
    expect(mockApplyPredicatesInProcess).not.toHaveBeenCalled();
  });

  it('a patch of a non-protected type with predicates still applies both', async () => {
    const result = await handleTrackerDefineType({ patch: { type: 'task', icon: 'x' }, predicates: [verb('in-market')] }, workspacePath);
    expect(result.isError, text(result)).toBe(false);
    expect(readWorkspacePredicateRegistry(workspacePath)?.map((p) => p.id)).toEqual(['in-market']);
    expect(mockUpsertWorkspaceTrackerSchemaPatch).toHaveBeenCalledTimes(1);
  });

  it('a vocabulary-only call is unchanged', async () => {
    const result = await handleTrackerDefineType({ predicates: [verb('made-by')] }, workspacePath);
    expect(result.isError, text(result)).toBe(false);
    expect(JSON.parse(text(result)).structured.action).toBe('defined-vocabulary');
  });
});

describe('tracker_define_type on every other type is unchanged', () => {
  it('a patch on a non-protected builtin (task, bug) is still accepted and written', async () => {
    for (const type of ['task', 'bug']) {
      mockUpsertWorkspaceTrackerSchemaPatch.mockClear();
      const patch = { type, fields: [{ name: 'status', options: { set: [{ value: 'archived', label: 'Archived' }] } }] };
      const result = await handleTrackerDefineType({ patch }, ws);
      expect(result.isError, text(result)).toBe(false);
      expect(JSON.parse(text(result)).structured).toMatchObject({ action: 'defined-type', type, mode: 'patch' });
      expect(mockUpsertWorkspaceTrackerSchemaPatch).toHaveBeenCalledWith(ws, patch, expect.any(Object));
    }
  });

  it('a patch on a custom type is accepted and written', async () => {
    const patch = { type: 'incident', icon: 'bolt' };
    const result = await handleTrackerDefineType({ patch }, ws);
    expect(result.isError, text(result)).toBe(false);
    expect(mockUpsertWorkspaceTrackerSchemaPatch).toHaveBeenCalledWith(ws, patch, expect.any(Object));
  });

  it('a full schema for a new custom type is accepted and written', async () => {
    const schema = { type: 'incident', displayName: 'Incident', displayNamePlural: 'Incidents', fields: [{ name: 'title', type: 'string' }] };
    const result = await handleTrackerDefineType({ schema }, ws);
    expect(result.isError, text(result)).toBe(false);
    expect(mockUpsertWorkspaceTrackerSchema).toHaveBeenCalledTimes(1);
  });

  it('a full schema for a non-protected builtin keeps its own refusal', async () => {
    const result = await handleTrackerDefineType({ schema: { type: 'task', displayName: 'T', fields: [] } }, ws);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Cannot replace built-in tracker type 'task'/);
    expect(mockUpsertWorkspaceTrackerSchema).not.toHaveBeenCalled();
  });

  it('a type that merely contains a protected name is not protected', async () => {
    const result = await handleTrackerDefineType({ patch: { type: 'team-note-archive', icon: 'bolt' } }, ws);
    expect(result.isError, text(result)).toBe(false);
  });
});
