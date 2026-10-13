/**
 * Detect Claude Code's enterprise MCP lockdown (NIM-2372).
 *
 * When IT deploys a `managed-mcp.json`, the `claude` binary takes exclusive
 * control of MCP and runs two guards before anything else:
 *
 *   if (strictMcpConfig)
 *     fail("You cannot use --strict-mcp-config when an enterprise MCP config is present")
 *   if (mcpConfig && !every(s => s.type === 'sdk' && s.name === 'claude-vscode'))
 *     fail("You cannot dynamically configure MCP servers when an enterprise MCP config is present")
 *
 * Nimbalyst omits strict mode under lockdown, which clears the first guard. The
 * second still rejects ANY server we pass — the Agent SDK serializes its
 * `mcpServers` option into `--mcp-config`, so both provider paths are affected,
 * and the only name the allowlist admits is the VS Code extension's own. We do
 * not impersonate it. So on these machines Nimbalyst launches with no MCP config
 * at all: the session runs on the enterprise's servers, and the UI says which
 * Nimbalyst tools are unavailable.
 *
 * Managed-settings roots are hardcoded in the binary with no env override:
 *
 *   macOS   /Library/Application Support/ClaudeCode
 *   Windows C:\Program Files\ClaudeCode
 *   other   /etc/claude-code
 *
 * Since CLI 2.1.271, unreadable or malformed managed files retain exclusive
 * control too. Fail closed unless the file is absent. The probe is cached for
 * the Nimbalyst process lifetime.
 *
 * `managed-settings.json` in the same roots is probed as well, for hook
 * policies a read/review child cannot neutralise (hasEnterpriseManagedHookPolicy).
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MANAGED_SETTINGS_DIRS: Record<string, string> = {
  darwin: '/Library/Application Support/ClaudeCode',
  win32: 'C:\\Program Files\\ClaudeCode',
};

const DEFAULT_MANAGED_SETTINGS_DIR = '/etc/claude-code';
const MANAGED_MCP_FILE_NAME = 'managed-mcp.json';

/** Absolute path the binary reads its enterprise MCP config from. */
export function resolveEnterpriseManagedMcpConfigPath(
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = MANAGED_SETTINGS_DIRS[platform] ?? DEFAULT_MANAGED_SETTINGS_DIR;
  // Windows paths must stay backslashed even when this runs from a posix host in
  // tests, so join per-platform rather than through the ambient path module.
  return platform === 'win32'
    ? path.win32.join(dir, MANAGED_MCP_FILE_NAME)
    : path.posix.join(dir, MANAGED_MCP_FILE_NAME);
}

export interface EnterpriseMcpConfigDeps {
  platform?: NodeJS.Platform;
  /** Read the managed file; return null when absent, throw on other failures. */
  readFile?: (filePath: string) => string | null;
}

const defaultReadFile = (filePath: string): string => readFileSync(filePath, 'utf8');

let cached: boolean | undefined;

/**
 * True when this machine has an enterprise MCP config, i.e. Nimbalyst must not
 * pass any MCP servers to Claude Code.
 */
export function hasEnterpriseManagedMcpConfig(deps: EnterpriseMcpConfigDeps = {}): boolean {
  if (cached !== undefined) return cached;

  const platform = deps.platform ?? process.platform;
  const read = deps.readFile ?? defaultReadFile;
  try {
    cached = read(resolveEnterpriseManagedMcpConfigPath(platform)) !== null;
  } catch (error) {
    cached = (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
  return cached;
}

/** Test-only: clear the cached probe. */
export function __resetEnterpriseManagedMcpConfigCache(): void {
  cached = undefined;
}

const MANAGED_SETTINGS_FILE_NAME = 'managed-settings.json';

/** Absolute path the binary reads its enterprise settings (hooks included) from. */
export function resolveEnterpriseManagedSettingsPath(
  platform: NodeJS.Platform = process.platform,
): string {
  const dir = MANAGED_SETTINGS_DIRS[platform] ?? DEFAULT_MANAGED_SETTINGS_DIR;
  return platform === 'win32'
    ? path.win32.join(dir, MANAGED_SETTINGS_FILE_NAME)
    : path.posix.join(dir, MANAGED_SETTINGS_FILE_NAME);
}

let cachedHookPolicy: boolean | undefined;

/**
 * True when the enterprise settings on this machine make hooks run that
 * Nimbalyst cannot turn off for a read/review child: managed `hooks` run even
 * under a non-managed `disableAllHooks`, and a managed `disableAllHooks: false`
 * outranks the flag-tier value Nimbalyst passes. `allowManagedHooksOnly` on
 * its own only blocks the non-managed hooks, so it is not a policy by itself.
 * Only the managed-settings.json file is probed: MDM, registry or server-side
 * managed settings are not read here. Unreadable or malformed files count as
 * a policy (fail closed); only an absent file, or one without hook settings,
 * is none.
 */
export function hasEnterpriseManagedHookPolicy(deps: EnterpriseMcpConfigDeps = {}): boolean {
  if (cachedHookPolicy !== undefined) return cachedHookPolicy;

  const platform = deps.platform ?? process.platform;
  const read = deps.readFile ?? defaultReadFile;
  try {
    const raw = read(resolveEnterpriseManagedSettingsPath(platform));
    if (raw === null) {
      cachedHookPolicy = false;
    } else {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const hooks = parsed.hooks;
      const declaresHooks = !!hooks && typeof hooks === 'object' && Object.keys(hooks as object).length > 0;
      cachedHookPolicy = declaresHooks || parsed.disableAllHooks === false;
    }
  } catch (error) {
    cachedHookPolicy = (error as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
  return cachedHookPolicy;
}

/** Test-only: clear the cached hook-policy probe. */
export function __resetEnterpriseManagedHookPolicyCache(): void {
  cachedHookPolicy = undefined;
}
