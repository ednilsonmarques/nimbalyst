// @vitest-environment node
/**
 * Enterprise MCP lockdown detection (NIM-2372).
 *
 * When `managed-mcp.json` is present the `claude` binary refuses BOTH
 * `--strict-mcp-config` and any dynamically-passed MCP server that isn't the
 * VS Code extension's own sdk server — so Nimbalyst must detect it and launch
 * without a snapshot rather than dying on exit 1.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetEnterpriseManagedHookPolicyCache,
  __resetEnterpriseManagedMcpConfigCache,
  hasEnterpriseManagedHookPolicy,
  hasEnterpriseManagedMcpConfig,
  resolveEnterpriseManagedMcpConfigPath,
  resolveEnterpriseManagedSettingsPath,
} from '../enterpriseMcpConfig';

beforeEach(() => {
  __resetEnterpriseManagedMcpConfigCache();
  __resetEnterpriseManagedHookPolicyCache();
});

describe('resolveEnterpriseManagedMcpConfigPath', () => {
  it('mirrors the binary’s managed-settings roots per platform', () => {
    expect(resolveEnterpriseManagedMcpConfigPath('darwin')).toBe(
      '/Library/Application Support/ClaudeCode/managed-mcp.json'
    );
    expect(resolveEnterpriseManagedMcpConfigPath('win32')).toBe(
      'C:\\Program Files\\ClaudeCode\\managed-mcp.json'
    );
    expect(resolveEnterpriseManagedMcpConfigPath('linux')).toBe('/etc/claude-code/managed-mcp.json');
  });
});

describe('hasEnterpriseManagedMcpConfig', () => {
  it('keeps managed MCP control for malformed files and disables it only when absent', () => {
    const read = (contents: string | null) => ({ platform: 'darwin' as const, readFile: () => contents });

    expect(hasEnterpriseManagedMcpConfig(read('{"mcpServers":{}}'))).toBe(true);
    __resetEnterpriseManagedMcpConfigCache();
    expect(hasEnterpriseManagedMcpConfig(read(null))).toBe(false);
    __resetEnterpriseManagedMcpConfigCache();
    // CLI 2.1.271 retains exclusive control even when the config cannot parse.
    expect(hasEnterpriseManagedMcpConfig(read('{not json'))).toBe(true);
  });

  it.each(['EACCES', 'EPERM', 'EISDIR'])('keeps managed MCP control when reading fails with %s', code => {
    expect(hasEnterpriseManagedMcpConfig({ readFile: () => { throw Object.assign(new Error('Cannot read managed config'), { code }); } })).toBe(true);
  });

  it('treats a missing managed file as unrestricted', () => {
    expect(hasEnterpriseManagedMcpConfig({ readFile: () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); } })).toBe(false);
  });

  it('caches the probe (the file cannot appear mid-session without an IT push + restart)', () => {
    let reads = 0;
    const deps = {
      platform: 'linux' as const,
      readFile: () => {
        reads += 1;
        return '{}';
      },
    };
    expect(hasEnterpriseManagedMcpConfig(deps)).toBe(true);
    expect(hasEnterpriseManagedMcpConfig(deps)).toBe(true);
    expect(reads).toBe(1);
  });
});

describe('hasEnterpriseManagedHookPolicy', () => {
  const read = (contents: string | null) => ({ platform: 'linux' as const, readFile: () => contents });

  it('resolves managed-settings.json next to managed-mcp.json', () => {
    expect(resolveEnterpriseManagedSettingsPath('win32')).toBe('C:\\Program Files\\ClaudeCode\\managed-settings.json');
    expect(resolveEnterpriseManagedSettingsPath('linux')).toBe('/etc/claude-code/managed-settings.json');
  });

  it('is a policy when managed settings declare hooks or re-enable them; allowManagedHooksOnly alone runs nothing', () => {
    expect(hasEnterpriseManagedHookPolicy(read('{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"audit"}]}]}}'))).toBe(true);
    __resetEnterpriseManagedHookPolicyCache();
    expect(hasEnterpriseManagedHookPolicy(read('{"disableAllHooks":false}'))).toBe(true);
    __resetEnterpriseManagedHookPolicyCache();
    expect(hasEnterpriseManagedHookPolicy(read('{"allowManagedHooksOnly":true}'))).toBe(false);
  });

  it('is no policy when the file is absent or carries no hook settings', () => {
    expect(hasEnterpriseManagedHookPolicy(read(null))).toBe(false);
    __resetEnterpriseManagedHookPolicyCache();
    expect(hasEnterpriseManagedHookPolicy(read('{"permissions":{"deny":["Bash"]},"hooks":{}}'))).toBe(false);
    __resetEnterpriseManagedHookPolicyCache();
    expect(hasEnterpriseManagedHookPolicy({ readFile: () => { throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); } })).toBe(false);
  });

  it('fails closed on malformed or unreadable managed settings, and caches the probe', () => {
    expect(hasEnterpriseManagedHookPolicy(read('{not json'))).toBe(true);
    __resetEnterpriseManagedHookPolicyCache();
    expect(hasEnterpriseManagedHookPolicy({ readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } })).toBe(true);
    __resetEnterpriseManagedHookPolicyCache();
    let reads = 0;
    const deps = { platform: 'linux' as const, readFile: () => { reads += 1; return '{"disableAllHooks":false}'; } };
    expect(hasEnterpriseManagedHookPolicy(deps)).toBe(true);
    expect(hasEnterpriseManagedHookPolicy(deps)).toBe(true);
    expect(reads).toBe(1);
  });
});
