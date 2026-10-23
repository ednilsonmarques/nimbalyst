// @vitest-environment node
/**
 * Portal F1.1 / F1.2 -- attribution of extension tool calls.
 *
 * The MCP session that made the tool call is turned by main into a one-call
 * actor token, and that token (not the raw session id) is what the renderer
 * carries as `context.aiSessionId` for the tools that still run there. A call
 * with no MCP session id is rejected: there is no placeholder actor.
 *
 * F1.2: the browser tools no longer run in the renderer at all (main runs them
 * with the MCP session as actor, see browserToolInMain.test.ts), so the token
 * path below is exercised with a non-browser extension tool.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestFromRenderer, runBrowserToolInMain } = vi.hoisted(() => ({
  requestFromRenderer: vi.fn(),
  runBrowserToolInMain: vi.fn(),
}));

vi.mock('electron', () => ({ BrowserWindow: { fromId: () => ({}) } }));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  McpError: class McpError extends Error {},
  ErrorCode: { MethodNotFound: -32601 },
}));
vi.mock('../../mcpWorkspaceResolver', () => ({
  findWindowIdForWorkspacePath: async () => 1,
  getAvailableExtensionTools: async () => [{ name: 'browser.navigate' }, { name: 'browser.click' }, { name: 'other.tool' }],
  documentStateBySession: new Map(),
}));
vi.mock('../../rendererRequest', () => ({ requestFromRenderer }));
vi.mock('../browserToolInMain', () => ({
  isBrowserToolName: (name: string) => /^browser[._]/.test(name),
  runBrowserToolInMain,
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));

import { handleExtensionTool } from '../extensionToolHandler';
import { resolveCaller, __resetActorTokensForTests } from '../../../services/BrowserAuthority';

beforeEach(() => {
  __resetActorTokensForTests();
  requestFromRenderer.mockReset();
  requestFromRenderer.mockResolvedValue({ status: 'ok', response: { success: true, message: 'ok' } });
  runBrowserToolInMain.mockReset();
  runBrowserToolInMain.mockResolvedValue({ success: true, message: 'ran in main' });
});

function sentContext(): Record<string, unknown> {
  return requestFromRenderer.mock.calls[0][2].context;
}

describe('handleExtensionTool attribution', () => {
  it('hands the renderer a main-issued token that resolves to the MCP session id', async () => {
    await handleExtensionTool('other.tool', 'other.tool', { url: 'https://example.com' }, 'ai-session-A', '/ws');
    const token = sentContext().aiSessionId as string;
    expect(token).not.toContain('ai-session-A');
    expect(resolveCaller('ai-session-A').ok).toBe(false);
  });

  it('the token is valid during the call, carries the project, and is revoked once it ends', async () => {
    let during: unknown;
    requestFromRenderer.mockImplementation(async (_w: unknown, _c: string, payload: any) => {
      during = resolveCaller(payload.context.aiSessionId);
      return { status: 'ok', response: { success: true, message: 'ok' } };
    });
    await handleExtensionTool('other.tool', 'other.tool', {}, 'ai-session-A', '/ws');
    expect(during).toEqual({ ok: true, actor: 'ai-session-A', workspacePath: '/ws' });
    expect(resolveCaller(sentContext().aiSessionId).ok).toBe(false);
  });

  it('cannot be overridden by tool arguments', async () => {
    let during: unknown;
    requestFromRenderer.mockImplementation(async (_w: unknown, _c: string, payload: any) => {
      during = resolveCaller(payload.context.aiSessionId);
      return { status: 'ok', response: { success: true, message: 'ok' } };
    });
    await handleExtensionTool(
      'other.tool', 'other.tool',
      { url: 'https://example.com', aiSessionId: 'ai-session-B', context: { aiSessionId: 'ai-session-B' } },
      'ai-session-A', '/ws',
    );
    expect(during).toMatchObject({ ok: true, actor: 'ai-session-A' });
  });

  it.each([undefined, ''])('rejects a call with MCP session id %j and never reaches the renderer', async (sid) => {
    const result = await handleExtensionTool('browser.navigate', 'browser.navigate', { url: 'https://example.com' }, sid as any, '/ws');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/attribut|session/i);
    expect(requestFromRenderer).not.toHaveBeenCalled();
    expect(runBrowserToolInMain).not.toHaveBeenCalled();
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
});

describe('browser tools take no renderer hop (F1.2)', () => {
  it('runs in main with the MCP session as actor and the project, and never asks the renderer', async () => {
    const result = await handleExtensionTool('browser.navigate', 'browser.navigate', { url: 'https://example.com' }, 'ai-session-A', '/ws');
    expect(requestFromRenderer).not.toHaveBeenCalled();
    expect(runBrowserToolInMain).toHaveBeenCalledWith('browser.navigate', { url: 'https://example.com' }, { actor: 'ai-session-A', workspacePath: '/ws' });
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe('ran in main');
  });

  it('a tool argument cannot change the actor', async () => {
    await handleExtensionTool('browser.navigate', 'browser.navigate', { aiSessionId: 'ai-session-B', actor: 'ai-session-B' }, 'ai-session-A', '/ws');
    expect(runBrowserToolInMain.mock.calls[0][2]).toEqual({ actor: 'ai-session-A', workspacePath: '/ws' });
  });

  it('turns a refusal from main into an error result', async () => {
    runBrowserToolInMain.mockResolvedValue({ success: false, error: 'not allowed' });
    const result = await handleExtensionTool('browser.click', 'browser.click', {}, 'ai-session-A', '/ws');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not allowed');
  });
});
