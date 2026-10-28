import { describe, expect, it } from 'vitest';
import { TEAM_ROOT_PRESETS } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  TEAM_MISSION_DONE_CRITERION_MAX_CHARS,
  TEAM_MISSION_ERROR_CODES,
  TEAM_MISSION_GOAL_MAX_CHARS,
} from '../../../../shared/teamMission';
import { parseTeamMissionRequest, TeamMissionError } from '../../../../main/services/team/teamMissions';
import {
  buildTeamMissionCreateInput,
  buildTeamMissionRequest,
  fieldUsage,
  teamFrontStatusLabelKey,
  teamMissionErrorKey,
  toTeamFrontOptions,
  TEAM_MISSION_REFRESH_CODES,
} from '../teamMissionDialog';

const item = (over: Record<string, unknown>) => ({ type: 'team-front', archived: false, ...over });

describe('toTeamFrontOptions', () => {
  it('lists the fronts with their status; only an active one is selectable', () => {
    const options = toTeamFrontOptions([
      item({ id: 'tfr_a', title: 'Paused front', status: 'paused' }),
      item({ id: 'tfr_b', title: 'Active front', status: 'active' }),
      item({ id: 'tfr_c', title: 'Closed front', status: 'closed' }),
    ]);
    expect(options.map((o) => [o.id, o.status, o.selectable])).toEqual([
      ['tfr_b', 'active', true],
      ['tfr_a', 'paused', false],
      ['tfr_c', 'closed', false],
    ]);
  });

  it('keeps the original order inside the active and the not-active groups', () => {
    const options = toTeamFrontOptions([
      item({ id: 'p1', title: 'P1', status: 'paused' }),
      item({ id: 'a1', title: 'A1', status: 'active' }),
      item({ id: 'c1', title: 'C1', status: 'closed' }),
      item({ id: 'a2', title: 'A2', status: 'active' }),
    ]);
    expect(options.map((o) => o.id)).toEqual(['a1', 'a2', 'p1', 'c1']);
  });

  it('treats a missing or unknown status as unknown and not selectable (the main refuses it too)', () => {
    const options = toTeamFrontOptions([
      item({ id: 'x1', title: 'No status' }),
      item({ id: 'x2', title: 'Odd status', status: 'on-hold' }),
    ]);
    expect(options.map((o) => [o.status, o.selectable])).toEqual([['unknown', false], ['unknown', false]]);
  });

  it('reads the status the way the main does: customFields first, then the item', () => {
    const [front] = toTeamFrontOptions([item({ id: 'tfr_d', title: 'D', status: 'closed', customFields: { status: 'active' } })]);
    expect(front.status).toBe('active');
  });

  it('omits archived items and anything that is not a team-front; a blank title falls back to the id', () => {
    const options = toTeamFrontOptions([
      item({ id: 'arch', title: 'Archived', status: 'active', archived: true }),
      item({ id: 'bug_1', title: 'A bug', status: 'active', type: 'bug' }),
      item({ id: 'tfr_e', title: '  ', status: 'active' }),
    ]);
    expect(options.map((o) => [o.id, o.title])).toEqual([['tfr_e', 'tfr_e']]);
  });

  it('is empty for anything that is not a list', () => {
    expect(toTeamFrontOptions(undefined)).toEqual([]);
    expect(toTeamFrontOptions({ items: [] })).toEqual([]);
  });
});

describe('the limits the dialog shows are the ones the main enforces', () => {
  const FRONT = 'tfr_front1';
  const refusal = (raw: unknown) => {
    try { parseTeamMissionRequest(raw); } catch (error) { return error as TeamMissionError; }
    throw new Error('expected a refusal');
  };

  it('accepts a goal of exactly the shared limit and refuses one character more', () => {
    expect(parseTeamMissionRequest({ front: FRONT, goal: 'g'.repeat(TEAM_MISSION_GOAL_MAX_CHARS) }).goal).toHaveLength(TEAM_MISSION_GOAL_MAX_CHARS);
    const error = refusal({ front: FRONT, goal: 'g'.repeat(TEAM_MISSION_GOAL_MAX_CHARS + 1) });
    expect(error.code).toBe('invalid-request');
    expect(error.message).toContain(String(TEAM_MISSION_GOAL_MAX_CHARS));
  });

  it('accepts a done criterion of exactly the shared limit and refuses one character more', () => {
    const goal = 'a goal';
    expect(parseTeamMissionRequest({ front: FRONT, goal, doneCriterion: 'd'.repeat(TEAM_MISSION_DONE_CRITERION_MAX_CHARS) }).doneCriterion).toHaveLength(TEAM_MISSION_DONE_CRITERION_MAX_CHARS);
    const error = refusal({ front: FRONT, goal, doneCriterion: 'd'.repeat(TEAM_MISSION_DONE_CRITERION_MAX_CHARS + 1) });
    expect(error.code).toBe('invalid-request');
    expect(error.message).toContain(String(TEAM_MISSION_DONE_CRITERION_MAX_CHARS));
  });

  it('measures the trimmed text, the way fieldUsage does', () => {
    const padded = `  ${'g'.repeat(TEAM_MISSION_GOAL_MAX_CHARS)}  `;
    expect(fieldUsage(padded, TEAM_MISSION_GOAL_MAX_CHARS).over).toBe(false);
    expect(parseTeamMissionRequest({ front: FRONT, goal: padded }).goal).toHaveLength(TEAM_MISSION_GOAL_MAX_CHARS);
  });
});

describe('buildTeamMissionCreateInput (the coordinator preset of a mission)', () => {
  const presets = [
    { id: 'large', model: 'claude-code:fable', effortLevel: 'high' },
    { id: 'standard', model: 'claude-code:opus', effortLevel: 'high' },
    { id: 'critical', model: 'claude-code:fable', effortLevel: 'max' },
  ] as never;
  const request = { front: 'tfr_a', goal: 'g' };

  it('uses the model and effort of the Standard preset', () => {
    expect(buildTeamMissionCreateInput(request, presets)).toEqual({
      teamMission: request,
      model: 'claude-code:opus',
      effortLevel: 'high',
      launchSource: 'session_history',
    });
  });

  it('uses the real Standard preset by default', () => {
    const real = buildTeamMissionCreateInput(request)!;
    expect(real.model).toBe(TEAM_ROOT_PRESETS.find((p) => p.id === 'standard')!.model);
    expect(real.effortLevel).toBe(TEAM_ROOT_PRESETS.find((p) => p.id === 'standard')!.effortLevel);
  });

  it('fails closed when there is no Standard preset: no model is guessed from another one', () => {
    expect(buildTeamMissionCreateInput(request, [{ id: 'critical', model: 'claude-code:fable', effortLevel: 'max' }] as never)).toBeNull();
    expect(buildTeamMissionCreateInput(request, [] as never)).toBeNull();
  });
});

describe('teamFrontStatusLabelKey', () => {
  it('has a static key for each known status and the unknown one for anything else', () => {
    expect(teamFrontStatusLabelKey('active')).toBe('teamMissionDialog.status.active');
    expect(teamFrontStatusLabelKey('paused')).toBe('teamMissionDialog.status.paused');
    expect(teamFrontStatusLabelKey('closed')).toBe('teamMissionDialog.status.closed');
    expect(teamFrontStatusLabelKey('unknown')).toBe('teamMissionDialog.status.unknown');
    expect(teamFrontStatusLabelKey('on-hold' as never)).toBe('teamMissionDialog.status.unknown');
  });
});

describe('fieldUsage', () => {
  it('counts the trimmed text, the way the main measures it, and flags only a real overflow', () => {
    expect(fieldUsage('  abc  ', 5)).toEqual({ used: 3, over: false, blank: false });
    expect(fieldUsage('a'.repeat(5), 5).over).toBe(false);
    expect(fieldUsage('a'.repeat(6), 5)).toMatchObject({ used: 6, over: true });
    expect(fieldUsage('   ', 5)).toEqual({ used: 0, over: false, blank: true });
  });
});

describe('buildTeamMissionRequest', () => {
  it('sends the front and the text exactly as typed (the main trims and validates)', () => {
    const goal = '  Ship the dialog\nwith  two spaces  ';
    expect(buildTeamMissionRequest({ front: 'tfr_a', goal, doneCriterion: ' done when green ' })).toEqual({
      front: 'tfr_a',
      goal,
      doneCriterion: ' done when green ',
    });
  });

  it('leaves the done criterion out when the field is empty, and adds no other key', () => {
    const request = buildTeamMissionRequest({ front: 'tfr_a', goal: 'g', doneCriterion: '' });
    expect(Object.keys(request).sort()).toEqual(['front', 'goal']);
    expect(Object.keys(buildTeamMissionRequest({ front: 'tfr_a', goal: 'g', doneCriterion: 'x' })).sort()).toEqual(['doneCriterion', 'front', 'goal']);
  });
});

describe('teamMissionErrorKey', () => {
  it('has a message for the client-side failures too', () => {
    for (const code of ['no-workspace', 'remote-host', 'preset-unavailable']) {
      expect(teamMissionErrorKey(code)).not.toBe('teamMissionDialog.errors.generic');
    }
  });

  it('has a translated message for every code the main can send, and a generic one otherwise', () => {
    for (const code of TEAM_MISSION_ERROR_CODES) {
      expect(teamMissionErrorKey(code)).not.toBe('teamMissionDialog.errors.generic');
    }
    expect(teamMissionErrorKey(undefined)).toBe('teamMissionDialog.errors.generic');
    expect(teamMissionErrorKey('something-new')).toBe('teamMissionDialog.errors.generic');
  });

  it('reloads the fronts after the refusals that mean the list was stale', () => {
    expect([...TEAM_MISSION_REFRESH_CODES].sort()).toEqual(['front-not-found', 'front-unavailable', 'mission-active']);
  });
});
