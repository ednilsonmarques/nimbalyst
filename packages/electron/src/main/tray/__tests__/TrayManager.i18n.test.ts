// @vitest-environment node
/** Tray menu follows app.uiLanguage. Harness copied from TrayManager.platform.test.ts. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted mocks. The vi.mock factories below reference these handles, so they
// must come from vi.hoisted() to be available before module resolution.
const {
  trayInstance,
  menuBuildFromTemplate,
  nativeThemeOn,
  nativeThemeRemoveListener,
  systemPrefsSubscribe,
  systemPrefsUnsubscribe,
  browserGetAllWindows,
  findWindowByWorkspaceMock,
  loggerInfo,
  loggerError,
  loggerWarn,
  loggerDebug,
  managerSubscribe,
  updateMetadataMock,
  syncPushChange,
  syncProvider,
  setShowTrayIconMock,
  isShowTrayIconMock,
  isShowTrayStripMock,
  getTrayStripStyleMock,
  showMenuBarIslandMock,
  closeMenuBarIslandMock,
  toggleTrayPanelWindowMock,
} = vi.hoisted(() => ({
  trayInstance: {
    setImage: vi.fn(),
    setTitle: vi.fn(),
    setContextMenu: vi.fn(),
    setToolTip: vi.fn(),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width: 24, height: 24 })),
    on: vi.fn(),
    destroy: vi.fn(),
  },
  menuBuildFromTemplate: vi.fn().mockReturnValue({}),
  nativeThemeOn: vi.fn(),
  nativeThemeRemoveListener: vi.fn(),
  systemPrefsSubscribe: vi.fn().mockReturnValue(42),
  systemPrefsUnsubscribe: vi.fn(),
  browserGetAllWindows: vi.fn<() => unknown[]>(() => []),
  findWindowByWorkspaceMock: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  managerSubscribe: vi.fn().mockReturnValue(() => {}),
  updateMetadataMock: vi.fn().mockResolvedValue(undefined),
  syncPushChange: vi.fn(),
  syncProvider: { pushChange: vi.fn() },
  setShowTrayIconMock: vi.fn(),
  // Off by default so `refreshMenuBar` skips creating a real Tray; the tests
  // that need one assign `internals.tray` directly or opt in.
  isShowTrayIconMock: vi.fn(() => false),
  // The strip is a rendered bitmap needing a real BrowserWindow; these tests
  // exercise the icon/menu path, so keep it off unless a test opts in.
  isShowTrayStripMock: vi.fn(() => false),
  getTrayStripStyleMock: vi.fn(() => 'image'),
  showMenuBarIslandMock: vi.fn(),
  closeMenuBarIslandMock: vi.fn(),
  toggleTrayPanelWindowMock: vi.fn(),
}));

syncProvider.pushChange = syncPushChange;

function createNativeImageMock() {
  return {
    isEmpty: () => false,
    setTemplateImage: vi.fn(),
    toBitmap: vi.fn(() => Buffer.alloc(32 * 32 * 4)),
  };
}

vi.mock('electron', () => ({
  Tray: vi.fn(function () {
    return trayInstance;
  }),
  Menu: { buildFromTemplate: menuBuildFromTemplate },
  app: {
    dock: undefined,
    on: vi.fn(),
    removeListener: vi.fn(),
    isReady: () => true,
  },
  nativeImage: {
    createFromPath: vi.fn().mockImplementation(() => createNativeImageMock()),
    createFromBuffer: vi.fn().mockImplementation(() => createNativeImageMock()),
  },
  nativeTheme: {
    on: nativeThemeOn,
    removeListener: nativeThemeRemoveListener,
    shouldUseDarkColors: false,
  },
  systemPreferences: {
    subscribeNotification: systemPrefsSubscribe,
    unsubscribeNotification: systemPrefsUnsubscribe,
  },
  BrowserWindow: { getAllWindows: browserGetAllWindows },
}));

vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({
  getSessionStateManager: vi.fn(() => ({ subscribe: managerSubscribe })),
}));

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: {
    updateMetadata: updateMetadataMock,
  },
}));

vi.mock('../../window/WindowManager', () => ({
  findWindowByWorkspace: findWindowByWorkspaceMock,
}));

vi.mock('../../utils/appPaths', () => ({
  getPackageRoot: vi.fn(() => '/fake/package/root'),
}));

vi.mock('../../utils/store', () => ({
  isShowTrayIcon: isShowTrayIconMock,
  setShowTrayIcon: setShowTrayIconMock,
  isShowTrayStrip: isShowTrayStripMock,
  // Fed back into the getter: `setStripVisible` reads its own write back to
  // decide which surface the menu bar gets, so a setter that goes nowhere makes
  // the reconciliation untestable.
  setShowTrayStrip: vi.fn((value: boolean) => { isShowTrayStripMock.mockReturnValue(value); }),
  getTrayStripStyle: getTrayStripStyleMock,
  setTrayStripStyle: vi.fn(),
  getSessionSyncConfig: vi.fn(() => ({})),
  setSessionSyncConfig: vi.fn(),
  isOSNotificationsEnabled: vi.fn(() => true),
  setOSNotificationsEnabled: vi.fn(),
  getTheme: vi.fn(() => 'dark'),
  getTrayPanelWidth: vi.fn(() => undefined),
  setTrayPanelWidth: vi.fn(),
}));

// The tray panel is macOS-only; these tests run on whatever platform CI uses, so
// pin it off unless a test opts in. That keeps the native-menu assertions below
// exercising the `setContextMenu` path they were written against.
vi.mock('../../window/TrayPanelWindow', () => ({
  isTrayPanelSupported: vi.fn(() => false),
  isTrayPanelWindow: vi.fn(() => false),
  toggleTrayPanelWindow: toggleTrayPanelWindowMock,
  pushTrayPanelFeed: vi.fn(),
  closeTrayPanelWindow: vi.fn(),
}));

vi.mock('../../window/MenuBarIslandWindow', () => ({
  isMenuBarIslandSupported: vi.fn(() => true),
  isMenuBarIslandWindow: vi.fn(() => false),
  showMenuBarIsland: showMenuBarIslandMock,
  closeMenuBarIsland: closeMenuBarIslandMock,
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: loggerInfo,
      error: loggerError,
      warn: loggerWarn,
      debug: loggerDebug,
    },
  },
}));

vi.mock('../../services/PowerSaveService', () => ({
  isPreventingSleep: vi.fn(() => false),
  getSleepPreventionMode: vi.fn(() => 'auto'),
}));

vi.mock('../../services/SyncManager', () => ({
  updateSleepPrevention: vi.fn(),
  resolvePreventSleepMode: vi.fn(() => 'auto'),
  getSyncProvider: vi.fn(() => syncProvider),
}));

// Suppress the database-seed query in initialize() by stubbing it.
vi.mock('../TrayManager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../TrayManager')>();
  return actual; // we want the real TrayManager; nothing to override at module level
});

import { TrayManager } from '../TrayManager';
import { setLanguage } from '@nimbalyst/runtime/i18n';

function resetSingleton() {
  // Reset the private singleton between tests so each it() runs against a
  // fresh instance. The TrayManager class uses a static `instance` field,
  // so we have to clear it via the constructor cache.
  (TrayManager as unknown as { instance?: TrayManager }).instance = undefined;
}

function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', original);
}

// ─── i18n ────────────────────────────────────────────────────────────────
// The harness above is the same one TrayManager.platform.test.ts uses.

type MenuItem = { label?: string; submenu?: MenuItem[]; click?: unknown; type?: string; [key: string]: unknown };

function lastMenu(): MenuItem[] {
  return (menuBuildFromTemplate.mock.calls.at(-1)?.[0] ?? []) as MenuItem[];
}

function labels(items: MenuItem[]): string[] {
  return items.flatMap((item) => [item.label ?? '', ...(item.submenu ? labels(item.submenu) : [])]).filter(Boolean);
}

function structure(items: MenuItem[]): unknown[] {
  return items.map(({ label: _label, submenu, click, icon: _icon, ...rest }) => ({
    ...rest,
    click: typeof click,
    submenu: submenu ? structure(submenu) : undefined,
  }));
}

function seedSessions(tm: TrayManager) {
  const base = { workspacePath: '/w', status: 'running', isStreaming: false, hasPendingPrompt: false, hasUnread: false };
  const cache = (tm as unknown as { sessionCache: Map<string, unknown> }).sessionCache;
  cache.set('blocked', { ...base, sessionId: 'blocked', title: 'Blocked One', hasPendingPrompt: true });
  cache.set('streaming', { ...base, sessionId: 'streaming', title: 'Streaming One', isStreaming: true });
  cache.set('unread', { ...base, sessionId: 'unread', title: 'Unread One', status: 'completed', hasUnread: true });
}

describe('TrayManager menu i18n', () => {
  let restorePlatform: () => void = () => {};

  beforeEach(async () => {
    vi.clearAllMocks();
    resetSingleton();
    delete process.env.PLAYWRIGHT;
    isShowTrayIconMock.mockReturnValue(true);
    restorePlatform = stubPlatform('win32');
    await setLanguage('en');
  });

  afterEach(async () => {
    restorePlatform();
    isShowTrayIconMock.mockReturnValue(false);
    TrayManager.getInstance().shutdown();
    await setLanguage('en');
  });

  it('renders the tray menu in English and pt-BR with the same structure', async () => {
    const tm = TrayManager.getInstance();
    seedSessions(tm);
    tm.setVisible(true);
    const en = lastMenu();
    expect(labels(en)).toEqual(expect.arrayContaining(['Needs Attention', 'Running', 'Unread', 'Clear All Unread', 'New Session', 'Open Nimbalyst', 'Hide Menu Bar Icon', 'Quit']));
    expect(labels(en)).toEqual(expect.arrayContaining(['Blocked One (blocked)', 'Streaming One (streaming...)']));

    await setLanguage('pt-BR');
    tm.setVisible(true);
    const pt = lastMenu();
    expect(labels(pt)).toEqual(expect.arrayContaining(['Precisa de atenção', 'Em execução', 'Não lidas', 'Marcar todas como lidas', 'Nova sessão', 'Abrir o Nimbalyst', 'Ocultar ícone da barra de menus', 'Sair']));
    expect(labels(pt)).toEqual(expect.arrayContaining(['Blocked One (bloqueada)', 'Streaming One (transmitindo...)']));

    expect(structure(pt)).toEqual(structure(en));
    for (const label of labels(pt)) {
      expect(label.startsWith('menu:') || /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(label)).toBe(false);
    }
  });

  it('rebuilds the tray menu when the language changes', async () => {
    const tm = TrayManager.getInstance();
    tm.setDatabase({ query: vi.fn().mockResolvedValue({ rows: [] }) } as never);
    await tm.initialize();
    expect(labels(lastMenu())).toContain('New Session');
    menuBuildFromTemplate.mockClear();

    await setLanguage('pt-BR');

    expect(menuBuildFromTemplate).toHaveBeenCalled();
    expect(labels(lastMenu())).toContain('Nova sessão');
  });

  it('stops following language changes after shutdown', async () => {
    const tm = TrayManager.getInstance();
    tm.setDatabase({ query: vi.fn().mockResolvedValue({ rows: [] }) } as never);
    await tm.initialize();
    tm.shutdown();
    menuBuildFromTemplate.mockClear();

    await setLanguage('pt-BR');

    expect(menuBuildFromTemplate).not.toHaveBeenCalled();
  });
});
