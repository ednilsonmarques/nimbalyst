// @vitest-environment node
/**
 * Codex's half of a Team mode child's tool scope: which scopes it honours,
 * what a restricted thread's config overrides disable, and the host bindings
 * that refuse every approval of a restricted thread.
 */
import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_ENFORCED_TOOL_SCOPES,
  CODEX_KNOWN_SAFE_READ_COMMANDS,
  buildCodexReadAccessNote,
  buildRestrictedCodexConfigOverrides,
  describeUnsupportedCodexScope,
  isFirstPartyCodexMcpElicitation,
  loadCodexUserConfigTables,
  mergeRestrictedCodexConfigOverrides,
  parseCodexUserConfigTables,
  resolveCodexHome,
  resolveCodexRestriction,
  wrapCodexHostBindingsForRestriction,
} from '../codexTeamPolicy';

// The shape of a real ~/.codex/config.toml written by the Codex desktop app:
// a notify hook, plugins with quoted ids, a user MCP server with sub-tables.
const USER_CONFIG = `
notify = [ "C:\\\\x\\\\codex-computer-use.exe", "turn-ended" ]
[desktop]
followUpQueueMode = "steer"

[marketplaces.openai-bundled]
source_type = "local"

[plugins."browser@openai-bundled"]
enabled = true

[plugins."computer-use@openai-bundled"]
enabled = true

[plugins.'pdf@openai-primary-runtime']
enabled = true

[mcp_servers.node_repl]
args = []
command = 'C:\\x\\node_repl.exe'

[mcp_servers.node_repl.env]
NODE_REPL_NODE_PATH = 'C:\\x\\node.exe'

[mcp_servers."my server"]
url = "http://127.0.0.1:9/mcp"

  [ mcp_servers . spaced ]
command = "x"

mcp_servers.dotted.command = "node"
mcp_servers."dotted quoted" = { command = "node", args = ["server.js"] }
plugins."inline@market".enabled = true

[mcp_servers]
bare = { command = "x" }
"bare quoted" = { command = "y" }
not_a_server_key_without_equals

[plugins]
bareplugin = { enabled = true }
`;

describe('resolveCodexRestriction', () => {
  it('read and review are restricted, full is none, write is unsupported', () => {
    expect(resolveCodexRestriction('read', 'advisor')).toEqual({ kind: 'restricted', scope: 'read', role: 'advisor' });
    expect(resolveCodexRestriction('review', 'reviewer')).toEqual({ kind: 'restricted', scope: 'review', role: 'reviewer' });
    expect(resolveCodexRestriction('full', null)).toEqual({ kind: 'none' });
    expect(resolveCodexRestriction('write', 'implementer')).toEqual({ kind: 'unsupported', scope: 'write' });
    expect(CODEX_ENFORCED_TOOL_SCOPES).toEqual(['read', 'review']);
  });

  it('the transport note tells a restricted member how it reads here and that nothing else is ever granted; it names no role and changes no rule', () => {
    const note = buildCodexReadAccessNote('read');
    expect(note).toContain('### Reading on this provider');
    expect(note).toContain('Read files with the Nimbalyst tools `read_file`, `list_files` and `search_files` (MCP server `nimbalyst`)');
    expect(note).toContain('Do not use your shell to read: on this host every command of yours is refused');
    expect(note).toContain(CODEX_KNOWN_SAFE_READ_COMMANDS);
    expect(note).toContain('refused automatically, no dialog ever reaches the user, so do not wait for one and do not ask for one');
    expect(note).toContain('web search is off');
    expect(note).not.toMatch(/advisor|architect|reviewer|explorer/i);
    expect(buildCodexReadAccessNote('review')).toContain('(the workspace test runner among them)');
    expect(note).not.toContain('test runner');
  });

  it('an unsupported scope or transport ends the turn with a reason, never runs it', () => {
    expect(describeUnsupportedCodexScope('write', 'scope')).toContain('cannot be enforced on OpenAI Codex');
    expect(describeUnsupportedCodexScope('write', 'scope')).toContain('the turn was not run');
    expect(describeUnsupportedCodexScope('read', 'transport')).toContain('only through the app-server transport');
    expect(describeUnsupportedCodexScope('read', 'transport')).toContain('the turn was not run');
  });
});

describe('the user\'s config.toml tables', () => {
  it('names every user MCP server and plugin: table headers, dotted keys, inline tables and bare-table entries, quoted or bare, once, ignoring sub-tables', () => {
    expect(parseCodexUserConfigTables(USER_CONFIG)).toEqual({
      mcpServerNames: ['node_repl', 'my server', 'spaced', 'dotted', 'dotted quoted', 'bare', 'bare quoted'],
      pluginIds: ['browser@openai-bundled', 'computer-use@openai-bundled', 'pdf@openai-primary-runtime', 'inline@market', 'bareplugin'],
    });
    expect(parseCodexUserConfigTables('')).toEqual({ mcpServerNames: [], pluginIds: [] });
    expect(parseCodexUserConfigTables('[desktop]\nx = 1\n[mcp_servers]\n')).toEqual({ mcpServerNames: [], pluginIds: [] });
    // A bare table ends at the next header: keys after it are not servers.
    expect(parseCodexUserConfigTables('[mcp_servers]\nfoo = { command = "x" }\n[desktop]\nbar = 1\n')).toEqual({ mcpServerNames: ['foo'], pluginIds: [] });
  });

  it('reads the user file under CODEX_HOME or ~/.codex and the project\'s .codex/config.toml; a missing file is empty, an unreadable one throws', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
    const project = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-project-'));
    try {
      expect(await loadCodexUserConfigTables(home)).toEqual({ mcpServerNames: [], pluginIds: [] });
      expect(await loadCodexUserConfigTables(home, project)).toEqual({ mcpServerNames: [], pluginIds: [] });
      await fs.writeFile(path.join(home, 'config.toml'), USER_CONFIG, 'utf8');
      expect((await loadCodexUserConfigTables(home)).mcpServerNames).toContain('node_repl');
      await fs.mkdir(path.join(project, '.codex'));
      await fs.writeFile(path.join(project, '.codex', 'config.toml'), '[mcp_servers.project_escape]\ncommand = "node"\n', 'utf8');
      const merged = await loadCodexUserConfigTables(home, project);
      expect(merged.mcpServerNames).toContain('node_repl');
      expect(merged.mcpServerNames).toContain('project_escape');
      // A directory where the file should be: not ENOENT, so it throws.
      await fs.mkdir(path.join(home, 'broken'));
      await fs.mkdir(path.join(home, 'broken', 'config.toml'));
      await expect(loadCodexUserConfigTables(path.join(home, 'broken'))).rejects.toThrow(/Could not read the Codex configuration .* the turn was not run/);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(project, { recursive: true, force: true });
    }
    expect(resolveCodexHome({ CODEX_HOME: 'D:\\codex' })).toBe('D:\\codex');
    expect(resolveCodexHome({ CODEX_HOME: '  ' })).toBe(path.join(os.homedir(), '.codex'));
    expect(resolveCodexHome({})).toBe(path.join(os.homedir(), '.codex'));
  });

  it('builds the restricted overrides: web search off, collaboration sub-agents off, every user server and plugin disabled', () => {
    const overrides = buildRestrictedCodexConfigOverrides(parseCodexUserConfigTables(USER_CONFIG));
    expect(overrides.web_search).toBe('disabled');
    expect(overrides.features).toEqual({ multi_agent: false });
    expect(overrides.mcp_servers).toEqual({
      node_repl: { enabled: false }, 'my server': { enabled: false }, spaced: { enabled: false },
      dotted: { enabled: false }, 'dotted quoted': { enabled: false }, bare: { enabled: false }, 'bare quoted': { enabled: false },
    });
    expect(overrides.plugins).toEqual({
      'browser@openai-bundled': { enabled: false },
      'computer-use@openai-bundled': { enabled: false },
      'pdf@openai-primary-runtime': { enabled: false },
      'inline@market': { enabled: false },
      bareplugin: { enabled: false },
    });
    expect(buildRestrictedCodexConfigOverrides({ mcpServerNames: [], pluginIds: [] })).toEqual({ web_search: 'disabled', features: { multi_agent: false } });
  });

  it('merges with the provider\'s overrides: Nimbalyst servers, plugin switches and feature flags win per key, web search stays off', () => {
    const provider = {
      show_raw_agent_reasoning: true,
      plugins: { 'browser@openai-bundled': { enabled: false } },
      mcp_servers: { nimbalyst: { url: 'http://127.0.0.1:1/mcp/core' }, node_repl: { url: 'http://127.0.0.1:1/mcp/x' } },
      features: { shell_snapshot: true },
    };
    const restricted = buildRestrictedCodexConfigOverrides({ mcpServerNames: ['node_repl', 'other'], pluginIds: ['browser@openai-bundled', 'computer-use@openai-bundled'] });
    expect(mergeRestrictedCodexConfigOverrides(provider, restricted)).toEqual({
      web_search: 'disabled',
      show_raw_agent_reasoning: true,
      features: { multi_agent: false, shell_snapshot: true },
      plugins: { 'browser@openai-bundled': { enabled: false }, 'computer-use@openai-bundled': { enabled: false } },
      mcp_servers: { other: { enabled: false }, nimbalyst: { url: 'http://127.0.0.1:1/mcp/core' }, node_repl: { url: 'http://127.0.0.1:1/mcp/x' } },
    });
    expect(mergeRestrictedCodexConfigOverrides(undefined, restricted)).toEqual(restricted);
  });
});

describe('wrapCodexHostBindingsForRestriction', () => {
  const restricted = (threadId: string | undefined) => threadId === 'r';
  const params = (threadId: string) => ({ threadId, turnId: 't', itemId: 'i', command: 'rm -rf /', changes: [] }) as never;

  it('refuses every approval, foreign elicitation, user input and dynamic tool of a restricted thread, whatever the real bindings would say', async () => {
    const allow = vi.fn(async () => ({ decision: 'approved' as const }));
    const elicit = vi.fn(async () => ({ action: 'accept' as const, content: { ok: true }, _meta: null }));
    const log = vi.fn();
    const host = wrapCodexHostBindingsForRestriction({
      approveFileChange: allow, approveCommandExecution: allow, approvePermissions: allow,
      handleMcpElicitation: elicit,
      handleToolUserInput: vi.fn(async () => ({ answer: 'yes' })),
      callDynamicTool: vi.fn(async () => ({ isError: false, content: [] })),
    }, restricted, log);
    expect(await host.approveFileChange!(params('r'))).toEqual({ decision: 'denied' });
    expect(await host.approveCommandExecution!(params('r'))).toEqual({ decision: 'denied' });
    expect(await host.approvePermissions!(params('r'))).toEqual({ decision: 'denied' });
    expect(await host.handleMcpElicitation!({ threadId: 'r', serverName: 'node_repl' })).toEqual({ action: 'decline', content: null, _meta: null });
    expect(await host.handleMcpElicitation!({ threadId: 'r' })).toEqual({ action: 'decline', content: null, _meta: null });
    expect(await host.handleToolUserInput!(params('r'))).toBeNull();
    const dynamic = await host.callDynamicTool!({ threadId: 'r', tool: 'x' } as never);
    expect(dynamic.isError).toBe(true);
    expect(allow).not.toHaveBeenCalled();
    expect(elicit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(7);
    expect(log.mock.calls[0][0]).toContain('refused for restricted thread r');
  });

  it('accepts a restricted thread\'s elicitation from Nimbalyst\'s own servers (the session-scoped server is the policy), never through the real bindings', async () => {
    const elicit = vi.fn(async () => ({ action: 'decline' as const, content: null, _meta: null }));
    const host = wrapCodexHostBindingsForRestriction({ handleMcpElicitation: elicit }, restricted, vi.fn());
    for (const serverName of ['nimbalyst', 'nimbalyst-host', 'nimbalyst-trackers', 'nimbalyst-situational']) {
      expect(await host.handleMcpElicitation!({ threadId: 'r', serverName }), serverName).toEqual({ action: 'accept', content: null, _meta: null });
    }
    expect(await host.handleMcpElicitation!({ threadId: 'r', serverName: 'nimbalyst-browser' })).toEqual({ action: 'decline', content: null, _meta: null });
    expect(await host.handleMcpElicitation!({ threadId: 'r', serverName: 'nimbalyst-extension-dev' })).toEqual({ action: 'decline', content: null, _meta: null });
    expect(elicit).not.toHaveBeenCalled();
    // Other threads still go through the real bindings.
    expect(await host.handleMcpElicitation!({ threadId: 'other', serverName: 'node_repl' })).toEqual({ action: 'decline', content: null, _meta: null });
    expect(elicit).toHaveBeenCalledTimes(1);
    expect(isFirstPartyCodexMcpElicitation({ server: 'nimbalyst' })).toBe(true);
    expect(isFirstPartyCodexMcpElicitation({})).toBe(false);
  });

  it('hands every other thread to the real bindings', async () => {
    const allow = vi.fn(async () => ({ decision: 'approved' as const }));
    const host = wrapCodexHostBindingsForRestriction({ approveCommandExecution: allow }, restricted, vi.fn());
    expect(await host.approveCommandExecution!(params('other'))).toEqual({ decision: 'approved' });
    expect(allow).toHaveBeenCalledTimes(1);
  });

  it('without real bindings keeps the protocol\'s defaults for other threads: approvals denied, elicitations accepted, no input, no dynamic tool', async () => {
    const host = wrapCodexHostBindingsForRestriction(undefined, restricted, vi.fn());
    expect(await host.approveFileChange!(params('other'))).toEqual({ decision: 'denied' });
    expect(await host.approveCommandExecution!(params('other'))).toEqual({ decision: 'denied' });
    expect(await host.approvePermissions!(params('other'))).toEqual({ decision: 'denied' });
    expect(await host.handleMcpElicitation!(params('other'))).toEqual({ action: 'accept', content: null, _meta: null });
    expect(await host.handleToolUserInput!(params('other'))).toBeNull();
    expect((await host.callDynamicTool!({ threadId: 'other', tool: 'x' } as never)).isError).toBe(true);
  });

  it('a request without a thread id is treated by the predicate (unknown is not restricted unless the predicate says so)', async () => {
    const host = wrapCodexHostBindingsForRestriction(undefined, (id) => id === undefined, vi.fn());
    expect(await host.approveCommandExecution!({ command: 'x' } as never)).toEqual({ decision: 'denied' });
  });
});
