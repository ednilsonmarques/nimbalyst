import { beforeAll, describe, expect, it } from 'vitest';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import type { TrackerDataModel } from '@nimbalyst/tracker-schema';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { propagateInverseRelationships } from '../inverseRelationshipWrites';

/**
 * F1 S2: the relationship fields a team-note gains (front, pendings,
 * relatedNotes) declare no inverse, so setting them never writes onto the item
 * they point to: not onto the team-front, not onto another note. A write onto a
 * note through the inverse path would go through updateTrackerItem and be
 * judged by the protected rule as a user edit; nothing reaches it at all.
 */
function deps(items: Array<{ id: string; type: string; data: Record<string, unknown> }>) {
  const writes: Array<{ itemId: string; fieldName: string; value: unknown }> = [];
  const loaded: string[] = [];
  const byId = new Map(items.map((item) => [item.id, item]));
  return {
    writes,
    loaded,
    deps: {
      loadItem: async (id: string) => {
        loaded.push(id);
        return byId.get(id) ?? null;
      },
      applyTargetUpdate: async (itemId: string, fieldName: string, value: unknown) => {
        writes.push({ itemId, fieldName, value });
      },
    },
  };
}

const SOURCE = { id: 'team-note_a', type: 'team-note', title: 'A handoff' };
const TARGETS = [
  { id: 'team-front_1', type: 'team-front', data: { title: 'Team Mode', status: 'active', description: 'Estado.' } },
  { id: 'team-note_b', type: 'team-note', data: { title: 'B', noteKind: 'pending', status: 'active' } },
  { id: 'team-note_c', type: 'team-note', data: { title: 'C', noteKind: 'decision', status: 'active' } },
];

describe('a team-note never writes onto the items it points to', () => {
  beforeAll(() => {
    loadBuiltinTrackers();
  });

  it('no relationship field of a team-note declares an inverse', () => {
    const fields = (globalRegistry.get('team-note') as TrackerDataModel).fields.filter((f) => f.type === 'relationship');
    expect(fields.map((f) => f.name).sort()).toEqual(['front', 'pendings', 'relatedNotes', 'supersedes']);
    for (const field of fields) expect((field as any).inverseFieldId, field.name).toBeUndefined();
  });

  it('front, pendings, relatedNotes and supersedes changes propagate nothing: no target is even loaded', async () => {
    const { writes, loaded, deps: d } = deps(TARGETS);
    const result = await propagateInverseRelationships(
      SOURCE,
      {
        front: { itemId: 'team-front_1' },
        pendings: [{ itemId: 'team-note_b' }],
        relatedNotes: [{ itemId: 'team-note_c' }],
        supersedes: [{ itemId: 'team-note_c' }],
      },
      {},
      d,
    );
    expect(result).toEqual({ targetsUpdated: 0 });
    expect(writes).toEqual([]);
    expect(loaded).toEqual([]);
  });

  it('and dropping the links later writes nothing either', async () => {
    const { writes, deps: d } = deps(TARGETS);
    await propagateInverseRelationships(
      SOURCE,
      { front: null, pendings: [], relatedNotes: [] },
      { front: { itemId: 'team-front_1' }, pendings: [{ itemId: 'team-note_b' }], relatedNotes: [{ itemId: 'team-note_c' }] },
      d,
    );
    expect(writes).toEqual([]);
  });

  it('control: the same test does catch a relationship that declares an inverse', async () => {
    const note = globalRegistry.get('team-note') as TrackerDataModel;
    const withInverse: TrackerDataModel = {
      ...note,
      type: 'team-note-with-inverse',
      fields: [
        ...note.fields.filter((f) => f.name !== 'pendings'),
        { name: 'pendings', type: 'relationship', multiValue: true, targetTrackerTypes: ['team-note'], inverseFieldId: 'supersedes' } as any,
      ],
    };
    globalRegistry.register(withInverse);
    const { writes, deps: d } = deps(TARGETS);
    const result = await propagateInverseRelationships(
      { id: 'x_1', type: 'team-note-with-inverse', title: 'X' },
      { pendings: [{ itemId: 'team-note_b' }] },
      {},
      d,
    );
    expect(result.targetsUpdated).toBe(1);
    expect(writes).toHaveLength(1);
  });
});
