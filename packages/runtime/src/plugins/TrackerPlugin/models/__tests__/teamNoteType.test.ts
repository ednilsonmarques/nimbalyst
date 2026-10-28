// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { globalRegistry, isTerminalStatus, statusCategoryOfItem } from '@nimbalyst/tracker-schema';
import {
  TEAM_NOTE_HANDOFF_ONLY_FIELDS,
  TEAM_NOTE_HANDOFF_RESULTS,
  TEAM_NOTE_KINDS,
  TEAM_NOTE_PROVENANCE_FIELDS,
} from '@nimbalyst/tracker-core';
import { loadBuiltinTrackers } from '../ModelLoader';
import { toolScopeDeniedTools } from '../../../../ai/server/providers/claudeCode/toolPolicy';

beforeAll(() => {
  loadBuiltinTrackers();
});

describe('team-note tracker type', () => {
  it('is registered as a team-shared type with the seven kinds', () => {
    const model = globalRegistry.get('team-note')!;
    expect(model.sharing).toBe('team');
    const kinds = model.fields.find((f) => f.name === 'noteKind')!;
    expect(kinds.required).toBe(true);
    expect(kinds.options?.map((o: any) => o.value)).toEqual(['decision', 'discovery', 'risk', 'pending', 'test', 'context', 'handoff']);
    // The yaml and the shared rule list the same kinds, in the same order.
    expect(kinds.options?.map((o: any) => o.value)).toEqual([...TEAM_NOTE_KINDS]);
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
    for (const name of ['sourceSession', 'teamRootSession', 'agentRole', 'branch', 'worktree', 'front']) {
      expect(model.fields.find((f) => f.name === name)?.readOnly, name).toBe(true);
    }
    // Every provenance field of the shared rule is declared read-only in the yaml.
    for (const name of TEAM_NOTE_PROVENANCE_FIELDS) {
      expect(model.fields.find((f) => f.name === name)?.readOnly, name).toBe(true);
    }
    const supersedes = model.fields.find((f) => f.name === 'supersedes') as any;
    expect(supersedes.relationshipTypeKey).toBe('supersedes');
    expect(supersedes.targetTrackerTypes).toEqual(['team-note']);
  });
});

describe('team-note fields added for the team lifecycle (F1 S2)', () => {
  const field = (name: string) => globalRegistry.get('team-note')!.fields.find((f) => f.name === name) as any;

  it('front is a single relationship to a team-front, host-owned, with no inverse', () => {
    const front = field('front');
    expect(front.type).toBe('relationship');
    expect(front.targetTrackerTypes).toEqual(['team-front']);
    expect(front.multiValue).toBeFalsy();
    expect(front.readOnly).toBe(true);
    expect(front.inverseFieldId).toBeUndefined();
    expect(front.inverseRelationshipTypeKey).toBeUndefined();
  });

  it('nextAction is a text field', () => {
    expect(field('nextAction').type).toBe('text');
    expect(field('nextAction').readOnly).toBeFalsy();
  });

  it('result is a select with the three outcomes, in the order of the shared rule', () => {
    expect(field('result').type).toBe('select');
    expect(field('result').options.map((o: any) => o.value)).toEqual([...TEAM_NOTE_HANDOFF_RESULTS]);
  });

  it('commits is a list of strings; pendings and relatedNotes are multi-value relations to team notes', () => {
    expect(field('commits').type).toBe('array');
    expect(field('commits').itemType).toBe('string');
    for (const name of ['pendings', 'relatedNotes']) {
      expect(field(name).type, name).toBe('relationship');
      expect(field(name).multiValue, name).toBe(true);
      expect(field(name).targetTrackerTypes, name).toEqual(['team-note']);
    }
  });

  it('the handoff-only fields in the yaml are exactly the shared rule\'s list', () => {
    for (const name of TEAM_NOTE_HANDOFF_ONLY_FIELDS) expect(field(name), name).toBeDefined();
  });

  it('no relationship field of a team-note declares an inverse: none of them writes onto the target', () => {
    const relationships = globalRegistry.get('team-note')!.fields.filter((f) => f.type === 'relationship') as any[];
    expect(relationships.map((f) => f.name).sort()).toEqual(['front', 'pendings', 'relatedNotes', 'supersedes']);
    for (const f of relationships) {
      expect(f.inverseFieldId, f.name).toBeUndefined();
      expect(f.inverseRelationshipTypeKey, f.name).toBeUndefined();
    }
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
