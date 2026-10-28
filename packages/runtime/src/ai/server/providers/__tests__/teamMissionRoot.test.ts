import { describe, expect, it } from 'vitest';
import {
  TEAM_MISSION_VERSION,
  TEAM_MISSION_VERSION_METADATA_KEY,
  isHostMissionRoot,
} from '../teamContext';

describe('isHostMissionRoot: the test every consumer of the mission keys applies (F1 S4)', () => {
  const mission = { teamMode: true, teamFront: 'team-front_1', teamMissionVersion: 1 };

  it('the marker is teamMissionVersion: 1', () => {
    expect(TEAM_MISSION_VERSION_METADATA_KEY).toBe('teamMissionVersion');
    expect(TEAM_MISSION_VERSION).toBe(1);
  });

  it('is true for a team root carrying the host marker', () => {
    expect(isHostMissionRoot(mission)).toBe(true);
    expect(isHostMissionRoot({ teamMode: true, teamMissionVersion: 1 })).toBe(true);
  });

  it('is false for a root with a front but no marker (stored before the keys were host-owned)', () => {
    expect(isHostMissionRoot({ teamMode: true, teamFront: 'team-front_1', teamGoal: 'g', teamMissionStatus: 'active' })).toBe(false);
  });

  it.each([0, 2, '1', true, null, undefined, [], {}])('is false for a marker that is not exactly the number 1 (%j)', (marker) => {
    expect(isHostMissionRoot({ ...mission, teamMissionVersion: marker } as never)).toBe(false);
  });

  it('is false unless teamMode is exactly true, and for a member', () => {
    for (const teamMode of [false, 'true', 1, null, undefined]) {
      expect(isHostMissionRoot({ ...mission, teamMode } as never), String(teamMode)).toBe(false);
    }
    expect(isHostMissionRoot({ ...mission, teamChild: { role: 'explorer', rootSessionId: 'r', depth: 1 } })).toBe(false);
  });

  it('is false for no metadata', () => {
    expect(isHostMissionRoot(null)).toBe(false);
    expect(isHostMissionRoot(undefined)).toBe(false);
    expect(isHostMissionRoot({})).toBe(false);
  });
});
