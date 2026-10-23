// @vitest-environment node
/**
 * Portal F1.2 -- what the unified MCP server lists and runs of `portal_*` and
 * `browser.*` per session, over the SDK's in-memory transport with the real
 * catalog. The policy is the host's (scope + team role), applied the same way at
 * ListTools and at CallTool; a refused call reaches no handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn() },
}));
vi.mock('../sessionNamingServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sessionNamingServer')>()),
  buildSessionMetaToolSchemas: vi.fn(async () => []),
}));
vi.mock('../tools/portalToolHandlers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/portalToolHandlers')>()),
  handlePortalTool: vi.fn(async (tool: string) => ({ content: [{ type: 'text', text: `PORTAL:${tool}` }], isError: false })),
}));
vi.mock('../tools/extensionToolHandler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../tools/extensionToolHandler')>()),
  handleExtensionTool: vi.fn(async (toolName: string) => ({ content: [{ type: 'text', text: `EXTENSION:${toolName}` }] })),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSharedMcpServer } from '../httpServer';
import { handlePortalTool } from '../tools/portalToolHandlers';
import { handleExtensionTool } from '../tools/extensionToolHandler';
import { resetSessionToolPolicies, setSessionToolPolicyReader } from '../sessionToolPolicy';
import type { McpEndpointSelection } from '../mcpEndpointRouting';

const row = (metadata: Record<string, unknown>) => ({ agentRole: 'standard', provider: 'claude-code', workspacePath: 'C:\\ws', metadata });
const ROWS: Record<string, ReturnType<typeof row>> = {
  solo: row({}),
  read: row({ toolScope: 'read' }),
  arch: row({ toolScope: 'read', teamChild: { role: 'architect', rootSessionId: 'r', depth: 1 } }),
  rev: row({ toolScope: 'review', teamChild: { role: 'reviewer', rootSessionId: 'r', depth: 1 } }),
  impl: row({ toolScope: 'write', teamChild: { role: 'implementer', rootSessionId: 'r', depth: 1 } }),
  full: row({ toolScope: 'full', teamChild: { role: 'other', rootSessionId: 'r', depth: 1 } }),
  codex: { agentRole: 'standard', provider: 'openai-codex', workspacePath: 'C:\\ws', metadata: {} },
};

const CORE: McpEndpointSelection = { kind: 'firstParty', configKey: 'nimbalyst' };
const BROWSER_EXT: McpEndpointSelection = { kind: 'extension', extensionShortName: 'browser' };

const OBSERVE = ['portal_open', 'portal_navigate', 'portal_list', 'portal_screenshot', 'portal_page_info', 'portal_close'];
const EXERCISE = ['portal_click', 'portal_type', 'portal_scroll'];
const ALL = [...OBSERVE, ...EXERCISE, 'portal_evaluate'];

async function connect(sessionId: string, endpoint: McpEndpointSelection) {
  const server = createSharedMcpServer('C:\\ws', sessionId, endpoint, false);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    names: async () => (await client.listTools()).tools.map((t) => t.name),
    call: async (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ text?: string }> }>,
    close: async () => { await client.close(); await server.close(); },
  };
}

beforeEach(() => {
  resetSessionToolPolicies();
  setSessionToolPolicyReader(async (id) => ROWS[id] ?? null);
  vi.mocked(handlePortalTool).mockClear();
  vi.mocked(handleExtensionTool).mockClear();
});
afterEach(() => setSessionToolPolicyReader(null));

describe('the catalog (ListTools)', () => {
  it('a solo session sees every portal tool', async () => {
    const c = await connect('solo', CORE);
    const names = await c.names();
    for (const t of ALL) expect(names, t).toContain(t);
    await c.close();
  });

  it.each(['read', 'arch'])('%s sees no portal tool', async (id) => {
    const c = await connect(id, CORE);
    const names = await c.names();
    for (const t of ALL) expect(names, t).not.toContain(t);
    await c.close();
  });

  it.each(['rev', 'impl'])('%s sees observe + exercise but not portal_evaluate', async (id) => {
    const c = await connect(id, CORE);
    const names = await c.names();
    for (const t of [...OBSERVE, ...EXERCISE]) expect(names, t).toContain(t);
    expect(names).not.toContain('portal_evaluate');
    await c.close();
  });

  it('a full-scope member sees portal_evaluate too', async () => {
    const c = await connect('full', CORE);
    expect(await c.names()).toContain('portal_evaluate');
    await c.close();
  });
});

describe('the call (CallTool) is refused at execution, whatever was listed', () => {
  it.each(ALL)('read scope calling %s reaches no handler', async (tool) => {
    const c = await connect('read', CORE);
    const res = await c.call(tool, { filePath: 'a.html' });
    expect(res.isError).toBe(true);
    expect(handlePortalTool).not.toHaveBeenCalled();
    await c.close();
  });

  it('a reviewer reaches click but never evaluate', async () => {
    const c = await connect('rev', CORE);
    expect((await c.call('portal_click', { x: 1, y: 1 })).isError).toBeFalsy();
    expect(handlePortalTool).toHaveBeenCalledTimes(1);
    const denied = await c.call('portal_evaluate', { script: '1' });
    expect(denied.isError).toBe(true);
    expect(handlePortalTool).toHaveBeenCalledTimes(1);
    await c.close();
  });

  it('the handler receives the MCP session id and the transport workspace', async () => {
    const c = await connect('solo', CORE);
    await c.call('portal_list', {});
    expect(vi.mocked(handlePortalTool).mock.calls[0][0]).toBe('portal_list');
    expect(vi.mocked(handlePortalTool).mock.calls[0][2]).toMatchObject({ sessionId: 'solo', workspacePath: 'C:\\ws' });
    await c.close();
  });
});

describe('browser.* on its extension endpoint', () => {
  it.each(['impl', 'full', 'rev', 'read'])('team member / scoped session %s is refused browser tools', async (id) => {
    const c = await connect(id, BROWSER_EXT);
    const res = await c.call('browser_open_session', { url: 'https://example.com' });
    expect(res.isError).toBe(true);
    expect(handleExtensionTool).not.toHaveBeenCalled();
    await c.close();
  });

  it('a solo session keeps browser.*', async () => {
    const c = await connect('solo', BROWSER_EXT);
    const res = await c.call('browser_open_session', { url: 'https://example.com' });
    expect(res.isError).toBeFalsy();
    expect(handleExtensionTool).toHaveBeenCalledTimes(1);
    await c.close();
  });
});

describe('Codex is not part of Portal V1 (N4)', () => {
  it('a Codex session is not listed any portal tool', async () => {
    const c = await connect('codex', CORE);
    const names = await c.names();
    for (const t of ALL) expect(names, t).not.toContain(t);
    await c.close();
  });

  it.each(ALL)('a Codex session calling %s reaches no handler', async (tool) => {
    const c = await connect('codex', CORE);
    const res = await c.call(tool, { filePath: 'a.html' });
    expect(res.isError).toBe(true);
    expect(handlePortalTool).not.toHaveBeenCalled();
    await c.close();
  });
});
