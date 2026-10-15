/**
 * Process-level restriction of a Codex child, verified against the app-server
 * (NIB.46 items 7.2, 7.5, 7.8).
 *
 * `thread/start` accepts any `config` map and echoes none of it (unknown keys
 * are accepted silently), so a thread-level override is a request, not a
 * guarantee. `codex app-server -c key=value` applies to the whole child
 * process, and `config/read` returns that process's effective configuration,
 * which makes a restriction verifiable: the host passes the overrides on the
 * command line and refuses to run the thread unless `config/read` shows every
 * one of them in effect. The thread-level overrides of codexTeamPolicy.ts stay
 * as defense in depth. `thread/start` does echo the approval policy, the
 * sandbox and the model, and reports the CLI version, so those are checked
 * from the echo.
 */

import { FIRST_PARTY_CODEX_MCP_SERVERS, type CodexUserConfigTables } from './codexTeamPolicy';

/** The Codex CLI version from which this integration's guarantees were verified (probe of 2026-10-14). */
export const CODEX_MIN_CLI_VERSION = '0.159.1';

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * `table={"a"={enabled=false},"b"={enabled=false}}`: one `-c` per table with
 * the names inside a TOML inline-table VALUE. The `-c` key path is split on
 * dots without TOML quoting (probe of 2026-10-14 on Windows: the quotes of
 * `plugins."id".enabled=false` reach Codex literally and create a new key
 * `"id"`, leaving the real plugin enabled), while the value is parsed as TOML
 * and merged into the user's table (the entry keeps its command, only
 * `enabled` changes).
 */
function disabledEntriesTable(table: 'mcp_servers' | 'plugins', names: readonly string[]): string {
  return `${table}={${names.map((name) => `${tomlString(name)}={enabled=false}`).join(',')}}`;
}

/**
 * The `-c key=value` arguments a restricted Codex child is spawned with:
 * no shell tool at all (`features.shell_tool` / `features.unified_exec`: a
 * read member reads through the host's confined read tools on every OS, so
 * no known-safe `cat`/`rg` can read outside the workspace on macOS/Linux),
 * no notify hook, no hooks, no web search, no collaboration sub-agents, every
 * user MCP server and plugin disabled. Process-level, so they bind the whole
 * child whatever a thread asks for; verified after spawn by
 * `verifyRestrictedCodexEffectiveConfig` and `verifyRestrictedCodexHooks`.
 */
export function buildRestrictedCodexProcessOverrides(tables: CodexUserConfigTables): string[] {
  const overrides = [
    'features.shell_tool=false',
    'features.unified_exec=false',
    'notify=[]',
    'hooks={}',
    'web_search="disabled"',
    'features.multi_agent=false',
  ];
  if (tables.mcpServerNames.length > 0) overrides.push(disabledEntriesTable('mcp_servers', tables.mcpServerNames));
  if (tables.pluginIds.length > 0) overrides.push(disabledEntriesTable('plugins', tables.pluginIds));
  return overrides;
}

/**
 * The user's MCP servers and plugins the effective configuration still shows
 * enabled (a plugin bundled with Codex that no config file names, a name the
 * host's list missed). With `isOnlyEnablementViolations`, lets the protocol
 * respawn the child ONCE with these added to the disabled set, instead of
 * refusing a member over an incomplete list. Any other violation never retries.
 */
export function stillEnabledCodexUserEntries(
  config: unknown,
  firstPartyServers: ReadonlySet<string> = FIRST_PARTY_CODEX_MCP_SERVERS,
): CodexUserConfigTables {
  const record = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const enabled = (table: unknown, skip: (name: string) => boolean) => (table && typeof table === 'object'
    ? Object.entries(table as Record<string, unknown>)
      .filter(([name, entry]) => !skip(name) && !(entry && typeof entry === 'object' && (entry as Record<string, unknown>).enabled === false))
      .map(([name]) => name)
    : []);
  return {
    mcpServerNames: enabled(record.mcp_servers, (name) => firstPartyServers.has(name)),
    pluginIds: enabled(record.plugins, () => false),
  };
}

/** Whether every violation is a user MCP server or plugin still enabled (the only kind a respawn may fix). */
export function isOnlyEnablementViolations(violations: readonly string[]): boolean {
  return violations.length > 0 && violations.every((violation) => /^(mcp_servers|plugins)\..+ is still enabled$/.test(violation));
}

/** Thrown by the protocol to respawn a restricted child once with a completed disabled set. */
export class RestrictedCodexRespawn extends Error {
  constructor(readonly discovered: CodexUserConfigTables) {
    super('restricted Codex child respawn with a completed disabled set');
  }
}

/** The tables a restricted session was spawned with (`raw.restrictedUserTables`), empty when absent. */
export function readRestrictedUserTables(raw: Record<string, unknown> | undefined): CodexUserConfigTables {
  const value = raw?.restrictedUserTables as Partial<CodexUserConfigTables> | undefined;
  return {
    mcpServerNames: Array.isArray(value?.mcpServerNames) ? value!.mcpServerNames.filter((name): name is string => typeof name === 'string') : [],
    pluginIds: Array.isArray(value?.pluginIds) ? value!.pluginIds.filter((id): id is string => typeof id === 'string') : [],
  };
}

/** `-c a=b` pairs as the spawn argument list. */
export function codexProcessOverrideArgs(overrides: readonly string[]): string[] {
  return overrides.flatMap((override) => ['-c', override]);
}

/** The user's MCP servers and plugins as the Codex process itself sees them (`config/read`). */
export function extractCodexUserConfigTablesFromEffectiveConfig(
  config: unknown,
  firstPartyServers: ReadonlySet<string> = FIRST_PARTY_CODEX_MCP_SERVERS,
): CodexUserConfigTables {
  const record = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  const servers = record.mcp_servers && typeof record.mcp_servers === 'object' ? Object.keys(record.mcp_servers as object) : [];
  const plugins = record.plugins && typeof record.plugins === 'object' ? Object.keys(record.plugins as object) : [];
  return {
    mcpServerNames: servers.filter((name) => !firstPartyServers.has(name)),
    pluginIds: plugins,
  };
}

/** Union of two table sets, each name once. */
export function mergeCodexUserConfigTables(a: CodexUserConfigTables, b: CodexUserConfigTables): CodexUserConfigTables {
  return {
    mcpServerNames: [...new Set([...a.mcpServerNames, ...b.mcpServerNames])],
    pluginIds: [...new Set([...a.pluginIds, ...b.pluginIds])],
  };
}

/**
 * Every way the effective configuration of a restricted child could still let
 * the thread act outside its scope. An empty list means the restriction is in
 * effect; anything else is a reason not to run the thread (fail-closed).
 */
export function verifyRestrictedCodexEffectiveConfig(
  config: unknown,
  firstPartyServers: ReadonlySet<string> = FIRST_PARTY_CODEX_MCP_SERVERS,
): string[] {
  const violations: string[] = [];
  const record = config && typeof config === 'object' ? (config as Record<string, unknown>) : null;
  if (!record) return ['the effective configuration could not be read'];
  if (!Array.isArray(record.notify) || record.notify.length > 0) violations.push('notify is not empty');
  const hooks = record.hooks;
  if (hooks && typeof hooks === 'object') {
    for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
      if (Array.isArray(entries) ? entries.length > 0 : entries != null) violations.push(`hooks.${event} is not empty`);
    }
  }
  if (record.web_search !== 'disabled') violations.push(`web_search is ${JSON.stringify(record.web_search ?? null)}, not "disabled"`);
  const features = record.features && typeof record.features === 'object' ? (record.features as Record<string, unknown>) : {};
  if (features.shell_tool !== false) violations.push('features.shell_tool is not false');
  if (features.unified_exec !== false) violations.push('features.unified_exec is not false');
  if (features.multi_agent !== false) violations.push('features.multi_agent is not false');
  const servers = record.mcp_servers && typeof record.mcp_servers === 'object' ? (record.mcp_servers as Record<string, unknown>) : {};
  for (const [name, entry] of Object.entries(servers)) {
    if (firstPartyServers.has(name)) continue;
    const enabled = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).enabled : undefined;
    if (enabled !== false) violations.push(`mcp_servers.${name} is still enabled`);
  }
  const plugins = record.plugins && typeof record.plugins === 'object' ? (record.plugins as Record<string, unknown>) : {};
  for (const [id, entry] of Object.entries(plugins)) {
    const enabled = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).enabled : undefined;
    if (enabled !== false) violations.push(`plugins.${id} is still enabled`);
  }
  return violations;
}

/**
 * The hooks the child would actually run for the workspace (`hooks/list`,
 * which also sees a project's own hook files, not only config.toml). A
 * restricted child runs none: any listed hook is a side channel of
 * execution outside the thread's sandbox and approvals.
 */
export function verifyRestrictedCodexHooks(hooksList: unknown): string[] {
  const data = (hooksList as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return ['hooks/list returned no data'];
  const violations: string[] = [];
  for (const row of data) {
    const entry = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
    const hooks = Array.isArray(entry.hooks) ? entry.hooks : [];
    if (hooks.length > 0) violations.push(`${hooks.length} hook(s) would run for ${String(entry.cwd ?? 'the workspace')}`);
  }
  return violations;
}

/**
 * What `thread/start` (or `thread/resume`) must echo for a restricted thread:
 * the `untrusted` approval policy, the read-only sandbox without network, and
 * the model the member was created with. The echo is the app-server's own
 * statement of the thread's effective policy, unlike the `config` map.
 */
export function verifyRestrictedCodexThreadStart(
  response: unknown,
  expectedModel: string | null | undefined,
): string[] {
  const violations: string[] = [];
  const record = response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  if (!record) return ['thread/start returned nothing'];
  if (record.approvalPolicy !== 'untrusted') violations.push(`approvalPolicy is ${JSON.stringify(record.approvalPolicy ?? null)}, not "untrusted"`);
  const sandbox = record.sandbox && typeof record.sandbox === 'object' ? (record.sandbox as Record<string, unknown>) : null;
  if (sandbox?.type !== 'readOnly') violations.push(`sandbox is ${JSON.stringify(sandbox?.type ?? null)}, not readOnly`);
  if (sandbox?.networkAccess === true) violations.push('sandbox grants network access');
  if (expectedModel) {
    const thread = record.thread && typeof record.thread === 'object' ? (record.thread as Record<string, unknown>) : null;
    const model = typeof record.model === 'string' ? record.model : thread?.model;
    // The echo carries the bare model id; the member may hold the prefixed one.
    const expected = expectedModel.replace(/^openai-codex:/, '');
    if (model !== expected) violations.push(`model is ${JSON.stringify(model ?? null)}, not ${JSON.stringify(expected)}`);
  }
  return violations;
}

/** `0.159.2` from `nimbalyst/0.159.2 (Windows ...)` or from a bare version; null when absent. */
export function parseCodexCliVersion(source: string | null | undefined): string | null {
  if (!source) return null;
  const match = /(?:^|\/)(\d+\.\d+\.\d+)(?:[^\d]|$)/.exec(source);
  return match ? match[1] : null;
}

export function compareCodexVersions(a: string, b: string): number {
  const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

export function isCodexCliVersionSupported(version: string | null | undefined, minimum: string = CODEX_MIN_CLI_VERSION): boolean {
  return !!version && compareCodexVersions(version, minimum) >= 0;
}

/**
 * The CLI version of a child, from the `thread/start` echo (`thread.cliVersion`)
 * or the `initialize` user agent, checked against CODEX_MIN_CLI_VERSION. A
 * version the child does not report is a reason to refuse (fail-closed).
 */
export function verifyCodexCliVersion(
  threadStartResponse: unknown,
  initializeUserAgent: string | null | undefined,
  minimum: string = CODEX_MIN_CLI_VERSION,
): { version: string | null; violation: string | null } {
  const thread = (threadStartResponse as { thread?: { cliVersion?: unknown } } | null)?.thread;
  const version = parseCodexCliVersion(typeof thread?.cliVersion === 'string' ? thread.cliVersion : null)
    ?? parseCodexCliVersion(initializeUserAgent);
  if (!version) return { version: null, violation: 'the Codex CLI did not report its version' };
  if (compareCodexVersions(version, minimum) < 0) {
    return { version, violation: `Codex CLI ${version} is older than the minimum ${minimum} this integration was verified with` };
  }
  return { version, violation: null };
}

/** The refusal of a restricted thread whose process or thread policy could not be verified. */
export function describeRestrictedCodexViolation(stage: 'process' | 'thread' | 'version', violations: readonly string[]): string {
  const what = stage === 'process'
    ? 'the Codex process did not take the restricted configuration'
    : stage === 'thread'
      ? 'the Codex thread did not take the restricted policy'
      : 'the Codex CLI version cannot be trusted for a restricted member';
  return `Restricted Team mode member refused: ${what} (${violations.join('; ')}). No turn was run; update or reconfigure Codex and try again.`;
}
