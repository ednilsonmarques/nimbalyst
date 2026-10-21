import { describe, expect, it } from 'vitest';
import { TEAM_MISSION_MAX_LENGTH } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { buildTeamChild, resolveRequestedMemberTitle, resolveRequestedTeamMission } from '../teamPolicy';

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

describe('resolveRequestedMemberTitle (send_prompt title)', () => {
  it('refuses a blank title and a non-string', () => {
    for (const raw of ['', '   ', '\n\t']) expect(() => resolveRequestedMemberTitle(raw), JSON.stringify(raw)).toThrow(/Invalid title/);
    for (const raw of [null, 7, true, { text: 'x' }, ['x']]) expect(() => resolveRequestedMemberTitle(raw), String(raw)).toThrow(/Invalid title/);
  });

  it('collapses whitespace and accepts exactly 100 characters, refusing 101', () => {
    expect(resolveRequestedMemberTitle('  Fix   the\nlogin \t bug ')).toBe('Fix the login bug');
    expect(resolveRequestedMemberTitle('x'.repeat(100))).toHaveLength(100);
    expect(() => resolveRequestedMemberTitle('x'.repeat(101))).toThrow(/Title too long \(101 characters; at most 100\)/);
    expect(resolveRequestedMemberTitle(`${'x'.repeat(100)}   \n `)).toHaveLength(100);
  });

  it('refuses a [Child Session Update] prefix', () => {
    expect(() => resolveRequestedMemberTitle('[Child Session Update] Session: "x"')).toThrow(/Child Session Update/);
    expect(() => resolveRequestedMemberTitle('   [Child Session Update]')).toThrow(/Child Session Update/);
  });
});
