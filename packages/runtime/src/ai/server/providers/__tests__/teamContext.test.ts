import { describe, expect, it } from 'vitest';
import { NO_TEAM, parseTeamChild, parseTeamRole, resolveTeamContext } from '../teamContext';

describe('parseTeamRole', () => {
  it('accepts the four roles only', () => {
    for (const role of ['explorer', 'implementer', 'reviewer', 'other']) expect(parseTeamRole(role)).toBe(role);
    expect(parseTeamRole('Explorer')).toBeNull();
    expect(parseTeamRole(undefined)).toBeNull();
  });
});

describe('parseTeamChild', () => {
  it('requires a role, a root id and a positive integer depth', () => {
    expect(parseTeamChild({ role: 'explorer', rootSessionId: 'root', depth: 1 })).toEqual({ role: 'explorer', rootSessionId: 'root', depth: 1 });
    expect(parseTeamChild({ role: 'explorer', rootSessionId: 'root', depth: 0 })).toBeNull();
    expect(parseTeamChild({ role: 'explorer', rootSessionId: '', depth: 1 })).toBeNull();
    expect(parseTeamChild({ role: 'boss', rootSessionId: 'root', depth: 1 })).toBeNull();
    expect(parseTeamChild('nope')).toBeNull();
  });
});

describe('resolveTeamContext', () => {
  it('is no team without metadata or keys', () => {
    expect(resolveTeamContext(undefined)).toBe(NO_TEAM);
    expect(resolveTeamContext({ phase: 'planning' })).toBe(NO_TEAM);
  });

  it('marks a root only for teamMode === true', () => {
    expect(resolveTeamContext({ teamMode: true })).toEqual({ teamMode: true, teamChild: null });
    expect(resolveTeamContext({ teamMode: 'true' })).toBe(NO_TEAM);
  });

  it('reads a member and never treats a member as a root', () => {
    const teamChild = { role: 'reviewer', rootSessionId: 'root', depth: 2 };
    expect(resolveTeamContext({ teamChild })).toEqual({ teamMode: false, teamChild });
    expect(resolveTeamContext({ teamMode: true, teamChild })).toEqual({ teamMode: false, teamChild });
  });

  it('ignores team keys on a meta-agent', () => {
    expect(resolveTeamContext({ teamMode: true }, 'meta-agent')).toBe(NO_TEAM);
  });
});
