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
import type { TeamRole } from '../teamContext';

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
  // Host — the packaged ECC catalog (Phase 1B): read-only passive data, no
  // workspace access, no execution; the scope policy still decides who sees it.
  'mcp__nimbalyst-host__ecc_catalog_lookup',
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
 * means no restriction. `review` is `read` plus the one execution a reviewer
 * needs: the workspace's own test command through `run_project_tests`.
 */
export type ChildToolScope = 'read' | 'review' | 'write' | 'full';

/**
 * Absent / `full` → full. Any other unrecognized value is treated as `read`:
 * a scope someone wrote but this build does not understand must not widen
 * into full access.
 */
export function resolveChildToolScope(raw: unknown): ChildToolScope {
  if (raw === 'read' || raw === 'review' || raw === 'write') return raw;
  if (raw === undefined || raw === null || raw === '' || raw === 'full') return 'full';
  return 'read';
}

// Anything that runs a process, schedules one, or moves the session to another
// working tree. 'PowerShell' is the CLI's Windows shell tool; it is not in
// SDK_NATIVE_TOOLS but must be denied with Bash. The scope probe
// (scripts/team-scope-probe.mjs) showed ExitWorktree, ScheduleWakeup and
// CronDelete in a restricted session's tool list, so they are named here too.
const RUN_TOOLS: readonly string[] = [
  'Bash', 'PowerShell', 'Monitor', 'REPL', 'EnterWorktree', 'ExitWorktree',
  'CronCreate', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger',
];

// Anything that reaches the user's other surfaces or an external design tool.
const OUTWARD_TOOLS: readonly string[] = ['PushNotification', 'DesignSync'];

// Skills. Denied to read/review children because a skill file may declare its
// own lifecycle hooks (`hooks:` in the frontmatter), and a hook command runs
// through the CLI, not through the Bash tool the scope denies: the scope probe
// (scripts/team-scope-probe.mjs, case P2b, 2026-10-12) saw such a hook write a
// file while Bash was denied and `disableSkillShellExecution` was on. Until the
// CLI offers a per-session way to keep skill hooks from running, a restricted
// child gets skill content only through its brief or system prompt.
const SKILL_TOOLS: readonly string[] = ['Skill'];

/**
 * Tools the `architect` team member loses on top of its (forced) `read` scope.
 * The architect prepares work and never asks the user, delegates or creates
 * tasks, and the contract is technical, not a prompt instruction:
 *
 * - AskUserQuestion (native) and the first-party AskUserQuestion /
 *   PromptForUserInput: a question from a member becomes an `ACTION REQUIRED`
 *   for its coordinator, which inverts the authority. The architect writes its
 *   doubts in the manifest's openQuestions instead.
 * - EnterPlanMode / ExitPlanMode: ExitPlanMode is an approval prompt to the
 *   user; the architect's plan is the manifest text, never a plan-mode plan.
 * - TaskCreate / TaskUpdate: the session task list the CLI shares with Agent
 *   Teams teammates; TaskCreate creates a work item and TaskUpdate can assign
 *   an `owner` (SDK 0.3.284 TaskUpdateInput). Creating or assigning work is
 *   delegation in form, even with teammates denied. TaskList and TaskGet
 *   (reads) stay, and so does TodoWrite on paper, although CLI 2.1.284 does
 *   not expose it next to the task tools (probe P8); Agent (alias Task),
 *   Workflow and SendMessage are already denied by the read scope.
 *
 * Applied by `mergeToolScopeDisallowedTools` (SDK `disallowedTools`) and by
 * `isToolDeniedForScope` (the PreToolUse guard) whenever the session's team
 * role is `architect`, whatever its scope says. The probe mirrors the native
 * names as ARCHITECT_DENY_NATIVE (two-way unit test).
 */
export const ARCHITECT_DENIED_TOOLS: readonly string[] = [
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TaskCreate', 'TaskUpdate',
  mcpTool(MCP_CORE, 'AskUserQuestion'),
  mcpTool(MCP_CORE, 'PromptForUserInput'),
];

/**
 * Tools the `advisor` team member (Consultor Independente) loses on top of its
 * (forced) `read` scope: the same list as the architect, for the same reason.
 * The advisor's authority is nil by design: it may question anything and ask
 * its coordinator for more evidence in its report, but a question to the user
 * (AskUserQuestion, PromptForUserInput), a plan-mode approval or a task it
 * creates or assigns would be an operational act, which it has none of. Its
 * doubts go into its opinion, labelled doubt. The read scope already withholds
 * edits, shell, sub-agents, sessions, prompts to other sessions, permission
 * answers, tracker writes, config, commits and every external MCP server.
 */
export const ADVISOR_DENIED_TOOLS: readonly string[] = ARCHITECT_DENIED_TOOLS;

/** Extra denials a team role carries on top of its scope; the architect and the advisor have the same ones. */
export function teamRoleDeniedTools(role: TeamRole | null | undefined): readonly string[] {
  if (role === 'architect') return ARCHITECT_DENIED_TOOLS;
  if (role === 'advisor') return ADVISOR_DENIED_TOOLS;
  return [];
}

/**
 * What the PreToolUse guard tells a member whose role denies `toolName`: the
 * same denial, a reason in the role's own terms (an architect writes its
 * question in the manifest; an advisor puts its doubt in its opinion).
 */
export function teamRoleDenialReason(role: TeamRole, toolName: string): string {
  if (role === 'advisor') {
    return `This session is the team's advisor, which gives an independent opinion and never asks the user, delegates or creates tasks; ${toolName} is not available. Put the doubt, or the request for more evidence, in your opinion instead.`;
  }
  return `This session is the team's ${role}, which prepares work and never asks the user, delegates or creates tasks; ${toolName} is not available. Write the question or the task in your Tool Manifest instead.`;
}

/**
 * The `settings` overlay sdkOptionsBuilder passes for read/review children.
 *
 * - disableSkillShellExecution: a skill or command body can run shell commands
 *   while it renders (the inline `!` form); the CLI replaces them with a
 *   placeholder (scope probe P2c and P6b, 2026-10-13).
 * - disableAllHooks: hooks declared in user, project and local settings, in
 *   plugins and in skill frontmatter run shell commands outside every tool the
 *   scope denies, triggered by the child's own allowed tool calls and even by
 *   the prompt itself; a PreToolUse guard cannot stop them because the hook
 *   runs whether or not the tool is denied (probe P7). With this flag the CLI
 *   runs none of them while still honouring the SDK's own PreToolUse callbacks
 *   and the enterprise's managed hooks (probe P7b).
 *
 * The probe mirrors this object as SHIPPED_RESTRICTED_SETTINGS; a two-way unit
 * test keeps them equal.
 */
export const RESTRICTED_SCOPE_SETTINGS = Object.freeze({
  disableSkillShellExecution: true,
  disableAllHooks: true,
});

// Anything that hands work to another agent, which has its own tools and could
// do what the scope denies this child: SDK sub-agents (denied until the SDK is
// shown to propagate disallowedTools to them), Agent Teams teammates, and the
// Nimbalyst host tools that create or drive other sessions (every claude-code
// session gets them, see MetaAgentService createChildSessionInternal).
const DELEGATION_TOOLS: readonly string[] = [
  'Agent', 'Task', 'Workflow',
  'TeamCreate', 'TeamDelete', 'TeammateTool', 'SendMessage',
  mcpTool(MCP_HOST, 'create_session'),
  mcpTool(MCP_HOST, 'spawn_session'),
  mcpTool(MCP_HOST, 'send_prompt'),
  mcpTool(MCP_HOST, 'respond_to_prompt'),
];

const FILE_WRITE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// Outbound web access. Denied to read/review children: a fetch to an arbitrary
// URL is an exfiltration channel for whatever the child has read, fetched
// content is an injection surface, and neither is needed to investigate or
// review a repository. A later scope may re-enable it per domain
// (`WebFetch(domain:...)` rules); it is never on by default.
const NETWORK_TOOLS: readonly string[] = ['WebFetch', 'WebSearch'];

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
 * The host's read-only file tools (electron mcp/devAgentTools.ts), as the core
 * MCP endpoint names them for a restricted member without native reads.
 */
export const HOST_READ_TOOLS: readonly string[] = ['read_file', 'list_files', 'search_files'];

/**
 * The `portal_*` tools (core endpoint, executed in main over BrowserAuthority):
 * observe = open/navigate/list/screenshot/page_info/close, exercise =
 * click/type/scroll, evaluate = arbitrary script in the page. The scope matrix:
 * read and the explorer/architect/advisor roles get none; review (reviewer) and
 * write (implementer) get observe + exercise; only full gets evaluate. The
 * click/type/evaluate tools additionally need the user-only test-data mark,
 * which main checks at execution (services/portalTestData.ts).
 */
export const PORTAL_OBSERVE_TOOLS: readonly string[] = [
  'portal_open', 'portal_navigate', 'portal_list', 'portal_screenshot', 'portal_page_info', 'portal_close',
];
export const PORTAL_EXERCISE_TOOLS: readonly string[] = ['portal_click', 'portal_type', 'portal_scroll'];
export const PORTAL_EVALUATE_TOOL = 'portal_evaluate';
export const PORTAL_TOOLS: readonly string[] = [...PORTAL_OBSERVE_TOOLS, ...PORTAL_EXERCISE_TOOLS, PORTAL_EVALUATE_TOOL];

/** Config key of the browser extension's MCP server; its tools are the legacy `browser.*`. */
const BROWSER_EXTENSION_SERVER = 'mcp__nimbalyst-browser';

const PORTAL_OBSERVE_EXERCISE_NAMES: ReadonlySet<string> = new Set(
  [...PORTAL_OBSERVE_TOOLS, ...PORTAL_EXERCISE_TOOLS].map((tool) => mcpTool(MCP_CORE, tool)),
);

/**
 * Portal and browser denials a team role carries whatever its scope says: the
 * explorer, architect and advisor never drive a browser; a reviewer never
 * evaluates; and every team member loses the legacy `browser.*` server (a team
 * member uses `portal_*`; a solo session keeps `browser.*` under ownership).
 * Kept apart from the architect's and advisor's ask/plan denials, whose lists
 * other policy mirrors compare exactly.
 */
export function teamRolePortalDeniedTools(role: TeamRole | null | undefined): readonly string[] {
  if (role === 'explorer' || role === 'architect' || role === 'advisor') {
    return PORTAL_TOOLS.map((tool) => mcpTool(MCP_CORE, tool));
  }
  if (role === 'reviewer') return [mcpTool(MCP_CORE, PORTAL_EVALUATE_TOOL)];
  return [];
}

/**
 * First-party Nimbalyst tools a `read` child may keep: lookups, plus asking the
 * user, rendering output to them, and naming its own session (the system prompt
 * asks every session to call update_session_meta). Everything else on the
 * first-party servers is denied, so a tool added to the topology later is
 * read-denied until someone lists it here.
 */
const READ_SCOPE_ALLOWED_FIRST_PARTY_TOOLS: ReadonlySet<string> = new Set([
  ...['AskUserQuestion', 'PromptForUserInput', 'display_to_user', 'capture_editor_screenshot',
    'get_session_edited_files', 'update_session_meta',
    // The host's own file reads (electron mcp/devAgentTools.ts: read_file,
    // list_files, search_files, confined to the workspace), served on the core
    // endpoint only to a restricted member whose provider has no native read
    // tool the scope keeps (openai-codex: its shell is refused). Read-only by
    // construction; Claude Code members never see them (they have Read/Grep).
    ...HOST_READ_TOOLS].map((tool) => mcpTool(MCP_CORE, tool)),
  ...['settings_get_overview', 'extensions_list', 'get_session_summary', 'get_session_coaching_signals',
    'get_workstream_overview', 'get_workstream_edited_files', 'list_recent_sessions', 'list_citable_inputs',
    'list_queued_prompts', 'get_session_status', 'get_session_result', 'list_spawned_sessions',
    'list_worktrees',
    // Phase 1B: a passive read of the packaged ECC catalog; it describes entries and grants nothing.
    'ecc_catalog_lookup'].map((tool) => mcpTool(MCP_HOST, tool)),
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

/**
 * Native (non-MCP) tools a `read`/`review` child may call. The PreToolUse
 * guard fails closed on any other native name, so a tool the CLI adds later is
 * denied until someone lists it here; the SDK `disallowedTools` half can only
 * name what it already knows. Read-only by construction: file and symbol
 * reads, listings, task and todo bookkeeping, plan mode and tool discovery
 * (ToolSearch). Skill is deliberately absent, see SKILL_TOOLS.
 */
export const READ_SCOPE_ALLOWED_NATIVE_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'LSP', 'NotebookRead',
  'ToolSearch', 'ListAgents', 'CronList', 'TaskOutput', 'TaskStop',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TodoRead', 'TodoWrite',
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'ReportFindings',
  'ListMcpResources', 'ListMcpResourcesTool', 'ReadMcpResource', 'ReadMcpResourceTool',
]);

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
 * The workspace test runner: the only execution `review` adds to `read`.
 * `write` never runs it either: that scope edits files and executes nothing
 * (NIB.23, 2026-10-13), so only `review` and `full` may call it.
 */
export const RUN_PROJECT_TESTS_TOOL = mcpTool(MCP_HOST, 'run_project_tests');

/**
 * Native and Nimbalyst tools a Claude Code child must not see for its scope:
 * `read` investigates only (no web access, no skills either); `review` is
 * `read` that may also run the workspace's tests (never a shell, never an
 * edit); `write` may also edit files but runs, delegates, commits and
 * reconfigures nothing, not even the workspace test runner.
 *
 * This list is the SDK `disallowedTools` half of the scope. MCP servers it
 * cannot name in advance (user, plugin and claude.ai connector servers) are
 * kept out of read/review sessions structurally instead: their MCP snapshot
 * uses the `scoped` profile and the SDK runs with `strictMcpConfig`
 * (sdkOptionsBuilder), and `isToolDeniedForScope` lets the PreToolUse guard
 * fail closed on any `mcp__` tool outside the first-party read allowlist.
 */
export function toolScopeDeniedTools(scope: ChildToolScope): readonly string[] {
  if (scope === 'read' || scope === 'review') {
    const denied = [...new Set([
      ...FILE_WRITE_TOOLS, ...RUN_TOOLS, ...DELEGATION_TOOLS, ...CONFIG_AND_COMMIT_TOOLS,
      ...OUTWARD_TOOLS, ...NETWORK_TOOLS, ...SKILL_TOOLS, ...readScopeDeniedFirstPartyTools(),
    ])];
    return scope === 'review'
      ? denied.filter((tool) => tool !== RUN_PROJECT_TESTS_TOOL && !PORTAL_OBSERVE_EXERCISE_NAMES.has(tool))
      : denied;
  }
  if (scope === 'write') {
    return [
      ...RUN_TOOLS, RUN_PROJECT_TESTS_TOOL, mcpTool(MCP_CORE, PORTAL_EVALUATE_TOOL),
      ...DELEGATION_TOOLS, ...CONFIG_AND_COMMIT_TOOLS, ...OUTWARD_TOOLS,
    ];
  }
  return [];
}

/**
 * Merge the scope's denied tools into existing SDK `disallowedTools` without
 * dropping prior entries. For `read` and `review`, per-extension Nimbalyst
 * servers (`nimbalyst-<ext>`, dynamic, not in the topology) are denied whole,
 * since their tools are not known to be read-only. A team role adds its own
 * denials (`teamRoleDeniedTools`) regardless of the scope.
 */
export function mergeToolScopeDisallowedTools(
  existing: readonly string[] | undefined,
  scope: ChildToolScope,
  mcpServerKeys: readonly string[] = [],
  role: TeamRole | null = null,
): string[] | undefined {
  const denied = [...toolScopeDeniedTools(scope), ...teamRoleDeniedTools(role), ...teamRolePortalDeniedTools(role)];
  if (role !== null) denied.push(BROWSER_EXTENSION_SERVER);
  if (scope === 'read' || scope === 'review') {
    denied.push(...mcpServerKeys.filter(isExtensionServerConfigKey).map((key) => `mcp__${key}`));
  }
  if (denied.length === 0) return existing ? [...existing] : undefined;
  return [...new Set([...(existing ?? []), ...denied])];
}

/**
 * Whether a `read`/`review` child may call this MCP tool. Only the first-party
 * read allowlist (plus the test runner for `review`) is admitted; any other
 * `mcp__` tool (user, plugin or connector servers, per-extension servers, a
 * first-party addition nobody listed) is denied.
 */
export function isReadScopeAllowedMcpTool(toolName: string, scope: 'read' | 'review'): boolean {
  if (READ_SCOPE_ALLOWED_FIRST_PARTY_TOOLS.has(toolName)) return true;
  if (scope === 'review' && PORTAL_OBSERVE_EXERCISE_NAMES.has(toolName)) return true;
  return scope === 'review' && toolName === RUN_PROJECT_TESTS_TOOL;
}

/**
 * Call-time check for the PreToolUse guard: true when `toolName` must not run
 * under `scope` (and `role`). Mirrors `mergeToolScopeDisallowedTools`, and for
 * read/review fails closed twice over: a native tool must be in
 * `READ_SCOPE_ALLOWED_NATIVE_TOOLS` and an `mcp__` tool in the first-party read
 * allowlist. `full` denies nothing; `write` denies only what its list says, so
 * user MCP and unlisted natives stay reachable there as today. The role's own
 * denials (the architect's and the advisor's) apply before the scope, so an
 * architect or advisor with a misconfigured scope still cannot ask or delegate.
 */
export function isToolDeniedForScope(
  scope: ChildToolScope,
  toolName: string,
  mcpServerKeys: readonly string[] = [],
  role: TeamRole | null = null,
): boolean {
  if (teamRoleDeniedTools(role).includes(toolName)) return true;
  if (role !== null && (teamRolePortalDeniedTools(role).includes(toolName) || toolName.startsWith(`${BROWSER_EXTENSION_SERVER}__`))) {
    return true;
  }
  if (scope === 'full') return false;
  const denied = new Set(mergeToolScopeDisallowedTools(undefined, scope, mcpServerKeys, role) ?? []);
  if (denied.has(toolName)) return true;
  if (!toolName.startsWith('mcp__')) {
    // Natives: read/review admit only the allowlist (fail-closed for a tool
    // nobody classified); write keeps its denylist contract.
    if (scope === 'read' || scope === 'review') return !READ_SCOPE_ALLOWED_NATIVE_TOOLS.has(toolName);
    return false;
  }
  const serverKey = toolName.slice('mcp__'.length).split('__')[0];
  if (serverKey && denied.has(`mcp__${serverKey}`)) return true;
  if (scope === 'read' || scope === 'review') return !isReadScopeAllowedMcpTool(toolName, scope);
  return false;
}
