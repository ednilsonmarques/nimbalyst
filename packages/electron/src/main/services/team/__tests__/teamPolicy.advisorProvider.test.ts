// @vitest-environment node
/**
 * Provider of a team member, the advisor's in particular: one table of role
 * defaults (provider, model, effort, scope), a provider refusal that is
 * explicit and never a fallback, and a notion of provider diversity against
 * the team root. Pure rules of teamPolicy.ts; the host-verified readiness of
 * a provider is teamProviders.ts (its own test).
 */
import { describe, expect, it } from 'vitest';
import {
  TEAM_ADVISOR_MODEL,
  TEAM_ADVISOR_PROVIDER,
  TEAM_ARCHITECT_MODEL,
  TEAM_PROVIDER,
  TEAM_ROLE_DEFAULTS,
  TEAM_SONNET_MODEL,
  resolveChildToolScopeRequest,
  resolveTeamMemberProvider,
  teamMemberProviderRefusal,
  teamProviderDiversity,
  teamRoleDefaultEffort,
  teamRoleDefaultModel,
  teamRoleDefaultToolScope,
  teamRoleProvider,
  teamRoleModelForProvider,
  type TeamMemberProviderCheck,
} from '../teamPolicy';
import { TEAM_ROLES } from '@nimbalyst/runtime/ai/server/providers/teamContext';

const READY = { ready: true } as const;
const NOT_READY = { ready: false, reason: 'does not enforce a member\'s tool scope (read, review or write) in Team mode' } as const;

function check(overrides: Partial<TeamMemberProviderCheck>): TeamMemberProviderCheck {
  return { role: 'advisor', provider: 'claude-code', origin: 'default', callerProvider: 'claude-code', readiness: READY, enabled: null, ...overrides };
}

describe('role defaults are one table', () => {
  it('every role has a provider, a model of that provider, an effort and a scope, and the role functions read the table', () => {
    for (const role of TEAM_ROLES) {
      const defaults = TEAM_ROLE_DEFAULTS[role];
      expect(defaults.model.startsWith(`${defaults.provider}:`), role).toBe(true);
      expect(teamRoleProvider(role), role).toBe(defaults.provider);
      expect(teamRoleDefaultModel(role), role).toBe(defaults.model);
      expect(teamRoleDefaultEffort(role), role).toBe(defaults.effort);
      expect(teamRoleDefaultToolScope(role), role).toBe(defaults.toolScope);
    }
    expect(Object.keys(TEAM_ROLE_DEFAULTS).sort()).toEqual([...TEAM_ROLES].sort());
  });

  it('the advisor provider is one constant, OpenAI Codex, with gpt-6.1-sol/high/read as its defaults: an advisor without provider and model resolves to it', () => {
    expect(TEAM_ROLE_DEFAULTS.advisor).toEqual({ provider: TEAM_ADVISOR_PROVIDER, model: TEAM_ADVISOR_MODEL, effort: 'high', toolScope: 'read' });
    expect(TEAM_ADVISOR_PROVIDER).toBe('openai-codex');
    expect(TEAM_ADVISOR_PROVIDER).not.toBe(TEAM_PROVIDER);
    expect(TEAM_ADVISOR_MODEL).toBe('openai-codex:gpt-6.1-sol');
    expect(TEAM_ADVISOR_MODEL.startsWith(`${TEAM_ADVISOR_PROVIDER}:`)).toBe(true);
    expect(resolveTeamMemberProvider({ role: 'advisor', callerProvider: 'claude-code' })).toEqual({ provider: 'openai-codex', origin: 'default' });
    expect(teamRoleDefaultModel('advisor')).toBe('openai-codex:gpt-6.1-sol');
    expect(teamRoleDefaultEffort('advisor')).toBe('high');
    expect(teamRoleDefaultToolScope('advisor')).toBe('read');
  });

  it('the other roles keep their defaults and the team provider (no regression)', () => {
    expect(TEAM_ROLE_DEFAULTS.explorer).toEqual({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'medium', toolScope: 'read' });
    expect(TEAM_ROLE_DEFAULTS.implementer).toEqual({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'medium', toolScope: 'full' });
    expect(TEAM_ROLE_DEFAULTS.reviewer).toEqual({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'high', toolScope: 'review' });
    expect(TEAM_ROLE_DEFAULTS.architect).toEqual({ provider: TEAM_PROVIDER, model: TEAM_ARCHITECT_MODEL, effort: 'high', toolScope: 'read' });
    expect(TEAM_ROLE_DEFAULTS.other).toEqual({ provider: TEAM_PROVIDER, model: TEAM_SONNET_MODEL, effort: 'medium', toolScope: undefined });
    expect(TEAM_PROVIDER).toBe('claude-code');
  });

  it('is frozen, table and rows', () => {
    expect(Object.isFrozen(TEAM_ROLE_DEFAULTS)).toBe(true);
    for (const role of TEAM_ROLES) expect(Object.isFrozen(TEAM_ROLE_DEFAULTS[role]), role).toBe(true);
  });

  it('a provider never changes the advisor\'s scope: read whatever was asked', () => {
    for (const requested of ['full', 'write', 'review', undefined, 'openai-codex']) {
      expect(resolveChildToolScopeRequest(requested, 'advisor')).toBe('read');
    }
  });
});

describe('resolveTeamMemberProvider: the provider a creation asks for, and where it came from', () => {
  it('nothing named: the role default', () => {
    expect(resolveTeamMemberProvider({ role: 'advisor', callerProvider: 'openai-codex' })).toEqual({ provider: TEAM_ADVISOR_PROVIDER, origin: 'default' });
    expect(resolveTeamMemberProvider({ role: 'explorer', provider: '', model: null, callerProvider: 'claude-code' })).toEqual({ provider: 'claude-code', origin: 'default' });
  });

  it('a named provider wins, whatever the model says', () => {
    expect(resolveTeamMemberProvider({ role: 'advisor', provider: 'openai-codex', model: 'claude-code:opus', callerProvider: 'claude-code' })).toEqual({ provider: 'openai-codex', origin: 'explicit' });
  });

  it('a named model gives its prefix; a bare model means the caller\'s provider', () => {
    expect(resolveTeamMemberProvider({ role: 'advisor', model: 'openai-codex:gpt-5.5', callerProvider: 'claude-code' })).toEqual({ provider: 'openai-codex', origin: 'explicit' });
    expect(resolveTeamMemberProvider({ role: 'advisor', model: 'opus', callerProvider: 'claude-code' })).toEqual({ provider: 'claude-code', origin: 'explicit' });
    expect(resolveTeamMemberProvider({ role: 'advisor', model: 'opus', callerProvider: null })).toEqual({ provider: TEAM_ADVISOR_PROVIDER, origin: 'explicit' });
  });

  it('a model copied from the caller is inherited, not explicit', () => {
    expect(resolveTeamMemberProvider({ role: 'advisor', model: 'openai-codex:gpt-5.5', modelInherited: true, callerProvider: 'openai-codex' })).toEqual({ provider: 'openai-codex', origin: 'inherited' });
  });
});

describe('teamMemberProviderRefusal: explicit, fail-closed, never a fallback', () => {
  it('accepts the role default on the caller\'s own provider without consulting availability', () => {
    expect(teamMemberProviderRefusal(check({ enabled: null }))).toBeNull();
    expect(teamMemberProviderRefusal(check({ enabled: false }))).toBeNull();
  });

  it('refuses a provider the host cannot keep read-only, naming the Independent Advisor, the reason, that nothing was created and that no fallback was applied', () => {
    const message = teamMemberProviderRefusal(check({ provider: 'openai-codex', origin: 'explicit', readiness: NOT_READY, enabled: true }));
    expect(message).toMatch(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) does not enforce a member's tool scope .*, so the advisor cannot run on it\. /);
    expect(message).toContain('No session was created and no fallback to another provider was applied');
    expect(message).toContain('omit provider and model to create it on the role default (openai-codex), and say in your report that the member ran on that provider');
  });

  it('a model inherited from the caller names inheritModel as the cause and the way back to the role default', () => {
    const message = teamMemberProviderRefusal(check({ provider: 'openai-codex', origin: 'inherited', callerProvider: 'openai-codex', readiness: NOT_READY, enabled: true }));
    expect(message).toMatch(/^Independent Advisor provider unavailable: openai-codex \(inherited from the caller's model \(inheritModel\)\) does not enforce/);
    expect(message).toContain('omit inheritModel (and model) to create it on the role default (openai-codex)');
    expect(message).not.toContain('omit provider and model');
  });

  it('the advisor\'s own default provider unavailable (disabled, unverifiable, not signed in): refused as the default being unavailable, nothing created, no fallback to the team provider', () => {
    const base = { provider: 'openai-codex', callerProvider: 'claude-code', origin: 'default', readiness: READY } as const;
    for (const [overrides, head] of [
      [{ enabled: false }, 'is not enabled in this app\'s AI provider settings for this workspace'],
      [{ enabled: null }, 'could not be verified as available (its settings were not readable)'],
      [{ enabled: true, authenticated: false }, 'is enabled but the user is not signed in to it'],
      [{ enabled: true, authenticated: null }, 'could not be verified as signed in'],
    ] as const) {
      const message = teamMemberProviderRefusal(check({ ...base, ...overrides }))!;
      expect(message, head).toContain(`Independent Advisor provider unavailable: openai-codex (the role default) ${head}. No session was created and no fallback to another provider was applied`);
      expect(message, head).toContain('the default provider of the Independent Advisor is unavailable, so report it to the user as it is');
      expect(message, head).toContain('a deliberate choice you may only make by naming provider and model explicitly');
      expect(message, head).not.toContain('create the member on the role default');
      expect(message, head).not.toContain('claude-code');
    }
    expect(teamMemberProviderRefusal(check({ ...base, enabled: true, authenticated: true }))).toBeNull();
  });

  it('the team provider named explicitly for the advisor stays a deliberate choice: accepted when ready and enabled, reported as same-provider by diversity', () => {
    expect(teamMemberProviderRefusal(check({ provider: 'claude-code', callerProvider: 'claude-code', origin: 'explicit', readiness: READY, enabled: null }))).toBeNull();
    expect(teamProviderDiversity('claude-code', 'claude-code')).toBe('same');
    expect(teamProviderDiversity('openai-codex', 'claude-code')).toBe('diverse');
  });

  it('readiness is checked even for the caller\'s own provider: a team on an unready provider cannot create a member on it', () => {
    const message = teamMemberProviderRefusal(check({ provider: 'openai-codex', callerProvider: 'openai-codex', origin: 'default', readiness: NOT_READY, enabled: true }));
    expect(message).toMatch(/^Independent Advisor provider unavailable: openai-codex \(the role default\) does not enforce/);
  });

  it('a ready provider other than the caller\'s must be enabled: disabled and unverifiable are both refused, enabled is accepted', () => {
    const base = { role: 'explorer', provider: 'claude-code', callerProvider: 'openai-codex', origin: 'default', readiness: READY } as const;
    expect(teamMemberProviderRefusal(check({ ...base, enabled: true }))).toBeNull();
    expect(teamMemberProviderRefusal(check({ ...base, enabled: false })))
      .toMatch(/^Team member \(explorer\) provider unavailable: claude-code \(the role default\) is not enabled in this app's AI provider settings for this workspace\. No session was created and no fallback/);
    expect(teamMemberProviderRefusal(check({ ...base, enabled: null })))
      .toMatch(/^Team member \(explorer\) provider unavailable: claude-code \(the role default\) could not be verified as available \(its settings were not readable\)\. No session was created and no fallback/);
  });

  it('a disabled explicit provider points at the user\'s settings or an explicit enabled provider, never at a configuration error and never at a silent switch', () => {
    const message = teamMemberProviderRefusal(check({ provider: 'claude-code', callerProvider: 'openai-codex', origin: 'explicit', readiness: READY, enabled: false }))!;
    expect(message).not.toContain('configuration error');
    expect(message).toContain('the user may enable claude-code in the AI provider settings; or you may name explicitly (provider and model) an enabled provider that enforces the member\'s scope');
    expect(message).toContain('a member on another provider than asked is the caller\'s choice, never the host\'s');
  });

  it('a role default the host cannot run is reported as a configuration error, not as something to retry on another provider', () => {
    const message = teamMemberProviderRefusal(check({ provider: 'openai-codex', origin: 'default', readiness: NOT_READY, enabled: true }))!;
    expect(message).toContain('this is a configuration error of the role defaults (teamPolicy.ts); report it to the user');
    expect(message).not.toContain('omit provider and model');
  });

  it('other roles are refused with their role name; the rule is the same for every role', () => {
    for (const role of TEAM_ROLES.filter((candidate) => candidate !== 'advisor')) {
      const message = teamMemberProviderRefusal(check({ role, provider: 'openai-codex', origin: 'explicit', readiness: NOT_READY, enabled: true }));
      expect(message, role).toMatch(new RegExp(`^Team member \\(${role}\\) provider unavailable: openai-codex \\(requested explicitly\\) does not enforce .*, so the ${role} cannot run on it`));
      expect(message, role).toContain('No session was created and no fallback to another provider was applied');
    }
  });

  it('a ready, enabled provider other than the caller\'s must also be signed in: not signed in and unverifiable are refused', () => {
    const base = { provider: 'openai-codex', callerProvider: 'claude-code', origin: 'explicit', readiness: READY, enabled: true } as const;
    expect(teamMemberProviderRefusal(check({ ...base, authenticated: true }))).toBeNull();
    expect(teamMemberProviderRefusal(check({ ...base, authenticated: false })))
      .toMatch(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) is enabled but the user is not signed in to it\. No session was created and no fallback .*\(its own login, never a key you configure\)/);
    expect(teamMemberProviderRefusal(check({ ...base, authenticated: null })))
      .toMatch(/^Independent Advisor provider unavailable: openai-codex \(requested explicitly\) could not be verified as signed in\. No session was created and no fallback/);
    // The caller's own provider needs no sign-in check at all.
    expect(teamMemberProviderRefusal(check({ provider: 'claude-code', callerProvider: 'claude-code', authenticated: null }))).toBeNull();
  });

  it('a named model this build does not know for the provider is refused before availability is even considered', () => {
    const unknown = check({ provider: 'openai-codex', origin: 'explicit', readiness: READY, enabled: null, authenticated: null, model: { id: 'openai-codex:gpt-9', known: false } });
    expect(teamMemberProviderRefusal(unknown))
      .toMatch(/^Independent Advisor model unavailable: openai-codex:gpt-9 is not a model of openai-codex this build knows, so the advisor cannot be created on it\. No session was created and no fallback .* omit the model to get the provider's default/);
    expect(teamMemberProviderRefusal(check({ model: { id: 'claude-code:opus', known: null } }))).toBeNull();
    expect(teamMemberProviderRefusal(check({ provider: 'openai-codex', callerProvider: 'openai-codex', model: { id: 'openai-codex:gpt-6.1-sol', known: true } }))).toBeNull();
  });

  it('never silently maps a refused provider to another: the message carries no accepted provider other than the role default to retry on', () => {
    const message = teamMemberProviderRefusal(check({ provider: 'opencode', origin: 'explicit', readiness: NOT_READY, enabled: true }))!;
    expect(message.match(/openai-codex/g)).toHaveLength(1);
    expect(message).toContain('(openai-codex)');
    expect(message).not.toContain('claude-code');
  });
});

describe('teamProviderDiversity', () => {
  it('is diverse when the member and root providers differ, same when equal, null when either is unknown', () => {
    expect(teamProviderDiversity('openai-codex', 'claude-code')).toBe('diverse');
    expect(teamProviderDiversity('claude-code', 'claude-code')).toBe('same');
    expect(teamProviderDiversity('claude-code', null)).toBeNull();
    expect(teamProviderDiversity(undefined, 'claude-code')).toBeNull();
    expect(teamProviderDiversity('', 'claude-code')).toBeNull();
  });

  it('a model promotion within the same provider is not diversity', () => {
    expect(teamProviderDiversity('claude-code', 'claude-code')).toBe('same');
  });
});

describe('NIB.46 hardening of the provider rules', () => {
  it("7.6: a provider named without a model gets the role's model for that provider, never the caller's", () => {
    expect(teamRoleModelForProvider('advisor', undefined)).toBe('openai-codex:gpt-6.1-sol');
    expect(teamRoleModelForProvider('advisor', 'openai-codex')).toBe('openai-codex:gpt-6.1-sol');
    // The deliberate same-provider second opinion: Opus, the architect's tier, not Sonnet or Fable of the coordinator.
    expect(teamRoleModelForProvider('advisor', 'claude-code')).toBe('claude-code:opus');
    expect(teamRoleModelForProvider('advisor', 'opencode')).toBeNull();
    for (const role of ['explorer', 'implementer', 'reviewer', 'architect', 'other'] as const) {
      expect(teamRoleModelForProvider(role, 'claude-code'), role).toBe(TEAM_ROLE_DEFAULTS[role].model);
      expect(teamRoleModelForProvider(role, 'openai-codex'), role).toBeNull();
    }
  });

  it("7.7: the advisor's default provider on an incompatible transport is refused as the default being unavailable, naming the transport setting, never as a configuration error", () => {
    const message = teamMemberProviderRefusal(check({
      provider: 'openai-codex', origin: 'default', enabled: true,
      readiness: { ready: false, cause: 'transport', reason: 'runs on the "sdk" transport, and only its app-server transport can restrict a thread (switch the OpenAI Codex transport setting to app-server)' },
    }))!;
    expect(message).toMatch(/^Independent Advisor provider unavailable: openai-codex \(the role default\) runs on the "sdk" transport/);
    expect(message).toContain('No session was created and no fallback to another provider was applied');
    expect(message).toContain('the default provider of the Independent Advisor (openai-codex) is configured on a transport that cannot keep a Team mode member read-only');
    expect(message).not.toContain('configuration error');
    expect(message).not.toContain('claude-code');
    // A scope or policy cause of a role default is still the host's own configuration error.
    expect(teamMemberProviderRefusal(check({ provider: 'openai-codex', origin: 'default', readiness: { ready: false, cause: 'scope', reason: 'x' }, enabled: true }))).toContain('configuration error of the role defaults');
  });

  it('7.8: a CLI older than the verified minimum, or one whose version is unknown, refuses the member; a supported one does not', () => {
    const base = { provider: 'openai-codex', callerProvider: 'claude-code', origin: 'default', readiness: READY, enabled: true, authenticated: true } as const;
    expect(teamMemberProviderRefusal(check({ ...base, cliVersion: { version: '0.159.2', minimum: '0.159.1', supported: true } }))).toBeNull();
    expect(teamMemberProviderRefusal(check({ ...base, cliVersion: { version: '0.150.0', minimum: '0.159.1', supported: false } })))
      .toMatch(/^Independent Advisor provider unavailable: openai-codex \(the role default\) its CLI is version 0\.150\.0, older than the minimum 0\.159\.1 this integration was verified with\. No session was created and no fallback .* the user may update openai-codex \(nothing is installed or updated automatically\); the default provider of the Independent Advisor is unavailable/);
    expect(teamMemberProviderRefusal(check({ ...base, cliVersion: { version: null, minimum: '0.159.1', supported: null } })))
      .toMatch(/its CLI version could not be verified \(minimum 0\.159\.1\)/);
    // No version check wired for the provider: nothing to refuse on.
    expect(teamMemberProviderRefusal(check({ ...base, cliVersion: undefined }))).toBeNull();
  });
});
