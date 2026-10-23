// @vitest-environment node
/**
 * Portal F1.1 -- the MCP session that made the tool call is turned by main into
 * a one-call actor token, and that token (not the raw session id) is what the
 * renderer carries as `context.aiSessionId`. A call with no MCP session id is
 * rejected: there is no placeholder actor any more.
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
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));

import { handleExtensionTool } from '../extensionToolHandler';
import { resolveCaller, __resetActorTokensForTests } from '../../../services/BrowserAuthority';

beforeEach(() => {
  __resetActorTokensForTests();
  requestFromRenderer.mockReset();
  requestFromRenderer.mockResolvedValue({ status: 'ok', response: { success: true, message: 'ok' } });
});

function sentContext(): Record<string, unknown> {
  return requestFromRenderer.mock.calls[0][2].context;
}

describe('handleExtensionTool attribution', () => {
  it('hands the renderer a main-issued token that resolves to the MCP session id', async () => {
    await handleExtensionTool('browser.navigate', 'browser.navigate', { url: 'https://example.com' }, 'ai-session-A', '/ws');
    const token = sentContext().aiSessionId as string;
    expect(token).not.toContain('ai-session-A');
    expect(resolveCaller('ai-session-A').ok).toBe(false);
    // resolved while the call is still open: ask from inside the renderer request
  });

  it('the token is valid during the call and revoked once it ends', async () => {
    let during: unknown;
    requestFromRenderer.mockImplementation(async (_w: unknown, _c: string, payload: any) => {
      during = resolveCaller(payload.context.aiSessionId);
      return { status: 'ok', response: { success: true, message: 'ok' } };
    });
    await handleExtensionTool('browser.navigate', 'browser.navigate', {}, 'ai-session-A', '/ws');
    expect(during).toEqual({ ok: true, actor: 'ai-session-A' });
    expect(resolveCaller(sentContext().aiSessionId).ok).toBe(false);
  });

  it('cannot be overridden by tool arguments', async () => {
    let during: unknown;
    requestFromRenderer.mockImplementation(async (_w: unknown, _c: string, payload: any) => {
      during = resolveCaller(payload.context.aiSessionId);
      return { status: 'ok', response: { success: true, message: 'ok' } };
    });
    await handleExtensionTool(
      'browser.navigate', 'browser.navigate',
      { url: 'https://example.com', aiSessionId: 'ai-session-B', context: { aiSessionId: 'ai-session-B' } },
      'ai-session-A', '/ws',
    );
    expect(during).toEqual({ ok: true, actor: 'ai-session-A' });
  });

  it.each([undefined, ''])('rejects a call with MCP session id %j and never reaches the renderer', async (sid) => {
    const result = await handleExtensionTool('browser.navigate', 'browser.navigate', { url: 'https://example.com' }, sid as any, '/ws');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/attribut|session/i);
    expect(requestFromRenderer).not.toHaveBeenCalled();
  });

  it('rejects an unattributed call to any extension tool, not only browser.*', async () => {
    const result = await handleExtensionTool('other.tool', 'other.tool', {}, undefined, '/ws');
    expect(result.isError).toBe(true);
    expect(requestFromRenderer).not.toHaveBeenCalled();
  });

  it('never mentions the placeholder actor any more', async () => {
    const result = await handleExtensionTool('browser.navigate', 'browser.navigate', {}, undefined, '/ws');
    expect(JSON.stringify(result)).not.toContain('unattributed-ai-session');
  });

  it('flags a browser tool whose result came back without the token ever being presented', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleExtensionTool('browser.navigate', 'browser.navigate', { url: 'https://example.com/?token=secret' }, 'ai-session-A', '/ws');
    const lines = err.mock.calls.map((c) => c.join(' '));
    expect(lines.some((l) => l.includes('browser.navigate') && /attribution/i.test(l))).toBe(true);
    expect(lines.join(' | ')).not.toContain('secret');
    err.mockRestore();
  });

  it('does not flag it when the token was presented', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    requestFromRenderer.mockImplementation(async (_w: unknown, _c: string, payload: any) => {
      resolveCaller(payload.context.aiSessionId);
      return { status: 'ok', response: { success: true, message: 'ok' } };
    });
    await handleExtensionTool('browser.navigate', 'browser.navigate', {}, 'ai-session-A', '/ws');
    expect(err.mock.calls.filter((c) => /attribution/i.test(c.join(' ')))).toEqual([]);
    err.mockRestore();
  });
});
