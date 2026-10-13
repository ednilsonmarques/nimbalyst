// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  TEAM_ARCHITECT_MODEL,
  TEAM_LIMITS,
  buildTeamChild,
  isTeamBudgetExhausted,
  teamSpawnRefusal,
  resolveRequestedTeamRole,
  resolveTeamCaller,
  teamRoleDefaultEffort,
  teamRoleDefaultModel,
  TEAM_ROOT_PRESETS,
  isRecommendedTeamRootModel,
  teamRoleDefaultToolScope,
  resolveChildToolScopeRequest,
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
    expect(resolveRequestedTeamRole('architect')).toBe('architect');
    expect(() => resolveRequestedTeamRole('boss')).toThrow(/Invalid role "boss"/);
  });
});

describe('role defaults', () => {
  it('model: every role defaults to Sonnet, except the architect (Opus)', () => {
    for (const role of ['explorer', 'implementer', 'reviewer', 'other'] as const) {
      expect(teamRoleDefaultModel(role)).toBe('claude-code:sonnet');
    }
    expect(teamRoleDefaultModel('architect')).toBe('claude-code:opus');
    expect(TEAM_ARCHITECT_MODEL).toBe('claude-code:opus');
  });

  it('effort: reviewer and architect high, every other role medium', () => {
    expect(teamRoleDefaultEffort('reviewer')).toBe('high');
    expect(teamRoleDefaultEffort('architect')).toBe('high');
    expect(teamRoleDefaultEffort('explorer')).toBe('medium');
    expect(teamRoleDefaultEffort('implementer')).toBe('medium');
    expect(teamRoleDefaultEffort('other')).toBe('medium');
  });

  it('tool scope: explorer and architect read, reviewer review, implementer full, other left to the caller', () => {
    expect(teamRoleDefaultToolScope('explorer')).toBe('read');
    expect(teamRoleDefaultToolScope('architect')).toBe('read');
    expect(teamRoleDefaultToolScope('reviewer')).toBe('review');
    expect(teamRoleDefaultToolScope('implementer')).toBe('full');
    expect(teamRoleDefaultToolScope('other')).toBeUndefined();
  });

  describe('resolveChildToolScopeRequest', () => {
    it('stores the role default when nothing is requested (full is stored as no scope)', () => {
      expect(resolveChildToolScopeRequest(undefined, 'explorer')).toBe('read');
      expect(resolveChildToolScopeRequest(undefined, 'reviewer')).toBe('review');
      expect(resolveChildToolScopeRequest(undefined, 'implementer')).toBeUndefined();
      expect(resolveChildToolScopeRequest(undefined, 'other')).toBeUndefined();
      expect(resolveChildToolScopeRequest(undefined, undefined)).toBeUndefined();
    });

    it('a reviewer never gets more than review: full, write or anything else is lowered', () => {
      for (const requested of ['full', 'write', 'review', 'admin', 42, null]) {
        expect(resolveChildToolScopeRequest(requested, 'reviewer'), String(requested)).toBe('review');
      }
      expect(resolveChildToolScopeRequest('read', 'reviewer')).toBe('read');
    });

    it('an architect is always read: full, write, review, read, nothing or junk all store read', () => {
      for (const requested of ['full', 'write', 'review', 'read', undefined, null, '', 'admin', 42]) {
        expect(resolveChildToolScopeRequest(requested, 'architect'), String(requested)).toBe('read');
      }
    });

    it('an explicit known scope wins for other roles; full means no restriction', () => {
      expect(resolveChildToolScopeRequest('write', 'implementer')).toBe('write');
      expect(resolveChildToolScopeRequest('review', 'other')).toBe('review');
      expect(resolveChildToolScopeRequest('read', undefined)).toBe('read');
      expect(resolveChildToolScopeRequest('full', 'explorer')).toBeUndefined();
    });

    it('fails closed: an unrecognized value is stored as read, never full', () => {
      for (const requested of ['admin', 'READ', 'Full', 42, {}]) {
        expect(resolveChildToolScopeRequest(requested, undefined), String(requested)).toBe('read');
        expect(resolveChildToolScopeRequest(requested, 'implementer'), String(requested)).toBe('read');
      }
    });
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

  it('teamBudget is out of reach of every ordinary write: a session cannot raise its own budget', () => {
    const forged = { teamBudget: { authorized: 99, extensions: 23 } };
    expect(stripCreationOnlyTeamMetadata({ ...forged, phase: 'x' })).toEqual({ phase: 'x' });
    // A re-issued create keeps the stored authorization and ignores a forged one.
    expect(preserveStoredTeamMetadata({ ...forged }, { teamMode: true, teamBudget: { authorized: 12, extensions: 1 } }))
      .toEqual({ teamMode: true, teamBudget: { authorized: 12, extensions: 1 } });
    expect(preserveStoredTeamMetadata({ ...forged }, { teamMode: true })).toEqual({ teamMode: true });
    // A renderer create starts at the initial budget, team root or not.
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, ...forged }, 'claude-code:opus')).toEqual({ teamMode: true });
    expect(sanitizeRendererCreateTeamMetadata({ ...forged, phase: 'x' }, 'claude-code:opus')).toEqual({ phase: 'x' });
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

describe('architect and the team budget', () => {
  it('counts like any other member: the budget and the active limit do not know roles', () => {
    const team = { rootSessionId: 'root', depth: 0 };
    // Seven members so far (an architect among them): the eighth is the last one allowed.
    expect(teamSpawnRefusal(team, { total: 7, active: 1 })).toBeNull();
    // Eight created, architect included: the checkpoint refuses the ninth whatever its role.
    expect(isTeamBudgetExhausted({ total: TEAM_LIMITS.budget, active: 1 }, TEAM_LIMITS.budget)).toBe(true);
    expect(teamSpawnRefusal(team, { total: TEAM_LIMITS.budget, active: 1 })).toMatch(/Team budget reached: this team has already created 8\/8 sessions/);
    // An architect still thinking counts as active.
    expect(teamSpawnRefusal(team, { total: 3, active: TEAM_LIMITS.maxActive })).toMatch(/3\/3 sessions are already active/);
  });
});
