// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  TOOL_MANIFEST_BODY_ERROR,
  TOOL_MANIFEST_HAND_CREATE_ERROR,
  TOOL_MANIFEST_IMMUTABLE_FIELDS,
  assertToolManifestBody,
  assertToolManifestUpdate,
  prepareHostToolManifestCreate,
  prepareManualToolManifestCreate,
  readToolManifestField,
  toolManifestStatusTransitionError,
  validateToolManifestData,
} from '../toolManifestRules';

/** A manifest as the host stores it (services/team/toolManifests.ts). */
const stored = {
  title: 'M-1: Make formatGreeting reject blank names',
  description: '```yaml\ntoolManifest: 1\nid: M-1\n```\nPreparation: complete',
  status: 'draft',
  manifestId: 'M-1',
  manifestVersion: '1',
  teamRootSessionId: 'root-1',
  architectSessionId: 'arch-1',
  generatedByRole: 'architect',
  model: 'claude-code:opus',
  confidence: 'high',
  contentHash: '0123456789abcdef',
};

describe('creation', () => {
  it('by hand, by the UI or through tracker_create is refused before any write', () => {
    expect(() => prepareManualToolManifestCreate('tool-manifest', { ...stored })).toThrow(TOOL_MANIFEST_HAND_CREATE_ERROR);
    expect(validateToolManifestData(stored, { mode: 'create' })).toEqual([TOOL_MANIFEST_HAND_CREATE_ERROR]);
    // Other types are untouched.
    expect(() => prepareManualToolManifestCreate('task', { title: 'x' })).not.toThrow();
    expect(() => prepareManualToolManifestCreate('team-note', { title: 'x' })).not.toThrow();
  });

  it('by the host needs the provenance, defaults the status to draft and marks the agent origin', () => {
    const data: Record<string, unknown> = { ...stored };
    delete data.status;
    prepareHostToolManifestCreate('tool-manifest', data);
    expect(data.status).toBe('draft');
    expect(data.createdByAgent).toBe(true);
    expect(() => prepareHostToolManifestCreate('tool-manifest', { ...stored, manifestId: 'manifest-1' })).toThrow(/manifestId must be M-<n>/);
    expect(() => prepareHostToolManifestCreate('tool-manifest', { ...stored, teamRootSessionId: '' })).toThrow(/teamRootSessionId must name the session/);
    expect(() => prepareHostToolManifestCreate('tool-manifest', { ...stored, architectSessionId: undefined })).toThrow(/architectSessionId must name the session/);
    expect(() => prepareHostToolManifestCreate('tool-manifest', { ...stored, generatedByRole: 'coordinator' })).toThrow(/generatedByRole must be architect/);
    expect(() => prepareHostToolManifestCreate('tool-manifest', { ...stored, status: 'done' })).toThrow(/status must be one of/);
    expect(() => prepareHostToolManifestCreate('task', { title: 'x' })).not.toThrow();
  });
});

describe('lifecycle', () => {
  it('draft -> accepted -> superseded; nothing returns to draft and superseded stays', () => {
    expect(toolManifestStatusTransitionError('draft', 'accepted')).toBeNull();
    expect(toolManifestStatusTransitionError('draft', 'superseded')).toBeNull();
    expect(toolManifestStatusTransitionError('accepted', 'superseded')).toBeNull();
    expect(toolManifestStatusTransitionError('accepted', 'accepted')).toBeNull();
    expect(toolManifestStatusTransitionError(undefined, 'draft')).toBeNull();
    expect(toolManifestStatusTransitionError('accepted', 'draft')).toMatch(/never returns to draft/);
    expect(toolManifestStatusTransitionError('superseded', 'accepted')).toMatch(/stays superseded/);
    expect(toolManifestStatusTransitionError('superseded', 'draft')).toMatch(/stays superseded/);
    expect(toolManifestStatusTransitionError('draft', 'done')).toMatch(/must be one of: draft, accepted, superseded/);
  });

  it('an update may change the status and nothing else', () => {
    expect(() => assertToolManifestUpdate('tool-manifest', { status: 'accepted' }, stored, { ...stored, status: 'accepted' })).not.toThrow();
    expect(() => assertToolManifestUpdate('tool-manifest', { status: 'superseded' }, { ...stored, status: 'accepted' }, { ...stored, status: 'superseded' })).not.toThrow();
    for (const field of TOOL_MANIFEST_IMMUTABLE_FIELDS) {
      if (field === 'description') continue;
      expect(
        () => assertToolManifestUpdate('tool-manifest', { [field]: 'x' }, stored, { ...stored, [field]: 'x' }),
        field,
      ).toThrow(new RegExp(`${field} is set by Nimbalyst`));
    }
    expect(() => assertToolManifestUpdate('tool-manifest', { description: 'edited' }, stored, { ...stored, description: 'edited' })).toThrow(TOOL_MANIFEST_BODY_ERROR);
    expect(() => assertToolManifestUpdate('tool-manifest', { supersedes: ['other'] }, stored, { ...stored, supersedes: ['other'] })).toThrow(/supersedes is set by Nimbalyst/);
    // Bookkeeping fields the tracker adds on every update are not immutable.
    expect(() => assertToolManifestUpdate('tool-manifest', { status: 'accepted' }, stored, { ...stored, status: 'accepted', lastModifiedBy: 'u', updated: '2026-10-13' })).not.toThrow();
  });

  it('reads either storage shape (top level or the synced customFields bag)', () => {
    expect(readToolManifestField({ customFields: { manifestId: 'M-2' } }, 'manifestId')).toBe('M-2');
    expect(readToolManifestField({ manifestId: 'M-3' }, 'manifestId')).toBe('M-3');
    expect(readToolManifestField({ customFields: { manifestId: undefined }, manifestId: 'M-4' }, 'manifestId')).toBe('M-4');
    expect(() => assertToolManifestUpdate('tool-manifest', { status: 'accepted' }, { title: stored.title, status: 'draft', customFields: { ...stored } }, { ...stored, status: 'accepted' })).not.toThrow();
  });

  it('type changes are refused both ways, other types pass, and the rich body is never written', () => {
    expect(() => assertToolManifestUpdate('tool-manifest', { type: 'task' }, stored, stored)).toThrow(/cannot change type/);
    expect(() => assertToolManifestUpdate('task', { typeTags: ['task', 'tool-manifest'] }, { title: 'x' }, { title: 'x' })).toThrow(/cannot be turned into a tool-manifest/);
    expect(() => assertToolManifestUpdate('task', { status: 'done' }, { status: 'to-do' }, { status: 'done' })).not.toThrow();
    expect(() => assertToolManifestBody('tool-manifest')).toThrow(TOOL_MANIFEST_BODY_ERROR);
    expect(() => assertToolManifestBody('team-note')).not.toThrow();
  });
});
