import { describe, expect, it } from 'vitest';
import { TEAM_MISSION_MAX_LENGTH } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { buildTeamChild, resolveRequestedTeamMission } from '../teamPolicy';

describe('resolveRequestedTeamMission', () => {
  it('absent, null or blank means no mission', () => {
    for (const raw of [undefined, null, '', '   ', '\n\t']) expect(resolveRequestedTeamMission(raw), String(raw)).toBeUndefined();
  });

  it('stores plain text normalized: trimmed, whitespace and newlines collapsed', () => {
    expect(resolveRequestedTeamMission('  Investigate only\nthe persistence   paths. ')).toBe('Investigate only the persistence paths.');
  });

  it('refuses a non-string before any side effect', () => {
    for (const raw of [7, true, { text: 'x' }, ['x']]) expect(() => resolveRequestedTeamMission(raw), String(raw)).toThrow(/Invalid mission/);
  });

  it('refuses a mission above the limit, and accepts one exactly at it', () => {
    expect(resolveRequestedTeamMission('x'.repeat(TEAM_MISSION_MAX_LENGTH))).toHaveLength(TEAM_MISSION_MAX_LENGTH);
    expect(() => resolveRequestedTeamMission('x'.repeat(TEAM_MISSION_MAX_LENGTH + 1))).toThrow(/Mission too long \(401 characters; at most 400\)/);
    // Whitespace does not count against it: the normalized text is what is judged.
    expect(resolveRequestedTeamMission(`${'x'.repeat(TEAM_MISSION_MAX_LENGTH)}   \n  `)).toHaveLength(TEAM_MISSION_MAX_LENGTH);
  });
});

describe('buildTeamChild with a mission', () => {
  it('adds the mission next to the role and depth, and omits the key without one', () => {
    expect(buildTeamChild({ rootSessionId: 'root', depth: 0 }, 'reviewer', 'Review the security of the Tracker.'))
      .toEqual({ role: 'reviewer', rootSessionId: 'root', depth: 1, mission: 'Review the security of the Tracker.' });
    expect(buildTeamChild({ rootSessionId: 'root', depth: 0 }, 'reviewer')).toEqual({ role: 'reviewer', rootSessionId: 'root', depth: 1 });
    expect(buildTeamChild({ rootSessionId: 'root', depth: 0 }, 'reviewer', undefined)).not.toHaveProperty('mission');
  });
});
