/**
 * Which providers may run a team member, and how a member's provider is
 * reported. Host-verified facts only: a provider is "ready" when the host
 * knows its turn applies the member's tool scope and the team role policy,
 * not when a class for it exists.
 *
 * The role table that decides which provider a role runs on by default lives
 * in teamPolicy.ts (TEAM_ROLE_DEFAULTS); this module only says whether a
 * provider is fit to run a member at all, and describes the member's provider
 * to its coordinator.
 */

import type { TeamRole } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { isToolScopeEnforced } from '../ai/childToolScope';
import type { TeamProviderDiversity, TeamProviderReadiness } from './teamPolicy';

/**
 * Providers whose turn applies the team role policy: the role's extra tool
 * denials (teamRoleDeniedTools: the architect and the advisor cannot ask the
 * user, delegate or create tasks), the team member addendum of the system
 * prompt (the role contract and the mission) and the team pre-authorization
 * (teamPermissionPolicy). Today that is the Claude Code turn only
 * (providers/claudeCode/turnPrologue.ts). Add a provider here only once its
 * turn does all three, with tests like toolScopePolicy.advisor.test.ts; a
 * provider listed here without them would let a member keep a tool its role
 * denies, or run without its contract.
 */
export const TEAM_ROLE_POLICY_PROVIDERS: readonly string[] = Object.freeze(['claude-code']);

export function isTeamRolePolicyEnforced(provider: string | null | undefined): boolean {
  return !!provider && TEAM_ROLE_POLICY_PROVIDERS.includes(provider);
}

/**
 * Whether a provider may run a team member: its turn must withhold what the
 * member's tool scope denies (isToolScopeEnforced) and apply the team role
 * policy (isTeamRolePolicyEnforced). Both are statements the host makes about
 * its own code, never about a provider's sandbox or prompt: a provider whose
 * sandbox is read-only but whose MCP tools are unfiltered is not ready.
 */
export function teamMemberProviderReadiness(provider: string | null | undefined): TeamProviderReadiness {
  if (!provider) return { ready: false, reason: 'is not a provider' };
  if (!isToolScopeEnforced(provider)) {
    return { ready: false, reason: 'does not enforce a member\'s tool scope (read, review or write) in Team mode: only a provider that withholds the denied tools can run a member' };
  }
  if (!isTeamRolePolicyEnforced(provider)) {
    return { ready: false, reason: 'does not apply the team role policy in its turn (the role\'s tool denials, the member contract in the system prompt and the team pre-authorization)' };
  }
  return { ready: true };
}

/**
 * The provider line of a team member's [Child Session Update] and of
 * get_session_result: role, provider, model and whether the provider differs
 * from the coordinator's. Written so the coordinator cannot upgrade a
 * same-provider second opinion into a provider-independent one. Null outside
 * a team.
 */
export function describeTeamMemberProvider(
  role: TeamRole | null | undefined,
  provider: string | null | undefined,
  model: string | null | undefined,
  diversity: TeamProviderDiversity | null | undefined,
): string | null {
  if (!role || !provider) return null;
  const where = `${provider}${model ? ` (${model})` : ''}`;
  if (role === 'advisor') {
    if (diversity === 'diverse') {
      return `Provider: ${where}, a different provider from the coordinator's. This second opinion is independent by provider as well as by session: it shares fewer blind spots with the team, which lowers the correlation of errors and guarantees nothing.`;
    }
    if (diversity === 'same') {
      return `Provider: ${where}, the same provider as the coordinator's. This second opinion is independent by session, context and instructions, not by provider: do not report it as independent by provider or as a different model family.`;
    }
    return `Provider: ${where}; whether it differs from the coordinator's could not be determined, so do not report this opinion as independent by provider.`;
  }
  const comparison = diversity === 'diverse'
    ? 'a different provider from the coordinator\'s'
    : diversity === 'same'
      ? 'the same provider as the coordinator\'s'
      : 'provider diversity vs the coordinator unknown';
  return `Provider: ${where}, ${comparison}.`;
}
