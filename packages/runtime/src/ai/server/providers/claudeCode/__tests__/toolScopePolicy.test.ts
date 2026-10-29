import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECT_DENIED_TOOLS,
  READ_SCOPE_ALLOWED_NATIVE_TOOLS,
  RUN_PROJECT_TESTS_TOOL,
  PORTAL_OBSERVE_TOOLS,
  PORTAL_EXERCISE_TOOLS,
  PORTAL_TOOLS,
  teamRoleDeniedTools,
  teamRoleFrontDeniedTools,
  teamRoleRendererEvalDeniedTools,
  teamSessionDeniedTools,
  RENDERER_EVAL_TOOL,
  isReadScopeAllowedMcpTool,
  isToolDeniedForScope,
  mergeToolScopeDisallowedTools,
  readScopeDeniedFirstPartyTools,
  resolveChildToolScope,
  toolScopeDeniedTools,
  RESTRICTED_SCOPE_SETTINGS,
} from '../toolPolicy';

const FRONT_PROPOSE = 'mcp__nimbalyst-host__team_front_propose';
const RENDERER_EVAL = 'mcp__nimbalyst-extension-dev__renderer_eval';

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
      'mcp__nimbalyst-extension-dev__renderer_eval',
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

  it('only review and full can run the project tests; read and write cannot (write edits, it never executes)', () => {
    expect(toolScopeDeniedTools('read')).toContain(RUN_PROJECT_TESTS_TOOL);
    expect(toolScopeDeniedTools('write')).toContain(RUN_PROJECT_TESTS_TOOL);
    expect(toolScopeDeniedTools('review')).not.toContain(RUN_PROJECT_TESTS_TOOL);
    expect(toolScopeDeniedTools('full')).not.toContain(RUN_PROJECT_TESTS_TOOL);
    // The call-time guard agrees, role or no role.
    expect(isToolDeniedForScope('write', RUN_PROJECT_TESTS_TOOL)).toBe(true);
    expect(isToolDeniedForScope('write', RUN_PROJECT_TESTS_TOOL, [], 'implementer')).toBe(true);
    expect(isToolDeniedForScope('read', RUN_PROJECT_TESTS_TOOL, [], 'explorer')).toBe(true);
    expect(isToolDeniedForScope('review', RUN_PROJECT_TESTS_TOOL, [], 'reviewer')).toBe(false);
    expect(isToolDeniedForScope('full', RUN_PROJECT_TESTS_TOOL, [], 'implementer')).toBe(false);
    // The rest of write's contract is untouched: it still edits and reads trackers.
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'mcp__nimbalyst-trackers__tracker_create']) {
      expect(isToolDeniedForScope('write', tool), tool).toBe(false);
    }
  });
});

describe('review scope', () => {
  const review = toolScopeDeniedTools('review');

  it('is exactly read plus run_project_tests', () => {
    const read = toolScopeDeniedTools('read');
    expect(RUN_PROJECT_TESTS_TOOL).toBe('mcp__nimbalyst-host__run_project_tests');
    expect(review).not.toContain(RUN_PROJECT_TESTS_TOOL);
    // F1.2: a reviewer also keeps the portal observe + exercise tools (never portal_evaluate).
    const portalKept = [...PORTAL_OBSERVE_TOOLS, ...PORTAL_EXERCISE_TOOLS].map((tool) => `mcp__nimbalyst__${tool}`);
    expect([...review].sort()).toEqual(read.filter((tool) => tool !== RUN_PROJECT_TESTS_TOOL && !portalKept.includes(tool)).sort());
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

describe('network tools (Phase 0 hardening)', () => {
  it('read and review deny WebFetch and WebSearch; write and full do not', () => {
    for (const scope of ['read', 'review'] as const) {
      expect(toolScopeDeniedTools(scope), scope).toContain('WebFetch');
      expect(toolScopeDeniedTools(scope), scope).toContain('WebSearch');
    }
    expect(toolScopeDeniedTools('write')).not.toContain('WebFetch');
    expect(toolScopeDeniedTools('write')).not.toContain('WebSearch');
    expect(toolScopeDeniedTools('full')).toEqual([]);
  });

  it('every restricted scope denies worktree exits, scheduled runs, cron edits, push notifications, design sync and team deletion', () => {
    for (const scope of ['read', 'review', 'write'] as const) {
      for (const tool of ['ExitWorktree', 'ScheduleWakeup', 'CronDelete', 'PushNotification', 'DesignSync', 'TeamDelete']) {
        expect(toolScopeDeniedTools(scope), `${scope} ${tool}`).toContain(tool);
      }
    }
    // Read-only listings stay.
    expect(toolScopeDeniedTools('read')).not.toContain('CronList');
    expect(toolScopeDeniedTools('read')).not.toContain('ListAgents');
  });

  it('read and review deny Skill (skill frontmatter hooks run shell commands outside Bash) but keep ToolSearch', () => {
    for (const scope of ['read', 'review'] as const) {
      expect(toolScopeDeniedTools(scope), scope).toContain('Skill');
      expect(toolScopeDeniedTools(scope), scope).not.toContain('ToolSearch');
    }
    expect(toolScopeDeniedTools('write')).not.toContain('Skill');
  });
});

describe('isToolDeniedForScope (PreToolUse guard)', () => {
  it('fails closed on every MCP tool outside the first-party read allowlist', () => {
    for (const tool of [
      'mcp__plugin_ecc_chrome-devtools__navigate_page',
      'mcp__claude_ai_Supabase__execute_sql',
      'mcp__github__create_issue',
      'mcp__nimbalyst-excalidraw__draw',
      'mcp__nimbalyst-host__create_session',
      'mcp__nimbalyst-trackers__tracker_create',
      'mcp__nimbalyst-host__brand_new_tool_nobody_listed',
    ]) {
      expect(isToolDeniedForScope('read', tool), tool).toBe(true);
      expect(isToolDeniedForScope('review', tool), tool).toBe(true);
    }
  });

  it('keeps the first-party read tools, ToolSearch and plain reads, and denies Skill', () => {
    for (const tool of [
      'mcp__nimbalyst-trackers__tracker_get',
      'mcp__nimbalyst-trackers__tracker_list',
      'mcp__nimbalyst__update_session_meta',
      'mcp__nimbalyst-host__get_session_result',
      'Read', 'Grep', 'Glob', 'ToolSearch',
    ]) {
      expect(isToolDeniedForScope('read', tool), tool).toBe(false);
      expect(isToolDeniedForScope('review', tool), tool).toBe(false);
    }
    expect(isToolDeniedForScope('read', 'Skill')).toBe(true);
    expect(isToolDeniedForScope('review', 'Skill')).toBe(true);
    expect(isToolDeniedForScope('write', 'Skill')).toBe(false);
  });

  it('review may run the project tests; read may not', () => {
    expect(isToolDeniedForScope('review', RUN_PROJECT_TESTS_TOOL)).toBe(false);
    expect(isToolDeniedForScope('read', RUN_PROJECT_TESTS_TOOL)).toBe(true);
    expect(isReadScopeAllowedMcpTool(RUN_PROJECT_TESTS_TOOL, 'review')).toBe(true);
    expect(isReadScopeAllowedMcpTool(RUN_PROJECT_TESTS_TOOL, 'read')).toBe(false);
  });

  it('denies native tools by name, including web, and whole extension servers', () => {
    for (const tool of ['Bash', 'PowerShell', 'Agent', 'Task', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Workflow',
      'mcp__nimbalyst__developer_git_commit_proposal']) {
      expect(isToolDeniedForScope('read', tool), tool).toBe(true);
    }
    expect(isToolDeniedForScope('read', 'mcp__nimbalyst-slides__insert', ['nimbalyst-slides'])).toBe(true);
  });

  it('write denies execution and delegation but not its own writes or user MCP; full denies nothing', () => {
    expect(isToolDeniedForScope('write', 'Bash')).toBe(true);
    expect(isToolDeniedForScope('write', 'Agent')).toBe(true);
    expect(isToolDeniedForScope('write', 'Write')).toBe(false);
    expect(isToolDeniedForScope('write', 'WebFetch')).toBe(false);
    expect(isToolDeniedForScope('write', 'mcp__github__create_issue')).toBe(false);
    expect(isToolDeniedForScope('full', 'Bash')).toBe(false);
    expect(isToolDeniedForScope('full', 'mcp__plugin_ecc_chrome-devtools__navigate_page')).toBe(false);
  });
});

describe('isToolDeniedForScope native allowlist (fail-closed for read/review)', () => {
  it('denies a native tool nobody classified, in read and review', () => {
    for (const tool of ['BrandNewCliTool', 'Artifact', 'KillShell', 'Monitor', 'PushNotification']) {
      expect(isToolDeniedForScope('read', tool), tool).toBe(true);
      expect(isToolDeniedForScope('review', tool), tool).toBe(true);
    }
  });

  it('keeps the read-only natives, none of which the deny list names', () => {
    for (const tool of ['LS', 'LSP', 'NotebookRead', 'CronList', 'ListAgents', 'TaskStop', 'TaskOutput', 'TodoWrite', 'TaskCreate',
      'EnterPlanMode', 'ExitPlanMode', 'ToolSearch']) {
      expect(isToolDeniedForScope('read', tool), tool).toBe(false);
      expect(isToolDeniedForScope('review', tool), tool).toBe(false);
    }
    for (const tool of READ_SCOPE_ALLOWED_NATIVE_TOOLS) {
      expect(toolScopeDeniedTools('read'), tool).not.toContain(tool);
    }
  });

  it('write keeps its denylist semantics for natives', () => {
    expect(isToolDeniedForScope('write', 'BrandNewCliTool')).toBe(false);
    expect(isToolDeniedForScope('write', 'Bash')).toBe(true);
    expect(isToolDeniedForScope('write', 'PushNotification')).toBe(true);
  });
});

describe('RESTRICTED_SCOPE_SETTINGS', () => {
  it('turns off inline skill shell execution and every external hook for read/review children, nothing else', () => {
    expect(RESTRICTED_SCOPE_SETTINGS).toEqual({ disableSkillShellExecution: true, disableAllHooks: true });
    expect(Object.isFrozen(RESTRICTED_SCOPE_SETTINGS)).toBe(true);
  });
});

describe('architect role denials (Phase 1A)', () => {
  const architectOnly = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate',
    'mcp__nimbalyst__AskUserQuestion', 'mcp__nimbalyst__PromptForUserInput'];

  it('the architect loses exactly the question, plan-mode and task-creation tools, native and first-party', () => {
    expect([...ARCHITECT_DENIED_TOOLS].sort()).toEqual([...architectOnly].sort());
    expect(teamRoleDeniedTools('architect')).toBe(ARCHITECT_DENIED_TOOLS);
    for (const role of ['explorer', 'implementer', 'reviewer', 'other', null, undefined] as const) {
      expect(teamRoleDeniedTools(role), String(role)).toEqual([]);
    }
  });

  it('isToolDeniedForScope denies them for an architect in any scope, and nothing more than read denies otherwise', () => {
    for (const tool of architectOnly) {
      expect(isToolDeniedForScope('read', tool, [], 'architect'), tool).toBe(true);
      // Even a misconfigured architect (full scope) cannot ask or create tasks.
      expect(isToolDeniedForScope('full', tool, [], 'architect'), tool).toBe(true);
    }
    // What the read scope allows stays allowed for the architect: reads, discovery, bookkeeping reads, the private checklist.
    for (const tool of ['Read', 'Grep', 'Glob', 'ToolSearch', 'TaskList', 'TaskGet', 'TodoWrite', 'TaskStop', 'mcp__nimbalyst-trackers__tracker_get', 'mcp__nimbalyst__update_session_meta', 'mcp__nimbalyst__display_to_user']) {
      expect(isToolDeniedForScope('read', tool, [], 'architect'), tool).toBe(false);
    }
    // And everything the read scope denies stays denied: no delegation path at all.
    for (const tool of ['Agent', 'Task', 'Workflow', 'SendMessage', 'TeamCreate', 'Bash', 'Write', 'Skill', 'WebFetch',
      'mcp__nimbalyst-host__create_session', 'mcp__nimbalyst-host__spawn_session', 'mcp__nimbalyst-host__send_prompt', 'mcp__nimbalyst-host__respond_to_prompt',
      'mcp__github__create_issue', 'mcp__nimbalyst-slides__insert', 'BrandNewNativeTool']) {
      expect(isToolDeniedForScope('read', tool, ['nimbalyst-slides'], 'architect'), tool).toBe(true);
    }
  });

  it('an explorer (read) and a reviewer (review) keep AskUserQuestion, plan mode and the task tools', () => {
    for (const tool of architectOnly) {
      expect(isToolDeniedForScope('read', tool, [], 'explorer'), tool).toBe(false);
      expect(isToolDeniedForScope('read', tool), tool).toBe(false);
      expect(isToolDeniedForScope('review', tool, [], 'reviewer'), tool).toBe(false);
    }
    expect(toolScopeDeniedTools('read')).not.toContain('AskUserQuestion');
    expect(READ_SCOPE_ALLOWED_NATIVE_TOOLS.has('AskUserQuestion')).toBe(true);
  });

  it('mergeToolScopeDisallowedTools adds the architect denials to the read list and leaves other roles alone', () => {
    const architect = mergeToolScopeDisallowedTools(undefined, 'read', [], 'architect') ?? [];
    const explorer = mergeToolScopeDisallowedTools(undefined, 'read', [], 'explorer') ?? [];
    for (const tool of architectOnly) {
      expect(architect, tool).toContain(tool);
      expect(explorer, tool).not.toContain(tool);
    }
    expect(architect.filter((tool) => !architectOnly.includes(tool)).sort()).toEqual([...explorer].sort());
    // The role denies even without a restricting scope (defense in depth).
    expect(mergeToolScopeDisallowedTools(undefined, 'full', [], 'architect')).toEqual(expect.arrayContaining(architectOnly));
    // F1.2: an explorer carries no ask/plan denials, but it never gets a portal tool and loses browser.*.
    // F1.1: and no team member proposes fronts.
    expect(mergeToolScopeDisallowedTools(undefined, 'full', [], 'explorer')?.sort()).toEqual(
      [...PORTAL_TOOLS.map((tool) => `mcp__nimbalyst__${tool}`), 'mcp__nimbalyst-browser', FRONT_PROPOSE, RENDERER_EVAL].sort(),
    );
  });
});

describe('team_front_propose is for the coordinator only (F1.1)', () => {
  const roles = ['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other'] as const;

  it('every team child role is denied it, whatever its scope', () => {
    for (const role of roles) {
      expect(teamRoleFrontDeniedTools(role), role).toEqual([FRONT_PROPOSE]);
      for (const scope of ['read', 'review', 'write', 'full'] as const) {
        expect(isToolDeniedForScope(scope, FRONT_PROPOSE, [], role), `${role}/${scope}`).toBe(true);
        expect(mergeToolScopeDisallowedTools(undefined, scope, [], role) ?? [], `${role}/${scope}`).toContain(FRONT_PROPOSE);
      }
    }
  });

  it('a session without a team role (the root, or a solo session) is not denied it under full scope', () => {
    expect(teamRoleFrontDeniedTools(null)).toEqual([]);
    expect(teamRoleFrontDeniedTools(undefined)).toEqual([]);
    expect(isToolDeniedForScope('full', FRONT_PROPOSE, [], null)).toBe(false);
    expect(mergeToolScopeDisallowedTools(undefined, 'full', [], null)).toBeUndefined();
  });

  it('a read or review session is denied it even without a role (not on the read allowlist)', () => {
    expect(isToolDeniedForScope('read', FRONT_PROPOSE)).toBe(true);
    expect(isToolDeniedForScope('review', FRONT_PROPOSE)).toBe(true);
    expect(readScopeDeniedFirstPartyTools()).toContain(FRONT_PROPOSE);
  });

  it('leaves the architect and advisor ask/plan denial lists exactly as they were', () => {
    expect(teamRoleDeniedTools('architect')).not.toContain(FRONT_PROPOSE);
    expect(teamRoleDeniedTools('advisor')).not.toContain(FRONT_PROPOSE);
  });
});

describe('renderer_eval is denied to Team mode sessions (F1.1 S3b)', () => {
  const roles = ['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other'] as const;

  it('every member role is denied it, whatever its scope', () => {
    expect(RENDERER_EVAL_TOOL).toBe(RENDERER_EVAL);
    for (const role of roles) {
      expect(teamRoleRendererEvalDeniedTools(role), role).toEqual([RENDERER_EVAL]);
      for (const scope of ['read', 'review', 'write', 'full'] as const) {
        expect(isToolDeniedForScope(scope, RENDERER_EVAL, [], role), `${role}/${scope}`).toBe(true);
        expect(mergeToolScopeDisallowedTools(undefined, scope, [], role) ?? [], `${role}/${scope}`).toContain(RENDERER_EVAL);
      }
    }
  });

  it('the root, which has no member role, is covered by the session-level denial', () => {
    expect(teamSessionDeniedTools(true)).toEqual([RENDERER_EVAL]);
    expect(teamSessionDeniedTools(false)).toEqual([]);
  });

  it('a non-team session keeps renderer_eval, and no other extension-dev tool is denied to a team member by this rule', () => {
    expect(teamRoleRendererEvalDeniedTools(null)).toEqual([]);
    expect(isToolDeniedForScope('full', RENDERER_EVAL, [], null)).toBe(false);
    for (const role of roles) {
      expect(isToolDeniedForScope('full', 'mcp__nimbalyst-extension-dev__get_environment_info', [], role), role).toBe(false);
    }
  });
});

describe('the Claude turn applies the session-level renderer_eval denial (F1.1 S3b)', () => {
  const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');

  it('turnPrologue merges teamSessionDeniedTools(host.isTeamSession()) into the non-meta-agent disallowedTools', () => {
    const source = read('turnPrologue.ts');
    expect(source).toMatch(/teamSessionDeniedTools\(host\.isTeamSession\?\.\(\) === true\)/);
    expect(source).toMatch(/\(options as any\)\.disallowedTools = withTeamDenials/);
  });

  it('the provider answers isTeamSession from the frozen team context (root or member)', () => {
    const provider = fs.readFileSync(path.resolve(__dirname, '..', '..', 'ClaudeCodeProvider.ts'), 'utf8');
    expect(provider).toMatch(/isTeamSession: \(\) => this\.frozenTeamContext\.teamMode \|\| !!this\.frozenTeamContext\.teamChild/);
  });
});
