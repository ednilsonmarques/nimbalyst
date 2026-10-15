// @vitest-environment node
/**
 * The verifiable half of a restricted Codex member (NIB.46 items 7.2, 7.5,
 * 7.8): the `-c` overrides the child is spawned with, what `config/read` must
 * show for them to count as in effect, what `thread/start` must echo, and the
 * CLI version floor. The fixtures mirror the real app-server answers recorded
 * by the probe of 2026-10-14 (Codex CLI 0.159.2 on Windows).
 */
import { describe, expect, it } from 'vitest';
import {
  CODEX_MIN_CLI_VERSION,
  buildRestrictedCodexProcessOverrides,
  codexProcessOverrideArgs,
  compareCodexVersions,
  describeRestrictedCodexViolation,
  extractCodexUserConfigTablesFromEffectiveConfig,
  isCodexCliVersionSupported,
  isOnlyEnablementViolations,
  mergeCodexUserConfigTables,
  parseCodexCliVersion,
  readRestrictedUserTables,
  RestrictedCodexRespawn,
  stillEnabledCodexUserEntries,
  verifyCodexCliVersion,
  verifyRestrictedCodexEffectiveConfig,
  verifyRestrictedCodexHooks,
  verifyRestrictedCodexThreadStart,
} from '../codexRestrictedProcess';

/** `config/read` of a child spawned with the restricted overrides (probe v5). */
const EFFECTIVE_RESTRICTED = {
  notify: [],
  hooks: { PreToolUse: [], PostToolUse: [], SessionStart: [], Stop: [] },
  web_search: 'disabled',
  features: { multi_agent: false, shell_tool: false, unified_exec: false, mentions_v2: true },
  mcp_servers: {
    node_repl: { command: 'node_repl.exe', enabled: false },
    nimbalyst: { url: 'http://127.0.0.1:1/mcp/core' },
    'nimbalyst-host': { url: 'http://127.0.0.1:1/mcp/host' },
  },
  plugins: { 'browser@openai-bundled': { enabled: false }, 'computer-use@openai-bundled': { enabled: false } },
};

/** `config/read` of a child spawned WITHOUT them (probe v4): the user's own setup. */
const EFFECTIVE_USER = {
  notify: ['codex-computer-use.exe', 'turn-ended'],
  hooks: null,
  web_search: null,
  features: { multi_agent: undefined },
  mcp_servers: { node_repl: { command: 'node_repl.exe', enabled: true } },
  plugins: { 'browser@openai-bundled': { enabled: true } },
};

describe('process overrides', () => {
  it('spell every restriction as a -c pair, the disabled servers and plugins as one inline-table value per table', () => {
    const overrides = buildRestrictedCodexProcessOverrides({ mcpServerNames: ['node_repl', 'my server'], pluginIds: ['browser@openai-bundled', 'computer-use@openai-bundled'] });
    expect(overrides).toEqual([
      'features.shell_tool=false',
      'features.unified_exec=false',
      'notify=[]',
      'hooks={}',
      'web_search="disabled"',
      'features.multi_agent=false',
      'mcp_servers={"node_repl"={enabled=false},"my server"={enabled=false}}',
      'plugins={"browser@openai-bundled"={enabled=false},"computer-use@openai-bundled"={enabled=false}}',
    ]);
    // No dotted key path with quoted segments: on Windows those quotes reach Codex literally.
    expect(overrides.some((override) => /^(mcp_servers|plugins)\.["\w]/.test(override))).toBe(false);
    expect(buildRestrictedCodexProcessOverrides({ mcpServerNames: [], pluginIds: [] })).toHaveLength(6);
    expect(codexProcessOverrideArgs(['notify=[]', 'hooks={}'])).toEqual(['-c', 'notify=[]', '-c', 'hooks={}']);
  });

  it('finds the user entries still enabled, and only enablement violations qualify for the single respawn', () => {
    expect(stillEnabledCodexUserEntries(EFFECTIVE_RESTRICTED)).toEqual({ mcpServerNames: [], pluginIds: [] });
    expect(stillEnabledCodexUserEntries({
      mcp_servers: { node_repl: { enabled: true }, nimbalyst: { url: 'x' }, other: {} },
      plugins: { 'a@b': { enabled: false }, 'c@d': { enabled: true } },
    })).toEqual({ mcpServerNames: ['node_repl', 'other'], pluginIds: ['c@d'] });
    expect(stillEnabledCodexUserEntries(null)).toEqual({ mcpServerNames: [], pluginIds: [] });

    expect(isOnlyEnablementViolations(['plugins.browser@openai-bundled is still enabled', 'mcp_servers.node_repl is still enabled'])).toBe(true);
    expect(isOnlyEnablementViolations(['plugins.x is still enabled', 'notify is not empty'])).toBe(false);
    expect(isOnlyEnablementViolations(['features.shell_tool is not false'])).toBe(false);
    expect(isOnlyEnablementViolations([])).toBe(false);
  });

  it('reads back the tables a session was spawned with, ignoring malformed entries', () => {
    expect(readRestrictedUserTables({ restrictedUserTables: { mcpServerNames: ['node_repl', 3], pluginIds: ['p'] } })).toEqual({ mcpServerNames: ['node_repl'], pluginIds: ['p'] });
    expect(readRestrictedUserTables({ restrictedUserTables: 'x' })).toEqual({ mcpServerNames: [], pluginIds: [] });
    expect(readRestrictedUserTables(undefined)).toEqual({ mcpServerNames: [], pluginIds: [] });
    expect(new RestrictedCodexRespawn({ mcpServerNames: [], pluginIds: ['p'] }).discovered.pluginIds).toEqual(['p']);
  });

  it('read the user\'s servers and plugins from the effective configuration, first-party servers excluded, and merge with the files', () => {
    expect(extractCodexUserConfigTablesFromEffectiveConfig(EFFECTIVE_RESTRICTED)).toEqual({
      mcpServerNames: ['node_repl'],
      pluginIds: ['browser@openai-bundled', 'computer-use@openai-bundled'],
    });
    expect(extractCodexUserConfigTablesFromEffectiveConfig(null)).toEqual({ mcpServerNames: [], pluginIds: [] });
    expect(mergeCodexUserConfigTables(
      { mcpServerNames: ['node_repl'], pluginIds: ['a'] },
      { mcpServerNames: ['node_repl', 'other'], pluginIds: ['a', 'b'] },
    )).toEqual({ mcpServerNames: ['node_repl', 'other'], pluginIds: ['a', 'b'] });
  });
});

describe('effective configuration verification (config/read)', () => {
  it('accepts the restricted child\'s configuration', () => {
    expect(verifyRestrictedCodexEffectiveConfig(EFFECTIVE_RESTRICTED)).toEqual([]);
  });

  it('names every way the user\'s own configuration still lets the thread act outside its scope', () => {
    const violations = verifyRestrictedCodexEffectiveConfig(EFFECTIVE_USER);
    expect(violations).toEqual([
      'notify is not empty',
      'web_search is null, not "disabled"',
      'features.shell_tool is not false',
      'features.unified_exec is not false',
      'features.multi_agent is not false',
      'mcp_servers.node_repl is still enabled',
      'plugins.browser@openai-bundled is still enabled',
    ]);
    expect(verifyRestrictedCodexEffectiveConfig({ ...EFFECTIVE_RESTRICTED, hooks: { PreToolUse: [{ command: 'x' }] } })).toEqual(['hooks.PreToolUse is not empty']);
    expect(verifyRestrictedCodexEffectiveConfig(undefined)).toEqual(['the effective configuration could not be read']);
  });
});

describe('hooks verification (hooks/list)', () => {
  it('accepts a workspace with no hook; names any hook that would still run', () => {
    expect(verifyRestrictedCodexHooks({ data: [{ cwd: 'C:\\ws', hooks: [], warnings: [], errors: [] }] })).toEqual([]);
    expect(verifyRestrictedCodexHooks({ data: [{ cwd: 'C:\\ws', hooks: [{ eventName: 'preToolUse' }, { eventName: 'stop' }] }] })).toEqual(['2 hook(s) would run for C:\\ws']);
    expect(verifyRestrictedCodexHooks(null)).toEqual(['hooks/list returned no data']);
  });
});

describe('thread/start echo verification', () => {
  const ECHO = { thread: { id: 't', cliVersion: '0.159.2', model: 'gpt-6.1-sol' }, approvalPolicy: 'untrusted', sandbox: { type: 'readOnly', networkAccess: false }, model: 'gpt-6.1-sol' };

  it('accepts untrusted + readOnly without network on the expected model, prefixed or bare', () => {
    expect(verifyRestrictedCodexThreadStart(ECHO, 'gpt-6.1-sol')).toEqual([]);
    expect(verifyRestrictedCodexThreadStart(ECHO, 'openai-codex:gpt-6.1-sol')).toEqual([]);
    expect(verifyRestrictedCodexThreadStart(ECHO, null)).toEqual([]);
  });

  it('refuses any other approval policy, sandbox, network grant or model', () => {
    expect(verifyRestrictedCodexThreadStart({ ...ECHO, approvalPolicy: 'never' }, 'gpt-6.1-sol')).toEqual(['approvalPolicy is "never", not "untrusted"']);
    expect(verifyRestrictedCodexThreadStart({ ...ECHO, approvalPolicy: { granular: { sandbox_approval: false } } }, null)[0]).toMatch(/^approvalPolicy is /);
    expect(verifyRestrictedCodexThreadStart({ ...ECHO, sandbox: { type: 'workspaceWrite' } }, null)).toEqual(['sandbox is "workspaceWrite", not readOnly']);
    expect(verifyRestrictedCodexThreadStart({ ...ECHO, sandbox: { type: 'readOnly', networkAccess: true } }, null)).toEqual(['sandbox grants network access']);
    expect(verifyRestrictedCodexThreadStart({ ...ECHO, model: 'gpt-5.5' }, 'gpt-6.1-sol')).toEqual(['model is "gpt-5.5", not "gpt-6.1-sol"']);
    expect(verifyRestrictedCodexThreadStart(null, null)).toEqual(['thread/start returned nothing']);
  });
});

describe('CLI version floor', () => {
  it('parses the version from the user agent or the thread echo and compares numerically', () => {
    expect(parseCodexCliVersion('nimbalyst-auth/0.159.2 (Windows 10.0.26200; x86_64) xterm (nimbalyst; 0.0.0)')).toBe('0.159.2');
    expect(parseCodexCliVersion('0.160.0')).toBe('0.160.0');
    expect(parseCodexCliVersion('fake/0')).toBeNull();
    expect(parseCodexCliVersion(null)).toBeNull();
    expect(compareCodexVersions('0.159.2', '0.159.1')).toBe(1);
    expect(compareCodexVersions('0.159.1', '0.159.10')).toBe(-1);
    expect(compareCodexVersions('1.0.0', '0.999.999')).toBe(1);
    expect(isCodexCliVersionSupported('0.159.1')).toBe(true);
    expect(isCodexCliVersionSupported('0.158.9')).toBe(false);
    expect(isCodexCliVersionSupported(null)).toBe(false);
    expect(CODEX_MIN_CLI_VERSION).toBe('0.159.1');
  });

  it('a thread without a version, or an old one, is a violation (fail-closed); the echo wins over the user agent', () => {
    expect(verifyCodexCliVersion({ thread: { cliVersion: '0.159.2' } }, 'x/0.100.0')).toEqual({ version: '0.159.2', violation: null });
    expect(verifyCodexCliVersion({ thread: {} }, 'nimbalyst/0.159.3 (mac)')).toEqual({ version: '0.159.3', violation: null });
    expect(verifyCodexCliVersion({ thread: { cliVersion: '0.150.0' } }, null)).toEqual({ version: '0.150.0', violation: 'Codex CLI 0.150.0 is older than the minimum 0.159.1 this integration was verified with' });
    expect(verifyCodexCliVersion({ thread: {} }, 'fake/0')).toEqual({ version: null, violation: 'the Codex CLI did not report its version' });
  });

  it('refusals say what was not verified and that no turn ran', () => {
    expect(describeRestrictedCodexViolation('process', ['notify is not empty'])).toBe('Restricted Team mode member refused: the Codex process did not take the restricted configuration (notify is not empty). No turn was run; update or reconfigure Codex and try again.');
    expect(describeRestrictedCodexViolation('thread', ['a', 'b'])).toContain('the Codex thread did not take the restricted policy (a; b)');
    expect(describeRestrictedCodexViolation('version', ['v'])).toContain('the Codex CLI version cannot be trusted for a restricted member (v)');
  });
});
