// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { globalRegistry, isTerminalStatus, statusCategoryOfItem } from '@nimbalyst/tracker-schema';
import { loadBuiltinTrackers } from '../ModelLoader';
import { toolScopeDeniedTools } from '../../../../ai/server/providers/claudeCode/toolPolicy';

beforeAll(() => {
  loadBuiltinTrackers();
});

describe('team-note tracker type', () => {
  it('is registered as a team-shared type with the six kinds', () => {
    const model = globalRegistry.get('team-note')!;
    expect(model.sharing).toBe('team');
    const kinds = model.fields.find((f) => f.name === 'noteKind')!;
    expect(kinds.required).toBe(true);
    expect(kinds.options?.map((o: any) => o.value)).toEqual(['decision', 'discovery', 'risk', 'pending', 'test', 'context']);
  });

  it('active is open; resolved and obsolete are closed, so the default listing hides them', () => {
    const category = (status: string) => statusCategoryOfItem('team-note', (name) => (name === 'status' ? status : undefined));
    expect(category('active')).toBe('started');
    expect(category('resolved')).toBe('done');
    expect(category('obsolete')).toBe('cancelled');
    expect(isTerminalStatus('team-note', 'active')).toBe(false);
    expect(isTerminalStatus('team-note', 'resolved')).toBe(true);
    expect(isTerminalStatus('team-note', 'obsolete')).toBe(true);
  });

  it('declares host-owned provenance fields as read-only and supersedes as a note relation', () => {
    const model = globalRegistry.get('team-note')!;
    for (const name of ['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree']) {
      expect(model.fields.find((f) => f.name === name)?.readOnly, name).toBe(true);
    }
    const supersedes = model.fields.find((f) => f.name === 'supersedes') as any;
    expect(supersedes.relationshipTypeKey).toBe('supersedes');
    expect(supersedes.targetTrackerTypes).toEqual(['team-note']);
  });
});

describe('read-only members and team notes', () => {
  it('read scope cannot write notes but can still list and read them', () => {
    const denied = toolScopeDeniedTools('read');
    expect(denied).toContain('mcp__nimbalyst-trackers__tracker_create');
    expect(denied).toContain('mcp__nimbalyst-trackers__tracker_update');
    expect(denied).not.toContain('mcp__nimbalyst-trackers__tracker_list');
    expect(denied).not.toContain('mcp__nimbalyst-trackers__tracker_get');
  });
});
