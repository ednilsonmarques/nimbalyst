// @vitest-environment node
/**
 * F1 S3: the team root's lifecycle keys (teamFront, teamGoal, teamMissionStatus,
 * teamMissionContext, teamDoneCriterion) are host-owned. A renderer create
 * cannot carry them, no metadata update can set, replace or clear them, a
 * re-issued create keeps the stored ones, and the only way to give a root its
 * keys is the host entry `applyHostTeamRootLifecycle`, which refuses anything
 * that is not a team root. Every closed list here is an exact match: extending
 * a list means editing this file, never loosening it.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATION_ONLY_KEYS,
  TEAM_ROOT_LIFECYCLE_KEYS,
  applyHostTeamRootLifecycle,
  preserveStoredTeamMetadata,
  sanitizeRendererCreateTeamMetadata,
  stripCreationOnlyTeamMetadata,
} from '../teamSessionMetadata';
import { decideTeamNoteWriter } from '../teamNotes';

const LIFECYCLE = ['teamFront', 'teamGoal', 'teamMissionStatus', 'teamMissionContext', 'teamDoneCriterion', 'teamMissionVersion'];
const forged = {
  teamFront: 'team-front_forged',
  teamGoal: 'Forged goal',
  teamMissionStatus: 'closed',
  teamMissionContext: 'Forged context',
  teamDoneCriterion: 'Forged criterion',
  teamMissionVersion: 1,
};

describe('closed lists are exact', () => {
  it('TEAM_ROOT_LIFECYCLE_KEYS is exactly the five lifecycle keys plus the host provenance marker', () => {
    expect([...TEAM_ROOT_LIFECYCLE_KEYS]).toEqual(LIFECYCLE);
  });

  it('CREATION_ONLY_KEYS is exactly the six existing keys plus the five lifecycle keys and the marker', () => {
    expect([...CREATION_ONLY_KEYS]).toEqual([
      'teamMode',
      'teamChild',
      'teamBudget',
      'toolScope',
      'sessionDirective',
      'toolManifestRef',
      ...LIFECYCLE,
    ]);
  });
});

describe('a renderer cannot inject the lifecycle keys at creation', () => {
  it('drops all six from a team root create and keeps teamMode and the rest', () => {
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, effortLevel: 'high', ...forged }, 'claude-code:opus'))
      .toEqual({ teamMode: true, effortLevel: 'high' });
  });

  it('drops them from a create that is not a team root, too', () => {
    expect(sanitizeRendererCreateTeamMetadata({ phase: 'planning', ...forged }, 'claude-code:opus')).toEqual({ phase: 'planning' });
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: false, ...forged }, 'claude-code:opus')).toEqual({});
  });

  it('drops a single forged teamFront and a null or empty one', () => {
    for (const teamFront of ['team-front_1', '', null, 7, { id: 'x' }]) {
      expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, teamFront }, 'claude-code:opus'), JSON.stringify(teamFront)).toEqual({ teamMode: true });
    }
  });
});

describe('no metadata update sets, replaces or clears them', () => {
  it('strips all six from an update and keeps the unrelated fields', () => {
    expect(stripCreationOnlyTeamMetadata({ phase: 'x', tags: ['a'], ...forged })).toEqual({ phase: 'x', tags: ['a'] });
  });

  it('strips a clearing write (null, empty string, undefined) as well as a replacing one', () => {
    for (const teamFront of [null, '', undefined, 'team-front_2']) {
      expect(stripCreationOnlyTeamMetadata({ teamFront, phase: 'x' }), String(teamFront)).toEqual({ phase: 'x' });
    }
  });

  it('a re-issued create keeps the stored values and ignores the incoming ones', () => {
    const stored = { teamMode: true, teamFront: 'team-front_1', teamGoal: 'Ship F1', teamMissionStatus: 'active', teamMissionContext: 'ctx' };
    expect(preserveStoredTeamMetadata({ ...forged, phase: 'implementing' }, stored)).toEqual({ phase: 'implementing', ...stored });
  });

  it('a re-issued create cannot give a legacy root (no stored front) a front', () => {
    expect(preserveStoredTeamMetadata({ ...forged, phase: 'implementing' }, { teamMode: true })).toEqual({ phase: 'implementing', teamMode: true });
  });
});

describe('applyHostTeamRootLifecycle: the host entry', () => {
  const lifecycle = { front: 'team-front_1', goal: 'Ship F1 identity and data' };

  it('sets the keys on a team root, with the status forced to active', () => {
    const result = applyHostTeamRootLifecycle({ teamMode: true, effortLevel: 'high' }, lifecycle);
    expect(result).toEqual({
      applied: true,
      metadata: { teamMode: true, effortLevel: 'high', teamFront: 'team-front_1', teamGoal: 'Ship F1 identity and data', teamMissionStatus: 'active', teamMissionVersion: 1 },
    });
  });

  it('carries the optional context and done criterion when given', () => {
    const result = applyHostTeamRootLifecycle({ teamMode: true }, { ...lifecycle, context: 'Bootstrap block', doneCriterion: 'S3 green' });
    expect(result).toMatchObject({
      applied: true,
      metadata: { teamMissionContext: 'Bootstrap block', teamDoneCriterion: 'S3 green', teamMissionStatus: 'active', teamMissionVersion: 1 },
    });
  });

  it('does not write an empty optional key', () => {
    const result = applyHostTeamRootLifecycle({ teamMode: true }, { ...lifecycle, context: '  ', doneCriterion: '' });
    expect(result.applied).toBe(true);
    expect('teamMissionContext' in result.metadata).toBe(false);
    expect('teamDoneCriterion' in result.metadata).toBe(false);
  });

  it('trims the front and the goal', () => {
    const result = applyHostTeamRootLifecycle({ teamMode: true }, { front: '  team-front_1 ', goal: '  Ship it ' });
    expect(result.metadata).toMatchObject({ teamFront: 'team-front_1', teamGoal: 'Ship it' });
  });

  it('only sets them when the session is a team root: teamMode must be exactly true', () => {
    for (const metadata of [{}, { phase: 'x' }, { teamMode: false }, { teamMode: 'true' }, { teamMode: 1 }, { teamChild: { role: 'explorer', rootSessionId: 'r', depth: 1 } }]) {
      const result = applyHostTeamRootLifecycle(metadata as never, lifecycle);
      expect(result.applied, JSON.stringify(metadata)).toBe(false);
      for (const key of LIFECYCLE) expect(key in result.metadata, `${JSON.stringify(metadata)} ${key}`).toBe(false);
    }
  });

  it('refuses a blank or non-string front or goal and says why, writing none of the keys', () => {
    for (const bad of [{ front: '', goal: 'g' }, { front: '   ', goal: 'g' }, { front: 'f', goal: '' }, { front: 7, goal: 'g' }, { front: 'f', goal: null }]) {
      const result = applyHostTeamRootLifecycle({ teamMode: true }, bad as never);
      expect(result.applied, JSON.stringify(bad)).toBe(false);
      expect(result).toHaveProperty('reason');
      for (const key of LIFECYCLE) expect(key in result.metadata, `${JSON.stringify(bad)} ${key}`).toBe(false);
    }
  });

  it('replaces forged lifecycle keys already in the metadata, and removes them when it refuses', () => {
    const ok = applyHostTeamRootLifecycle({ teamMode: true, ...forged }, lifecycle);
    expect(ok.metadata).toMatchObject({ teamFront: 'team-front_1', teamGoal: 'Ship F1 identity and data', teamMissionStatus: 'active' });
    expect('teamMissionContext' in ok.metadata).toBe(false);
    expect('teamDoneCriterion' in ok.metadata).toBe(false);

    const refused = applyHostTeamRootLifecycle({ phase: 'x', ...forged }, lifecycle);
    expect(refused.applied).toBe(false);
    expect(refused.metadata).toEqual({ phase: 'x' });
  });

  it('does not mutate its input', () => {
    const input = { teamMode: true, ...forged };
    const snapshot = JSON.parse(JSON.stringify(input));
    applyHostTeamRootLifecycle(input, lifecycle);
    expect(input).toEqual(snapshot);
  });

  it('provenance chain: the front the host wrote is the front a coordinator note carries; a front the renderer chose is not', () => {
    const hosted = applyHostTeamRootLifecycle(sanitizeRendererCreateTeamMetadata({ teamMode: true, ...forged }, 'claude-code:opus'), lifecycle);
    const hostedDecision = decideTeamNoteWriter('root', { agentRole: 'standard', metadata: hosted.metadata }, null);
    expect(hostedDecision).toMatchObject({ allowed: true, provenance: { front: 'team-front_1', teamRootSession: 'root' } });

    // A renderer-created root: the sanitizer dropped the forged front and nobody replaced it.
    const legacy = sanitizeRendererCreateTeamMetadata({ teamMode: true, ...forged }, 'claude-code:opus');
    const legacyDecision = decideTeamNoteWriter('root', { agentRole: 'standard', metadata: legacy }, null);
    expect(legacyDecision).toMatchObject({ allowed: true, provenance: { front: null, teamRootSession: 'root' } });
  });

  it('a pre-S3 style root (teamFront stored, no host marker) is a legacy root: its front is not copied to a note', () => {
    const preS3 = { teamMode: true, teamFront: 'team-front_forged', teamGoal: 'g', teamMissionStatus: 'active' };
    expect(decideTeamNoteWriter('root', { agentRole: 'standard', metadata: preS3 }, null))
      .toMatchObject({ allowed: true, provenance: { front: null, teamRootSession: 'root' } });
    // Not even a wrong marker value counts.
    for (const marker of [0, 2, '1', true, null]) {
      expect(decideTeamNoteWriter('root', { agentRole: 'standard', metadata: { ...preS3, teamMissionVersion: marker } }, null), String(marker))
        .toMatchObject({ provenance: { front: null } });
    }
  });

  it('the output survives the store rules: a re-issued create and an update leave it as written', () => {
    const { metadata } = applyHostTeamRootLifecycle({ teamMode: true }, lifecycle);
    expect(preserveStoredTeamMetadata({ ...forged }, metadata)).toEqual(metadata);
    expect(stripCreationOnlyTeamMetadata({ ...forged, phase: 'x' })).toEqual({ phase: 'x' });
  });
});

describe('applyHostTeamRootLifecycle stamps the host provenance marker', () => {
  it('writes teamMissionVersion: 1 with the keys, and never when it refuses', () => {
    expect(applyHostTeamRootLifecycle({ teamMode: true }, { front: 'f', goal: 'g' }).metadata).toMatchObject({ teamMissionVersion: 1 });
    expect('teamMissionVersion' in applyHostTeamRootLifecycle({ teamMode: false, teamMissionVersion: 1 }, { front: 'f', goal: 'g' }).metadata).toBe(false);
    expect('teamMissionVersion' in applyHostTeamRootLifecycle({ teamMode: true, teamMissionVersion: 1 }, { front: '', goal: 'g' }).metadata).toBe(false);
  });

  it('a renderer cannot send the marker on a plain create, and an update cannot set or clear it', () => {
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, teamMissionVersion: 1 }, 'claude-code:opus')).toEqual({ teamMode: true });
    expect(sanitizeRendererCreateTeamMetadata({ teamMissionVersion: 1 }, 'claude-code:opus')).toEqual({});
    expect(stripCreationOnlyTeamMetadata({ teamMissionVersion: 1, phase: 'x' })).toEqual({ phase: 'x' });
    expect(stripCreationOnlyTeamMetadata({ teamMissionVersion: null, phase: 'x' })).toEqual({ phase: 'x' });
    expect(preserveStoredTeamMetadata({ teamMissionVersion: 1 }, { teamMode: true })).toEqual({ teamMode: true });
  });
});
