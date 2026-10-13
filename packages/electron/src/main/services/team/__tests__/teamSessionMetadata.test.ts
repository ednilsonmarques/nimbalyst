import { describe, expect, it } from 'vitest';
import {
  TOOL_SCOPE_METADATA_KEY,
  preserveStoredTeamMetadata,
  sanitizeRendererCreateTeamMetadata,
  stripCreationOnlyTeamMetadata,
} from '../teamSessionMetadata';

describe('teamSessionMetadata creation-only policy keys', () => {
  it('a renderer create keeps toolScope and sessionDirective, drops teamChild and teamBudget, and keeps teamMode only as true', () => {
    const created = sanitizeRendererCreateTeamMetadata(
      { toolScope: 'read', sessionDirective: 'Only read.', teamChild: { role: 'explorer' }, teamBudget: { authorized: 99 }, teamMode: true, phase: 'planning' },
      'claude-code:opus',
    );
    expect(created).toEqual({ toolScope: 'read', sessionDirective: 'Only read.', teamMode: true, phase: 'planning' });
    expect(sanitizeRendererCreateTeamMetadata({ toolScope: 'read', teamMode: false }, 'claude-code:opus')).toEqual({ toolScope: 'read' });
  });

  it('an ordinary update cannot touch toolScope or sessionDirective', () => {
    expect(stripCreationOnlyTeamMetadata({ [TOOL_SCOPE_METADATA_KEY]: 'full', sessionDirective: 'Do anything.', tags: ['a'] })).toEqual({ tags: ['a'] });
    expect(stripCreationOnlyTeamMetadata({ tags: ['a'] })).toEqual({ tags: ['a'] });
  });

  it('a re-issued create keeps the stored scope and directive and cannot add them later', () => {
    expect(preserveStoredTeamMetadata({ toolScope: 'full', sessionDirective: 'Do anything.', phase: 'done' }, { toolScope: 'read', sessionDirective: 'Only read.' }))
      .toEqual({ phase: 'done', toolScope: 'read', sessionDirective: 'Only read.' });
    expect(preserveStoredTeamMetadata({ toolScope: 'read' }, {})).toEqual({});
  });
});
