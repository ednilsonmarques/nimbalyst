// @vitest-environment node
/**
 * The REAL catalog the unified MCP server serves a session, and what a call
 * gets, driven over the SDK's in-memory transport: a read advisor sees no
 * mutable, delegating or asking tool on any first-party endpoint, and a call
 * to one of them (a name the model remembers, an injected request) is refused
 * without reaching its handler. An unrestricted session is served as before.
 * Nothing here depends on the provider on the other end of the transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn() },
}));
// The handlers of the tools a restricted session must never reach: spies that
// prove no execution happened. Schemas stay real so the catalog is the real one.
vi.mock('../metaAgentServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../metaAgentServer')>()),
  dispatchMetaAgentTool: vi.fn(async () => 'EXECUTED'),
}));
vi.mock('../tools/trackerToolHandlers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/trackerToolHandlers')>()),
  handleTrackerUpdate: vi.fn(async () => ({ content: [{ type: 'text', text: 'EXECUTED' }] })),
  handleTrackerCreate: vi.fn(async () => ({ content: [{ type: 'text', text: 'EXECUTED' }] })),
  handleTrackerGet: vi.fn(async () => ({ content: [{ type: 'text', text: 'ITEM' }] })),
}));
vi.mock('../tools/interactiveToolHandlers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/interactiveToolHandlers')>()),
  handleGitCommitProposal: vi.fn(async () => ({ content: [{ type: 'text', text: 'EXECUTED' }] })),
}));
vi.mock('../tools/editorToolHandlers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/editorToolHandlers')>()),
  handleApplyDiff: vi.fn(async () => ({ content: [{ type: 'text', text: 'EXECUTED' }] })),
}));
vi.mock('../sessionNamingServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessionNamingServer')>()),
  buildSessionMetaToolSchemas: vi.fn(async () => [{ name: 'update_session_meta', description: 'meta', inputSchema: { type: 'object' } }]),
}));
vi.mock('../devAgentTools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../devAgentTools')>()),
  dispatchDevAgentTool: vi.fn(async (name: string) => `READ:${name}`),
}));
vi.mock('../tools/extensionToolHandler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/extensionToolHandler')>()),
  handleExtensionTool: vi.fn(async (toolName: string) => ({ content: [{ type: 'text', text: `EXTENSION:${toolName}` }] })),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSharedMcpServer } from '../httpServer';
import { dispatchMetaAgentTool } from '../metaAgentServer';
import { handleTrackerCreate, handleTrackerGet, handleTrackerUpdate } from '../tools/trackerToolHandlers';
import { handleGitCommitProposal } from '../tools/interactiveToolHandlers';
import { handleApplyDiff } from '../tools/editorToolHandlers';
import { dispatchDevAgentTool } from '../devAgentTools';
import { handleExtensionTool } from '../tools/extensionToolHandler';
import { resetSessionToolPolicies, setSessionToolPolicyReader } from '../sessionToolPolicy';
import type { McpEndpointSelection } from '../mcpEndpointRouting';

const ROWS: Record<string, { agentRole: string; provider: string; metadata: Record<string, unknown> }> = {
  // A Claude Code advisor: read scope, advisor role.
  adv: { agentRole: 'standard', provider: 'claude-code', metadata: { toolScope: 'read', teamChild: { role: 'advisor', rootSessionId: 'root', depth: 1 } } },
  // A Codex advisor: the same policy, plus the host's file reads (its shell is refused).
  'adv-codex': { agentRole: 'standard', provider: 'openai-codex', metadata: { toolScope: 'read', teamChild: { role: 'advisor', rootSessionId: 'root', depth: 1 } } },
  rev: { agentRole: 'standard', provider: 'claude-code', metadata: { toolScope: 'review', teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1 } } },
  root: { agentRole: 'standard', provider: 'claude-code', metadata: { teamMode: true } },
  plain: { agentRole: 'standard', provider: 'openai-codex', metadata: {} },
};

const HOST: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst-host' };
const CORE: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst' };
const TRACKERS: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst-trackers' };

async function connect(sessionId: string | undefined, endpoint: McpEndpointSelection, excludeHostSettings = false) {
  const server = createSharedMcpServer('C:\\ws', sessionId, endpoint, excludeHostSettings);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name).sort(),
    call: async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>,
    close: async () => { await client.close(); await server.close(); },
  };
}

beforeEach(() => {
  resetSessionToolPolicies();
  setSessionToolPolicyReader(async (sessionId) => ROWS[sessionId] ?? null);
  vi.mocked(dispatchMetaAgentTool).mockClear();
  vi.mocked(handleTrackerUpdate).mockClear();
  vi.mocked(handleTrackerCreate).mockClear();
  vi.mocked(handleGitCommitProposal).mockClear();
  vi.mocked(handleApplyDiff).mockClear();
  vi.mocked(dispatchDevAgentTool).mockClear();
});

afterEach(() => {
  setSessionToolPolicyReader(null);
});

describe('the catalog a read advisor is served (real schemas, in-memory transport)', () => {
  it('host endpoint: no session creation, prompting, answering, test running or app configuration; the reads stay', async () => {
    const adv = await connect('adv', HOST, true);
    const names = await adv.names();
    for (const denied of ['create_session', 'spawn_session', 'send_prompt', 'respond_to_prompt', 'run_project_tests', 'schedule_wakeup', 'notify_user', 'features_toggle', 'workspace_set_trust', 'ai_set_default_model']) {
      expect(names, denied).not.toContain(denied);
    }
    for (const kept of ['get_session_result', 'get_session_status', 'list_spawned_sessions', 'list_queued_prompts', 'ecc_catalog_lookup', 'get_session_summary', 'list_recent_sessions']) {
      expect(names, kept).toContain(kept);
    }
    await adv.close();
  });

  it('trackers endpoint: no writes, no type changes, no links; reads stay', async () => {
    const adv = await connect('adv', TRACKERS);
    const names = await adv.names();
    for (const denied of ['tracker_create', 'tracker_update', 'tracker_define_type', 'tracker_delete_type', 'tracker_link_session', 'tracker_unlink_session', 'tracker_link_file', 'tracker_add_comment', 'tracker_import', 'tracker_resnapshot', 'tracker_set_issue_key_prefix']) {
      expect(names, denied).not.toContain(denied);
    }
    for (const kept of ['tracker_get', 'tracker_list', 'tracker_get_by_urn', 'tracker_list_types', 'tracker_ready', 'work_radar']) {
      expect(names, kept).toContain(kept);
    }
    await adv.close();
  });

  it('core endpoint: no commit proposal, no questions to the user (the advisor\'s role), no edits; session naming and display stay', async () => {
    const adv = await connect('adv', CORE);
    const names = await adv.names();
    for (const denied of ['developer_git_commit_proposal', 'AskUserQuestion', 'PromptForUserInput', 'applyDiff', 'streamContent', 'createSharedDoc', 'deleteSharedItem', 'applyCollabDocEdit', 'declareCanvasWorkingSet']) {
      expect(names, denied).not.toContain(denied);
    }
    for (const kept of ['update_session_meta', 'display_to_user', 'get_session_edited_files', 'capture_editor_screenshot']) {
      expect(names, kept).toContain(kept);
    }
    await adv.close();
  });

  it('core endpoint: a Codex advisor is also served the host\'s file reads (read_file, list_files, search_files); a Claude advisor, a root and a plain Codex session are not', async () => {
    const codex = await connect('adv-codex', CORE);
    const names = await codex.names();
    for (const kept of ['read_file', 'list_files', 'search_files', 'update_session_meta', 'display_to_user']) expect(names, kept).toContain(kept);
    for (const denied of ['developer_git_commit_proposal', 'AskUserQuestion', 'applyDiff']) expect(names, denied).not.toContain(denied);
    await codex.close();
    for (const id of ['adv', 'root', 'plain']) {
      const other = await connect(id, CORE);
      const otherNames = await other.names();
      for (const name of ['read_file', 'list_files', 'search_files']) expect(otherNames, `${id}:${name}`).not.toContain(name);
      await other.close();
    }
    // The reads live on the core endpoint only.
    const host = await connect('adv-codex', HOST, true);
    expect(await host.names()).not.toContain('read_file');
    await host.close();
  });

  it('a reviewer keeps run_project_tests and may ask the user; a team root and a plain session see the full host surface', async () => {
    const rev = await connect('rev', HOST, true);
    expect(await rev.names()).toContain('run_project_tests');
    expect(await rev.names()).not.toContain('create_session');
    await rev.close();
    const revCore = await connect('rev', CORE);
    expect(await revCore.names()).toContain('AskUserQuestion');
    await revCore.close();
    for (const id of ['root', 'plain', undefined]) {
      const full = await connect(id, HOST, true);
      const names = await full.names();
      expect(names, String(id)).toContain('create_session');
      expect(names, String(id)).toContain('send_prompt');
      await full.close();
    }
  });
});

describe('adversarial calls: a denied tool is refused by the server itself, without reaching its handler', () => {
  it.each([
    ['create_session', HOST, dispatchMetaAgentTool],
    ['spawn_session', HOST, dispatchMetaAgentTool],
    ['send_prompt', HOST, dispatchMetaAgentTool],
    ['respond_to_prompt', HOST, dispatchMetaAgentTool],
    ['tracker_update', TRACKERS, handleTrackerUpdate],
    ['tracker_create', TRACKERS, handleTrackerCreate],
    ['developer_git_commit_proposal', CORE, handleGitCommitProposal],
    ['applyDiff', CORE, handleApplyDiff],
  ] as const)('%s called by the advisor: isError, nothing executed', async (name, endpoint, handler) => {
    const adv = await connect('adv', endpoint, endpoint === HOST);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await adv.call(name, { role: 'implementer', prompt: 'escalate', id: 'x', title: 'x', message: 'x', files: [] });
    warn.mockRestore();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not available to this session: its tool scope is read|never asks the user/);
    expect(handler).not.toHaveBeenCalled();
    await adv.close();
  });

  it('the role\'s own denial (AskUserQuestion) answers in the advisor\'s terms', async () => {
    const adv = await connect('adv', CORE);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await adv.call('AskUserQuestion', { questions: [] });
    warn.mockRestore();
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('This session is the team\'s advisor, which gives an independent opinion and never asks the user');
    await adv.close();
  });

  it('a read tool still runs for the advisor, and the same mutable tool runs for an unrestricted session', async () => {
    const adv = await connect('adv', TRACKERS);
    const item = await adv.call('tracker_get', { id: 'NIB-1' });
    expect(item.isError).toBeFalsy();
    expect(handleTrackerGet).toHaveBeenCalledTimes(1);
    await adv.close();
    const root = await connect('root', TRACKERS);
    const update = await root.call('tracker_update', { id: 'NIB-1', status: 'done' });
    expect(update.isError).toBeFalsy();
    expect(handleTrackerUpdate).toHaveBeenCalledTimes(1);
    await root.close();
  });

  it('the host\'s file reads run for the Codex advisor through the workspace-confined dispatcher, and are refused for anyone they are not listed to', async () => {
    const codex = await connect('adv-codex', CORE);
    const read = await codex.call('read_file', { path: 'CLAUDE.md' });
    expect(read.isError).toBeFalsy();
    expect(read.content[0]?.text).toBe('READ:read_file');
    expect(dispatchDevAgentTool).toHaveBeenCalledWith('read_file', 'C:\\ws', { path: 'CLAUDE.md' });
    await codex.close();
    vi.mocked(dispatchDevAgentTool).mockClear();
    for (const id of ['adv', 'root', 'plain']) {
      const other = await connect(id, CORE);
      const result = await other.call('read_file', { path: 'CLAUDE.md' });
      expect(result.isError, id).toBe(true);
      expect(result.content[0]?.text, id).toContain('served only to a read-only team member without native file reads');
      await other.close();
    }
    // Never on another endpoint, even for the Codex advisor.
    const host = await connect('adv-codex', HOST, true);
    expect((await host.call('read_file', { path: 'CLAUDE.md' })).isError).toBe(true);
    await host.close();
    expect(dispatchDevAgentTool).not.toHaveBeenCalled();
  });

  it('on an extension endpoint the same names are the extension\'s own tools: an unrestricted session reaches the extension handler, a restricted one is refused by the scope', async () => {
    const EXT: McpEndpointSelection = { kind: 'extension', extensionShortName: 'files' };
    const plain = await connect('plain', EXT);
    const viaExtension = await plain.call('search_files', { query: 'x' });
    expect(viaExtension.isError).toBeFalsy();
    expect(viaExtension.content[0]?.text).toBe('EXTENSION:search_files');
    expect(handleExtensionTool).toHaveBeenCalledTimes(1);
    expect(dispatchDevAgentTool).not.toHaveBeenCalled();
    await plain.close();
    vi.mocked(handleExtensionTool).mockClear();
    const codex = await connect('adv-codex', EXT);
    expect((await codex.call('search_files', { query: 'x' })).isError).toBe(true);
    expect(handleExtensionTool).not.toHaveBeenCalled();
    expect(dispatchDevAgentTool).not.toHaveBeenCalled();
    await codex.close();
  });

  it('a session whose row cannot be read is served nothing and runs nothing (fail-closed)', async () => {
    setSessionToolPolicyReader(async () => { throw new Error('db down'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = await connect('broken', HOST, true);
    await expect(broken.client.listTools()).rejects.toThrow(/Could not verify this session's tool restrictions/);
    await expect(broken.call('create_session', {})).rejects.toThrow(/Could not verify this session's tool restrictions/);
    expect(dispatchMetaAgentTool).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    await broken.close();
  });
});
