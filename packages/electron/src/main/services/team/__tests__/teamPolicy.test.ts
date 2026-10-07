// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildTeamChild,
  resolveRequestedTeamRole,
  resolveTeamCaller,
  teamRoleDefaultModel,
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
  it('model: explorer and reviewer on Sonnet, implementer and other on the root model', () => {
    expect(teamRoleDefaultModel('explorer', 'claude-code:opus')).toBe('claude-code:sonnet');
    expect(teamRoleDefaultModel('reviewer', 'claude-code:opus')).toBe('claude-code:sonnet');
    expect(teamRoleDefaultModel('implementer', 'claude-code:opus')).toBe('claude-code:opus');
    expect(teamRoleDefaultModel('other', 'claude-code:opus')).toBe('claude-code:opus');
    expect(teamRoleDefaultModel('implementer', null)).toBeNull();
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

  it('renderer creates: never teamChild, teamMode only as true on claude-code', () => {
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, teamChild: { role: 'x' } }, 'claude-code')).toEqual({ teamMode: true });
    expect(sanitizeRendererCreateTeamMetadata({ teamMode: 'yes' }, 'claude-code')).toEqual({});
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(sanitizeRendererCreateTeamMetadata({ teamMode: true, phase: 'x' }, 'openai-codex')).toEqual({ phase: 'x' });
    } finally {
      console.warn = warn;
    }
    const plain = { phase: 'x' };
    expect(sanitizeRendererCreateTeamMetadata(plain, 'claude-code')).toBe(plain);
  });
});
