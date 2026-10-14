// @vitest-environment node
/**
 * Which providers may run a team member (host-verified: scope enforcement and
 * the team role policy, per scope), and how a member's provider is described
 * to its coordinator. The role defaults must name ready providers only.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../ai/providerResolution', () => ({
  usesHostSuppliedToolLoop: (provider: string) => provider === 'antigravity-gemini-agent',
  isExtensionAgentProvider: () => false,
  resolveExtensionAgentRef: () => null,
}));

import { TEAM_ROLE_DEFAULTS, teamRoleDefaultToolScope } from '../teamPolicy';
import {
  TEAM_ROLE_POLICY_PROVIDERS,
  describeTeamMemberProvider,
  isTeamRolePolicyEnforced,
  setTeamProviderTransportResolver,
  teamMemberProviderReadiness,
} from '../teamProviders';
import { TEAM_ROLES } from '@nimbalyst/runtime/ai/server/providers/teamContext';

describe('teamMemberProviderReadiness', () => {
  it('claude-code is ready at every scope: its turn enforces the scope and applies the role policy', () => {
    for (const scope of ['read', 'review', 'write', 'full'] as const) {
      expect(teamMemberProviderReadiness('claude-code', scope), scope).toEqual({ ready: true });
    }
    expect(teamMemberProviderReadiness('claude-code')).toEqual({ ready: true });
    expect(isTeamRolePolicyEnforced('claude-code')).toBe(true);
  });

  it('openai-codex is ready for a read member only: the session-scoped MCP server and the read-only thread enforce read; write cannot be enforced natively', () => {
    expect(TEAM_ROLE_POLICY_PROVIDERS).toEqual(['claude-code', 'openai-codex']);
    expect(teamMemberProviderReadiness('openai-codex', 'read')).toEqual({ ready: true });
    expect(teamMemberProviderReadiness('openai-codex', 'review')).toEqual({ ready: true });
    const write = teamMemberProviderReadiness('openai-codex', 'write');
    expect(write.ready).toBe(false);
    expect(write.ready ? '' : write.reason).toContain('does not enforce a member\'s write tool scope');
    // A full-tools member on Codex would run on the project's own permissions
    // with none of the team's guarantees: refused, as before this phase (NIB.44).
    const full = teamMemberProviderReadiness('openai-codex', 'full');
    expect(full.ready).toBe(false);
    expect(full.ready ? '' : full.reason).toContain('does not enforce every member tool scope in Team mode, so a full-tools member cannot run on it');
    expect(teamMemberProviderReadiness('openai-codex').ready).toBe(false);
  });

  it('openai-codex is ready only on its app-server transport: the legacy SDK transport cannot restrict a thread', () => {
    setTeamProviderTransportResolver((provider) => (provider === 'openai-codex' ? 'sdk' : 'app-server'));
    try {
      const readiness = teamMemberProviderReadiness('openai-codex', 'read');
      expect(readiness.ready).toBe(false);
      expect(readiness.ready ? '' : readiness.reason).toContain('runs on the "sdk" transport, and only its app-server transport can restrict a thread');
      expect(teamMemberProviderReadiness('claude-code', 'read')).toEqual({ ready: true });
    } finally {
      setTeamProviderTransportResolver(null);
    }
    expect(teamMemberProviderReadiness('openai-codex', 'read')).toEqual({ ready: true });
    // A resolver that throws is "unknown", which is not app-server.
    setTeamProviderTransportResolver(() => { throw new Error('settings down'); });
    try {
      expect(teamMemberProviderReadiness('openai-codex', 'read').ready).toBe(false);
    } finally {
      setTeamProviderTransportResolver(null);
    }
  });

  it.each(['openai-codex-acp', 'opencode', 'copilot-cli', 'grok-build', 'cursor-agent', 'claude-code-cli'])(
    '%s is not ready for a read member: it does not enforce the scope',
    (provider) => {
      const readiness = teamMemberProviderReadiness(provider, 'read');
      expect(readiness.ready).toBe(false);
      expect(readiness.ready ? '' : readiness.reason).toContain('does not enforce a member\'s read tool scope');
      // Nor any scope at all, for a full member.
      const full = teamMemberProviderReadiness(provider, 'full');
      expect(full.ready).toBe(false);
      expect(full.ready ? '' : full.reason).toContain('does not enforce every member tool scope');
    },
  );

  it('a provider that enforces the scope but not the role policy is not ready either (both are required)', () => {
    for (const scope of ['read', 'full'] as const) {
      const readiness = teamMemberProviderReadiness('antigravity-gemini-agent', scope);
      expect(readiness.ready).toBe(false);
      expect(readiness.ready ? '' : readiness.reason).toContain('does not apply the team role policy');
    }
  });

  it('a missing provider is not ready', () => {
    expect(teamMemberProviderReadiness(null, 'read').ready).toBe(false);
    expect(teamMemberProviderReadiness('', 'read').ready).toBe(false);
  });

  it('every role default names a provider that is ready at the role\'s own scope (a role whose default the host cannot enforce would refuse every creation)', () => {
    for (const role of TEAM_ROLES) {
      const scope = teamRoleDefaultToolScope(role) ?? 'full';
      expect(teamMemberProviderReadiness(TEAM_ROLE_DEFAULTS[role].provider, scope), role).toEqual({ ready: true });
    }
  });
});

describe('describeTeamMemberProvider', () => {
  it('an advisor on the same provider as the coordinator is an independent opinion, not one independent by provider', () => {
    const line = describeTeamMemberProvider('advisor', 'claude-code', 'claude-code:opus', 'same')!;
    expect(line).toBe('Provider: claude-code (claude-code:opus), the same provider as the coordinator\'s. This second opinion is independent by session, context and instructions, not by provider: do not report it as independent by provider or as a different model family.');
  });

  it('an advisor on another provider is independent by provider too, which lowers correlation and guarantees nothing', () => {
    const line = describeTeamMemberProvider('advisor', 'openai-codex', 'openai-codex:gpt-6.1-sol', 'diverse')!;
    expect(line).toContain('Provider: openai-codex (openai-codex:gpt-6.1-sol), a different provider from the coordinator\'s.');
    expect(line).toContain('independent by provider as well as by session');
    expect(line).toContain('lowers the correlation of errors and guarantees nothing');
  });

  it('an advisor whose diversity is unknown is never reported as independent by provider', () => {
    const line = describeTeamMemberProvider('advisor', 'claude-code', null, null)!;
    expect(line).toBe('Provider: claude-code; whether it differs from the coordinator\'s could not be determined, so do not report this opinion as independent by provider.');
  });

  it('other roles get a plain provider line; outside a team there is none', () => {
    expect(describeTeamMemberProvider('reviewer', 'claude-code', 'claude-code:sonnet', 'same')).toBe('Provider: claude-code (claude-code:sonnet), the same provider as the coordinator\'s.');
    expect(describeTeamMemberProvider('explorer', 'openai-codex', 'openai-codex:gpt-5.5', 'diverse')).toBe('Provider: openai-codex (openai-codex:gpt-5.5), a different provider from the coordinator\'s.');
    expect(describeTeamMemberProvider('implementer', 'claude-code', null, null)).toBe('Provider: claude-code, provider diversity vs the coordinator unknown.');
    expect(describeTeamMemberProvider(null, 'claude-code', 'claude-code:sonnet', 'same')).toBeNull();
    expect(describeTeamMemberProvider('advisor', null, null, 'same')).toBeNull();
  });
});
