import { describe, expect, it } from 'vitest';
import {
  RUN_PROJECT_TESTS_TOOL,
  mergeToolScopeDisallowedTools,
  readScopeDeniedFirstPartyTools,
  resolveChildToolScope,
  toolScopeDeniedTools,
} from '../toolPolicy';

describe('resolveChildToolScope', () => {
  it('keeps read and write, and treats absent or full as full', () => {
    expect(resolveChildToolScope('read')).toBe('read');
    expect(resolveChildToolScope('write')).toBe('write');
    expect(resolveChildToolScope('full')).toBe('full');
    expect(resolveChildToolScope(undefined)).toBe('full');
    expect(resolveChildToolScope(null)).toBe('full');
    expect(resolveChildToolScope('')).toBe('full');
  });

  it('fails closed: an unrecognized scope becomes read, never full', () => {
    expect(resolveChildToolScope('READ')).toBe('read');
    expect(resolveChildToolScope('readonly')).toBe('read');
    expect(resolveChildToolScope(42)).toBe('read');
    expect(resolveChildToolScope('REVIEW')).toBe('read');
    expect(resolveChildToolScope('admin')).toBe('read');
  });
});

describe('toolScopeDeniedTools', () => {
  it('read denies file writes, shells, sub-agents and commits', () => {
    const denied = toolScopeDeniedTools('read');
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'Agent', 'Task',
      'mcp__nimbalyst__developer_git_commit_proposal']) {
      expect(denied, tool).toContain(tool);
    }
    expect(denied).not.toContain('Read');
    expect(denied).not.toContain('Grep');
  });

  it('read denies Nimbalyst tools that change app state', () => {
    const denied = toolScopeDeniedTools('read');
    for (const tool of [
      'mcp__nimbalyst-trackers__tracker_create',
      'mcp__nimbalyst-trackers__tracker_update',
      'mcp__nimbalyst-trackers__tracker_link_session',
      'mcp__nimbalyst-trackers__tracker_add_comment',
      'mcp__nimbalyst-trackers__tracker_import',
      'mcp__nimbalyst-host__appearance_set_theme',
      'mcp__nimbalyst-host__ai_set_default_model',
      'mcp__nimbalyst-host__workspace_create',
      'mcp__nimbalyst-host__workspace_open',
      'mcp__nimbalyst-host__schedule_wakeup',
      'mcp__nimbalyst-host__update_session_board',
      'mcp__nimbalyst-host__notify_user',
      'mcp__nimbalyst-situational__applyCollabDocEdit',
      'mcp__nimbalyst-situational__createSharedDoc',
      'mcp__nimbalyst-situational__deleteSharedItem',
      'mcp__nimbalyst-situational__feedback_open_github_issue',
      'mcp__nimbalyst-situational__voice_agent_speak',
      'mcp__nimbalyst-extension-dev__renderer_eval',
      'mcp__nimbalyst-extension-dev__database_query',
    ]) {
      expect(denied, tool).toContain(tool);
    }
  });

  it('read keeps lookups, asking the user, rendering output and naming its own session', () => {
    const denied = toolScopeDeniedTools('read');
    for (const tool of [
      'mcp__nimbalyst__AskUserQuestion',
      'mcp__nimbalyst__display_to_user',
      'mcp__nimbalyst__update_session_meta',
      'mcp__nimbalyst-host__get_session_result',
      'mcp__nimbalyst-host__list_worktrees',
      'mcp__nimbalyst-trackers__tracker_get',
      'mcp__nimbalyst-trackers__tracker_list',
      'mcp__nimbalyst-situational__readCollabDoc',
    ]) {
      expect(denied, tool).not.toContain(tool);
    }
  });

  it('read denies a first-party tool the allowlist has never seen', () => {
    const denied = readScopeDeniedFirstPartyTools([
      { configKey: 'nimbalyst-host', endpointPath: '/mcp/host', loadPolicy: 'deferred', optOutUnit: 'x',
        tools: ['get_session_result', 'brand_new_mutation'] },
    ]);
    expect(denied).toEqual(['mcp__nimbalyst-host__brand_new_mutation']);
  });

  it('write keeps file edits and tracker work, but denies shells, sub-agents, commits and app config', () => {
    const denied = toolScopeDeniedTools('write');
    for (const tool of [
      'Bash', 'PowerShell', 'Agent', 'mcp__nimbalyst__developer_git_commit_proposal',
      'mcp__nimbalyst-host__appearance_set_theme',
      'mcp__nimbalyst-host__ai_set_default_model',
      'mcp__nimbalyst-host__workspace_set_trust',
      'mcp__nimbalyst-host__workspace_create',
      'mcp__nimbalyst-trackers__tracker_set_sync_policy',
      'mcp__nimbalyst-extension-dev__extension_install',
      'mcp__nimbalyst-extension-dev__restart_nimbalyst',
    ]) {
      expect(denied, tool).toContain(tool);
    }
    for (const tool of ['Write', 'Edit', 'mcp__nimbalyst-trackers__tracker_create', 'mcp__nimbalyst-host__schedule_wakeup']) {
      expect(denied, tool).not.toContain(tool);
    }
  });

  it.each(['read', 'write'] as const)('%s closes every route to another agent', (scope) => {
    const denied = toolScopeDeniedTools(scope);
    for (const tool of [
      'TeamCreate', 'TeammateTool', 'SendMessage',
      'mcp__nimbalyst-host__create_session',
      'mcp__nimbalyst-host__spawn_session',
      'mcp__nimbalyst-host__send_prompt',
      'mcp__nimbalyst-host__respond_to_prompt',
      'Config', 'mcp__nimbalyst-host__features_toggle',
    ]) {
      expect(denied, tool).toContain(tool);
    }
  });

  it('full denies nothing', () => {
    expect(toolScopeDeniedTools('full')).toEqual([]);
  });

  it('read cannot run the project tests; write and full can', () => {
    expect(toolScopeDeniedTools('read')).toContain(RUN_PROJECT_TESTS_TOOL);
    expect(toolScopeDeniedTools('write')).not.toContain(RUN_PROJECT_TESTS_TOOL);
    expect(toolScopeDeniedTools('full')).not.toContain(RUN_PROJECT_TESTS_TOOL);
  });
});

describe('review scope', () => {
  const review = toolScopeDeniedTools('review');

  it('is exactly read plus run_project_tests', () => {
    const read = toolScopeDeniedTools('read');
    expect(RUN_PROJECT_TESTS_TOOL).toBe('mcp__nimbalyst-host__run_project_tests');
    expect(review).not.toContain(RUN_PROJECT_TESTS_TOOL);
    expect([...review].sort()).toEqual(read.filter((tool) => tool !== RUN_PROJECT_TESTS_TOOL).sort());
  });

  it('denies every shell, file edit, delegation, commit and config route', () => {
    for (const tool of [
      'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
      'Bash', 'PowerShell', 'REPL', 'Monitor', 'EnterWorktree', 'CronCreate', 'RemoteTrigger',
      'Agent', 'Task', 'Workflow', 'TeamCreate', 'TeammateTool', 'SendMessage',
      'mcp__nimbalyst-host__create_session', 'mcp__nimbalyst-host__spawn_session',
      'mcp__nimbalyst-host__send_prompt', 'mcp__nimbalyst-host__respond_to_prompt',
      'mcp__nimbalyst__developer_git_commit_proposal', 'Config', 'Mcp',
      'mcp__nimbalyst-host__features_toggle', 'mcp__nimbalyst-host__workspace_set_trust',
      'mcp__nimbalyst-trackers__tracker_create', 'mcp__nimbalyst-trackers__tracker_define_type',
      'mcp__nimbalyst-extension-dev__extension_install', 'mcp__nimbalyst-extension-dev__renderer_eval',
    ]) {
      expect(review, tool).toContain(tool);
    }
  });

  it('keeps reading and the read-only Nimbalyst lookups', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'mcp__nimbalyst-trackers__tracker_get',
      'mcp__nimbalyst-host__get_session_result', 'mcp__nimbalyst__update_session_meta']) {
      expect(review, tool).not.toContain(tool);
    }
  });

  it('is recognized, not failed closed to read', () => {
    expect(resolveChildToolScope('review')).toBe('review');
  });

  it('denies per-extension servers wholesale, like read', () => {
    const merged = mergeToolScopeDisallowedTools(undefined, 'review', ['nimbalyst-host', 'nimbalyst-excalidraw'])!;
    expect(merged).toContain('mcp__nimbalyst-excalidraw');
    expect(merged).not.toContain('mcp__nimbalyst-host');
    expect(merged).not.toContain(RUN_PROJECT_TESTS_TOOL);
  });
});

describe('mergeToolScopeDisallowedTools', () => {
  it('leaves options untouched for a full scope', () => {
    expect(mergeToolScopeDisallowedTools(undefined, 'full', ['nimbalyst-excalidraw'])).toBeUndefined();
    expect(mergeToolScopeDisallowedTools(['Foo'], 'full')).toEqual(['Foo']);
  });

  it('keeps existing entries and does not duplicate', () => {
    const merged = mergeToolScopeDisallowedTools(['Foo', 'Bash'], 'write')!;
    expect(merged).toContain('Foo');
    expect(merged.filter((tool) => tool === 'Bash')).toHaveLength(1);
  });

  it('read denies whole per-extension servers, but not first-party or user servers', () => {
    const merged = mergeToolScopeDisallowedTools(undefined, 'read',
      ['nimbalyst', 'nimbalyst-host', 'nimbalyst-excalidraw', 'github'])!;
    expect(merged).toContain('mcp__nimbalyst-excalidraw');
    expect(merged).not.toContain('mcp__nimbalyst');
    expect(merged).not.toContain('mcp__nimbalyst-host');
    expect(merged).not.toContain('mcp__github');
  });

  it('write does not deny extension servers wholesale', () => {
    const merged = mergeToolScopeDisallowedTools(undefined, 'write', ['nimbalyst-excalidraw'])!;
    expect(merged).not.toContain('mcp__nimbalyst-excalidraw');
  });
});
