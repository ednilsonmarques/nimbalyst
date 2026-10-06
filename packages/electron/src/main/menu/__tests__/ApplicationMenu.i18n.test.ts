// @vitest-environment node
/**
 * The application menu follows app.uiLanguage: labels come from the `menu`
 * namespace, the template is rebuilt when the language changes, and only the
 * text differs between languages (accelerators, roles, ids and handlers stay).
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18N_RESOURCES, i18n, setLanguage } from '@nimbalyst/runtime/i18n';

const { buildFromTemplate, setApplicationMenu } = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((template: unknown) => ({ template })),
  setApplicationMenu: vi.fn(),
}));

vi.mock('electron', () => ({
  Menu: { buildFromTemplate, setApplicationMenu, getApplicationMenu: vi.fn(() => null) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  app: { getName: () => 'Nimbalyst', getPath: () => '/tmp', isPackaged: false, quit: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn(), showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  nativeTheme: { shouldUseDarkColors: false, themeSource: 'system' },
}));
vi.mock('../../utils/store', () => ({
  getRecentItems: vi.fn(() => []),
  clearRecentItems: vi.fn(),
  addToRecentItems: vi.fn(),
  getTheme: vi.fn(() => 'dark'),
  setTheme: vi.fn(),
  store: { get: vi.fn(), set: vi.fn() },
  getWorkspaceState: vi.fn(),
  getWorkspaceWindowState: vi.fn(),
  isExtensionDevToolsEnabled: vi.fn(() => false),
  setWorktreeOnboardingShown: vi.fn(),
}));
vi.mock('../../window/WindowManager', () => ({
  windowStates: new Map(),
  createWindow: vi.fn(),
  findWindowByFilePath: vi.fn(),
  getWindowId: vi.fn(() => null),
}));
vi.mock('../../window/TeamManagementWindow', () => ({
  createTeamManagementWindow: vi.fn(),
  isTeamManagementWindowFocused: vi.fn(() => false),
  registerTeamManagementFocusChange: vi.fn(),
  sendOrgWindowCommand: vi.fn(),
}));
vi.mock('../../ipc/WalkthroughHandlers', () => ({
  getRegisteredWalkthroughs: vi.fn(() => []),
  getRegisteredTips: vi.fn(() => []),
}));
vi.mock('../organizationMenuState', () => ({
  getHasOrganizationsForMenu: vi.fn(() => false),
  registerOrganizationMenuRebuild: vi.fn(),
}));
vi.mock('../menuBarBridge', () => ({ notifyWindowMenuChanged: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: { menu: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }, main: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));
// Everything below is only reached from click handlers; stub it without loading it.
vi.mock('../../window/AboutWindow', () => ({}));
vi.mock('../../window/WorkspaceManagerWindow.ts', () => ({}));
vi.mock('../../window/AIUsageReportWindow', () => ({}));
vi.mock('../../window/DatabaseBrowserWindow', () => ({}));
vi.mock('../../window/DeveloperDashboardWindow', () => ({}));
vi.mock('../../window/SplashScreen', () => ({}));
vi.mock('../../file/DiffErgonomicsFixture', () => ({}));
vi.mock('../../file/FileOperations', () => ({}));
vi.mock('../../file/FileWatcherDebug', () => ({}));
vi.mock('../../theme/ThemeManager', () => ({}));
vi.mock('../../utils/FileTree', () => ({}));
vi.mock('../../utils/windowFocus', () => ({}));
vi.mock('../../utils/workspaceDetection', () => ({}));
vi.mock('../../utils/dialogPaths', () => ({}));
vi.mock('../../services/autoUpdater', () => ({}));
vi.mock('../../services/ExtensionProjectScaffolder', () => ({}));
vi.mock('../../services/BrowserSessionService', () => ({}));
vi.mock('../../services/analytics/AnalyticsService', () => ({}));
vi.mock('../../services/analytics/FeatureTrackingService', () => ({}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({}));
vi.mock('../helpMenuActions', () => ({ launchTutorialFromMenu: vi.fn() }));

type Item = { label?: string; submenu?: Item[]; [key: string]: unknown };

let createApplicationMenu: () => Promise<void>;

beforeAll(async () => {
  ({ createApplicationMenu } = await import('../ApplicationMenu'));
});

afterEach(async () => {
  await setLanguage('en');
  buildFromTemplate.mockClear();
  setApplicationMenu.mockClear();
});

function lastTemplate(): Item[] {
  return (buildFromTemplate.mock.calls.at(-1)?.[0] ?? []) as Item[];
}

function topLabels(template: Item[]): string[] {
  return template.map((item) => item.label ?? '');
}

function find(template: Item[], path: number[]): Item {
  return path.slice(1).reduce((item, index) => item.submenu![index], template[path[0]]);
}

function allLabels(items: Item[]): string[] {
  return items.flatMap((item) => [item.label ?? '', ...(Array.isArray(item.submenu) ? allLabels(item.submenu) : [])]).filter(Boolean);
}

/** Everything except the text: ids, accelerators, roles, types, flags, handlers. */
function structure(items: Item[]): unknown[] {
  return items.map(({ label: _label, submenu, click, ...rest }) => ({
    ...rest,
    click: typeof click,
    submenu: Array.isArray(submenu) ? structure(submenu) : undefined,
  }));
}

async function build(language: 'en' | 'pt-BR'): Promise<Item[]> {
  await setLanguage(language);
  await createApplicationMenu();
  return lastTemplate();
}

describe('application menu i18n', () => {
  it('renders the menu in English', async () => {
    const template = await build('en');
    const top = topLabels(template);
    expect(top).toEqual(expect.arrayContaining(['File', 'Edit', 'View', 'Window', 'Help']));
    const labels = allLabels(template);
    expect(labels).toEqual(expect.arrayContaining(['New File...', 'Undo', 'Select All', 'Zoom In', 'Keyboard Shortcuts', 'Recent Projects']));
  });

  it('renders the menu in pt-BR', async () => {
    const template = await build('pt-BR');
    const top = topLabels(template);
    expect(top).toEqual(expect.arrayContaining(['Arquivo', 'Editar', 'Exibir', 'Janela', 'Ajuda']));
    const labels = allLabels(template);
    expect(labels).toEqual(expect.arrayContaining(['Novo arquivo...', 'Desfazer', 'Selecionar tudo', 'Ampliar', 'Atalhos de teclado', 'Projetos recentes']));
    // Developer menu deliberately stays in English.
    expect(top).toContain('Developer');
  });

  it('never shows a raw i18n key as a label', async () => {
    for (const language of ['en', 'pt-BR'] as const) {
      const labels = allLabels(await build(language));
      const raw = labels.filter((label) => label.startsWith('menu:') || /^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(label));
      expect(raw).toEqual([]);
    }
  });

  it('keeps accelerators, roles, ids and handlers identical across languages', async () => {
    const en = await build('en');
    const pt = await build('pt-BR');
    expect(structure(pt)).toEqual(structure(en));
    const editMenu = en.find((item) => item.label === 'Edit')!;
    expect(editMenu.submenu!.find((item) => item.role === 'undo')).toMatchObject({ label: 'Undo' });
    const ptEdit = pt.find((item) => item.label === 'Editar')!;
    expect(ptEdit.submenu!.find((item) => item.role === 'undo')).toMatchObject({ label: 'Desfazer' });
  });

  it('rebuilds with new labels when the language changes, without a restart', async () => {
    await build('en');
    expect(topLabels(lastTemplate())).toContain('File');
    setApplicationMenu.mockClear();

    await setLanguage('pt-BR');

    await vi.waitFor(() => expect(setApplicationMenu).toHaveBeenCalled());
    expect(topLabels(lastTemplate())).toContain('Arquivo');
  });

  it('falls back to English for keys missing in pt-BR', async () => {
    // i18next keeps a reference to the bundled object; restore from a copy.
    const ptMenu = structuredClone(I18N_RESOURCES['pt-BR'].menu);
    i18n.removeResourceBundle('pt-BR', 'menu');
    try {
      const template = await build('pt-BR');
      expect(topLabels(template)).toContain('File');
    } finally {
      i18n.addResourceBundle('pt-BR', 'menu', ptMenu);
    }
    expect(find(await build('pt-BR'), [0]).label).toBe('Arquivo');
  });
});

describe('Messages menu i18n', () => {
  it('translates the org-window Messages menu and keeps its accelerators', async () => {
    const { buildMessagesMenu } = await import('../messagesMenu');
    await setLanguage('en');
    const en = buildMessagesMenu();
    await setLanguage('pt-BR');
    const pt = buildMessagesMenu();
    expect(en.label).toBe('Messages');
    expect(pt.label).toBe('Mensagens');
    expect(pt.submenu.map((item: Item) => item.label)).toContain('Marcar tudo como lido');
    expect(structure(pt.submenu)).toEqual(structure(en.submenu));
  });
});

describe('menu i18n keys', () => {
  it('every menu: key used by the menu and tray exists in the English resources', () => {
    const flatten = (tree: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(tree).flatMap(([key, value]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return typeof value === 'string' ? [path] : flatten(value as Record<string, unknown>, path);
      });
    const known = new Set(flatten(I18N_RESOURCES.en.menu as Record<string, unknown>));
    const files = ['../ApplicationMenu.ts', '../messagesMenu.ts', '../helpMenuActions.ts', '../../tray/TrayManager.ts'];
    const used: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      for (const match of source.matchAll(/\bt\(\s*'menu:([^']+)'/g)) used.push(match[1]);
    }
    expect(used.length).toBeGreaterThan(100);
    expect(used.filter((key) => !known.has(key))).toEqual([]);
  });
});
