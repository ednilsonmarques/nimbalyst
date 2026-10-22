// @vitest-environment node
/**
 * Portal F0 -- agent tool path. The AI session id handed down by main
 * (`context.aiSessionId`) must travel with every browser call, and an agent
 * call without an explicit sessionId must never fall back to the user's editor.
 * (Main is the enforcement point; this proves the renderer carries the
 * attribution and does not itself reach for the editor.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIToolContext, ExtensionAITool } from '@nimbalyst/extension-sdk';

vi.mock('../browserClient', () => ({
  clickInBrowserSession: vi.fn().mockResolvedValue(undefined),
  createBrowserSession: vi.fn().mockResolvedValue({ sessionId: 'x' }),
  destroyBrowserSession: vi.fn().mockResolvedValue(undefined),
  evaluateInBrowserSession: vi.fn().mockResolvedValue(1),
  getBrowserPageInfo: vi.fn().mockResolvedValue({}),
  listBrowserSessions: vi.fn().mockResolvedValue([]),
  navigateBrowserSession: vi.fn().mockResolvedValue(undefined),
  reloadBrowserSession: vi.fn().mockResolvedValue(undefined),
  goBackBrowserSession: vi.fn().mockResolvedValue(undefined),
  goForwardBrowserSession: vi.fn().mockResolvedValue(undefined),
  buildPreviewUrl: vi.fn().mockResolvedValue('nim-preview://abcd/index.html'),
  screenshotBrowserSessionToFile: vi.fn().mockResolvedValue('/ws/.nimbalyst/shot.png'),
  scrollBrowserSession: vi.fn().mockResolvedValue(undefined),
  typeInBrowserSession: vi.fn().mockResolvedValue(undefined),
}));

import * as client from '../browserClient';
import { aiTools } from '../aiTools';

const EDITOR_SESSION = 'browser:doc.html:editor-uuid';
const AI = 'ai-session-A';

function tool(name: string): ExtensionAITool {
  const found = aiTools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

function agentCtx(): AIToolContext {
  return {
    workspacePath: '/ws',
    aiSessionId: AI,
    editorAPI: { getSessionId: () => EDITOR_SESSION },
  } as unknown as AIToolContext;
}

function userCtx(): AIToolContext {
  return {
    workspacePath: '/ws',
    editorAPI: { getSessionId: () => EDITOR_SESSION },
  } as unknown as AIToolContext;
}

const EDITOR_SCOPED: Array<[string, Record<string, unknown>]> = [
  ['browser.navigate', { url: 'https://example.com' }],
  ['browser.reload', {}],
  ['browser.go_back', {}],
  ['browser.go_forward', {}],
  ['browser.get_page_info', {}],
  ['browser.click', { selector: '#go' }],
  ['browser.type', { text: 'hi' }],
  ['browser.scroll', { dy: 10 }],
  ['browser.evaluate', { script: '1' }],
  ['browser.screenshot', {}],
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('agent calls never fall back to the user editor', () => {
  it.each(EDITOR_SCOPED)('%s without a sessionId fails and touches no session', async (name, params) => {
    const result = await tool(name).handler(params, agentCtx());
    expect(result.success).toBe(false);
    expect(String((result as { error?: string }).error)).toMatch(/sessionId/);
    for (const fn of Object.values(client)) {
      expect(fn as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalledWith(EDITOR_SESSION, expect.anything());
    }
    expect(vi.mocked(client.navigateBrowserSession)).not.toHaveBeenCalled();
    expect(vi.mocked(client.clickInBrowserSession)).not.toHaveBeenCalled();
    expect(vi.mocked(client.evaluateInBrowserSession)).not.toHaveBeenCalled();
    expect(vi.mocked(client.screenshotBrowserSessionToFile)).not.toHaveBeenCalled();
  });

  it('an empty/whitespace sessionId is treated as omitted', async () => {
    const result = await tool('browser.evaluate').handler({ script: '1', sessionId: '   ' }, agentCtx());
    expect(result.success).toBe(false);
    expect(vi.mocked(client.evaluateInBrowserSession)).not.toHaveBeenCalled();
  });
});

describe('agent calls carry the AI session id to main', () => {
  it('open_session', async () => {
    await tool('browser.open_session').handler({ url: 'https://example.com', width: 800, height: 600 }, agentCtx());
    const [, url, opts] = vi.mocked(client.createBrowserSession).mock.calls[0];
    expect(url).toBe('https://example.com');
    expect(opts).toMatchObject({ headless: true, actorSessionId: AI, viewport: { width: 800, height: 600 } });
  });

  it('open_local_preview', async () => {
    await tool('browser.open_local_preview').handler({ filePath: '/ws/index.html' }, agentCtx());
    const [, , opts] = vi.mocked(client.createBrowserSession).mock.calls[0];
    expect(opts).toMatchObject({ actorSessionId: AI });
  });

  it('list_sessions', async () => {
    await tool('browser.list_sessions').handler({}, agentCtx());
    expect(vi.mocked(client.listBrowserSessions)).toHaveBeenCalledWith(AI);
  });

  it('close_session', async () => {
    await tool('browser.close_session').handler({ sessionId: 'agent-browser:1' }, agentCtx());
    expect(vi.mocked(client.destroyBrowserSession)).toHaveBeenCalledWith('agent-browser:1', AI);
  });

  it('every editor-scoped tool, given an explicit id', async () => {
    for (const [name, params] of EDITOR_SCOPED) {
      vi.clearAllMocks();
      const result = await tool(name).handler({ ...params, sessionId: 'agent-browser:1' }, agentCtx());
      expect(result.success, name).toBe(true);
      const calls = Object.values(client)
        .map((fn) => (fn as unknown as ReturnType<typeof vi.fn>).mock.calls)
        .flat()
        .filter((args) => args[0] === 'agent-browser:1');
      expect(calls.length, name).toBe(1);
      expect(calls[0].includes(AI) || calls[0].some((a: unknown) => (a as { actorSessionId?: string })?.actorSessionId === AI), name).toBe(true);
    }
  });
});

describe('calls without an AI session (the user path) keep the old behaviour', () => {
  it('still resolves the active editor when no id is given', async () => {
    const result = await tool('browser.reload').handler({}, userCtx());
    expect(result.success).toBe(true);
    expect(vi.mocked(client.reloadBrowserSession)).toHaveBeenCalledWith(EDITOR_SESSION, undefined);
  });
});
