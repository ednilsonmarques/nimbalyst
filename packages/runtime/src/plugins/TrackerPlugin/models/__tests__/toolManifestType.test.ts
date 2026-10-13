// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { globalRegistry, isTerminalStatus, statusCategoryOfItem } from '@nimbalyst/tracker-schema';
import { loadBuiltinTrackers } from '../ModelLoader';
import { toolScopeDeniedTools } from '../../../../ai/server/providers/claudeCode/toolPolicy';
import { TOOL_MANIFEST_PROVENANCE_FIELDS, TOOL_MANIFEST_STATUSES } from '../toolManifestRules';

beforeAll(() => {
  loadBuiltinTrackers();
});

describe('tool-manifest tracker type', () => {
  it('is registered as a team-shared type nobody creates by hand, with the draft/accepted/superseded lifecycle', () => {
    const model = globalRegistry.get('tool-manifest')!;
    expect(model).toBeDefined();
    expect(model.sharing).toBe('team');
    // Nobody creates one by hand (the pickers hide it); the host's own write path ignores the flag.
    expect(model.creatable).toBe(false);
    const status = model.fields.find((f) => f.name === 'status')!;
    expect(status.options?.map((o: any) => o.value)).toEqual([...TOOL_MANIFEST_STATUSES]);
    expect((status as any).default).toBe('draft');
  });

  it('draft and accepted are open (the current manifest stays listed by default); superseded is closed', () => {
    const category = (status: string) => statusCategoryOfItem('tool-manifest', (name) => (name === 'status' ? status : undefined));
    expect(category('draft')).toBe('started');
    expect(category('accepted')).toBe('started');
    expect(category('superseded')).toBe('cancelled');
    expect(isTerminalStatus('tool-manifest', 'draft')).toBe(false);
    expect(isTerminalStatus('tool-manifest', 'accepted')).toBe(false);
    expect(isTerminalStatus('tool-manifest', 'superseded')).toBe(true);
  });

  it('declares the host-owned provenance as read-only and supersedes as a manifest-to-manifest relation', () => {
    const model = globalRegistry.get('tool-manifest')!;
    for (const name of TOOL_MANIFEST_PROVENANCE_FIELDS) {
      expect(model.fields.find((f) => f.name === name)?.readOnly, name).toBe(true);
    }
    const supersedes = model.fields.find((f) => f.name === 'supersedes') as any;
    expect(supersedes.type).toBe('relationship');
    expect(supersedes.relationshipTypeKey).toBe('supersedes');
    expect(supersedes.targetTrackerTypes).toEqual(['tool-manifest']);
  });
});

describe('members and manifests', () => {
  it('read and review scopes can list and read manifests but never write them', () => {
    for (const scope of ['read', 'review'] as const) {
      const denied = toolScopeDeniedTools(scope);
      expect(denied).toContain('mcp__nimbalyst-trackers__tracker_create');
      expect(denied).toContain('mcp__nimbalyst-trackers__tracker_update');
      expect(denied).not.toContain('mcp__nimbalyst-trackers__tracker_get');
      expect(denied).not.toContain('mcp__nimbalyst-trackers__tracker_list');
    }
  });
});
