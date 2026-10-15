// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
import { buildToolManifestTrackerPort, toStoredToolManifest, trackerItemReference } from '../toolManifestTrackerPort';

const item = (overrides: Partial<TrackerItem> & { customFields?: Record<string, unknown> }): TrackerItem => ({
  id: 'tool-manifest_1', type: 'tool-manifest', title: 'M-1: x', status: 'draft', localKey: 'NIB.30',
  customFields: { manifestId: 'M-1', teamRootSessionId: 'root-1', architectSessionId: 'arch-1', contentHash: 'h1' },
  ...overrides,
} as TrackerItem);

function fakeDocService(items: TrackerItem[]) {
  return {
    listTrackerItems: vi.fn(async () => items),
    createHostOwnedTrackerItem: vi.fn(async (payload: any) => ({ ...item({ id: payload.id, title: payload.title, status: payload.status, customFields: payload.customFields }), localKey: 'NIB.40' })),
    updateTrackerItem: vi.fn(async (id: string, updates: Record<string, unknown>) => item({ id, status: String(updates.status) })),
  };
}

describe('the tracker port', () => {
  it('lists this team\'s manifests, archived ones included, mapped to what the rule needs', async () => {
    const docService = fakeDocService([
      item({}),
      item({ id: 'tool-manifest_2', customFields: { manifestId: 'M-1', teamRootSessionId: 'root-2', architectSessionId: 'arch-2', contentHash: 'h2' } }),
      item({ id: 'tool-manifest_3', archived: true }),
      item({ id: 'task_1', type: 'task', customFields: { teamRootSessionId: 'root-1' } }),
      item({ id: 'tool-manifest_4', status: 'superseded', localKey: undefined, customFields: { manifestId: 'M-0', teamRootSessionId: 'root-1', architectSessionId: 'arch-0', declaredManifestId: 'M-1' } }),
    ]);
    const port = buildToolManifestTrackerPort(docService, '/ws');
    // The reference is the item id: these items have a local number but no issue key.
    expect(await port.listTeamManifests('root-1')).toEqual([
      { itemId: 'tool-manifest_1', ref: 'tool-manifest_1', manifestId: 'M-1', status: 'draft', architectSessionId: 'arch-1', declaredManifestId: null, contentHash: 'h1', archived: false },
      { itemId: 'tool-manifest_3', ref: 'tool-manifest_3', manifestId: 'M-1', status: 'draft', architectSessionId: 'arch-1', declaredManifestId: null, contentHash: 'h1', archived: true },
      { itemId: 'tool-manifest_4', ref: 'tool-manifest_4', manifestId: 'M-0', status: 'superseded', architectSessionId: 'arch-0', declaredManifestId: 'M-1', contentHash: null, archived: false },
    ]);
    expect(await port.listTeamManifests('root-3')).toEqual([]);
    // Either storage shape reads the same.
    expect(toStoredToolManifest(item({ customFields: undefined, manifestId: 'M-5', teamRootSessionId: 'root-1' } as any)).manifestId).toBe('M-5');
  });

  it('creates through the host-owned path with the manifest type, a draft status and the given provenance', async () => {
    const docService = fakeDocService([]);
    const port = buildToolManifestTrackerPort(docService, '/ws');
    const created = await port.create({ title: 'M-1: x', description: 'body', status: 'draft', customFields: { manifestId: 'M-1', teamRootSessionId: 'root-1' } });
    // The item came back numbered NIB.40 but without an issue key: the reference is its id.
    expect(created).toEqual({ itemId: expect.stringMatching(/^tool-manifest_\d+_[a-z0-9]+$/), ref: created.itemId });
    expect(created.ref).not.toBe('NIB.40');
    const payload = docService.createHostOwnedTrackerItem.mock.calls[0][0];
    expect(payload).toMatchObject({ type: 'tool-manifest', title: 'M-1: x', status: 'draft', workspace: '/ws', description: 'body', customFields: { manifestId: 'M-1', teamRootSessionId: 'root-1' } });
    expect(payload.source).toBeUndefined();
  });

  it('supersedes through the ordinary update funnel (status only)', async () => {
    const docService = fakeDocService([]);
    const port = buildToolManifestTrackerPort(docService, '/ws');
    await port.setStatus('tool-manifest_1', 'superseded');
    expect(docService.updateTrackerItem).toHaveBeenCalledWith('tool-manifest_1', { status: 'superseded' });
  });

  it('a created item that comes back with a published issue key is referenced by that key', async () => {
    const docService = fakeDocService([]);
    docService.createHostOwnedTrackerItem.mockImplementationOnce(async (payload: any) => ({ ...item({ id: payload.id }), issueKey: 'NIM-123', localKey: 'NIB.40' }));
    const created = await buildToolManifestTrackerPort(docService, '/ws').create({ title: 'M-1: x', description: 'body', status: 'draft', customFields: {} });
    expect(created.ref).toBe('NIM-123');
  });
});

describe('the reference the host hands the coordinator (pilot G: "WOK.1" was not found)', () => {
  it('A: a published issue key is preferred', () => {
    expect(trackerItemReference({ id: 'tool-manifest_1', issueKey: 'NIM-123', localKey: 'WOK.1' } as never)).toBe('NIM-123');
    expect(trackerItemReference({ id: 'tool-manifest_1', issueKey: '  NIM-7 ' })).toBe('NIM-7');
  });

  it('B/C: without an issue key (null, empty, or only a local number) it is the real id, never the local number', () => {
    expect(trackerItemReference({ id: 'tool-manifest_1792006788175_mitmzg', issueKey: undefined, localKey: 'WOK.1' } as never)).toBe('tool-manifest_1792006788175_mitmzg');
    expect(trackerItemReference({ id: 'tool-manifest_1', issueKey: null })).toBe('tool-manifest_1');
    expect(trackerItemReference({ id: 'tool-manifest_1', issueKey: '' })).toBe('tool-manifest_1');
    // A local number or a legacy provisional key in the key slot is not a reference either.
    expect(trackerItemReference({ id: 'tool-manifest_1', issueKey: 'WOK.1' })).toBe('tool-manifest_1');
    expect(trackerItemReference({ id: 'tool-manifest_1', issueKey: 'LC-4' })).toBe('tool-manifest_1');
  });

  it('D: an item with neither has no reference and none is invented (fail-closed)', () => {
    expect(() => trackerItemReference({ id: '', issueKey: null })).toThrow(/neither an issue key nor an id/);
    expect(() => trackerItemReference({ id: undefined, issueKey: undefined, localKey: 'WOK.1' } as never)).toThrow(/neither an issue key nor an id/);
  });

  it('D: a created item without a usable reference fails the creation result instead of naming a false one', async () => {
    const docService = fakeDocService([]);
    docService.createHostOwnedTrackerItem.mockImplementationOnce(async () => ({ ...item({}), id: '', localKey: 'WOK.1' }));
    await expect(buildToolManifestTrackerPort(docService, '/ws').create({ title: 'M-1: x', description: 'body', status: 'draft', customFields: {} }))
      .rejects.toThrow(/neither an issue key nor an id/);
  });
});
