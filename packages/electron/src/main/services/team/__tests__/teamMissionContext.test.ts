// @vitest-environment node
/**
 * F1 S4 (M-3 AC-5): the bootstrap block of a mission, assembled by the host and
 * stored in `teamMissionContext`. At most 6,000 characters, cut with a visible
 * marker, and built from what the host already knows: no file is read (only the
 * existence of the project's policy files is passed in).
 */
import { describe, expect, it } from 'vitest';
import {
  TEAM_MISSION_CONTEXT_MAX_CHARS,
  TEAM_MISSION_CUT_MARKER,
  buildTeamMissionContext,
  detectPolicyFiles,
} from '../teamMissionContext';

const base = {
  workspaceName: 'nimbalyst',
  policyFiles: ['CLAUDE.md', 'GOVERNANCA.md'],
  goal: 'Ship the F1 identity layer',
  doneCriterion: 'S4 green and reviewed',
  front: { id: 'team-front_1', title: 'Team Mode', status: 'active', description: 'Goal: lifecycle. Authority: ESTADO.md' },
};

describe('buildTeamMissionContext', () => {
  it('carries project, mission and front state, in that order', () => {
    const block = buildTeamMissionContext(base);
    const project = block.indexOf('nimbalyst');
    const goal = block.indexOf('Ship the F1 identity layer');
    const front = block.indexOf('Team Mode');
    expect(project).toBeGreaterThanOrEqual(0);
    expect(goal).toBeGreaterThan(project);
    expect(front).toBeGreaterThan(goal);
    expect(block).toContain('CLAUDE.md');
    expect(block).toContain('GOVERNANCA.md');
    expect(block).toContain('S4 green and reviewed');
    expect(block).toContain('Authority: ESTADO.md');
    expect(block).toContain('team-front_1');
    expect(block).not.toContain(TEAM_MISSION_CUT_MARKER);
  });

  it('says so when the project has no policy file, and omits an absent done criterion', () => {
    const block = buildTeamMissionContext({ ...base, policyFiles: [], doneCriterion: undefined });
    expect(block).toMatch(/no local policy file/i);
    expect(block).not.toMatch(/done criterion/i);
  });

  it('is deterministic', () => {
    expect(buildTeamMissionContext(base)).toBe(buildTeamMissionContext({ ...base }));
  });

  it('cuts an over-long front state at its own cap and says what was cut and where to read it', () => {
    const block = buildTeamMissionContext({ ...base, front: { ...base.front, description: 'x'.repeat(5000) } });
    expect(block).toContain(TEAM_MISSION_CUT_MARKER);
    expect(block).toMatch(/\[cortado: \d+ caracteres; leia team-front_1/);
    expect(block.length).toBeLessThanOrEqual(TEAM_MISSION_CONTEXT_MAX_CHARS);
    // The mission itself (item 2) is never the thing that is dropped.
    expect(block).toContain('Ship the F1 identity layer');
  });

  it('every cut marker is entirely in Portuguese, whichever item was cut', () => {
    const block = buildTeamMissionContext({
      workspaceName: 'w'.repeat(500),
      policyFiles: [],
      goal: 'g'.repeat(300),
      doneCriterion: 'd'.repeat(300),
      front: { id: 'team-front_1', title: 'Team Mode', status: 'active', description: 'x'.repeat(3000) },
    });
    const markers = block.split('\n').filter((line) => line.startsWith(TEAM_MISSION_CUT_MARKER));
    expect(markers).toHaveLength(3);
    expect(markers).toEqual([
      expect.stringMatching(/^\[cortado: \d+ caracteres; leia a raiz do projeto\]$/),
      expect.stringMatching(/^\[cortado: \d+ caracteres; leia os metadados da sessão\]$/),
      expect.stringMatching(/^\[cortado: \d+ caracteres; leia team-front_1 com tracker_get\]$/),
    ]);
  });

  it('never exceeds the 6,000 character cap, even when every item overflows', () => {
    const block = buildTeamMissionContext({
      workspaceName: 'w'.repeat(3000),
      policyFiles: ['CLAUDE.md', 'GOVERNANCA.md'],
      goal: 'g'.repeat(3000),
      doneCriterion: 'd'.repeat(3000),
      front: { id: 'team-front_1', title: 't'.repeat(3000), status: 'active', description: 'x'.repeat(9000) },
    });
    expect(block.length).toBeLessThanOrEqual(TEAM_MISSION_CONTEXT_MAX_CHARS);
    expect(block).toContain(TEAM_MISSION_CUT_MARKER);
  });

  it('the cap is 6,000 and the marker is [cortado', () => {
    expect(TEAM_MISSION_CONTEXT_MAX_CHARS).toBe(6000);
    expect(TEAM_MISSION_CUT_MARKER).toBe('[cortado');
  });

  it('handles a front without a description', () => {
    const block = buildTeamMissionContext({ ...base, front: { ...base.front, description: null } });
    expect(block).toContain('Team Mode');
    expect(block.length).toBeLessThanOrEqual(TEAM_MISSION_CONTEXT_MAX_CHARS);
  });
});

describe('detectPolicyFiles: existence only', () => {
  it('lists the policy files that exist at the workspace root and reads nothing', () => {
    const asked: string[] = [];
    const exists = (file: string) => { asked.push(file); return file.endsWith('CLAUDE.md'); };
    expect(detectPolicyFiles('/ws', exists)).toEqual(['CLAUDE.md']);
    expect(asked.map((f) => f.replace(/\\/g, '/'))).toEqual(['/ws/CLAUDE.md', '/ws/GOVERNANCA.md']);
  });

  it('treats a failing existence check as absent', () => {
    expect(detectPolicyFiles('/ws', () => { throw new Error('EACCES'); })).toEqual([]);
  });
});
