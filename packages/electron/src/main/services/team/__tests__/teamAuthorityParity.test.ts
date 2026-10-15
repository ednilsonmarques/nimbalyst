// @vitest-environment node
/**
 * Parity of operational authority between an advisor on Claude Code and an
 * advisor on OpenAI Codex, for the same scope (read) and role. The two do not
 * share a catalog: Claude Code has native tools the SDK withholds, Codex has
 * a shell and a patch tool its thread withholds. They share the host: the
 * same first-party MCP surface, served by the same session policy. This test
 * compares capabilities, never tool names blindly.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../ai/providerResolution', () => ({
  usesHostSuppliedToolLoop: () => false,
  isExtensionAgentProvider: () => false,
  resolveExtensionAgentRef: () => null,
}));

import {
  isToolDeniedForScope,
  mergeToolScopeDisallowedTools,
  readScopeDeniedFirstPartyTools,
} from '@nimbalyst/runtime/ai/server/providers/claudeCode/toolPolicy';
import { MCP_FIRST_PARTY_TOPOLOGY } from '@nimbalyst/runtime/ai/server/services/mcpTopology';
import { resolveCodexPermissionProfile } from '@nimbalyst/runtime/ai/server/protocols/codexPermissionProfile';
import { buildRestrictedCodexConfigOverrides, resolveCodexRestriction, wrapCodexHostBindingsForRestriction } from '@nimbalyst/runtime/ai/server/providers/codex/codexTeamPolicy';
import { filterToolsForSession, isToolDeniedForSession, servesHostReadTools } from '../../../mcp/sessionToolPolicy';
import { isToolScopeEnforced } from '../../ai/childToolScope';
import { teamMemberProviderReadiness } from '../teamProviders';

const ADVISOR = { scope: 'read', role: 'advisor', provider: 'claude-code', workspaceRoot: null } as const;
const ADVISOR_CODEX = { scope: 'read', role: 'advisor', provider: 'openai-codex', workspaceRoot: null } as const;

/** The first-party MCP surface (every topology tool) as the host serves it to a session. */
function hostSurfaceFor(policy: { scope: 'read' | 'review' | 'write' | 'full'; role: 'advisor' | null; provider: string | null; workspaceRoot: string | null }): string[] {
  return MCP_FIRST_PARTY_TOPOLOGY.flatMap((server) =>
    filterToolsForSession(server.tools.map((name) => ({ name })), policy, { kind: 'firstParty', configKey: server.configKey })
      .map((tool) => `mcp__${server.configKey}__${tool.name}`),
  ).sort();
}

describe('the host surface of a read advisor is one surface, whatever the provider', () => {
  it('is exactly the first-party read allowlist minus the role\'s denials, the same list Claude Code\'s turn applies, whatever the provider', () => {
    const served = hostSurfaceFor(ADVISOR);
    expect(hostSurfaceFor(ADVISOR_CODEX)).toEqual(served);
    // Nothing served is denied by the Claude Code policy, and everything the
    // Claude Code policy denies among first-party tools is absent.
    const claudeDenied = new Set(mergeToolScopeDisallowedTools(undefined, 'read', [], 'advisor'));
    for (const tool of served) expect(claudeDenied.has(tool), tool).toBe(false);
    for (const tool of readScopeDeniedFirstPartyTools()) expect(served, tool).not.toContain(tool);
    for (const tool of ['mcp__nimbalyst__AskUserQuestion', 'mcp__nimbalyst__PromptForUserInput']) expect(served, tool).not.toContain(tool);
    // Sanity: the surface is non-trivial and read-only by inspection.
    expect(served).toContain('mcp__nimbalyst-trackers__tracker_get');
    expect(served).toContain('mcp__nimbalyst-host__ecc_catalog_lookup');
    expect(served).toContain('mcp__nimbalyst-host__get_session_result');
    for (const absent of [
      'mcp__nimbalyst-host__create_session', 'mcp__nimbalyst-host__spawn_session', 'mcp__nimbalyst-host__send_prompt', 'mcp__nimbalyst-host__respond_to_prompt',
      'mcp__nimbalyst-host__run_project_tests', 'mcp__nimbalyst-host__features_toggle', 'mcp__nimbalyst-host__workspace_set_trust',
      'mcp__nimbalyst-trackers__tracker_create', 'mcp__nimbalyst-trackers__tracker_update', 'mcp__nimbalyst-trackers__tracker_define_type', 'mcp__nimbalyst-trackers__tracker_link_session',
      'mcp__nimbalyst__developer_git_commit_proposal', 'mcp__nimbalyst__applyDiff', 'mcp__nimbalyst-situational__createSharedDoc', 'mcp__nimbalyst-situational__deleteSharedItem',
    ]) {
      expect(served, absent).not.toContain(absent);
    }
  });

  it('every capability a read advisor must not have is withheld on both providers, by a host or thread mechanism, never by the prompt', () => {
    const codex = resolveCodexRestriction('read', 'advisor');
    expect(codex.kind).toBe('restricted');
    const profile = resolveCodexPermissionProfile('bypass-all', true, 'read');
    const restrictedOverrides = buildRestrictedCodexConfigOverrides({ mcpServerNames: ['node_repl'], pluginIds: ['browser@openai-bundled'] });
    const bindings = wrapCodexHostBindingsForRestriction(undefined, () => true, () => {});
    const denied = (tool: string) => isToolDeniedForScope('read', tool, [], 'advisor');
    const hostDenied = (configKey: string, tool: string) => isToolDeniedForSession(ADVISOR, { kind: 'firstParty', configKey }, tool);

    const parity: Array<{ capability: string; claude: boolean; codex: boolean }> = [
      // File writes: Claude's native Write/Edit are SDK-denied; Codex's apply_patch needs an approval the host refuses, in a read-only sandbox.
      { capability: 'write files', claude: denied('Write') && denied('Edit') && denied('MultiEdit'), codex: profile.sandboxMode === 'read-only' && profile.approvalPolicy === 'untrusted' },
      // Shell: Claude's Bash/PowerShell are SDK-denied; Codex's shell tool is switched off in the process (verified through config/read), and any approval is refused anyway.
      { capability: 'arbitrary shell', claude: denied('Bash') && denied('PowerShell'), codex: profile.approvalPolicy === 'untrusted' && profile.sandboxMode === 'read-only' },
      // Delegation: both reach it only through the host's own tools, withheld by the same policy.
      { capability: 'delegate / create sessions', claude: denied('Agent') && denied('mcp__nimbalyst-host__create_session') && denied('mcp__nimbalyst-host__spawn_session'), codex: hostDenied('nimbalyst-host', 'create_session') && hostDenied('nimbalyst-host', 'spawn_session') },
      { capability: 'drive other sessions', claude: denied('mcp__nimbalyst-host__send_prompt') && denied('mcp__nimbalyst-host__respond_to_prompt'), codex: hostDenied('nimbalyst-host', 'send_prompt') && hostDenied('nimbalyst-host', 'respond_to_prompt') },
      { capability: 'tracker writes', claude: denied('mcp__nimbalyst-trackers__tracker_create') && denied('mcp__nimbalyst-trackers__tracker_update'), codex: hostDenied('nimbalyst-trackers', 'tracker_create') && hostDenied('nimbalyst-trackers', 'tracker_update') },
      { capability: 'commit', claude: denied('mcp__nimbalyst__developer_git_commit_proposal'), codex: hostDenied('nimbalyst', 'developer_git_commit_proposal') },
      { capability: 'app configuration', claude: denied('mcp__nimbalyst-host__features_toggle') && denied('Config'), codex: hostDenied('nimbalyst-host', 'features_toggle') },
      { capability: 'ask the user', claude: denied('AskUserQuestion') && denied('mcp__nimbalyst__AskUserQuestion'), codex: hostDenied('nimbalyst', 'AskUserQuestion') && hostDenied('nimbalyst', 'PromptForUserInput') },
      { capability: 'run the project tests', claude: denied('mcp__nimbalyst-host__run_project_tests'), codex: hostDenied('nimbalyst-host', 'run_project_tests') },
      // External MCP: Claude denies every non-first-party mcp__ tool and the snapshot is scoped; Codex gets the scoped snapshot and the user's own servers disabled.
      { capability: 'external MCP', claude: denied('mcp__some-user-server__tool'), codex: hostDenied('nimbalyst-x', 'tool') },
      { capability: 'web access', claude: denied('WebFetch') && denied('WebSearch'), codex: restrictedOverrides.web_search === 'disabled' },
      // Sub-agents: Claude's Agent/Task are SDK-denied; Codex's collaboration feature is switched off in the thread config, and an unknown (child) thread is refused by the wrapper.
      { capability: 'spawn sub-agents', claude: denied('Agent') && denied('Task'), codex: (restrictedOverrides.features as { multi_agent?: boolean })?.multi_agent === false },
    ];
    for (const row of parity) {
      expect(row.claude, `claude: ${row.capability}`).toBe(true);
      expect(row.codex, `codex: ${row.capability}`).toBe(true);
    }
    // And every approval a Codex thread could raise is refused, so an approval flow never widens the scope.
    return Promise.all([
      Promise.resolve(bindings.approveFileChange!({ threadId: 't' } as never)).then((r) => expect(r).toEqual({ decision: 'denied' })),
      Promise.resolve(bindings.approveCommandExecution!({ threadId: 't' } as never)).then((r) => expect(r).toEqual({ decision: 'denied' })),
      Promise.resolve(bindings.approvePermissions!({ threadId: 't' } as never)).then((r) => expect(r).toEqual({ decision: 'denied' })),
    ]);
  });

  it('and both keep the same reads: files (natively), tracker reads, manifest and note reads, the ECC catalog, session results', () => {
    const reads = ['tracker_get', 'tracker_list', 'tracker_get_by_urn', 'tracker_list_types'];
    for (const tool of reads) {
      expect(isToolDeniedForScope('read', `mcp__nimbalyst-trackers__${tool}`, [], 'advisor'), tool).toBe(false);
      expect(isToolDeniedForSession(ADVISOR, { kind: 'firstParty', configKey: 'nimbalyst-trackers' }, tool), tool).toBe(false);
    }
    for (const tool of ['ecc_catalog_lookup', 'get_session_result', 'get_session_status']) {
      expect(isToolDeniedForScope('read', `mcp__nimbalyst-host__${tool}`, [], 'advisor'), tool).toBe(false);
      expect(isToolDeniedForSession(ADVISOR, { kind: 'firstParty', configKey: 'nimbalyst-host' }, tool), tool).toBe(false);
    }
    expect(isToolDeniedForScope('read', 'Read', [], 'advisor')).toBe(false);
    expect(isToolDeniedForScope('read', 'Grep', [], 'advisor')).toBe(false);
    // File reads: Claude Code natively (Read/Glob/Grep); Codex through the host's read tools on the core endpoint, which Claude never needs.
    for (const tool of ['read_file', 'list_files', 'search_files']) {
      expect(isToolDeniedForSession(ADVISOR_CODEX, { kind: 'firstParty', configKey: 'nimbalyst' }, tool), tool).toBe(false);
    }
    expect(servesHostReadTools(ADVISOR_CODEX)).toBe(true);
    // Never listed for Claude Code (any scope), a full session or an unknown provider: the allowlist names them, the server decides who sees them.
    expect(servesHostReadTools(ADVISOR)).toBe(false);
    expect(servesHostReadTools({ scope: 'review', role: 'reviewer', provider: 'claude-code', workspaceRoot: null })).toBe(false);
    expect(servesHostReadTools({ scope: 'full', role: null, provider: 'openai-codex', workspaceRoot: null })).toBe(false);
    expect(servesHostReadTools({ scope: 'read', role: 'advisor', provider: null, workspaceRoot: null })).toBe(false);
  });

  it('the host declares both providers ready for a read member, and neither for a scope it cannot enforce on Codex', () => {
    expect(teamMemberProviderReadiness('claude-code', 'read')).toEqual({ ready: true });
    expect(teamMemberProviderReadiness('openai-codex', 'read')).toEqual({ ready: true });
    expect(isToolScopeEnforced('claude-code', 'read')).toBe(true);
    expect(isToolScopeEnforced('openai-codex', 'read')).toBe(true);
    expect(isToolScopeEnforced('openai-codex', 'write')).toBe(false);
    expect(teamMemberProviderReadiness('openai-codex', 'write').ready).toBe(false);
  });
});
