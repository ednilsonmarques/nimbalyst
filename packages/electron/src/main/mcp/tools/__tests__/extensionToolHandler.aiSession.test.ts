// @vitest-environment node
/**
 * Portal F0 -- the MCP session that made the tool call is passed to the
 * renderer as `context.aiSessionId`, so browser tools can be attributed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestFromRenderer } = vi.hoisted(() => ({ requestFromRenderer: vi.fn() }));

vi.mock('electron', () => ({ BrowserWindow: { fromId: () => ({}) } }));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  McpError: class McpError extends Error {},
  ErrorCode: { MethodNotFound: -32601 },
}));
vi.mock('../../mcpWorkspaceResolver', () => ({
  findWindowIdForWorkspacePath: async () => 1,
  getAvailableExtensionTools: async () => [{ name: 'browser.navigate' }, { name: 'other.tool' }],
  documentStateBySession: new Map(),
}));
vi.mock('../../rendererRequest', () => ({ requestFromRenderer }));

import { handleExtensionTool } from '../extensionToolHandler';

beforeEach(() => {
  requestFromRenderer.mockReset();
  requestFromRenderer.mockResolvedValue({ status: 'ok', response: { success: true, message: 'ok' } });
});

function sentContext(): Record<string, unknown> {
  return requestFromRenderer.mock.calls[0][2].context;
}

describe('handleExtensionTool attribution', () => {
  it('passes the MCP session id to the renderer as aiSessionId', async () => {
    await handleExtensionTool('browser.navigate', 'browser.navigate', { url: 'https://example.com' }, 'ai-session-A', '/ws');
    expect(sentContext().aiSessionId).toBe('ai-session-A');
  });

  it('cannot be overridden by tool arguments', async () => {
    await handleExtensionTool(
      'browser.navigate', 'browser.navigate',
      { url: 'https://example.com', aiSessionId: 'ai-session-B', context: { aiSessionId: 'ai-session-B' } },
      'ai-session-A', '/ws',
    );
    expect(sentContext().aiSessionId).toBe('ai-session-A');
  });

  it('warns, naming the tool, when it falls back to the unattributed placeholder', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleExtensionTool('browser.navigate', 'browser.navigate', { url: 'https://example.com/?token=secret' }, undefined, '/ws');
    const lines = warn.mock.calls.map((c) => c.join(' '));
    expect(lines.some((l) => l.includes('browser.navigate') && /unattributed/i.test(l))).toBe(true);
    // no arguments (they may carry secrets) in the log line
    expect(lines.join(' | ')).not.toContain('secret');
    warn.mockRestore();
  });

  it('does not warn when the MCP session id is present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await handleExtensionTool('browser.navigate', 'browser.navigate', {}, 'ai-session-A', '/ws');
    expect(warn.mock.calls.filter((c) => /unattributed/i.test(c.join(' ')))).toEqual([]);
    warn.mockRestore();
  });

  it('marks a call with no session id as a distinct unattributed agent, never as the user', async () => {
    await handleExtensionTool('browser.navigate', 'browser.navigate', {}, undefined, '/ws');
    const id = sentContext().aiSessionId;
    expect(typeof id).toBe('string');
    expect(id).not.toBe('');
    expect(id).not.toBe('ai-session-A');
  });
});
