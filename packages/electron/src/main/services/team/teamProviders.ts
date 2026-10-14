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
import type { ChildToolScope } from '@nimbalyst/runtime/ai/server/providers/claudeCode/toolPolicy';
import { isToolScopeEnforced } from '../ai/childToolScope';
import type { TeamProviderDiversity, TeamProviderReadiness } from './teamPolicy';

/**
 * Providers whose turn applies the team role policy: the role's extra tool
 * denials (teamRoleDeniedTools: the architect and the advisor cannot ask the
 * user, delegate or create tasks) and the team member addendum of the system
 * prompt (the role contract and the mission).
 *
 * - `claude-code`: its turn merges the denials into the SDK's disallowedTools
 *   and guards every call (providers/claudeCode/turnPrologue.ts), builds the
 *   member addendum and pre-authorizes the team's own host tools
 *   (teamPermissionPolicy.ts).
 * - `openai-codex` (app-server transport): the role's denials are first-party
 *   MCP tools, which the session-scoped MCP server withholds and refuses for
 *   the session (mcp/sessionToolPolicy.ts, the same isToolDeniedForScope);
 *   the member addendum goes into the thread's developer instructions
 *   (providers/codex/codexSystemPrompt.ts); there is no per-tool permission
 *   prompt to pre-authorize, every approval of a restricted thread is refused
 *   (providers/codex/codexTeamPolicy.ts).
 *
 * Add a provider here only once its turn does all of that, with tests; a
 * provider listed here without them would let a member keep a tool its role
 * denies, or run without its contract.
 */
export const TEAM_ROLE_POLICY_PROVIDERS: readonly string[] = Object.freeze(['claude-code', 'openai-codex']);

export function isTeamRolePolicyEnforced(provider: string | null | undefined): boolean {
  return !!provider && TEAM_ROLE_POLICY_PROVIDERS.includes(provider);
}

/**
 * Whether a provider may run a team member at `scope`: its turn must withhold
 * what that tool scope denies (isToolScopeEnforced) and apply the team role
 * policy (isTeamRolePolicyEnforced). Both are statements the host makes about
 * its own code, never about a provider's sandbox or prompt: a provider whose
 * sandbox is read-only but whose MCP tools are unfiltered is not ready. With
 * no scope (`full`: the caller asked for every tool) only the role policy is
 * required.
 */
export function teamMemberProviderReadiness(
  provider: string | null | undefined,
  scope: ChildToolScope = 'full',
): TeamProviderReadiness {
  if (!provider) return { ready: false, reason: 'is not a provider' };
  // A full-tools member asks for no restriction, but a provider that cannot
  // enforce every scope is not a team provider: its members would run on the
  // project's own permissions with none of the team's guarantees (openai-codex
  // may run read members only, NIB.44).
  if (scope === 'full' ? !isToolScopeEnforced(provider) : !isToolScopeEnforced(provider, scope)) {
    return {
      ready: false,
      reason: scope === 'full'
        ? 'does not enforce every member tool scope in Team mode, so a full-tools member cannot run on it (it may run only members at a scope it enforces)'
        : `does not enforce a member's ${scope} tool scope in Team mode: only a provider that withholds the denied tools can run a member at that scope`,
    };
  }
  if (!isTeamRolePolicyEnforced(provider)) {
    return { ready: false, reason: 'does not apply the team role policy in its turn (the role\'s tool denials and the member contract in the system prompt)' };
  }
  const transport = resolveTeamProviderTransport(provider);
  if (provider === 'openai-codex' && transport !== 'app-server') {
    return { ready: false, reason: `runs on the "${transport}" transport, and only its app-server transport can restrict a thread (switch the OpenAI Codex transport setting to app-server)` };
  }
  return { ready: true };
}

/**
 * The transport a provider is configured to run on, when that decides
 * whether its turn can be restricted (openai-codex: the legacy SDK transport
 * cannot). Wired by the host at startup (index.ts) to the app setting; the
 * default assumes the shipping default (app-server). The provider itself
 * refuses a restricted turn on the SDK transport as well (defense in depth).
 */
let teamProviderTransportResolver: (provider: string) => string = () => 'app-server';

export function setTeamProviderTransportResolver(resolver: ((provider: string) => string) | null): void {
  teamProviderTransportResolver = resolver ?? (() => 'app-server');
}

function resolveTeamProviderTransport(provider: string): string {
  try {
    return teamProviderTransportResolver(provider) || 'app-server';
  } catch {
    return 'unknown';
  }
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
