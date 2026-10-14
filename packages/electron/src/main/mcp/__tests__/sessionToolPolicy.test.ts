// @vitest-environment node
/**
 * The unified MCP server's per-session tool policy: the same scope rules
 * Claude Code's turn applies, read from the session row and applied to the
 * catalog (ListTools) and to calls (CallTool) for every provider. Fail-closed
 * when the row cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn() },
}));

import {
  SESSION_TOOL_POLICY_UNAVAILABLE,
  UNRESTRICTED_TOOL_POLICY,
  filterToolsForSession,
  isToolDeniedForSession,
  policyToolName,
  resetSessionToolPolicies,
  resolveSessionToolPolicy,
  servesHostReadTools,
  sessionToolDenial,
  setSessionToolPolicyReader,
} from '../sessionToolPolicy';
import type { McpEndpointSelection } from '../mcpEndpointRouting';

const HOST: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst-host' };
const CORE: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst' };
const TRACKERS: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst-trackers' };
const EXTENSION: McpEndpointSelection = { kind: 'extension', extensionShortName: 'browser' };
const ADVISOR_READ = { scope: 'read', role: 'advisor', provider: 'claude-code' } as const;
const ADVISOR_CODEX = { scope: 'read', role: 'advisor', provider: 'openai-codex' } as const;
const REVIEWER = { scope: 'review', role: 'reviewer', provider: 'claude-code' } as const;
const IMPLEMENTER_FULL = { scope: 'full', role: 'implementer', provider: 'claude-code' } as const;

const tool = (name: string) => ({ name, description: name, inputSchema: {} });

beforeEach(() => {
  resetSessionToolPolicies();
});

afterEach(() => {
  setSessionToolPolicyReader(null);
});

describe('policy names and denials', () => {
  it('names a tool the way the scope policy knows it: mcp__<configKey>__<tool>', () => {
    expect(policyToolName(HOST, 'create_session')).toBe('mcp__nimbalyst-host__create_session');
    expect(policyToolName(EXTENSION, 'open')).toBe('mcp__nimbalyst-browser__open');
    expect(policyToolName({ kind: 'legacy' }, 'x')).toBe('mcp__nimbalyst-fallback__x');
  });

  it('a read advisor is denied every mutable, delegating or asking host tool and keeps the reads', () => {
    for (const name of ['create_session', 'spawn_session', 'send_prompt', 'respond_to_prompt', 'run_project_tests', 'features_toggle', 'workspace_set_trust', 'ai_set_default_model']) {
      expect(isToolDeniedForSession(ADVISOR_READ, HOST, name), name).toBe(true);
    }
    for (const name of ['get_session_result', 'get_session_status', 'list_spawned_sessions', 'ecc_catalog_lookup', 'get_session_summary']) {
      expect(isToolDeniedForSession(ADVISOR_READ, HOST, name), name).toBe(false);
    }
    for (const name of ['tracker_create', 'tracker_update', 'tracker_define_type', 'tracker_delete_type', 'tracker_link_session', 'tracker_add_comment']) {
      expect(isToolDeniedForSession(ADVISOR_READ, TRACKERS, name), name).toBe(true);
    }
    for (const name of ['tracker_get', 'tracker_list', 'tracker_get_by_urn', 'tracker_list_types', 'work_radar']) {
      expect(isToolDeniedForSession(ADVISOR_READ, TRACKERS, name), name).toBe(false);
    }
    for (const name of ['developer_git_commit_proposal', 'AskUserQuestion', 'PromptForUserInput', 'applyDiff', 'streamContent']) {
      expect(isToolDeniedForSession(ADVISOR_READ, CORE, name), name).toBe(true);
    }
    for (const name of ['update_session_meta', 'display_to_user', 'get_session_edited_files', 'capture_editor_screenshot']) {
      expect(isToolDeniedForSession(ADVISOR_READ, CORE, name), name).toBe(false);
    }
    // Extension servers are denied whole under read, whatever the tool.
    expect(isToolDeniedForSession(ADVISOR_READ, EXTENSION, 'read_page')).toBe(true);
  });

  it('a reviewer keeps the test runner and loses the rest; a full implementer loses nothing; a read explorer may still ask the user', () => {
    expect(isToolDeniedForSession(REVIEWER, HOST, 'run_project_tests')).toBe(false);
    expect(isToolDeniedForSession(REVIEWER, HOST, 'create_session')).toBe(true);
    expect(isToolDeniedForSession(IMPLEMENTER_FULL, HOST, 'create_session')).toBe(false);
    expect(isToolDeniedForSession(IMPLEMENTER_FULL, EXTENSION, 'anything')).toBe(false);
    expect(isToolDeniedForSession(UNRESTRICTED_TOOL_POLICY, CORE, 'developer_git_commit_proposal')).toBe(false);
    expect(isToolDeniedForSession({ scope: 'read', role: 'explorer', provider: 'claude-code' }, CORE, 'AskUserQuestion')).toBe(false);
    expect(isToolDeniedForSession({ scope: 'read', role: 'architect', provider: 'claude-code' }, CORE, 'AskUserQuestion')).toBe(true);
  });

  it('the host\'s file reads are allowed under read, and served only to a restricted member without native reads (not claude-code, not full, not unknown)', () => {
    for (const name of ['read_file', 'list_files', 'search_files']) {
      expect(isToolDeniedForSession(ADVISOR_CODEX, CORE, name), name).toBe(false);
      expect(isToolDeniedForSession(ADVISOR_READ, CORE, name), name).toBe(false);
    }
    expect(servesHostReadTools(ADVISOR_CODEX)).toBe(true);
    expect(servesHostReadTools({ scope: 'review', role: 'reviewer', provider: 'openai-codex' })).toBe(true);
    expect(servesHostReadTools(ADVISOR_READ)).toBe(false);
    expect(servesHostReadTools(REVIEWER)).toBe(false);
    expect(servesHostReadTools({ scope: 'full', role: null, provider: 'openai-codex' })).toBe(false);
    expect(servesHostReadTools({ scope: 'write', role: 'implementer', provider: 'openai-codex' })).toBe(false);
    expect(servesHostReadTools({ scope: 'read', role: 'advisor', provider: null })).toBe(false);
    expect(servesHostReadTools(UNRESTRICTED_TOOL_POLICY)).toBe(false);
  });

  it('filters a catalog the same way, keeping the order; an unrestricted policy copies it', () => {
    const catalog = [tool('create_session'), tool('get_session_result'), tool('send_prompt'), tool('ecc_catalog_lookup')];
    expect(filterToolsForSession(catalog, ADVISOR_READ, HOST).map((t) => t.name)).toEqual(['get_session_result', 'ecc_catalog_lookup']);
    expect(filterToolsForSession(catalog, UNRESTRICTED_TOOL_POLICY, HOST)).toEqual(catalog);
  });

  it('a denial is an error result in the role\'s own words when the role denies it, in the scope\'s otherwise, and never an execution', () => {
    const asking = sessionToolDenial(ADVISOR_READ, CORE, 'AskUserQuestion');
    expect(asking.isError).toBe(true);
    expect(asking.content[0].text).toContain('This session is the team\'s advisor, which gives an independent opinion and never asks the user');
    const writing = sessionToolDenial(ADVISOR_READ, TRACKERS, 'tracker_update');
    expect(writing.content[0].text).toBe('Error: Tool "tracker_update" is not available to this session: its tool scope is read, which does not include it. Nothing was executed.');
  });
});

describe('resolveSessionToolPolicy', () => {
  it('reads scope, role and provider from the session row once and freezes them', async () => {
    const get = vi.fn(async () => ({ agentRole: 'standard', provider: 'openai-codex', metadata: { toolScope: 'read', teamChild: { role: 'advisor', rootSessionId: 'root', depth: 1 } } }));
    setSessionToolPolicyReader(get);
    expect(await resolveSessionToolPolicy('adv')).toEqual({ scope: 'read', role: 'advisor', provider: 'openai-codex' });
    expect(await resolveSessionToolPolicy('adv')).toEqual({ scope: 'read', role: 'advisor', provider: 'openai-codex' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('no session id, no row, no scope: unrestricted; a missing row is never frozen', async () => {
    const rows: Record<string, unknown> = { plain: { agentRole: 'standard', provider: 'claude-code', metadata: {} } };
    const get = vi.fn(async (id: string) => rows[id] ?? null);
    setSessionToolPolicyReader(get as never);
    expect(await resolveSessionToolPolicy(undefined)).toEqual(UNRESTRICTED_TOOL_POLICY);
    expect(await resolveSessionToolPolicy('late')).toEqual(UNRESTRICTED_TOOL_POLICY);
    expect(await resolveSessionToolPolicy('plain')).toEqual({ scope: 'full', role: null, provider: 'claude-code' });
    // The row appears later (a connection that raced its own creation): the next read sees it.
    rows.late = { agentRole: 'standard', provider: 'openai-codex', metadata: { toolScope: 'read' } };
    expect(await resolveSessionToolPolicy('late')).toEqual({ scope: 'read', role: null, provider: 'openai-codex' });
    expect(get.mock.calls.filter(([id]) => id === 'late')).toHaveLength(2);
  });

  it('an unknown scope value fails closed to read; a meta-agent has no team role; a missing provider is null', async () => {
    setSessionToolPolicyReader(vi.fn(async (id: string) => (id === 'odd'
      ? { agentRole: 'standard', metadata: { toolScope: 'admin' } }
      : { agentRole: 'meta-agent', provider: 'claude-code', metadata: { teamChild: { role: 'advisor', rootSessionId: 'root', depth: 1 } } })));
    expect(await resolveSessionToolPolicy('odd')).toEqual({ scope: 'read', role: null, provider: null });
    expect(await resolveSessionToolPolicy('meta')).toEqual({ scope: 'full', role: null, provider: 'claude-code' });
  });

  it('a row that cannot be read (after one retry) rejects, is not frozen, and is read again next time', async () => {
    const get = vi.fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue({ agentRole: 'standard', metadata: { toolScope: 'read' } });
    setSessionToolPolicyReader(get);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(resolveSessionToolPolicy('flaky')).rejects.toThrow(SESSION_TOOL_POLICY_UNAVAILABLE);
    expect(get).toHaveBeenCalledTimes(2);
    expect(await resolveSessionToolPolicy('flaky')).toEqual({ scope: 'read', role: null, provider: null });
    expect(get).toHaveBeenCalledTimes(3);
    errorSpy.mockRestore();
  });
});
