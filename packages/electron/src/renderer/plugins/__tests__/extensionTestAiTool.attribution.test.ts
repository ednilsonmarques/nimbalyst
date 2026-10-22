// @vitest-environment jsdom
/**
 * The extension_test_ai_tool path (extensionDevServer -> `extension-test:ai-tool`)
 * runs extension tools from the renderer without an MCP connection. It must
 * not run `browser.*` as the user: its context carries a fixed placeholder
 * actor that owns nothing, so the tools reach no existing session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { executeExtensionTool } = vi.hoisted(() => ({ executeExtensionTool: vi.fn() }));

vi.mock('@nimbalyst/runtime', () => ({
  setExtensionPlatformService: vi.fn(), initializeExtensions: vi.fn(), initializeExtensionAIToolsBridge: vi.fn(),
  setOnToolsChangedCallback: vi.fn(), getMCPToolDefinitions: vi.fn(), executeExtensionTool,
  setEnabledStateProvider: vi.fn(), setConfigurationServiceProvider: vi.fn(), screenshotService: {},
  getExtensionLoader: vi.fn(), setOffscreenMountCallback: vi.fn(), setEnsureEditorCallback: vi.fn(),
  collectVoiceSessionContext: vi.fn(),
}));
vi.mock('../../services/nativeScreenshot', () => ({ captureNativeElement: vi.fn() }));
vi.mock('../../services/ExtensionPlatformServiceImpl', () => ({ ExtensionPlatformServiceImpl: class {} }));
vi.mock('../../extensions/ExtensionEditorBridge', () => ({ initializeExtensionEditorBridge: vi.fn(), syncExtensionEditors: vi.fn() }));
vi.mock('../../extensions/ExtensionPluginBridge', () => ({ initializeExtensionPluginBridge: vi.fn() }));
vi.mock('../../extensions/ExtensionDocumentHeaderBridge', () => ({ initializeExtensionDocumentHeaderBridge: vi.fn(), syncExtensionDocumentHeaders: vi.fn() }));
vi.mock('../../extensions/ExtensionThemeBridge', () => ({ initializeExtensionThemeBridge: vi.fn() }));

// The real browser tools, with only their IPC client replaced by a recorder
// that plays the part of main's ownership check.
const { ipc } = vi.hoisted(() => ({
  ipc: {
    calls: [] as Array<{ fn: string; args: unknown[] }>,
    owners: new Map<string, string | null>([
      ['agent-browser:A1', 'ai-session-A'],
      ['browser:doc.html:editor', null],
    ]),
  },
}));
vi.mock('../../../../../extensions/browser/src/browserClient', () => {
  const visible = (actor?: string) =>
    [...ipc.owners.entries()].filter(([, o]) => actor === undefined || (o !== null && o === actor)).map(([id]) => id);
  return {
    listBrowserSessions: async (actor?: string) => {
      ipc.calls.push({ fn: 'list', args: [actor] });
      return visible(actor);
    },
    destroyBrowserSession: async (id: string, actor?: string) => {
      ipc.calls.push({ fn: 'destroy', args: [id, actor] });
      if (!visible(actor).includes(id)) throw new Error(`No browser session: ${id}`);
      ipc.owners.delete(id);
    },
  };
});

import { aiTools } from '../../../../../extensions/browser/src/aiTools';

let handler: (data: any) => Promise<void>;
const sent: Array<{ channel: string; payload: any }> = [];

beforeEach(async () => {
  vi.resetModules();
  ipc.calls.length = 0;
  sent.length = 0;
  ipc.owners.clear();
  ipc.owners.set('agent-browser:A1', 'ai-session-A');
  ipc.owners.set('browser:doc.html:editor', null);
  executeExtensionTool.mockReset();
  // Run the real browser tool with the context the listener built.
  executeExtensionTool.mockImplementation(async (fullToolName: string, args: any, context: any) => {
    const tool = aiTools.find((t) => t.name === fullToolName)!;
    return tool.handler(args, { workspacePath: context.workspacePath, aiSessionId: context.aiSessionId } as any);
  });
  const on = vi.fn((channel: string, cb: any) => {
    if (channel === 'extension-test:ai-tool') handler = cb;
  });
  (window as any).electronAPI = { on, send: (channel: string, payload: any) => sent.push({ channel, payload }) };
  const mod = await import('../registerExtensionSystem');
  mod.setupExtensionTestListeners();
});
afterEach(() => {
  delete (window as any).electronAPI;
});

function run(toolName: string, args: Record<string, unknown>) {
  return handler({ extensionId: 'com.nimbalyst.browser', toolName, args, responseChannel: 'resp', workspacePath: '/ws' });
}

describe('extension-test:ai-tool attribution', () => {
  it('passes a fixed placeholder actor in the tool context, never none', async () => {
    await run('list_sessions', {});
    const context = executeExtensionTool.mock.calls[0][2];
    expect(context.aiSessionId).toBe('extension-dev-test');
  });

  it('browser.list_sessions does not see an agent-owned or an editor session', async () => {
    await run('list_sessions', {});
    expect(ipc.calls).toEqual([{ fn: 'list', args: ['extension-dev-test'] }]);
    expect(sent[0].payload.data.data.sessionIds).toEqual([]);
  });

  it.each(['agent-browser:A1', 'browser:doc.html:editor'])('browser.close_session cannot close %s', async (id) => {
    await run('close_session', { sessionId: id });
    expect(ipc.calls).toEqual([{ fn: 'destroy', args: [id, 'extension-dev-test'] }]);
    expect(sent[0].payload.data.success).toBe(false);
    expect(ipc.owners.has(id)).toBe(true);
  });
});
