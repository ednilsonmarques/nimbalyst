/**
 * Tool policy constants for Claude Code provider.
 *
 * Keeping these lists centralized avoids burying policy data inside
 * large control-flow methods.
 *
 * Note: Planning mode tool restrictions are handled natively by the SDK
 * via `permissionMode: 'plan'`. No manual tool filtering is needed.
 */

import {
  MCP_CORE,
  MCP_EXTENSION_DEV,
  MCP_FIRST_PARTY_TOPOLOGY,
  MCP_HOST,
  MCP_SITUATIONAL,
  MCP_TRACKERS,
  isExtensionServerConfigKey,
  type McpServerTopologyEntry,
} from '../../services/mcpTopology';

// Internal Nimbalyst MCP tools that are auto-allowed (no permission prompt):
// they are display-only or confirm within their own widget, and the SDK's
// canUseTool path otherwise falls through to a dialog handler that has no UI for
// nimbalyst-owned tools — the Promise never resolves and the SDK surfaces "user
// cancelled MCP tool call" (issue #236, the kanban board appearing broken).
// Tool names follow the consolidated topology (mcp__<server>__<tool>).
export const INTERNAL_MCP_TOOLS: readonly string[] = [
  // Core (`nimbalyst`); some schemas defer through ToolSearch.
  'mcp__nimbalyst__update_session_meta',
  'mcp__nimbalyst__capture_editor_screenshot',
  'mcp__nimbalyst__display_to_user',
  'mcp__nimbalyst__get_session_edited_files',
  'mcp__nimbalyst__developer_git_commit_proposal',
  // git_log is served by the built-in Developer Tools extension, so it carries
  // the extension prefix (not core). Read-only → safe to auto-allow.
  'mcp__nimbalyst-developer__developer_git_log',
  // Situational (`nimbalyst-situational`) — voice.
  'mcp__nimbalyst-situational__voice_agent_speak',
  'mcp__nimbalyst-situational__voice_agent_stop',
  // Trackers (`nimbalyst-trackers`).
  'mcp__nimbalyst-trackers__tracker_list',
  'mcp__nimbalyst-trackers__tracker_ready',
  'mcp__nimbalyst-trackers__work_radar',
  'mcp__nimbalyst-trackers__tracker_get',
  'mcp__nimbalyst-trackers__tracker_list_types',
  'mcp__nimbalyst-trackers__tracker_create',
  'mcp__nimbalyst-trackers__tracker_update',
  'mcp__nimbalyst-trackers__tracker_link_session',
  'mcp__nimbalyst-trackers__tracker_unlink_session',
  'mcp__nimbalyst-trackers__tracker_link_file',
  'mcp__nimbalyst-trackers__tracker_add_comment',
  'mcp__nimbalyst-trackers__tracker_define_type',
  'mcp__nimbalyst-trackers__tracker_delete_type',
  // Host (`nimbalyst-host`) — session-context reads.
  'mcp__nimbalyst-host__get_session_summary',
  'mcp__nimbalyst-host__get_workstream_overview',
  'mcp__nimbalyst-host__list_recent_sessions',
  'mcp__nimbalyst-host__get_workstream_edited_files',
];

export const TEAM_TOOLS: readonly string[] = [
  'SendMessage',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
  'TeamCreate',
  'TeamDelete',
  'TeammateTool',
  'TodoRead',
  'TodoWrite',
];

/**
 * SDK-native tools that are executed by the Claude Code SDK itself (not by Nimbalyst).
 * AskUserQuestion is included because we handle it in canUseTool (user input, not local execution).
 * This list is the single source of truth — used for tool_use logging and tool_result logging.
 */
export const SDK_NATIVE_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'MultiEdit',
  'Glob', 'Grep', 'LS',
  'Bash',
  'WebFetch', 'WebSearch',
  'Task', 'Agent',  // Agent is the renamed Task tool (SDK 0.2.x+)
  'TaskOutput', 'TaskStop', 'ExitPlanMode', 'AskUserQuestion',
  'EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'Skill',
  'NotebookRead', 'NotebookEdit',
  'TodoRead', 'TodoWrite',
  'ToolSearch',
  // Task management tools (SDK-internal)
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList',
  // Agent Teams tools (SDK-internal, executed by CLI subprocess)
  'TeammateTool', 'SendMessage', 'TeamCreate', 'TeamDelete',
  // Claude Code 2.1.116+ additions (CLI-native, do NOT route through our toolHandler)
  'Monitor', 'PushNotification', 'RemoteTrigger',
  'CronCreate', 'CronDelete', 'CronList',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'Config', 'Mcp',
  // claude-agent-sdk 0.3.x additions (CLI-native multi-agent orchestration)
  'Workflow', 'REPL',
];

/**
 * Tools the CLI emits as tool_use but Nimbalyst services handle as a side effect
 * inside this provider (see the `tool_use` switch). Their tool_result from the CLI
 * is informational only -- routing them through `this.toolHandler` would throw
 * "Unknown tool", so we treat them like SDK_NATIVE_TOOLS for the warn/route check.
 */
export const NIMBALYST_HANDLED_TOOLS: readonly string[] = [
  'ScheduleWakeup',
];

/**
 * Capability scope a child session was created with (`metadata.toolScope`,
 * written by MetaAgentService.createChildSessionInternal). `full` or absent
 * means no restriction.
 */
export type ChildToolScope = 'read' | 'write' | 'full';

/**
 * Absent / `full` → full. Any other unrecognized value is treated as `read`:
 * a scope someone wrote but this build does not understand must not widen
 * into full access.
 */
export function resolveChildToolScope(raw: unknown): ChildToolScope {
  if (raw === 'read' || raw === 'write') return raw;
  if (raw === undefined || raw === null || raw === '' || raw === 'full') return 'full';
  return 'read';
}

// Anything that runs a process or schedules one. 'PowerShell' is the CLI's
// Windows shell tool; it is not in SDK_NATIVE_TOOLS but must be denied with Bash.
const RUN_TOOLS: readonly string[] = [
  'Bash', 'PowerShell', 'Monitor', 'REPL', 'EnterWorktree', 'CronCreate', 'RemoteTrigger',
];

// Anything that hands work to another agent, which has its own tools and could
// do what the scope denies this child: SDK sub-agents (denied until the SDK is
// shown to propagate disallowedTools to them), Agent Teams teammates, and the
// Nimbalyst host tools that create or drive other sessions (every claude-code
// session gets them, see MetaAgentService createChildSessionInternal).
const DELEGATION_TOOLS: readonly string[] = [
  'Agent', 'Task', 'Workflow',
  'TeamCreate', 'TeammateTool', 'SendMessage',
  mcpTool(MCP_HOST, 'create_session'),
  mcpTool(MCP_HOST, 'spawn_session'),
  mcpTool(MCP_HOST, 'send_prompt'),
  mcpTool(MCP_HOST, 'respond_to_prompt'),
];

const FILE_WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// Commits, and anything that changes CLI / app configuration, permissions or
// installed code. Denied to every scoped child, write included.
const CONFIG_AND_COMMIT_TOOLS: readonly string[] = [
  mcpTool(MCP_CORE, 'developer_git_commit_proposal'),
  'Config', 'Mcp',
  ...[
    'appearance_set_theme', 'appearance_set_completion_sound', 'appearance_set_spellcheck',
    'appearance_set_spellcheck_languages', 'ai_set_default_model', 'ai_set_preferred_language',
    'analytics_set_enabled', 'features_toggle', 'extension_set_enabled', 'sync_set_for_project',
    'workspace_create', 'workspace_open', 'workspace_set_trust',
  ].map((tool) => mcpTool(MCP_HOST, tool)),
  ...['tracker_set_sync_policy', 'tracker_set_issue_key_prefix', 'tracker_define_type', 'tracker_delete_type']
    .map((tool) => mcpTool(MCP_TRACKERS, tool)),
  ...[
    'database_query', 'extension_build', 'extension_install', 'extension_reload', 'extension_uninstall',
    'extension_test_ai_tool', 'extension_test_open_file', 'extension_test_run', 'renderer_eval', 'restart_nimbalyst',
  ].map((tool) => mcpTool(MCP_EXTENSION_DEV, tool)),
];

/**
 * First-party Nimbalyst tools a `read` child may keep: lookups, plus asking the
 * user, rendering output to them, and naming its own session (the system prompt
 * asks every session to call update_session_meta). Everything else on the
 * first-party servers is denied, so a tool added to the topology later is
 * read-denied until someone lists it here.
 */
const READ_SCOPE_ALLOWED_FIRST_PARTY_TOOLS: ReadonlySet<string> = new Set([
  ...['AskUserQuestion', 'PromptForUserInput', 'display_to_user', 'capture_editor_screenshot',
    'get_session_edited_files', 'update_session_meta'].map((tool) => mcpTool(MCP_CORE, tool)),
  ...['settings_get_overview', 'extensions_list', 'get_session_summary', 'get_session_coaching_signals',
    'get_workstream_overview', 'get_workstream_edited_files', 'list_recent_sessions', 'list_citable_inputs',
    'list_queued_prompts', 'get_session_status', 'get_session_result', 'list_spawned_sessions',
    'list_worktrees'].map((tool) => mcpTool(MCP_HOST, tool)),
  ...['tracker_list', 'tracker_ready', 'work_radar', 'tracker_get', 'tracker_get_by_urn', 'tracker_list_types',
    'tracker_importer_list', 'tracker_importer_search'].map((tool) => mcpTool(MCP_TRACKERS, tool)),
  ...['readCollabDoc', 'readCollabDocComments', 'listPages', 'findOrgMembers', 'getResourceSharingStatus',
    'feedback_anonymize_text', 'feedback_get_environment'].map((tool) => mcpTool(MCP_SITUATIONAL, tool)),
  ...['extension_get_status', 'get_environment_info', 'get_main_process_logs', 'get_renderer_debug_logs']
    .map((tool) => mcpTool(MCP_EXTENSION_DEV, tool)),
]);

function mcpTool(configKey: string, tool: string): string {
  return `mcp__${configKey}__${tool}`;
}

/** Every first-party tool a `read` child may not use (topology minus the read allowlist). */
export function readScopeDeniedFirstPartyTools(
  topology: readonly McpServerTopologyEntry[] = MCP_FIRST_PARTY_TOPOLOGY,
): string[] {
  return topology.flatMap((server) =>
    server.tools
      .map((tool) => mcpTool(server.configKey, tool))
      .filter((tool) => !READ_SCOPE_ALLOWED_FIRST_PARTY_TOOLS.has(tool)),
  );
}

/**
 * Native and Nimbalyst tools a Claude Code child must not see for its scope:
 * `read` investigates only; `write` may also edit files but runs, delegates,
 * commits and reconfigures nothing. User-configured MCP servers are not covered.
 */
export function toolScopeDeniedTools(scope: ChildToolScope): readonly string[] {
  if (scope === 'read') {
    return [...new Set([
      ...FILE_WRITE_TOOLS, ...RUN_TOOLS, ...DELEGATION_TOOLS, ...CONFIG_AND_COMMIT_TOOLS,
      ...readScopeDeniedFirstPartyTools(),
    ])];
  }
  if (scope === 'write') return [...RUN_TOOLS, ...DELEGATION_TOOLS, ...CONFIG_AND_COMMIT_TOOLS];
  return [];
}

/**
 * Merge the scope's denied tools into existing SDK `disallowedTools` without
 * dropping prior entries. For `read`, per-extension Nimbalyst servers
 * (`nimbalyst-<ext>`, dynamic, not in the topology) are denied whole, since
 * their tools are not known to be read-only.
 */
export function mergeToolScopeDisallowedTools(
  existing: readonly string[] | undefined,
  scope: ChildToolScope,
  mcpServerKeys: readonly string[] = [],
): string[] | undefined {
  const denied = [...toolScopeDeniedTools(scope)];
  if (scope === 'read') {
    denied.push(...mcpServerKeys.filter(isExtensionServerConfigKey).map((key) => `mcp__${key}`));
  }
  if (denied.length === 0) return existing ? [...existing] : undefined;
  return [...new Set([...(existing ?? []), ...denied])];
}
