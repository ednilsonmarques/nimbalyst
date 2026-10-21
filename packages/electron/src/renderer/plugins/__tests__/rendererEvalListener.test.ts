// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime', () => ({
  setExtensionPlatformService: vi.fn(), initializeExtensions: vi.fn(), initializeExtensionAIToolsBridge: vi.fn(),
  setOnToolsChangedCallback: vi.fn(), getMCPToolDefinitions: vi.fn(), executeExtensionTool: vi.fn(),
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

afterEach(() => {
  delete (window as any).electronAPI;
  vi.resetModules();
});

describe('renderer:eval listener (HTML audit, item 5b)', () => {
  it('is not installed in a production renderer', async () => {
    const on = vi.fn();
    (window as any).electronAPI = { on, send: vi.fn() };
    const { setupRendererEvalListener } = await import('../registerExtensionSystem');
    setupRendererEvalListener(false);
    expect(on).not.toHaveBeenCalledWith('renderer:eval', expect.anything());
  });

  it('is installed (once) in a development renderer', async () => {
    const on = vi.fn();
    (window as any).electronAPI = { on, send: vi.fn() };
    const { setupRendererEvalListener } = await import('../registerExtensionSystem');
    setupRendererEvalListener(true);
    setupRendererEvalListener(true);
    expect(on.mock.calls.filter((c) => c[0] === 'renderer:eval')).toHaveLength(1);
  });

  it('defaults to the build-time flag: the vitest build is not a production one, so the default follows import.meta.env.DEV', async () => {
    const on = vi.fn();
    (window as any).electronAPI = { on, send: vi.fn() };
    const { setupRendererEvalListener } = await import('../registerExtensionSystem');
    setupRendererEvalListener();
    expect(on.mock.calls.some((c) => c[0] === 'renderer:eval')).toBe(import.meta.env.DEV);
  });
});
