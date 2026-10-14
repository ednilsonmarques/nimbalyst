// @vitest-environment node
/**
 * Which providers may run a team member (host-verified: scope enforcement and
 * the team role policy), and how a member's provider is described to its
 * coordinator. The role defaults must name ready providers only.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../ai/providerResolution', () => ({
  usesHostSuppliedToolLoop: (provider: string) => provider === 'antigravity-gemini-agent',
  isExtensionAgentProvider: () => false,
  resolveExtensionAgentRef: () => null,
}));

import { TEAM_ROLE_DEFAULTS } from '../teamPolicy';
import {
  TEAM_ROLE_POLICY_PROVIDERS,
  describeTeamMemberProvider,
  isTeamRolePolicyEnforced,
  teamMemberProviderReadiness,
} from '../teamProviders';
import { TEAM_ROLES } from '@nimbalyst/runtime/ai/server/providers/teamContext';

describe('teamMemberProviderReadiness', () => {
  it('claude-code is ready: its turn enforces the scope and applies the role policy', () => {
    expect(teamMemberProviderReadiness('claude-code')).toEqual({ ready: true });
    expect(isTeamRolePolicyEnforced('claude-code')).toBe(true);
    expect(TEAM_ROLE_POLICY_PROVIDERS).toEqual(['claude-code']);
  });

  it.each(['openai-codex', 'openai-codex-acp', 'opencode', 'copilot-cli', 'grok-build', 'cursor-agent', 'claude-code-cli'])(
    '%s is not ready: it does not enforce a member\'s tool scope',
    (provider) => {
      const readiness = teamMemberProviderReadiness(provider);
      expect(readiness.ready).toBe(false);
      expect(readiness.ready ? '' : readiness.reason).toContain('does not enforce a member\'s tool scope');
    },
  );

  it('a provider that enforces the scope but not the role policy is not ready either (both are required)', () => {
    const readiness = teamMemberProviderReadiness('antigravity-gemini-agent');
    expect(readiness.ready).toBe(false);
    expect(readiness.ready ? '' : readiness.reason).toContain('does not apply the team role policy');
  });

  it('a missing provider is not ready', () => {
    expect(teamMemberProviderReadiness(null).ready).toBe(false);
    expect(teamMemberProviderReadiness('').ready).toBe(false);
  });

  it('every role default names a ready provider (a role whose default the host cannot enforce would refuse every creation)', () => {
    for (const role of TEAM_ROLES) {
      expect(teamMemberProviderReadiness(TEAM_ROLE_DEFAULTS[role].provider), role).toEqual({ ready: true });
    }
  });
});

describe('describeTeamMemberProvider', () => {
  it('an advisor on the same provider as the coordinator is an independent opinion, not one independent by provider', () => {
    const line = describeTeamMemberProvider('advisor', 'claude-code', 'claude-code:opus', 'same')!;
    expect(line).toBe('Provider: claude-code (claude-code:opus), the same provider as the coordinator\'s. This second opinion is independent by session, context and instructions, not by provider: do not report it as independent by provider or as a different model family.');
  });

  it('an advisor on another provider is independent by provider too, which lowers correlation and guarantees nothing', () => {
    const line = describeTeamMemberProvider('advisor', 'openai-codex', 'openai-codex:gpt-5.5', 'diverse')!;
    expect(line).toContain('Provider: openai-codex (openai-codex:gpt-5.5), a different provider from the coordinator\'s.');
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
