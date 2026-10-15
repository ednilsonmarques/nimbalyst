/**
 * Team mode policy for an OpenAI Codex (app-server) session: the provider's
 * half of a child's tool scope.
 *
 * What a restricted member may do is decided once, by the host policy
 * (providers/claudeCode/toolPolicy.ts, the single source of truth) and by
 * the session-scoped MCP server (electron mcp/sessionToolPolicy.ts), which
 * lists and runs only the first-party read tools for a read/review session.
 * This module adapts the parts of a Codex thread that policy cannot reach
 * through MCP, because they are Codex's own:
 *
 *  - its sandbox and approval policy (codexPermissionProfile.ts: read-only
 *    sandbox, `untrusted` approvals, so only Codex's fixed set of known-safe
 *    read commands runs without asking);
 *  - every approval request of the thread (command, patch, permission
 *    escalation, MCP elicitation, user-input prompt, dynamic tool), refused
 *    here whatever the user's project permissions say;
 *  - the user's own `~/.codex/config.toml`: its MCP servers (a node REPL,
 *    for instance) and plugins (browser, computer use) are disabled for the
 *    thread by config override, and web search is turned off.
 *
 * Nothing here reads the prompt and nothing here is a prompt: the member's
 * contract still goes into the developer instructions (codexSystemPrompt.ts)
 * as behaviour, and would change nothing below if the model ignored it.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { ChildToolScope } from '../claudeCode/toolPolicy';
import type { TeamRole } from '../teamContext';
import { MCP_CORE, MCP_HOST, MCP_SITUATIONAL, MCP_TRACKERS } from '../../services/mcpTopology';
import type { CodexRestrictedToolScope } from '../../protocols/codexPermissionProfile';
import type { CodexAppServerHostBindings } from '../../protocols/CodexAppServerProtocol';
import type {
  ApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  McpElicitationResponse,
} from '../../protocols/codexAppServer/types';

export type CodexRestriction =
  /** Full tools: the project's permissions decide, as for any Codex session. */
  | { kind: 'none' }
  /** A read or review child: the restricted thread profile applies. */
  | { kind: 'restricted'; scope: CodexRestrictedToolScope; role: TeamRole | null }
  /** A scope Codex cannot honour natively (`write`: edits without a shell); the turn must not run. */
  | { kind: 'unsupported'; scope: ChildToolScope };

/** The scopes a Codex thread can honour natively in this phase. */
export const CODEX_ENFORCED_TOOL_SCOPES: readonly ChildToolScope[] = Object.freeze(['read', 'review']);

export function resolveCodexRestriction(scope: ChildToolScope, role: TeamRole | null): CodexRestriction {
  if (scope === 'read' || scope === 'review') return { kind: 'restricted', scope, role };
  if (scope === 'full') return { kind: 'none' };
  return { kind: 'unsupported', scope };
}

/** The error a turn ends with when its scope cannot be honoured on this provider or transport. */
export function describeUnsupportedCodexScope(scope: ChildToolScope, reason: 'scope' | 'transport'): string {
  return reason === 'transport'
    ? `This session's tool scope (${scope}) is enforced on OpenAI Codex only through the app-server transport; the legacy SDK transport cannot restrict a thread, so the turn was not run. Switch the Codex transport to app-server or create the member on another provider.`
    : `This session's tool scope (${scope}) cannot be enforced on OpenAI Codex (it edits files only through the same shell and patch tools a read-only thread withholds), so the turn was not run. Create the member on a provider that enforces that scope.`;
}

/**
 * The provider adapter's transport note for a restricted member: how the
 * provider-neutral contract ("read-only tools, no shell, no edits") maps onto
 * this provider. The member's Codex process runs with its shell tool switched
 * off on every OS (codexRestrictedProcess.ts, verified through config/read),
 * so reading is the host's workspace-confined read tools. Behaviour only: the
 * host refuses everything else whether or not the model reads this.
 */
export function buildCodexReadAccessNote(scope: CodexRestrictedToolScope): string {
  return `
### Reading on this provider
Read files with the Nimbalyst tools \`read_file\`, \`list_files\` and \`search_files\` (MCP server \`nimbalyst\`): they are your read access here, confined to the workspace, and they need no approval. You have no shell on this host: it is switched off for read members, so do not try to run commands. Everything beyond reading is withheld by the host and never granted: any file change or patch, any permission escalation and any approval request are refused automatically, no dialog ever reaches the user, so do not wait for one and do not ask for one; web search is off; the Nimbalyst tools listed to you are the complete set${scope === 'review' ? ' (the workspace test runner among them)' : ''}. A refused request was outside your access, not a failure to retry.`;
}

// ---- The user's own Codex configuration ----

export interface CodexUserConfigTables {
  /** `[mcp_servers.<name>]` tables of config.toml: the user's MCP servers. */
  mcpServerNames: string[];
  /** `[plugins."<id>"]` tables of config.toml: the user's plugins. */
  pluginIds: string[];
}

const EMPTY_TABLES: CodexUserConfigTables = Object.freeze({ mcpServerNames: [], pluginIds: [] }) as CodexUserConfigTables;

/**
 * Every way a Codex `config.toml` can name a user MCP server or a plugin:
 *
 *  - a table header `[mcp_servers.name]` / `[mcp_servers.name.env]` /
 *    `[plugins."id@marketplace"]` (the first key segment is the name);
 *  - a dotted key anywhere, `mcp_servers.name.command = ...` or
 *    `mcp_servers.name = { ... }` (an inline table);
 *  - an entry of the bare table: after a `[mcp_servers]` or `[plugins]`
 *    header, each `name = { ... }` / `"name" = ...` line.
 *
 * The first key segment is taken quoted or bare; nothing else of the file is
 * interpreted. A line scan on purpose, not a TOML parser: it must never
 * under-count, and a name it over-counts is merely disabled for the thread.
 */
export function parseCodexUserConfigTables(toml: string): CodexUserConfigTables {
  const mcpServerNames = new Set<string>();
  const pluginIds = new Set<string>();
  const add = (table: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (table === 'mcp_servers') mcpServerNames.add(trimmed);
    else pluginIds.add(trimmed);
  };
  const key = '(?:"((?:[^"\\\\]|\\\\.)+)"|\'([^\']+)\'|([^\\s.\\]"\'=]+))';
  const header = new RegExp(`^\\s*\\[\\s*(mcp_servers|plugins)\\s*\\.\\s*${key}`);
  const bareHeader = /^\s*\[\s*(mcp_servers|plugins)\s*\]/;
  const anyHeader = /^\s*\[/;
  const dotted = new RegExp(`^\\s*(mcp_servers|plugins)\\s*\\.\\s*${key}`);
  const entry = new RegExp(`^\\s*${key}\\s*=`);
  let inBareTable: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    const headerMatch = header.exec(line);
    if (headerMatch) { inBareTable = null; add(headerMatch[1], headerMatch[2] ?? headerMatch[3] ?? headerMatch[4] ?? ''); continue; }
    const bareMatch = bareHeader.exec(line);
    if (bareMatch) { inBareTable = bareMatch[1]; continue; }
    if (anyHeader.test(line)) { inBareTable = null; continue; }
    const dottedMatch = dotted.exec(line);
    if (dottedMatch) { add(dottedMatch[1], dottedMatch[2] ?? dottedMatch[3] ?? dottedMatch[4] ?? ''); continue; }
    if (inBareTable) {
      const entryMatch = entry.exec(line);
      if (entryMatch) add(inBareTable, entryMatch[1] ?? entryMatch[2] ?? entryMatch[3] ?? '');
    }
  }
  return { mcpServerNames: [...mcpServerNames], pluginIds: [...pluginIds] };
}

function mergeTables(a: CodexUserConfigTables, b: CodexUserConfigTables): CodexUserConfigTables {
  return {
    mcpServerNames: [...new Set([...a.mcpServerNames, ...b.mcpServerNames])],
    pluginIds: [...new Set([...a.pluginIds, ...b.pluginIds])],
  };
}

/** Where Codex keeps its configuration: `$CODEX_HOME`, else `~/.codex`. */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.CODEX_HOME?.trim();
  return home ? home : path.join(os.homedir(), '.codex');
}

/**
 * Read the `config.toml` tables Codex would load for a thread: the user's
 * (`$CODEX_HOME/config.toml`) and, when a workspace is given, the project's
 * (`<workspace>/.codex/config.toml`, which Codex layers for a trusted
 * project). A missing file means no servers and no plugins; any other failure
 * is rethrown so a restricted turn fails closed rather than running next to
 * servers the host could not see.
 */
export async function loadCodexUserConfigTables(
  codexHome: string = resolveCodexHome(),
  workspacePath?: string | null,
): Promise<CodexUserConfigTables> {
  const files = [path.join(codexHome, 'config.toml')];
  if (workspacePath) files.push(path.join(workspacePath, '.codex', 'config.toml'));
  let tables = EMPTY_TABLES;
  for (const file of files) {
    let toml: string;
    try {
      toml = await fs.readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || (error as NodeJS.ErrnoException)?.code === 'ENOTDIR') continue;
      throw new Error(`Could not read the Codex configuration at ${file} to restrict this session (${(error as Error)?.message ?? String(error)}); the turn was not run.`);
    }
    tables = mergeTables(tables, parseCodexUserConfigTables(toml));
  }
  return tables;
}

/**
 * Config overrides of a restricted thread (the app-server `config` map, the
 * same dotted-path TOML overrides as `--config`):
 *
 *  - `web_search = "disabled"`: no outbound web access from the model;
 *  - every user MCP server disabled (`mcp_servers.<name>.enabled = false`):
 *    a server the host did not register must not be reachable, whatever its
 *    tools are called;
 *  - every user plugin disabled (`plugins.<id>.enabled = false`): plugins
 *    carry skills and MCP servers of their own (browser, computer use, a node
 *    REPL) that a read-only member has no business with;
 *  - `features.multi_agent = false`: no collaboration sub-agents spawned by
 *    the model (a child thread would share the thread's sandbox, approvals
 *    and MCP, but a member delegates to nobody).
 *
 * Nimbalyst's own servers are added by the provider (buildCodexConfigOverrides)
 * and merged over this; a user server that happens to share a name with one
 * of them is left to the provider's entry.
 */
export function buildRestrictedCodexConfigOverrides(tables: CodexUserConfigTables): Record<string, unknown> {
  const mcpServers: Record<string, { enabled: false }> = {};
  for (const name of tables.mcpServerNames) mcpServers[name] = { enabled: false };
  const plugins: Record<string, { enabled: false }> = {};
  for (const id of tables.pluginIds) plugins[id] = { enabled: false };
  return {
    web_search: 'disabled',
    features: { multi_agent: false },
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
    ...(Object.keys(plugins).length > 0 ? { plugins } : {}),
  };
}

/**
 * The provider's overrides over the restriction's: `mcp_servers` and
 * `plugins` are merged key by key (Nimbalyst's servers and its own plugin
 * switches win over a same-named user entry), every other key of the
 * provider's map wins as a whole, and the restriction's remaining keys
 * (`web_search`) are kept.
 */
export function mergeRestrictedCodexConfigOverrides(
  providerOverrides: Record<string, unknown> | undefined,
  restrictedOverrides: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...restrictedOverrides, ...(providerOverrides ?? {}) };
  for (const table of ['mcp_servers', 'plugins', 'features'] as const) {
    const fromRestriction = restrictedOverrides[table];
    const fromProvider = providerOverrides?.[table];
    if (isRecord(fromRestriction) && isRecord(fromProvider)) {
      merged[table] = { ...fromRestriction, ...fromProvider };
    }
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ---- Approvals of a restricted thread ----

const DENIED: ApprovalResponse = Object.freeze({ decision: 'denied' }) as ApprovalResponse;
const ELICITATION_DECLINED: McpElicitationResponse = Object.freeze({ action: 'decline', content: null, _meta: null }) as McpElicitationResponse;
/** The protocol's own default when no host binding exists (CodexAppServerProtocol.wireServerRequestHandlers). */
const ELICITATION_AUTO_ACCEPT: McpElicitationResponse = Object.freeze({ action: 'accept', content: null, _meta: null }) as McpElicitationResponse;

function threadIdOf(params: unknown): string | undefined {
  const threadId = (params as { threadId?: unknown } | null)?.threadId;
  return typeof threadId === 'string' ? threadId : undefined;
}

/**
 * Nimbalyst's own MCP servers as Codex names them (the provider keeps the
 * config keys as server names: letters, digits, `_` and `-` survive). A
 * restricted thread's MCP elicitation is accepted only for these: the host's
 * session-scoped server already lists and runs nothing the scope denies, so
 * accepting is what lets the member's allowed reads (tracker_get, read_file)
 * complete (#797: a declined elicitation is "user rejected MCP tool call").
 * Every other server's elicitation is declined; the user's own servers are
 * disabled for the thread anyway (buildRestrictedCodexConfigOverrides).
 */
export const FIRST_PARTY_CODEX_MCP_SERVERS: ReadonlySet<string> = new Set([MCP_CORE, MCP_HOST, MCP_TRACKERS, MCP_SITUATIONAL]);

function elicitationServerOf(params: unknown): string | undefined {
  const record = params as { serverName?: unknown; server?: unknown; mcpServer?: unknown } | null;
  const name = record?.serverName ?? record?.server ?? record?.mcpServer;
  return typeof name === 'string' ? name : undefined;
}

export function isFirstPartyCodexMcpElicitation(params: unknown): boolean {
  const server = elicitationServerOf(params);
  return !!server && FIRST_PARTY_CODEX_MCP_SERVERS.has(server);
}

/**
 * Host bindings that refuse every approval of a restricted thread and hand
 * every other thread to the real bindings (or to the protocol's defaults
 * when there are none: approvals denied, elicitations accepted). A restricted
 * thread's requests are refused here even when the user's project runs with
 * every permission granted: an approval would be an escalation above the
 * member's scope, and a user click never widens a scope.
 */
export function wrapCodexHostBindingsForRestriction(
  bindings: CodexAppServerHostBindings | undefined,
  isRestrictedThread: (threadId: string | undefined) => boolean,
  log: (message: string) => void = (message) => console.warn(message),
): CodexAppServerHostBindings {
  const refuse = (what: string, params: unknown): boolean => {
    const threadId = threadIdOf(params);
    if (!isRestrictedThread(threadId)) return false;
    log(`[CODEX][TEAM] ${what} refused for restricted thread ${threadId ?? '(unknown)'}: the session's tool scope does not include it`);
    return true;
  };
  return {
    approveFileChange: async (params) =>
      refuse('file change', params) ? DENIED : (bindings?.approveFileChange ? bindings.approveFileChange(params) : DENIED),
    approveCommandExecution: async (params) =>
      refuse('command execution', params) ? DENIED : (bindings?.approveCommandExecution ? bindings.approveCommandExecution(params) : DENIED),
    approvePermissions: async (params) =>
      refuse('permission request', params) ? DENIED : (bindings?.approvePermissions ? bindings.approvePermissions(params) : DENIED),
    handleMcpElicitation: async (params) => {
      if (isRestrictedThread(threadIdOf(params))) {
        // First-party servers: the host's session-scoped server is the policy; let the allowed call complete.
        if (isFirstPartyCodexMcpElicitation(params)) return ELICITATION_AUTO_ACCEPT;
        refuse(`MCP elicitation from ${elicitationServerOf(params) ?? 'an unnamed server'}`, params);
        return ELICITATION_DECLINED;
      }
      return bindings?.handleMcpElicitation ? bindings.handleMcpElicitation(params) : ELICITATION_AUTO_ACCEPT;
    },
    handleToolUserInput: async (params) =>
      refuse('tool user input', params) ? null : (bindings?.handleToolUserInput ? bindings.handleToolUserInput(params) : null),
    callDynamicTool: async (params: DynamicToolCallParams): Promise<DynamicToolCallResponse> =>
      refuse(`dynamic tool ${params?.tool}`, params)
        ? { isError: true, content: [{ type: 'text', text: 'This session\'s tool scope does not include dynamic tools.' }] }
        : (bindings?.callDynamicTool
          ? bindings.callDynamicTool(params)
          : { isError: true, content: [{ type: 'text', text: `dynamic tool ${params.tool} not registered on host` }] }),
  };
}
