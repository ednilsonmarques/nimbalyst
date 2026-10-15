// @vitest-environment node
/**
 * A Team mode read member on OpenAI Codex, end to end through sendMessage
 * with a mock protocol (no Codex process, no network): the thread is started
 * with the restricted profile inputs (scoped MCP snapshot, restricted scope
 * for the read-only sandbox and `untrusted` approvals, the user's own MCP
 * servers and plugins disabled, web search off), the member's contract and
 * mission in the developer instructions, and the thread marked restricted so
 * every approval is refused. A scope Codex cannot honour, or the legacy SDK
 * transport, ends the turn before any thread starts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICodexProvider } from '../OpenAICodexProvider';
import { configureMcpServers } from '../../services/mcpServerConfig';
import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';
import { AgentMessagesRepository } from '../../../../storage/repositories/AgentMessagesRepository';
import { CodexAppServerExitedError } from '../../protocols/CodexAppServerProtocol';

vi.mock('openai', () => ({
  default: class {
    models = { list: async () => ({ data: [] as Array<{ id: string }> }) };
  },
}));

const MISSION = 'Read the Tool Manifest, the implementation and the reviewer\'s verdict and test whether the team\'s conclusion holds.';
const ROWS: Record<string, { agentRole: string; metadata: Record<string, unknown> }> = {
  adv: { agentRole: 'standard', metadata: { toolScope: 'read', teamChild: { role: 'advisor', rootSessionId: 'root', depth: 1, mission: MISSION } } },
  rev: { agentRole: 'standard', metadata: { toolScope: 'review', teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1 } } },
  writer: { agentRole: 'standard', metadata: { toolScope: 'write', teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } } },
  plain: { agentRole: 'standard', metadata: {} },
};

function makeProvider(
  transport: 'app-server' | 'sdk',
  createSessionImpl: (options: any) => Promise<unknown> = async () => ({ id: 'thread-under-test', platform: 'mock', raw: {} }),
) {
  const createSession = vi.fn(createSessionImpl);
  const protocol = {
    platform: 'mock',
    createSession,
    resumeSession: vi.fn(),
    forkSession: vi.fn(),
    sendMessage: () => (async function* () {})(),
    abortSession: vi.fn(),
    cleanupSession: vi.fn(),
  };
  const provider = new OpenAICodexProvider({ apiKey: 'test-key' }, { transport, protocol: protocol as never });
  return { provider, createSession };
}

async function drain(provider: OpenAICodexProvider, sessionId: string): Promise<Array<Record<string, unknown>>> {
  const chunks: Array<Record<string, unknown>> = [];
  for await (const chunk of provider.sendMessage('brief', undefined, sessionId, [], process.cwd())) {
    chunks.push(chunk as unknown as Record<string, unknown>);
  }
  return chunks;
}

let userConfigLoader: ReturnType<typeof vi.fn<(workspacePath?: string) => Promise<{ mcpServerNames: string[]; pluginIds: string[] }>>>;

describe('OpenAICodexProvider: a restricted Team mode member', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    configureMcpServers({ mcpServerPort: 41001, extensionDevServerPort: null });
    OpenAICodexProvider.setMCPConfigLoader(null);
    OpenAICodexProvider.setClaudeSettingsEnvLoader(null);
    OpenAICodexProvider.setShellEnvironmentLoader(null);
    OpenAICodexProvider.setEnhancedPathLoader(null);
    OpenAICodexProvider.setPreEditHookScriptPathResolver(null);
    OpenAICodexProvider.setPreEditSidecarDirResolver(null);
    OpenAICodexProvider.setCodexTransportResolver(null);
    OpenAICodexProvider.setCodexAuthGate(null);
    OpenAICodexProvider.setTrustChecker(() => ({ trusted: true, mode: 'bypass-all' as any, allowAllUsesClassifier: true }));
    OpenAICodexProvider.setPermissionPatternChecker(async () => false);
    OpenAICodexProvider.setPermissionPatternSaver(async () => {});
    OpenAICodexProvider.setSecurityLogger(() => {});
    userConfigLoader = vi.fn(async (_workspacePath?: string) => ({
      mcpServerNames: ['node_repl'],
      pluginIds: ['browser@openai-bundled', 'computer-use@openai-bundled'],
    }));
    OpenAICodexProvider.setCodexUserConfigLoader(userConfigLoader);
    AISessionsRepository.setStore({ get: async (id: string) => ROWS[id] ?? null } as never);
  });

  afterEach(() => {
    AISessionsRepository.clearStore();
    OpenAICodexProvider.setCodexUserConfigLoader(null);
    OpenAICodexProvider.setTrustChecker(null as never);
  });

  it('starts the advisor\'s thread restricted: scoped MCP snapshot, read scope, user servers and plugins off, web search off, contract and mission in the instructions, thread marked', async () => {
    const { provider, createSession } = makeProvider('app-server');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'adv');
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(createSession).toHaveBeenCalledTimes(1);
    const options = createSession.mock.calls[0]![0] as any;
    expect(options.raw.restrictedToolScope).toBe('read');
    expect(Object.keys(options.mcpServers).every((name: string) => name.startsWith('nimbalyst'))).toBe(true);
    expect(Object.keys(options.mcpServers)).toContain('nimbalyst-host');
    expect(options.mcpServers['nimbalyst-host'].url).toContain('hostExcludeSettings=1');
    const config = options.raw.codexConfigOverrides;
    expect(config.web_search).toBe('disabled');
    expect(config.features).toEqual({ multi_agent: false });
    expect(config.mcp_servers.node_repl).toEqual({ enabled: false });
    expect(userConfigLoader).toHaveBeenCalledWith(process.cwd());
    expect(config.plugins['computer-use@openai-bundled']).toEqual({ enabled: false });
    expect(config.plugins['browser@openai-bundled']).toEqual({ enabled: false });
    expect(Object.keys(config.mcp_servers).some((name: string) => name.startsWith('nimbalyst'))).toBe(true);
    expect(options.raw.systemPrompt).toContain('## Team Member: Independent Advisor');
    expect(options.raw.systemPrompt).toContain(MISSION);
    expect(options.raw.systemPrompt).toContain('You have read-only tools and nothing else');
    // The provider adapter's transport note: no shell on this provider, reading is the host's tools.
    expect(options.raw.systemPrompt).toContain('### Reading on this provider');
    expect(options.raw.systemPrompt).toContain('Read files with the Nimbalyst tools `read_file`, `list_files` and `search_files`');
    expect(options.raw.systemPrompt).toContain('You have no shell on this host: it is switched off for read members');
    // The process-level restriction the protocol spawns the child with and verifies (NIB.46 7.2/7.4/7.5).
    expect(options.raw.codexProcessOverrides).toEqual(expect.arrayContaining(['features.shell_tool=false', 'features.unified_exec=false', 'notify=[]', 'hooks={}', 'web_search="disabled"', 'features.multi_agent=false', 'mcp_servers={"node_repl"={enabled=false}}', 'plugins={"browser@openai-bundled"={enabled=false},"computer-use@openai-bundled"={enabled=false}}']));
    // The tables the overrides were built from, for the protocol's single respawn.
    expect(options.raw.restrictedUserTables).toEqual({ mcpServerNames: ['node_repl'], pluginIds: ['browser@openai-bundled', 'computer-use@openai-bundled'] });
    expect(options.raw.restrictedExpectedModel).toBeTruthy();
    expect(options.raw.systemPrompt.indexOf('## Team Member: Independent Advisor')).toBeLessThan(options.raw.systemPrompt.indexOf('### Reading on this provider'));
    expect(provider.isRestrictedThread('thread-under-test')).toBe(true);
    // Fail-closed while a restricted thread exists: an unknown thread (a
    // collaboration child, an unnamed request) is restricted too.
    expect(provider.isRestrictedThread('child-thread-the-app-server-spawned')).toBe(true);
    expect(provider.isRestrictedThread(undefined)).toBe(true);
  });

  it('with no restricted thread, nothing is restricted; a thread this provider created unrestricted never is', async () => {
    const { provider } = makeProvider('app-server');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    expect(provider.isRestrictedThread('anything')).toBe(false);
    expect(provider.isRestrictedThread(undefined)).toBe(false);
    await drain(provider, 'plain');
    expect(provider.isRestrictedThread('thread-under-test')).toBe(false);
    expect(provider.isRestrictedThread('other')).toBe(false);
  });

  it('a reviewer (review) is restricted the same way with its own contract', async () => {
    const { provider, createSession } = makeProvider('app-server');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    await drain(provider, 'rev');
    const options = createSession.mock.calls[0]![0] as any;
    expect(options.raw.restrictedToolScope).toBe('review');
    expect(options.raw.systemPrompt).toContain('## Team Member');
    expect(options.raw.systemPrompt).not.toContain('Independent Advisor');
  });

  it('an unrestricted session is started as before: standard snapshot, no restriction, no web-search or user-server overrides, thread not marked', async () => {
    const { provider, createSession } = makeProvider('app-server');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    await drain(provider, 'plain');
    const options = createSession.mock.calls[0]![0] as any;
    expect(options.raw.restrictedToolScope).toBeUndefined();
    expect(options.raw.codexConfigOverrides.web_search).toBeUndefined();
    expect(options.raw.codexConfigOverrides.mcp_servers.node_repl).toBeUndefined();
    expect(options.mcpServers['nimbalyst-host'].url).not.toContain('hostExcludeSettings=1');
    expect(options.raw.systemPrompt).not.toContain('## Team Member');
    expect(options.raw.systemPrompt).not.toContain('### Reading on this provider');
    expect(provider.isRestrictedThread('thread-under-test')).toBe(false);
  });

  it('a write member ends the turn before any thread starts: Codex cannot enforce that scope', async () => {
    const { provider, createSession } = makeProvider('app-server');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'writer');
    expect(chunks).toEqual([{ type: 'error', error: expect.stringContaining('cannot be enforced on OpenAI Codex') }]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('the legacy SDK transport cannot restrict a thread: a read member ends the turn before any thread starts', async () => {
    const { provider, createSession } = makeProvider('sdk');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'adv');
    expect(chunks).toEqual([{ type: 'error', error: expect.stringContaining('only through the app-server transport') }]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('a user configuration that cannot be read ends the turn before any thread starts (fail-closed)', async () => {
    OpenAICodexProvider.setCodexUserConfigLoader(async () => { throw new Error('Could not read the Codex configuration at X to restrict this session (EACCES); the turn was not run.'); });
    const { provider, createSession } = makeProvider('app-server');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'adv');
    expect(chunks.some((chunk) => chunk.type === 'error' && String(chunk.error).includes('Could not read the Codex configuration'))).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe('OpenAICodexProvider: a refused restricted member leaves the error in its own transcript', () => {
  // A background member has no window for the ai:error event; its coordinator
  // reads the transcript (pilot G, 2026-10-14: the refusal was invisible).
  let rows: Array<{ sessionId: string; direction: string; content: string }>;

  beforeEach(() => {
    vi.restoreAllMocks();
    configureMcpServers({ mcpServerPort: 41001, extensionDevServerPort: null });
    OpenAICodexProvider.setCodexTransportResolver(null);
    OpenAICodexProvider.setCodexAuthGate(null);
    OpenAICodexProvider.setTrustChecker(() => ({ trusted: true, mode: 'bypass-all' as any, allowAllUsesClassifier: true }));
    OpenAICodexProvider.setSecurityLogger(() => {});
    OpenAICodexProvider.setCodexUserConfigLoader(async () => ({ mcpServerNames: [], pluginIds: ['browser@openai-bundled'] }));
    AISessionsRepository.setStore({ get: async (id: string) => ROWS[id] ?? null } as never);
    rows = [];
    AgentMessagesRepository.setStore({ create: async (message: any) => { rows.push(message); } } as never);
  });

  afterEach(() => {
    AgentMessagesRepository.clearStore();
    AISessionsRepository.clearStore();
    OpenAICodexProvider.setCodexUserConfigLoader(null);
    OpenAICodexProvider.setTrustChecker(null as never);
  });

  function errorRows(sessionId: string) {
    return rows
      .filter((row) => row.sessionId === sessionId && row.direction === 'output')
      .map((row) => JSON.parse(row.content))
      .filter((content) => content.method === 'error');
  }

  it('the protocol\'s process-verification refusal is persisted as an error row the transcript and get_session_result read', async () => {
    const refusal = '[CodexAppServer] Restricted Team mode member refused: the Codex process did not take the restricted configuration (plugins.computer-use@openai-bundled is still enabled). No turn was run; update or reconfigure Codex and try again.';
    const { provider, createSession } = makeProvider('app-server', async () => { throw new Error(refusal); });
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'adv');
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(chunks).toContainEqual({ type: 'error', error: refusal });
    expect(errorRows('adv')).toEqual([{ method: 'error', params: { error: { message: refusal } }, error: refusal }]);
  });

  it('NIB.54: a Codex process that dies mid-turn ends the turn as an error in the transcript and the dead session is dropped, so the next turn starts a fresh one', async () => {
    const exitedMessage = '[CodexAppServer] the Codex process exited during the turn (signal SIGKILL); the turn did not complete';
    const createSession = vi.fn(async () => ({ id: 'thread-dead', platform: 'mock', raw: {} }));
    const resumeSession = vi.fn(async () => ({ id: 'thread-dead', platform: 'mock', raw: {} }));
    const protocol = {
      platform: 'mock', createSession, resumeSession, forkSession: vi.fn(), abortSession: vi.fn(), cleanupSession: vi.fn(),
      sendMessage: () => (async function* () { throw new CodexAppServerExitedError(exitedMessage); })(),
    };
    const provider = new OpenAICodexProvider({ apiKey: 'test-key' }, { transport: 'app-server', protocol: protocol as never });
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'adv');
    expect(chunks).toContainEqual({ type: 'error', error: exitedMessage });
    expect(errorRows('adv')).toEqual([{ method: 'error', params: { error: { message: exitedMessage } }, error: exitedMessage }]);
    // No retry inside the turn: one session open, one attempt.
    expect(createSession.mock.calls.length + resumeSession.mock.calls.length).toBe(1);
    // The dead live session was evicted: the next turn opens the session again instead of reusing it.
    await drain(provider, 'adv');
    expect(createSession.mock.calls.length + resumeSession.mock.calls.length).toBe(2);
  });

  it('NIB.54 (review B1): a death by SIGABRT with "cancelled" in its stderr is still a failure, never swallowed as a cancel', async () => {
    const exitedMessage = '[CodexAppServer] the Codex process exited during the turn (signal SIGABRT); the turn did not complete\nstderr tail: request cancelled; aborted';
    const createSession = vi.fn(async () => ({ id: 'thread-abrt', platform: 'mock', raw: {} }));
    const resumeSession = vi.fn(async () => ({ id: 'thread-abrt', platform: 'mock', raw: {} }));
    const protocol = {
      platform: 'mock', createSession, resumeSession, forkSession: vi.fn(), abortSession: vi.fn(), cleanupSession: vi.fn(),
      sendMessage: () => (async function* () { throw new CodexAppServerExitedError(exitedMessage); })(),
    };
    const provider = new OpenAICodexProvider({ apiKey: 'test-key' }, { transport: 'app-server', protocol: protocol as never });
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'adv');
    expect(chunks).toContainEqual({ type: 'error', error: exitedMessage });
    expect(errorRows('adv')).toHaveLength(1);
    await drain(provider, 'adv');
    expect(createSession.mock.calls.length + resumeSession.mock.calls.length).toBe(2); // evicted
  });

  it('an ordinary error whose text says "cancelled" keeps today\'s cancel classification (only the Codex exit is exempt)', async () => {
    const protocol = {
      platform: 'mock', createSession: vi.fn(async () => ({ id: 't', platform: 'mock', raw: {} })), resumeSession: vi.fn(), forkSession: vi.fn(), abortSession: vi.fn(), cleanupSession: vi.fn(),
      sendMessage: () => (async function* () { throw new Error('request cancelled by the transport'); })(),
    };
    const provider = new OpenAICodexProvider({ apiKey: 'test-key' }, { transport: 'app-server', protocol: protocol as never });
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    const chunks = await drain(provider, 'adv');
    expect(chunks.filter((chunk) => chunk.type === 'error')).toEqual([]);
    expect(errorRows('adv')).toEqual([]);
  });

  it('a scope Codex cannot enforce is persisted too, before any thread starts', async () => {
    const { provider, createSession } = makeProvider('app-server');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    await drain(provider, 'writer');
    expect(createSession).not.toHaveBeenCalled();
    const persisted = errorRows('writer');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].error).toContain('cannot be enforced on OpenAI Codex');
  });

  it('the legacy SDK transport refusal is persisted too', async () => {
    const { provider } = makeProvider('sdk');
    await provider.initialize({ apiKey: 'test-key', model: 'openai-codex:gpt-6.1-sol' });
    await drain(provider, 'adv');
    const persisted = errorRows('adv');
    expect(persisted).toHaveLength(1);
    expect(persisted[0].error).toContain('only through the app-server transport');
  });
});
