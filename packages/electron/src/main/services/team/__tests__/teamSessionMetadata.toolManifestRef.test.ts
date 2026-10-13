import { describe, expect, it } from 'vitest';
import { TOOL_MANIFEST_REF_METADATA_KEY } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  preserveStoredTeamMetadata,
  sanitizeRendererCreateTeamMetadata,
  stripCreationOnlyTeamMetadata,
} from '../teamSessionMetadata';

const ref = { itemId: 'item-1', ref: 'NIB.31', manifestId: 'M-1', architectSessionId: 'arch-1', at: 'now' };

describe('metadata.toolManifestRef is host-only (Phase 1B)', () => {
  it('an ordinary metadata update cannot set or replace it', () => {
    expect(stripCreationOnlyTeamMetadata({ phase: 'implementing', [TOOL_MANIFEST_REF_METADATA_KEY]: ref })).toEqual({ phase: 'implementing' });
    expect(stripCreationOnlyTeamMetadata({ [TOOL_MANIFEST_REF_METADATA_KEY]: { manifestId: 'M-9' } })).toEqual({});
  });

  it('a renderer create never carries one', () => {
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, [TOOL_MANIFEST_REF_METADATA_KEY]: ref }, 'claude-code:opus')).toEqual({ teamMode: true });
    expect(sanitizeRendererCreateTeamMetadata({ phase: 'planning', [TOOL_MANIFEST_REF_METADATA_KEY]: ref }, 'claude-code:opus')).toEqual({ phase: 'planning' });
  });

  it('a re-issued create keeps the stored pointer and ignores a forged one', () => {
    const stored = { teamMode: true, [TOOL_MANIFEST_REF_METADATA_KEY]: ref };
    expect(preserveStoredTeamMetadata({ teamMode: true, [TOOL_MANIFEST_REF_METADATA_KEY]: { manifestId: 'M-9' } }, stored)).toEqual(stored);
    expect(preserveStoredTeamMetadata({ phase: 'done' }, stored)).toEqual({ phase: 'done', ...stored });
  });
});
