// @vitest-environment node
/**
 * Team mode facts travel from the session row's metadata to the renderer
 * registry as plain read-only fields; nothing new is stored.
 */
import { describe, expect, it } from 'vitest';
import { readTeamSessionFields } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { SessionMeta } from '@nimbalyst/runtime';
import { projectSessionList } from '../../../../main/ipc/sessionListProjection';
import { sessionListMetadata } from '../sessionListMetadata';

describe('readTeamSessionFields', () => {
  it('reads a Team mode root', () => {
    expect(readTeamSessionFields({ teamMode: true, effortLevel: 'high' })).toEqual({ teamMode: true, effortLevel: 'high' });
  });

  it('reads a team member', () => {
    expect(readTeamSessionFields({
      teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1 },
      effortLevel: 'high',
      toolScope: 'review',
    })).toEqual({ teamRole: 'reviewer', effortLevel: 'high', toolScope: 'review' });
  });

  it('adds nothing for a session without team metadata, whatever the metadata looks like', () => {
    for (const metadata of [undefined, null, {}, { teamMode: 'yes' }, { teamChild: 'reviewer' }, { teamChild: { role: 7 } }, { toolScope: 3 }]) {
      expect(readTeamSessionFields(metadata as never)).toEqual({});
    }
  });
});

describe('session list pipeline', () => {
  const base = { id: 's', createdAt: 1, updatedAt: 2, title: 'T', provider: 'claude-code' } as SessionMeta;

  it('carries the team fields from the store entry to the registry entry', () => {
    const [projected] = projectSessionList([{ ...base, teamRole: 'explorer', effortLevel: 'medium', toolScope: 'read' }], new Map());
    expect(projected).toMatchObject({ teamRole: 'explorer', effortLevel: 'medium', toolScope: 'read' });
    expect(sessionListMetadata(projected as never, '/ws')).toMatchObject({ teamRole: 'explorer', effortLevel: 'medium', toolScope: 'read' });

    const [root] = projectSessionList([{ ...base, teamMode: true, effortLevel: 'high' }], new Map());
    expect(sessionListMetadata(root as never, '/ws')).toMatchObject({ teamMode: true, effortLevel: 'high' });
  });

  it('a normal session gains no team field', () => {
    const [projected] = projectSessionList([base], new Map());
    const entry = sessionListMetadata(projected as never, '/ws');
    for (const field of ['teamMode', 'teamRole', 'effortLevel', 'toolScope'] as const) {
      expect(entry[field], field).toBeUndefined();
    }
  });
});
