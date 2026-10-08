// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildTeamChild,
  resolveRequestedTeamRole,
  resolveTeamCaller,
  teamRoleDefaultEffort,
  teamRoleDefaultModel,
  TEAM_ROOT_PRESETS,
  isRecommendedTeamRootModel,
  teamRoleDefaultToolScope,
} from '../teamPolicy';
import {
  preserveStoredTeamMetadata,
  sanitizeRendererCreateTeamMetadata,
  stripCreationOnlyTeamMetadata,
} from '../teamSessionMetadata';

describe('resolveTeamCaller', () => {
  it('a root is depth 0 of its own team', () => {
    expect(resolveTeamCaller('root', { teamMode: true }, 'standard')).toEqual({ rootSessionId: 'root', depth: 0 });
  });

  it('a member reports its root and depth', () => {
    expect(resolveTeamCaller('c', { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } }, 'standard'))
      .toEqual({ rootSessionId: 'root', depth: 1 });
  });

  it('is null outside a team, for meta-agents and for junk metadata', () => {
    expect(resolveTeamCaller('s', { phase: 'planning' }, 'standard')).toBeNull();
    expect(resolveTeamCaller('s', null, 'standard')).toBeNull();
    expect(resolveTeamCaller('s', 'teamMode', 'standard')).toBeNull();
    expect(resolveTeamCaller('m', { teamMode: true }, 'meta-agent')).toBeNull();
  });
});

describe('resolveRequestedTeamRole', () => {
  it('defaults to other and refuses unknown roles', () => {
    expect(resolveRequestedTeamRole(undefined)).toBe('other');
    expect(resolveRequestedTeamRole('')).toBe('other');
    expect(resolveRequestedTeamRole('reviewer')).toBe('reviewer');
    expect(() => resolveRequestedTeamRole('architect')).toThrow(/Invalid role "architect"/);
  });
});

describe('role defaults', () => {
  it('model: every role defaults to Sonnet', () => {
    for (const role of ['explorer', 'implementer', 'reviewer', 'other'] as const) {
      expect(teamRoleDefaultModel(role)).toBe('claude-code:sonnet');
    }
  });

  it('effort: reviewer high, every other role medium', () => {
    expect(teamRoleDefaultEffort('reviewer')).toBe('high');
    expect(teamRoleDefaultEffort('explorer')).toBe('medium');
    expect(teamRoleDefaultEffort('implementer')).toBe('medium');
    expect(teamRoleDefaultEffort('other')).toBe('medium');
  });

  it('tool scope: explorer and reviewer read, implementer full, other left to the caller', () => {
    expect(teamRoleDefaultToolScope('explorer')).toBe('read');
    expect(teamRoleDefaultToolScope('reviewer')).toBe('read');
    expect(teamRoleDefaultToolScope('implementer')).toBe('full');
    expect(teamRoleDefaultToolScope('other')).toBeUndefined();
  });

  it('a member is one level below its caller', () => {
    expect(buildTeamChild({ rootSessionId: 'root', depth: 1 }, 'reviewer')).toEqual({ role: 'reviewer', rootSessionId: 'root', depth: 2 });
  });
});

describe('coordinator presets', () => {
  it('Standard = Opus/high, Large = Fable/high, Critical = Fable/max, never -1m', () => {
    expect(TEAM_ROOT_PRESETS.map((p) => [p.id, p.model, p.effortLevel])).toEqual([
      ['standard', 'claude-code:opus', 'high'],
      ['large', 'claude-code:fable', 'high'],
      ['critical', 'claude-code:fable', 'max'],
    ]);
    expect(TEAM_ROOT_PRESETS.some((p) => p.model.endsWith('-1m'))).toBe(false);
  });

  it('recommended coordinator tier is any Opus or Fable variant', () => {
    for (const m of ['claude-code:opus', 'claude-code:opus-1m', 'claude-code:opus-4-8', 'claude-code:fable', 'claude-code:fable-1m']) {
      expect(isRecommendedTeamRootModel(m), m).toBe(true);
    }
    for (const m of ['claude-code:sonnet', 'claude-code:haiku', 'openai-codex:gpt-5.5', null]) {
      expect(isRecommendedTeamRootModel(m), String(m)).toBe(false);
    }
  });
});

describe('creation-only team metadata', () => {
  it('strips both keys from updates and leaves others alone', () => {
    expect(stripCreationOnlyTeamMetadata({ teamMode: true, teamChild: {}, phase: 'x' })).toEqual({ phase: 'x' });
    const untouched = { phase: 'x' };
    expect(stripCreationOnlyTeamMetadata(untouched)).toBe(untouched);
  });

  it('a re-create keeps what is stored and adds nothing new', () => {
    expect(preserveStoredTeamMetadata({ phase: 'y' }, { teamMode: true })).toEqual({ phase: 'y', teamMode: true });
    expect(preserveStoredTeamMetadata({ teamMode: true }, { phase: 'old' })).toEqual({});
    expect(preserveStoredTeamMetadata({ teamMode: true }, null)).toEqual({ teamMode: true });
  });

  it('renderer creates: never teamChild, teamMode only as true', () => {
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, teamChild: { role: 'x' } }, 'claude-code:opus')).toEqual({ teamMode: true });
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: 'yes' }, 'claude-code:opus')).toEqual({});
    const plain = { phase: 'x' };
    expect(sanitizeRendererCreateTeamMetadata(plain, 'claude-code:opus')).toBe(plain);
  });

  it('keeps teamMode outside the recommended presets and only warns (policy in the UX, not in the core)', () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => { warnings.push(msg); };
    try {
      expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, effortLevel: 'low' }, 'claude-code:sonnet'))
        .toEqual({ teamMode: true, effortLevel: 'low' });
      expect(sanitizeRendererCreateTeamMetadata({ teamMode: true }, 'openai-codex:gpt-5.5')).toEqual({ teamMode: true });
      expect(warnings).toHaveLength(2);
      warnings.length = 0;
      sanitizeRendererCreateTeamMetadata({ teamMode: true }, 'claude-code:fable');
      expect(warnings).toHaveLength(0);
    } finally {
      console.warn = warn;
    }
  });
});
