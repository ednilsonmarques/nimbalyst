// @vitest-environment node
/**
 * Portal F1.1 (post-review) -- a connection without `?sessionId` cannot run
 * extension tools (handleExtensionTool refuses it), so the extension endpoint
 * does not list them for it. A connection with a session id is listed as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn() },
}));
vi.mock('../mcpWorkspaceResolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../mcpWorkspaceResolver')>()),
  getAvailableExtensionTools: vi.fn(async () => [
    { name: 'files.search_files', extensionId: 'com.nimbalyst.files', description: 'search', inputSchema: { type: 'object' } },
    { name: 'other.thing', extensionId: 'com.nimbalyst.other', description: 'other', inputSchema: { type: 'object' } },
  ]),
  getAvailableBackendTools: vi.fn(async () => [
    { name: 'files.backend_tool', extensionId: 'com.nimbalyst.files', description: 'backend', inputSchema: { type: 'object' } },
  ]),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSharedMcpServer } from '../httpServer';
import { resetSessionToolPolicies, setSessionToolPolicyReader } from '../sessionToolPolicy';
import type { McpEndpointSelection } from '../mcpEndpointRouting';

const EXT: McpEndpointSelection = { kind: 'extension', extensionShortName: 'files' };

async function listNames(sessionId: string | undefined): Promise<string[]> {
  const server = createSharedMcpServer('C:\ws', sessionId, EXT, false);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  await client.close();
  await server.close();
  return names;
}

beforeEach(() => {
  resetSessionToolPolicies();
  setSessionToolPolicyReader(async () => ({ agentRole: 'standard', provider: 'claude-code', workspacePath: 'C:\ws', metadata: {} }));
});
afterEach(() => setSessionToolPolicyReader(null));

describe('extension endpoint tool listing', () => {
  it('excludes extension tools for a connection without a session id', async () => {
    expect(await listNames(undefined)).not.toContain('files_search_files');
    expect((await listNames(undefined)).some((n) => n.includes('search_files'))).toBe(false);
  });

  it('keeps backend-module tools (they do not need an MCP session id)', async () => {
    expect((await listNames(undefined)).some((n) => n.includes('backend_tool'))).toBe(true);
  });

  it('is unchanged for a connection with a session id', async () => {
    const names = await listNames('plain');
    expect(names.some((n) => n.includes('search_files'))).toBe(true);
    expect(names.some((n) => n.includes('backend_tool'))).toBe(true);
    expect(names.some((n) => n.includes('thing'))).toBe(false);
  });
});
