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

// F1 S3: three mission keys (front, goal, status) reach the renderer as read-only
// fields, only for a team root, only when well formed. The renderer can read them;
// nothing in this pipeline writes them back. `teamMissionContext` (up to ~6,000
// characters) and `teamDoneCriterion` stay protected and main-only: nothing in the
// renderer reads them and the list is refreshed often.
describe('team mission lifecycle projection', () => {
  const base = { id: 's', createdAt: 1, updatedAt: 2, title: 'T', provider: 'claude-code' } as SessionMeta;
  const root = {
    teamMode: true,
    teamFront: 'team-front_1',
    teamGoal: 'Ship F1',
    teamMissionStatus: 'active',
    teamMissionContext: 'Bootstrap block',
    teamMissionVersion: 1,
  };
  const exposed = { teamMode: true, teamFront: 'team-front_1', teamGoal: 'Ship F1', teamMissionStatus: 'active' } as const;
  const EXPOSED_FIELDS = ['teamFront', 'teamGoal', 'teamMissionStatus'] as const;

  it('reads exactly the three exposed keys of a team root, never the context or the done criterion', () => {
    expect(readTeamSessionFields({ ...root, teamDoneCriterion: 'S3 green' })).toEqual(exposed);
    expect('teamMissionContext' in readTeamSessionFields({ ...root })).toBe(false);
  });

  it('a root with mission keys but no host marker (stored before S3) gains nothing, and the marker itself is never exposed', () => {
    const { teamMissionVersion: _marker, ...preS3 } = root;
    expect(readTeamSessionFields({ ...preS3, teamDoneCriterion: 'x' })).toEqual({ teamMode: true });
    for (const marker of [0, 2, '1', true, null]) {
      expect(readTeamSessionFields({ ...preS3, teamMissionVersion: marker } as never), String(marker)).toEqual({ teamMode: true });
    }
    expect('teamMissionVersion' in readTeamSessionFields({ ...root })).toBe(false);
  });

  it('a legacy root (teamMode without a front) gains nothing', () => {
    expect(readTeamSessionFields({ teamMode: true })).toEqual({ teamMode: true });
    expect(readTeamSessionFields({ teamMode: true, effortLevel: 'high' })).toEqual({ teamMode: true, effortLevel: 'high' });
  });

  it('exposes the keys only for a team root: a forged value on any other session is not read', () => {
    const forged = { teamFront: 'team-front_forged', teamGoal: 'g', teamMissionStatus: 'active', teamMissionContext: 'c' };
    for (const metadata of [forged, { ...forged, teamMode: false }, { ...forged, teamMode: 'yes' }, { ...forged, teamChild: { role: 'explorer', rootSessionId: 'r', depth: 1 } }]) {
      const fields = readTeamSessionFields(metadata as never) as Record<string, unknown>;
      for (const key of Object.keys(forged)) expect(fields[key], `${JSON.stringify(metadata)} ${key}`).toBeUndefined();
    }
  });

  it('ignores a value that is not a non-blank string, and a status outside active/closed', () => {
    for (const bad of [{ teamFront: '' }, { teamFront: '   ' }, { teamFront: 7 }, { teamFront: null }, { teamGoal: {} }, { teamMissionContext: [] }, { teamMissionStatus: 'paused' }, { teamMissionStatus: true }]) {
      const fields = readTeamSessionFields({ teamMode: true, teamMissionVersion: 1, ...bad } as never) as Record<string, unknown>;
      expect(fields, JSON.stringify(bad)).toEqual({ teamMode: true });
    }
    expect(readTeamSessionFields({ teamMode: true, teamMissionVersion: 1, teamMissionStatus: 'closed' })).toEqual({ teamMode: true, teamMissionStatus: 'closed' });
  });

  it('carries the three keys from the store entry to the registry entry and a normal session gains none', () => {
    const [projected] = projectSessionList([{ ...base, ...exposed }], new Map());
    expect(projected).toMatchObject(exposed);
    expect(sessionListMetadata(projected as never, '/ws')).toMatchObject(exposed);

    const [plain] = projectSessionList([base], new Map());
    const entry = sessionListMetadata(plain as never, '/ws');
    for (const field of EXPOSED_FIELDS) {
      expect(entry[field], field).toBeUndefined();
    }
  });

  it('neither projection step forwards a context or a done criterion, even if a store entry carried one', () => {
    const entry = { ...base, ...exposed, teamMissionContext: 'Bootstrap block', teamDoneCriterion: 'S3 green' } as never;
    const [projected] = projectSessionList([entry], new Map());
    expect(projected).toMatchObject(exposed);
    expect(projected).not.toHaveProperty('teamMissionContext', 'Bootstrap block');
    expect((projected as Record<string, unknown>).teamMissionContext).toBeUndefined();
    expect((projected as Record<string, unknown>).teamDoneCriterion).toBeUndefined();

    const registry = sessionListMetadata({ ...(projected as object), teamMissionContext: 'Bootstrap block', teamDoneCriterion: 'S3 green' } as never, '/ws') as unknown as Record<string, unknown>;
    expect(registry.teamMissionContext).toBeUndefined();
    expect(registry.teamDoneCriterion).toBeUndefined();
  });

  it('a legacy root entry carries no front through the pipeline', () => {
    const [projected] = projectSessionList([{ ...base, teamMode: true }], new Map());
    const entry = sessionListMetadata(projected as never, '/ws');
    expect(entry).toMatchObject({ teamMode: true });
    for (const field of EXPOSED_FIELDS) {
      expect(entry[field], field).toBeUndefined();
    }
  });
});

describe('team mission projection', () => {
  const base = { id: 's', createdAt: 1, updatedAt: 2, title: 'T', provider: 'claude-code' } as SessionMeta;

  it('reads teamChild.mission as teamMission, only for a member, and never invents one', () => {
    expect(readTeamSessionFields({ teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1, mission: 'Review the security.' }, toolScope: 'review' }))
      .toEqual({ teamRole: 'reviewer', teamMission: 'Review the security.', toolScope: 'review' });
    expect(readTeamSessionFields({ teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1 } })).toEqual({ teamRole: 'reviewer' });
    for (const metadata of [{ teamChild: { role: 'reviewer', mission: '' } }, { teamChild: { role: 'reviewer', mission: 7 } }, { teamChild: { mission: 'x' } }, { teamMode: true, mission: 'x' }]) {
      expect(readTeamSessionFields(metadata as never).teamMission, JSON.stringify(metadata)).toBeUndefined();
    }
  });

  it('carries teamMission from the store entry to the registry entry, and a session without one gains nothing', () => {
    const [projected] = projectSessionList([{ ...base, teamRole: 'explorer', teamMission: 'Map the write paths.', toolScope: 'read' }], new Map());
    expect(projected).toMatchObject({ teamRole: 'explorer', teamMission: 'Map the write paths.' });
    expect(sessionListMetadata(projected as never, '/ws')).toMatchObject({ teamMission: 'Map the write paths.' });
    const [plain] = projectSessionList([{ ...base, teamRole: 'explorer' }], new Map());
    expect(sessionListMetadata(plain as never, '/ws').teamMission).toBeUndefined();
  });
});
