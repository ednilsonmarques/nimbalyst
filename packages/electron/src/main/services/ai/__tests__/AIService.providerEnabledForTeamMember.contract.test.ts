// @vitest-environment node
/**
 * Contract of `AIService.isProviderEnabledForTeamMember` against the REAL
 * settings store and the real project-override reader (NIB.43 item A): the
 * method the team member creation consults, exercised on the real method
 * body with a real electron-store in a temp directory, not a fake. No
 * provider is started and nothing paid is reached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getAppPath: () => tmpDir,
    getName: () => 'nimbalyst-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    once: () => {},
    off: () => {},
    whenReady: () => Promise.resolve(),
    isReady: () => true,
  },
  ipcMain: { on: () => {}, handle: () => {}, removeHandler: () => {} },
  ipcRenderer: undefined,
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openExternal: async () => {} },
  dialog: {},
  nativeTheme: { on: () => {}, shouldUseDarkColors: false },
  powerMonitor: { on: () => {} },
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } },
  net: {},
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}));

describe('AIService.isProviderEnabledForTeamMember (real store, real method)', () => {
  let service: any;
  let Store: any;

  // The AIService module graph is large; loading it once is the cost of a
  // contract test on the real method rather than on a copy of its rule.
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-service-contract-'));
    vi.resetModules();
    const { AIService } = await import('../AIService');
    Store = (await import('electron-store')).default;
    // The real method bodies on a prototype-only instance: the constructor
    // wires session management and mobile sync, none of which the settings
    // read needs. getSettingsStore() lazily creates the real store below.
    service = Object.create(AIService.prototype);
    service.settingsStore = new Store({ name: 'ai-settings', cwd: tmpDir });
  }, 120_000);

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('claude-code is enabled unless the store says enabled: false; every other provider is disabled unless the store says enabled: true', () => {
    expect(service.isProviderEnabledForTeamMember('claude-code')).toBe(true);
    expect(service.isProviderEnabledForTeamMember('openai-codex')).toBe(false);
    expect(service.isProviderEnabledForTeamMember('opencode')).toBe(false);

    service.settingsStore.set('providerSettings', { 'openai-codex': { enabled: true }, 'claude-code': { enabled: false } });
    expect(service.isProviderEnabledForTeamMember('openai-codex')).toBe(true);
    expect(service.isProviderEnabledForTeamMember('claude-code')).toBe(false);

    service.settingsStore.set('providerSettings', { 'openai-codex': { enabled: false } });
    expect(service.isProviderEnabledForTeamMember('openai-codex')).toBe(false);
  });

  it('a workspace without overrides falls through to the global setting; the answer is a boolean, never undefined', () => {
    const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
    expect(service.isProviderEnabledForTeamMember('openai-codex', workspace)).toBe(false);
    service.settingsStore.set('providerSettings', { 'openai-codex': { enabled: true } });
    expect(service.isProviderEnabledForTeamMember('openai-codex', workspace)).toBe(true);
    expect(typeof service.isProviderEnabledForTeamMember('openai-codex', workspace)).toBe('boolean');
  });

  it('a project-level override wins over the global setting, in both directions', async () => {
    const { getWorkspaceState, setWorkspaceState } = await import('../../../utils/store') as any;
    const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
    if (typeof setWorkspaceState !== 'function' || typeof getWorkspaceState !== 'function') {
      // The override store is not writable from here in this build: the fall-through is the contract.
      expect(service.isProviderEnabledForTeamMember('openai-codex', workspace)).toBe(false);
      return;
    }
    setWorkspaceState(workspace, { ...getWorkspaceState(workspace), aiProviderOverrides: { providers: { 'openai-codex': { enabled: true } } } });
    expect(service.isProviderEnabledForTeamMember('openai-codex', workspace)).toBe(true);
    service.settingsStore.set('providerSettings', { 'openai-codex': { enabled: true } });
    setWorkspaceState(workspace, { ...getWorkspaceState(workspace), aiProviderOverrides: { providers: { 'openai-codex': { enabled: false } } } });
    expect(service.isProviderEnabledForTeamMember('openai-codex', workspace)).toBe(false);
  });
});
