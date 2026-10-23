// @vitest-environment node
/**
 * Portal F1.2 -- the user-only "test data" mark.
 *
 * Stored as `portalTestData` in the project's WorkspaceState (app store under
 * userData, never a workspace file). Only the UI sets it, through an IPC that
 * validates the sender and requires recent real user input in that window. No
 * MCP tool can write it. Main reads it on every click, type and evaluate, with
 * a worktree resolved to its parent project, and only for LOCAL previews
 * (nim-preview and loopback): the mark never unlocks anything else.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import enSettings from '../../../../../runtime/src/i18n/locales/en/settings.json';

const { handlers, stateByProject, windows, confirm } = vi.hoisted(() => ({
  confirm: vi.fn(async (_info: unknown, _show?: unknown, _parent?: unknown) => true),
  handlers: new Map<string, (event: unknown, ...args: any[]) => Promise<any>>(),
  stateByProject: new Map<string, Record<string, unknown>>(),
  // project path -> the window the lookup returns and whether it is SHOWING the project
  windows: new Map<string, { window: { webContents: { id: number } }; isActive: boolean } | null>(),
}));

vi.mock('../portalMarkConfirmation', () => ({ confirmPortalMark: confirm }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: unknown, ...args: any[]) => Promise<any>) => {
    handlers.set(channel, fn);
  },
}));
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../utils/store', () => ({
  getWorkspaceState: (p: string) => ({ ...(stateByProject.get(p) ?? {}) }),
  updateWorkspaceState: (p: string, fn: (s: Record<string, unknown>) => void) => {
    const draft = { ...(stateByProject.get(p) ?? {}) };
    fn(draft);
    stateByProject.set(p, draft);
    return draft;
  },
}));
// A worktree resolves to its parent project; anything else resolves to itself.
vi.mock('../PermissionService', () => ({
  resolveWorkspacePathForPermissions: async (p: string) => (p.startsWith('/proj_worktrees/') ? '/proj' : p),
}));
vi.mock('../../window/WindowManager', () => ({
  findWorkspaceWindowMatch: (p: string) => windows.get(p) ?? null,
}));

import {
  assertAgentMayExercise,
  assertAgentMayExerciseOn,
  isPortalTestDataMarked,
  registerPortalTestDataHandlers,
  PORTAL_TEST_DATA_GET,
  PORTAL_TEST_DATA_SET,
  PORTAL_INTERACTION_PORTS_SET,
  getInteractionPorts,
  normalizePorts,
} from '../portalTestData';
import { __resetUserInputForTests, recordUserInput } from '../userInputRecency';

const WINDOW_ID = 7;
const uiEvent = (id = WINDOW_ID) => ({ sender: { id } });
const setMark = (...projects: string[]) => {
  for (const p of projects) stateByProject.set(p, { portalTestData: { enabled: true, markedAt: 1 }, portalInteractionPorts: [80, 3000, 5173, 8080] });
};
const previewOf = (root: string) => `nim-preview://${Buffer.from(root, 'utf8').toString('hex')}/index.html`;

beforeEach(() => {
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  handlers.clear();
  stateByProject.clear();
  windows.clear();
  __resetUserInputForTests();
  windows.set('/proj', { window: { webContents: { id: WINDOW_ID } }, isActive: true });
  registerPortalTestDataHandlers();
});

describe('the mark is off by default and lives in WorkspaceState', () => {
  it('is not marked for an untouched project', async () => {
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('is not marked without a workspace path (fail closed)', async () => {
    expect(await isPortalTestDataMarked(undefined)).toBe(false);
    await expect(assertAgentMayExercise(undefined, 'click')).rejects.toThrow(/test data/i);
  });

  it('is stored as portalTestData in the app store entry of the project', async () => {
    recordUserInput(WINDOW_ID);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(res).toMatchObject({ success: true, enabled: true });
    expect(stateByProject.get('/proj')).toHaveProperty('portalTestData');
    expect(await isPortalTestDataMarked('/proj')).toBe(true);
  });
});

describe('only the UI can set it', () => {
  it('refuses a set with no recent real user input in the sender window', async () => {
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(res).toMatchObject({ success: false, code: 'noUserInput' });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('refuses a set once the user input is stale', async () => {
    recordUserInput(WINDOW_ID, Date.now() - 60_000);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(res).toMatchObject({ success: false, code: 'noUserInput' });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('refuses a sender that is not the window of that project, even with input in it', async () => {
    recordUserInput(99);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(99), '/proj', true);
    expect(res).toMatchObject({ success: false, code: 'notProjectWindow' });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('refuses a sender without a webContents id', async () => {
    recordUserInput(WINDOW_ID);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!({ sender: {} }, '/proj', true);
    expect(res).toMatchObject({ success: false, code: 'notProjectWindow' });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('refuses malformed arguments with an invalidRequest code', async () => {
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', 'yes');
    expect(res).toMatchObject({ success: false, code: 'invalidRequest' });
  });

  it('input recorded in another window does not count for this one', async () => {
    recordUserInput(1234);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(res.success).toBe(false);
  });

  it('spends the input: a second change needs a fresh keypress or click', async () => {
    recordUserInput(WINDOW_ID);
    expect((await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true)).success).toBe(true);
    const again = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', false);
    expect(again.success).toBe(false);
    expect(await isPortalTestDataMarked('/proj')).toBe(true);
  });

  it('can turn the mark off again (with input)', async () => {
    recordUserInput(WINDOW_ID);
    await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    recordUserInput(WINDOW_ID);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', false);
    expect(res).toMatchObject({ success: true, enabled: false });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('the read channel needs no input and reports the mark', async () => {
    expect(await handlers.get(PORTAL_TEST_DATA_GET)!(uiEvent(), '/proj')).toMatchObject({ success: true, enabled: false });
  });
});

describe('the sender must be the window that SHOWS the project (several windows, the rail)', () => {
  it('a window that only lists the project in its rail cannot set the mark; the window showing it can', async () => {
    // W1 (id 1) references /proj in its rail but displays another project; W2 (id 2) shows /proj.
    windows.set('/proj', { window: { webContents: { id: 1 } }, isActive: false });
    recordUserInput(1);
    expect(await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(1), '/proj', true)).toMatchObject({ success: false, code: 'notProjectWindow' });
    windows.set('/proj', { window: { webContents: { id: 2 } }, isActive: true });
    recordUserInput(2);
    expect(await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(2), '/proj', true)).toMatchObject({ success: true });
    expect(await isPortalTestDataMarked('/proj')).toBe(true);
  });

  it('a window showing a different project cannot set the mark of this one', async () => {
    windows.set('/other', { window: { webContents: { id: 3 } }, isActive: true });
    recordUserInput(3);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(3), '/proj', true);
    expect(res).toMatchObject({ success: false, code: 'notProjectWindow' });
    expect(stateByProject.has('/proj')).toBe(false);
  });

  it('a project with no window cannot be marked', async () => {
    windows.clear();
    recordUserInput(WINDOW_ID);
    expect(await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true)).toMatchObject({ success: false, code: 'notProjectWindow' });
  });
});

describe('worktrees resolve to the parent project', () => {
  it('a mark on the project applies to its worktree', async () => {
    recordUserInput(WINDOW_ID);
    await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(await isPortalTestDataMarked('/proj_worktrees/feat')).toBe(true);
    await expect(assertAgentMayExercise('/proj_worktrees/feat', 'evaluate')).resolves.toBeUndefined();
  });

  it('setting it from a worktree path stores it on the parent project', async () => {
    recordUserInput(WINDOW_ID);
    windows.set('/proj_worktrees/feat', { window: { webContents: { id: WINDOW_ID } }, isActive: true });
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj_worktrees/feat', true);
    expect(res.success).toBe(true);
    expect(stateByProject.get('/proj')).toHaveProperty('portalTestData');
    expect(stateByProject.has('/proj_worktrees/feat')).toBe(false);
  });

  it('a mark on another project does not leak', async () => {
    setMark('/other');
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });
});

describe('main checks the mark before any click, type or evaluate', () => {
  it.each(['click', 'type', 'evaluate'] as const)('refuses %s without the mark', async (action) => {
    await expect(assertAgentMayExercise('/proj', action)).rejects.toThrow(/test data/i);
  });

  it.each(['click', 'type', 'evaluate'] as const)('allows %s with the mark', async (action) => {
    setMark('/proj');
    await expect(assertAgentMayExercise('/proj', action)).resolves.toBeUndefined();
  });

  it('treats a malformed stored value as off', async () => {
    stateByProject.set('/proj', { portalTestData: 'yes' });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
    stateByProject.set('/proj', { portalTestData: { enabled: false } });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it("names the mark the way the settings UI does, so the agent can tell the user where to find it", async () => {
    const ui = (enSettings as any).projectPermissions.portalTestData;
    const err = await assertAgentMayExercise('/proj', 'click').catch((e: Error) => e);
    expect((err as Error).message).toContain(ui.title);
    expect((err as Error).message).toContain(ui.enable);
    expect((err as Error).message).not.toContain('Portal test data');
  });
});

describe('the mark only gates LOCAL previews and never unlocks more', () => {
  it('a portal (bound project) is checked against that project, not the caller', async () => {
    setMark('/other');
    await expect(
      assertAgentMayExerciseOn({ url: 'http://localhost:5173/', boundProject: '/proj', openedByProject: '/other' }, 'click'),
    ).rejects.toThrow(/test data/i);
    setMark('/proj');
    await expect(
      assertAgentMayExerciseOn({ url: 'http://localhost:5173/', boundProject: '/proj', openedByProject: '/other' }, 'click'),
    ).resolves.toBeUndefined();
  });

  it('a nim-preview page is checked against the project whose root it serves', async () => {
    setMark('/proj');
    await expect(assertAgentMayExerciseOn({ url: previewOf('/other'), openedByProject: '/proj' }, 'click')).rejects.toThrow(/test data/i);
    await expect(assertAgentMayExerciseOn({ url: previewOf('/proj'), openedByProject: '/other' }, 'click')).resolves.toBeUndefined();
  });

  it('a loopback page belongs to the project the session was opened for', async () => {
    setMark('/proj');
    await expect(assertAgentMayExerciseOn({ url: 'http://127.0.0.1:3000/', openedByProject: '/proj' }, 'type')).resolves.toBeUndefined();
    await expect(assertAgentMayExerciseOn({ url: 'http://127.0.0.1:3000/', openedByProject: '/other' }, 'type')).rejects.toThrow(/test data/i);
    await expect(assertAgentMayExerciseOn({ url: 'http://[::1]:3000/', openedByProject: undefined }, 'type')).rejects.toThrow(/test data/i);
  });

  it.each(['https://example.com/', 'http://192.168.1.5/', 'http://localhost.evil.com/', 'about:blank'])(
    'a non-local page (%s) is not gated by the mark, marked or not',
    async (url) => {
      await expect(assertAgentMayExerciseOn({ url, openedByProject: '/proj' }, 'click')).resolves.toBeUndefined();
      setMark('/proj');
      await expect(assertAgentMayExerciseOn({ url, openedByProject: '/proj' }, 'evaluate')).resolves.toBeUndefined();
    },
  );

  it.each([
    'http://app.localhost:5173/',
    'http://a.b.localhost/',
    'http://localhost./',
    'http://127.0.0.2/',
    'http://127.255.255.254:8080/',
    'http://0.0.0.0:3000/',
    'http://[::1]:3000/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
  ])('%s is a local preview: gated by the mark of the actor project', async (url) => {
    await expect(assertAgentMayExerciseOn({ url, openedByProject: '/proj' }, 'click')).rejects.toThrow(/test data/i);
    setMark('/proj');
    await expect(assertAgentMayExerciseOn({ url, openedByProject: '/proj' }, 'click')).resolves.toBeUndefined();
  });

  it.each([
    'http://localhost.evil.com/',
    'http://evil-localhost/',
    'http://128.0.0.1/',
    'http://126.255.255.255/',
    'http://1.2.3.4/',
    'http://[::ffff:8.8.8.8]/',
    'http://[2001:db8::1]/',
    'http://localhostx/',
  ])('%s is not local: not gated', async (url) => {
    await expect(assertAgentMayExerciseOn({ url, openedByProject: '/proj' }, 'click')).resolves.toBeUndefined();
  });

  it('an undecodable nim-preview host fails closed', async () => {
    setMark('/proj');
    await expect(assertAgentMayExerciseOn({ url: 'nim-preview://workspace/x.html', openedByProject: '/proj' }, 'click')).rejects.toThrow(/test data/i);
  });
});

const setPorts = (event: unknown, project: string, ports: unknown) => handlers.get(PORTAL_INTERACTION_PORTS_SET)!(event, project, ports);
const markOnly = (project: string, ports?: number[]) =>
  stateByProject.set(project, { portalTestData: { enabled: true, markedAt: 1 }, ...(ports ? { portalInteractionPorts: ports } : {}) });

describe('enabling the mark needs a native confirmation owned by main', () => {
  it('OK enables it; the dialog names the project and is shown on the project window', async () => {
    recordUserInput(WINDOW_ID);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(res).toMatchObject({ success: true, enabled: true });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ kind: 'enable', projectPath: '/proj' });
    expect(confirm.mock.calls[0][2]).toBe(windows.get('/proj')!.window);
    expect(await isPortalTestDataMarked('/proj')).toBe(true);
  });

  it('shows the ports that will apply', async () => {
    stateByProject.set('/proj', { portalInteractionPorts: [3000, 5173] });
    recordUserInput(WINDOW_ID);
    await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(confirm.mock.calls[0][0]).toMatchObject({ ports: [3000, 5173] });
  });

  it.each([false, undefined, null, 'ok', 0, 1])('a result of %j from the dialog leaves the mark unchanged', async (answer) => {
    confirm.mockResolvedValue(answer as never);
    recordUserInput(WINDOW_ID);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(res).toMatchObject({ success: false, code: 'notConfirmed' });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('an error from the dialog leaves the mark unchanged', async () => {
    confirm.mockRejectedValue(new Error('no display'));
    recordUserInput(WINDOW_ID);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true);
    expect(res).toMatchObject({ success: false, code: 'notConfirmed' });
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('turning it off needs no dialog', async () => {
    markOnly('/proj');
    recordUserInput(WINDOW_ID);
    const res = await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', false);
    expect(res).toMatchObject({ success: true, enabled: false });
    expect(confirm).not.toHaveBeenCalled();
    expect(await isPortalTestDataMarked('/proj')).toBe(false);
  });

  it('the sender and input guards still apply first: no dialog is shown for a refused request', async () => {
    expect(await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true)).toMatchObject({ code: 'noUserInput' });
    recordUserInput(99);
    expect(await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(99), '/proj', true)).toMatchObject({ code: 'notProjectWindow' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('enabling a project that is already marked changes nothing and shows no dialog', async () => {
    markOnly('/proj');
    recordUserInput(WINDOW_ID);
    expect(await handlers.get(PORTAL_TEST_DATA_SET)!(uiEvent(), '/proj', true)).toMatchObject({ success: true, enabled: true });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('interaction ports are declared by the user, with the same gate and a confirmation when widened', () => {
  it('widening (adding a port) asks, and OK stores the ports', async () => {
    recordUserInput(WINDOW_ID);
    const res = await setPorts(uiEvent(), '/proj', [5173, 3000, 5173]);
    expect(res).toMatchObject({ success: true, ports: [3000, 5173] });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toMatchObject({ kind: 'ports', projectPath: '/proj', ports: [3000, 5173] });
    expect(await getInteractionPorts('/proj')).toEqual([3000, 5173]);
  });

  it('Cancel, any other result or an error leaves the ports unchanged', async () => {
    stateByProject.set('/proj', { portalInteractionPorts: [3000] });
    for (const impl of [async () => false, async () => undefined, async () => { throw new Error('x'); }]) {
      confirm.mockImplementation(impl as never);
      recordUserInput(WINDOW_ID);
      const res = await setPorts(uiEvent(), '/proj', [3000, 8080]);
      expect(res).toMatchObject({ success: false, code: 'notConfirmed' });
      expect(await getInteractionPorts('/proj')).toEqual([3000]);
    }
  });

  it('removing ports (narrowing) or leaving them as they are needs no dialog', async () => {
    stateByProject.set('/proj', { portalInteractionPorts: [3000, 5173] });
    recordUserInput(WINDOW_ID);
    expect(await setPorts(uiEvent(), '/proj', [5173])).toMatchObject({ success: true, ports: [5173] });
    recordUserInput(WINDOW_ID);
    expect(await setPorts(uiEvent(), '/proj', [5173])).toMatchObject({ success: true, ports: [5173] });
    recordUserInput(WINDOW_ID);
    expect(await setPorts(uiEvent(), '/proj', [])).toMatchObject({ success: true, ports: [] });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('is gated like the mark: sender window, recent input; no dialog for a refused request', async () => {
    expect(await setPorts(uiEvent(), '/proj', [5173])).toMatchObject({ success: false, code: 'noUserInput' });
    recordUserInput(99);
    expect(await setPorts(uiEvent(99), '/proj', [5173])).toMatchObject({ success: false, code: 'notProjectWindow' });
    expect(confirm).not.toHaveBeenCalled();
    expect(await getInteractionPorts('/proj')).toEqual([]);
  });

  it.each([[0], [65536], [-1], [1.5], ['80'], [NaN], [null], [[80, 'x']], ['5173'], [{}], [new Array(40).fill(0).map((_, i) => i + 1)]])(
    'refuses invalid ports %j without a dialog',
    async (ports) => {
      recordUserInput(WINDOW_ID);
      expect(await setPorts(uiEvent(), '/proj', ports)).toMatchObject({ success: false, code: 'invalidRequest' });
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it('stores the ports on the parent project when set from a worktree path', async () => {
    windows.set('/proj_worktrees/feat', { window: { webContents: { id: WINDOW_ID } }, isActive: true });
    recordUserInput(WINDOW_ID);
    await setPorts(uiEvent(), '/proj_worktrees/feat', [5173]);
    expect(stateByProject.get('/proj')).toHaveProperty('portalInteractionPorts', [5173]);
    expect(stateByProject.has('/proj_worktrees/feat')).toBe(false);
  });

  it('the read channel reports the mark and the ports', async () => {
    markOnly('/proj', [5173]);
    expect(await handlers.get(PORTAL_TEST_DATA_GET)!(uiEvent(), '/proj')).toMatchObject({ success: true, enabled: true, ports: [5173] });
  });
});

describe('normalizePorts', () => {
  it('keeps integers 1..65535, sorted and unique', () => {
    expect(normalizePorts([5173, 80, 443, 80, 65535, 1])).toEqual([1, 80, 443, 5173, 65535]);
    expect(normalizePorts([])).toEqual([]);
  });
  it.each([[0], [65536], [1.5], ['80'], [null], [undefined], [NaN]])('rejects an array containing %j', (bad) => {
    expect(normalizePorts([80, bad])).toBeNull();
  });
  it('rejects a non-array', () => {
    expect(normalizePorts('80')).toBeNull();
    expect(normalizePorts(undefined)).toBeNull();
  });
});

describe('with the mark ON, interaction needs a declared port on loopback (nim-preview needs none)', () => {
  const check = (url: string, project = '/proj', action: 'click' | 'type' | 'evaluate' = 'click') =>
    assertAgentMayExerciseOn({ url, openedByProject: project }, action);

  it('a declared port is allowed; any other port is observe-only even though the project is marked', async () => {
    markOnly('/proj', [5173]);
    await expect(check('http://localhost:5173/')).resolves.toBeUndefined();
    await expect(check('http://localhost:3000/')).rejects.toThrow(/port 3000/i);
    await expect(check('http://localhost:3000/', '/proj', 'evaluate')).rejects.toThrow(/declared/i);
  });

  it('the same port on any loopback host form the classifier knows is accepted; another port on those forms is not', async () => {
    markOnly('/proj', [5173]);
    for (const u of ['http://127.0.0.1:5173/', 'http://app.localhost:5173/', 'http://[::1]:5173/', 'http://0.0.0.0:5173/', 'http://127.9.9.9:5173/', 'http://[::ffff:127.0.0.1]:5173/']) {
      await expect(check(u), u).resolves.toBeUndefined();
    }
    for (const u of ['http://127.0.0.1:3000/', 'http://app.localhost:3000/', 'http://[::1]:3000/', 'http://0.0.0.0:3000/', 'http://[::ffff:127.0.0.1]:3000/']) {
      await expect(check(u), u).rejects.toThrow(/declared/i);
    }
  });

  it('the default scheme ports must be declared explicitly: 80 for http, 443 for https', async () => {
    markOnly('/proj', [5173]);
    await expect(check('http://localhost/')).rejects.toThrow(/port 80/);
    await expect(check('https://localhost/')).rejects.toThrow(/port 443/);
    markOnly('/proj', [80, 443]);
    await expect(check('http://localhost/')).resolves.toBeUndefined();
    await expect(check('https://localhost/')).resolves.toBeUndefined();
    await expect(check('http://localhost:80/')).resolves.toBeUndefined();
  });

  it('an unmarked project refuses everywhere, even a declared port', async () => {
    stateByProject.set('/proj', { portalInteractionPorts: [5173] });
    await expect(check('http://localhost:5173/')).rejects.toThrow(/test data/i);
    await expect(check(previewOf('/proj'))).rejects.toThrow(/test data/i);
  });

  it('an empty list means every loopback page is observe-only, while nim-preview pages of the project are allowed', async () => {
    markOnly('/proj', []);
    await expect(check('http://localhost:5173/')).rejects.toThrow(/declared/i);
    await expect(check(previewOf('/proj'))).resolves.toBeUndefined();
  });

  it('a worktree resolves to the parent project list', async () => {
    markOnly('/proj', [5173]);
    await expect(check('http://localhost:5173/', '/proj_worktrees/feat')).resolves.toBeUndefined();
    await expect(check('http://localhost:3000/', '/proj_worktrees/feat')).rejects.toThrow(/declared/i);
  });

  it('a portal (bound project) follows the same port rule on loopback and none on nim-preview', async () => {
    markOnly('/proj', [5173]);
    await expect(assertAgentMayExerciseOn({ url: 'http://localhost:3000/', boundProject: '/proj' }, 'click')).rejects.toThrow(/declared/i);
    await expect(assertAgentMayExerciseOn({ url: 'http://localhost:5173/', boundProject: '/proj' }, 'click')).resolves.toBeUndefined();
    await expect(assertAgentMayExerciseOn({ url: previewOf('/proj'), boundProject: '/proj' }, 'click')).resolves.toBeUndefined();
  });

  it('the ports of another project do not leak', async () => {
    markOnly('/proj', []);
    markOnly('/other', [5173]);
    await expect(check('http://localhost:5173/')).rejects.toThrow(/declared/i);
  });

  it('non-local pages are still neither gated nor unlocked', async () => {
    await expect(check('https://example.com/')).resolves.toBeUndefined();
    markOnly('/proj', [5173]);
    await expect(check('https://example.com/')).resolves.toBeUndefined();
  });

  it('the refusal names the setting the way the UI does', async () => {
    const ui = (enSettings as any).projectPermissions.portalTestData;
    markOnly('/proj', []);
    const err = (await check('http://localhost:3000/').catch((e: Error) => e)) as Error;
    expect(err.message).toContain(ui.title);
    expect(err.message).toContain(ui.ports.title);
  });
});
