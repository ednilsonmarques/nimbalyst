// @vitest-environment node
/**
 * Portal F1.2 -- the `portal_*` tools run in main, as a thin first-party
 * surface over BrowserSessionService (no second engine, no renderer hop).
 *
 *  - the actor is the MCP connection's session id; no id, no execution;
 *  - open is limited to the project's local preview (nim-preview built by main
 *    from a workspace file) or a loopback dev server;
 *  - navigation stays on the origin the portal opened on;
 *  - click / type / evaluate need the user-only test-data mark;
 *  - the scope and role of the calling session are re-checked at execution;
 *  - no tool can set the mark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { stateByProject, registeredWorktrees } = vi.hoisted(() => ({
  stateByProject: new Map<string, Record<string, unknown>>(),
  registeredWorktrees: new Set<string>(),
}));

vi.mock('electron', async () => (await import('../../../services/__tests__/helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../../protocols/nimPreviewProtocol', () => ({
  ensureNimPreviewProtocolForSession: vi.fn(),
}));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
vi.mock('../../../services/portalMarkConfirmation', () => ({ confirmPortalMark: vi.fn(async () => true) }));
vi.mock('../../../utils/store', () => ({
  getWorkspaceState: (p: string) => ({ ...(stateByProject.get(p) ?? {}) }),
  updateWorkspaceState: (p: string, fn: (s: Record<string, unknown>) => void) => {
    const draft = { ...(stateByProject.get(p) ?? {}) };
    fn(draft);
    stateByProject.set(p, draft);
    return draft;
  },
}));
vi.mock('../../../services/PermissionService', () => ({
  resolveWorkspacePathForPermissions: async (p: string) => (p.startsWith('/proj_worktrees/') ? '/proj' : p),
}));
vi.mock('../../../window/WindowManager', () => ({ findWorkspaceWindowMatch: () => null }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn() },
}));
// Files: main builds the preview URL and writes screenshots; faked here.
vi.mock('../../../services/BrowserAgentFiles', () => ({
  // Both /proj and /other are registered roots (the roots are process-wide). With
  // confineToRoot the file must lie under the caller's own root (the real
  // function is tested in BrowserAgentFiles.test.ts).
  buildPreviewUrlForFile: vi.fn(async (filePath: string, root?: string, opts?: { confineToRoot?: boolean }) => {
    if (opts?.confineToRoot && !(root && filePath.startsWith(root + '/'))) throw new Error('File is outside the project of this session');
    const host = filePath.startsWith('/proj/')
      ? '6162636465'
      : filePath.startsWith('/other/')
        ? '6f74686572'
        : filePath.startsWith('/proj_worktrees/feat/') && registeredWorktrees.has('/proj_worktrees/feat')
          ? '776f726b74726565'
          : null;
    if (!host) throw new Error('File is not under any active workspace root');
    return 'nim-preview://' + host + '/' + (root && filePath.startsWith(root + '/') ? filePath.slice(root.length + 1) : filePath.split('/').slice(2).join('/'));
  }),
  // The real one checks WorktreeStore; here only this worktree "belongs to a registered project".
  registerWorktreeRoot: vi.fn(async (root: string) => {
    if (root === '/proj_worktrees/feat') registeredWorktrees.add(root);
  }),
  captureScreenshotToFile: vi.fn(async () => '/proj/.nimbalyst/transcript-images/portal-1.png'),
  resolveRegisteredWorkspace: vi.fn(),
  getBrowserTranscriptImageDir: vi.fn(),
  BROWSER_TRANSCRIPT_IMAGE_DIRNAME: 'transcript-images',
}));

import { BrowserSessionService } from '../../../services/BrowserSessionService';
import { fakeState } from '../../../services/__tests__/helpers/fakeElectronBrowser';
import { __resetActorTokensForTests } from '../../../services/BrowserAuthority';
import { resetSessionToolPolicies, setSessionToolPolicyReader } from '../../sessionToolPolicy';
import { handlePortalTool, portalToolSchemas, PORTAL_TOOL_NAMES } from '../portalToolHandlers';
import { buildPreviewUrlForFile, registerWorktreeRoot } from '../../../services/BrowserAgentFiles';
import { confirmPortalMark } from '../../../services/portalMarkConfirmation';

const WS = '/proj';

const ROWS: Record<string, { agentRole: string; provider: string; workspacePath: string; metadata: Record<string, unknown> }> = {
  solo: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: {} },
  other: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: {} },
  rev: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'review', teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1 } } },
  impl: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'write', teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } } },
  arch: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'read', teamChild: { role: 'architect', rootSessionId: 'root', depth: 1 } } },
  expl: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'read', teamChild: { role: 'explorer', rootSessionId: 'root', depth: 1 } } },
  adv: { agentRole: 'standard', provider: 'openai-codex', workspacePath: WS, metadata: { toolScope: 'read', teamChild: { role: 'advisor', rootSessionId: 'root', depth: 1 } } },
  reader: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'read' } },
  // A session of ANOTHER registered project.
  otherproj: { agentRole: 'standard', provider: 'claude-code', workspacePath: '/other', metadata: {} },
  // A Codex session: not part of Portal V1.
  codex: { agentRole: 'standard', provider: 'openai-codex', workspacePath: WS, metadata: {} },
  // A session whose record names no project.
  // A member working in a git worktree of /proj.
  wt: { agentRole: 'standard', provider: 'claude-code', workspacePath: '/proj', worktreePath: '/proj_worktrees/feat', metadata: {} } as never,
  // A session whose worktree is not a worktree of any registered project.
  wtbad: { agentRole: 'standard', provider: 'claude-code', workspacePath: '/proj', worktreePath: '/elsewhere/feat', metadata: {} } as never,
  noroot: { agentRole: 'standard', provider: 'claude-code', metadata: {} } as never,
};

const svc = () => BrowserSessionService.getInstance();
const mark = (project = WS) => stateByProject.set(project, { portalTestData: { enabled: true, markedAt: 1 }, portalInteractionPorts: [80, 3000, 5173, 8080] });
/** `sessionId` null means "no MCP session id" (undefined would pick the default). */
const call = (tool: string, args: Record<string, unknown>, sessionId: string | null = 'solo', workspacePath: string | undefined = WS) =>
  handlePortalTool(tool, args, { sessionId: sessionId ?? undefined, workspacePath });
const body = (res: { content: Array<{ text: string }> }) => res.content[0].text;
const data = (res: { content: Array<{ text: string }> }) => JSON.parse(body(res));

async function openPortal(sessionId = 'solo'): Promise<string> {
  const res = await call('portal_open', { filePath: '/proj/index.html' }, sessionId);
  expect(res.isError, body(res)).toBe(false);
  return data(res).sessionId as string;
}
const lastWc = () => fakeState.views[fakeState.views.length - 1].webContents;

beforeEach(() => {
  registeredWorktrees.clear();
  vi.mocked(registerWorktreeRoot).mockClear();
  BrowserSessionService.__resetForTests();
  __resetActorTokensForTests();
  fakeState.reset();
  stateByProject.clear();
  resetSessionToolPolicies();
  setSessionToolPolicyReader(async (id) => ROWS[id] ?? null);
});
afterEach(() => setSessionToolPolicyReader(null));

describe('attribution', () => {
  it('refuses every portal tool when the MCP connection has no session id, and opens nothing', async () => {
    for (const tool of PORTAL_TOOL_NAMES) {
      const res = await call(tool, { filePath: '/proj/index.html', url: 'http://localhost:1', sessionId: 'agent-portal:x', script: '1', text: 'a' }, null);
      expect(res.isError, tool).toBe(true);
    }
    expect(fakeState.views).toHaveLength(0);
  });

  it('opens the portal owned by the calling MCP session and by nobody else', async () => {
    const id = await openPortal('solo');
    expect(svc().getOwner(id)).toBe('solo');
    expect(data(await call('portal_list', {}, 'solo')).sessionIds).toEqual([id]);
    expect(data(await call('portal_list', {}, 'other')).sessionIds).toEqual([]);
  });

  it('another session cannot drive, navigate or close a portal it does not own', async () => {
    const id = await openPortal('solo');
    mark();
    for (const [tool, args] of [
      ['portal_navigate', { sessionId: id, url: 'nim-preview://6162636465/x.html' }],
      ['portal_close', { sessionId: id }],
      ['portal_page_info', { sessionId: id }],
      ['portal_click', { sessionId: id, selector: '#go' }],
      ['portal_evaluate', { sessionId: id, script: '1' }],
    ] as const) {
      const res = await call(tool, args as Record<string, unknown>, 'other');
      expect(res.isError, tool).toBe(true);
    }
    expect(svc().hasSession(id)).toBe(true);
    expect(lastWc().inputs).toEqual([]);
  });
});

describe('open is limited to the local preview', () => {
  it('opens a workspace file over nim-preview, headless, bound to that origin', async () => {
    const id = await openPortal();
    expect(lastWc().loaded[0]).toBe('nim-preview://6162636465/index.html');
    expect(svc().getBoundOrigin(id)).toBe('nim-preview://6162636465');
    expect(id.startsWith('agent-')).toBe(true);
  });

  it.each(['http://localhost:5173/', 'http://127.0.0.1:3000/app', 'http://[::1]:8080/'])('opens the loopback dev server %s and binds its origin', async (url) => {
    const res = await call('portal_open', { url });
    expect(res.isError, body(res)).toBe(false);
    expect(svc().getBoundOrigin(data(res).sessionId)).toBe(new URL(url).protocol + '//' + new URL(url).host);
  });

  it.each([
    'https://example.com/',
    'http://192.168.1.5:3000/',
    'http://localhost.evil.com/',
    'http://127.0.0.1.evil.com/',
    'file:///C:/Windows/win.ini',
    'data:text/html,hi',
    'javascript:alert(1)',
    'about:blank',
    'nim-preview://ffff/index.html',
  ])('refuses to open %s', async (url) => {
    const res = await call('portal_open', { url });
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });

  it('refuses a file outside the workspace', async () => {
    const res = await call('portal_open', { filePath: '/etc/passwd' });
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });

  it('refuses when neither a file nor a url is given', async () => {
    expect((await call('portal_open', {})).isError).toBe(true);
  });

  it('keeps at most two portals per agent', async () => {
    await openPortal();
    await openPortal();
    const third = await call('portal_open', { filePath: '/proj/index.html' });
    expect(third.isError).toBe(true);
    expect(body(third)).toMatch(/at most 2/);
  });

  it('describes the confinement and what it leaves free', () => {
    const open = portalToolSchemas.find((t) => t.name === 'portal_open')!;
    const nav = portalToolSchemas.find((t) => t.name === 'portal_navigate')!;
    for (const t of [open, nav]) {
      expect(t.description).toMatch(/subresource/i);
      expect(t.description).toMatch(/origin/i);
    }
  });
});

describe('navigation stays inside the bound origin', () => {
  it('navigates within the origin', async () => {
    const id = await openPortal();
    const res = await call('portal_navigate', { sessionId: id, url: 'nim-preview://6162636465/other.html' });
    expect(res.isError, body(res)).toBe(false);
    expect(lastWc().loaded).toContain('nim-preview://6162636465/other.html');
  });

  it.each(['https://example.com/', 'nim-preview://ffff/index.html', 'http://localhost:5173/', 'file:///C:/x', 'javascript:1'])('refuses to navigate to %s and loads nothing', async (url) => {
    const id = await openPortal();
    const before = [...lastWc().loaded];
    const res = await call('portal_navigate', { sessionId: id, url });
    expect(res.isError).toBe(true);
    expect(lastWc().loaded).toEqual(before);
  });

  it('only drives portals: a plain agent browser session is not reachable through portal_*', async () => {
    svc().createSession({ sessionId: 'agent-browser:1', url: 'https://example.com', headless: true, ownerSessionId: 'solo' });
    mark();
    const res = await call('portal_navigate', { sessionId: 'agent-browser:1', url: 'https://example.org/' });
    expect(res.isError).toBe(true);
  });
});

describe('the test-data mark gates click, type and evaluate', () => {
  it.each([
    ['portal_click', { selector: '#go' }],
    ['portal_type', { selector: '#q', text: 'hello' }],
    ['portal_evaluate', { script: 'document.title' }],
  ] as const)('refuses %s without the mark and sends nothing to the page', async (tool, args) => {
    const id = await openPortal();
    const wc = lastWc();
    const scripts = wc.scripts.length;
    const res = await call(tool, { sessionId: id, ...args });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/test data/i);
    expect(wc.inputs).toEqual([]);
    expect(wc.scripts.length).toBe(scripts);
  });

  it.each([
    ['portal_click', { selector: '#go' }],
    ['portal_type', { selector: '#q', text: 'hi' }],
    ['portal_evaluate', { script: 'document.title' }],
  ] as const)('allows %s with the mark (full scope, solo session)', async (tool, args) => {
    const id = await openPortal();
    mark();
    const res = await call(tool, { sessionId: id, ...args });
    expect(res.isError, body(res)).toBe(false);
  });

  it('click and type reach the page as real input events through the service', async () => {
    const id = await openPortal();
    mark();
    await call('portal_click', { sessionId: id, x: 5, y: 6 });
    await call('portal_type', { sessionId: id, text: 'ab' });
    expect(lastWc().inputs.length).toBeGreaterThanOrEqual(5);
  });

  it('observation never needs the mark: page_info, screenshot, scroll, list, close', async () => {
    const id = await openPortal();
    for (const [tool, args] of [
      ['portal_page_info', { sessionId: id }],
      ['portal_screenshot', { sessionId: id }],
      ['portal_scroll', { sessionId: id, dy: 100 }],
      ['portal_list', {}],
    ] as const) {
      const res = await call(tool, args as Record<string, unknown>);
      expect(res.isError, tool + body(res)).toBe(false);
    }
    expect((await call('portal_close', { sessionId: id })).isError).toBe(false);
    expect(svc().hasSession(id)).toBe(false);
  });

  it('a mark on the parent project applies to a worktree session', async () => {
    const id = await openPortal();
    mark();
    const res = await call('portal_click', { sessionId: id, x: 1, y: 1 }, 'solo', '/proj_worktrees/feat');
    expect(res.isError, body(res)).toBe(false);
  });
});

describe('the scope and role are re-checked at execution', () => {
  it.each(['arch', 'expl', 'adv', 'reader'])('%s gets no portal tool: every call is refused and nothing opens', async (sessionId) => {
    mark();
    for (const tool of PORTAL_TOOL_NAMES) {
      const res = await call(tool, { filePath: '/proj/index.html', url: 'http://localhost:1', sessionId: 'agent-portal:x', script: '1', text: 'a' }, sessionId);
      expect(res.isError, `${sessionId} ${tool}`).toBe(true);
    }
    expect(fakeState.views).toHaveLength(0);
  });

  it.each(['rev', 'impl'])('%s may observe and exercise, never evaluate, even with the mark', async (sessionId) => {
    const id = await openPortal(sessionId);
    mark();
    expect((await call('portal_page_info', { sessionId: id }, sessionId)).isError).toBe(false);
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 }, sessionId)).isError).toBe(false);
    expect((await call('portal_type', { sessionId: id, text: 'a' }, sessionId)).isError).toBe(false);
    const scripts = lastWc().scripts.length;
    const res = await call('portal_evaluate', { sessionId: id, script: 'document.cookie' }, sessionId);
    expect(res.isError).toBe(true);
    expect(lastWc().scripts.length).toBe(scripts);
  });

  it('a full-scope solo session may evaluate once the mark is on', async () => {
    const id = await openPortal('solo');
    mark();
    expect((await call('portal_evaluate', { sessionId: id, script: '1+1' }, 'solo')).isError).toBe(false);
  });

  it('fails closed when the session policy cannot be read', async () => {
    setSessionToolPolicyReader(async () => { throw new Error('db down'); });
    resetSessionToolPolicies();
    const res = await call('portal_open', { filePath: '/proj/index.html' }, 'solo');
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });
});

describe('no tool can set the mark', () => {
  it('offers no tool that names the mark, test data or trust', () => {
    for (const t of portalToolSchemas) {
      expect(t.name).not.toMatch(/mark|test.?data|trust/i);
      expect(JSON.stringify(t.inputSchema)).not.toMatch(/portalTestData|testData|test_data/i);
    }
    expect([...PORTAL_TOOL_NAMES].sort()).toEqual(
      ['portal_click', 'portal_close', 'portal_evaluate', 'portal_list', 'portal_navigate', 'portal_open', 'portal_page_info', 'portal_screenshot', 'portal_scroll', 'portal_type'],
    );
  });

  it('an unknown or invented tool name is refused and changes nothing', async () => {
    for (const tool of ['portal_set_test_data', 'portal_mark', 'portal_trust']) {
      const res = await call(tool, { enabled: true, portalTestData: true });
      expect(res.isError).toBe(true);
    }
    expect(stateByProject.size).toBe(0);
  });

  it('extra fields on a real tool do not write the mark', async () => {
    await call('portal_open', { filePath: '/proj/index.html', portalTestData: true, testData: true, mark: true });
    expect(stateByProject.size).toBe(0);
    const id = data(await call('portal_list', {})).sessionIds[0];
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1, portalTestData: true })).isError).toBe(true);
  });
});

describe("the user's tabs are unchanged", () => {
  it('portal tools neither list, drive nor close a user tab', async () => {
    svc().createSession({ sessionId: 'browser:doc.html:1', url: 'about:blank' });
    mark();
    expect(data(await call('portal_list', {})).sessionIds).toEqual([]);
    for (const [tool, args] of [
      ['portal_close', { sessionId: 'browser:doc.html:1' }],
      ['portal_page_info', { sessionId: 'browser:doc.html:1' }],
      ['portal_click', { sessionId: 'browser:doc.html:1', x: 1, y: 1 }],
      ['portal_evaluate', { sessionId: 'browser:doc.html:1', script: '1' }],
    ] as const) {
      expect((await call(tool, args as Record<string, unknown>)).isError, tool).toBe(true);
    }
    expect(svc().hasSession('browser:doc.html:1')).toBe(true);
  });
});

describe('a portal belongs to the project of the session that opened it (B1)', () => {
  it("opens from the session record's project root, not from the transport workspace, and confines the file to it", async () => {
    const res = await call('portal_open', { filePath: '/proj/index.html' }, 'solo', '/other');
    expect(res.isError, body(res)).toBe(false);
    expect(vi.mocked(buildPreviewUrlForFile)).toHaveBeenLastCalledWith('/proj/index.html', '/proj', { confineToRoot: true });
  });

  it('refuses a file of another registered project, marked or not, and opens nothing', async () => {
    mark(WS);
    const res = await call('portal_open', { filePath: '/other/index.html' }, 'solo');
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
    // ...also when the transport workspace claims to be the other project
    expect((await call('portal_open', { filePath: '/other/index.html' }, 'solo', '/other')).isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });

  it("the mark is read for the portal's project: a mark on the caller's transport workspace does not open it", async () => {
    const id = data(await call('portal_open', { filePath: '/other/index.html' }, 'otherproj', '/proj')).sessionId as string;
    mark('/proj'); // the transport workspace the caller claimed is marked; /other is NOT
    for (const [tool, args] of [
      ['portal_click', { x: 1, y: 1 }],
      ['portal_type', { text: 'a' }],
      ['portal_evaluate', { script: '1' }],
    ] as const) {
      expect((await call(tool, { sessionId: id, ...args }, 'otherproj', '/proj')).isError, tool).toBe(true);
    }
    expect(lastWc().inputs).toEqual([]);
    mark('/other');
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 }, 'otherproj', '/proj')).isError).toBe(false);
  });

  it('the mark of another project does not unlock this one', async () => {
    const id = await openPortal('solo');
    mark('/other');
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 })).isError).toBe(true);
  });

  it("a loopback portal belongs to the calling session's project", async () => {
    const res = await call('portal_open', { url: 'http://localhost:5173/' }, 'otherproj', '/proj');
    const id = data(res).sessionId as string;
    expect(svc().getProjectPath(id)).toBe('/other');
    mark('/proj');
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 }, 'otherproj', '/proj')).isError).toBe(true);
    mark('/other');
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 }, 'otherproj', '/proj')).isError).toBe(false);
  });

  it('a portal opened on /proj cannot be driven, navigated or closed by a session of another project', async () => {
    const id = await openPortal('solo');
    mark('/proj');
    mark('/other');
    for (const [tool, args] of [
      ['portal_click', { x: 1, y: 1 }],
      ['portal_evaluate', { script: '1' }],
      ['portal_navigate', { url: 'nim-preview://6162636465/x.html' }],
      ['portal_close', {}],
      ['portal_page_info', {}],
    ] as const) {
      expect((await call(tool, { sessionId: id, ...args }, 'otherproj')).isError, tool).toBe(true);
    }
    expect(svc().hasSession(id)).toBe(true);
  });

  it('records the portal project on the session', async () => {
    const id = await openPortal('solo');
    expect(svc().getProjectPath(id)).toBe('/proj');
  });

  it('refuses to open when the session record names no project', async () => {
    const res = await call('portal_open', { filePath: '/proj/index.html' }, 'noroot');
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });
});

describe('Codex is not part of Portal V1 (N4)', () => {
  it('every portal tool is refused to an openai-codex session at execution, and nothing opens', async () => {
    mark();
    for (const tool of PORTAL_TOOL_NAMES) {
      const res = await call(tool, { filePath: '/proj/index.html', url: 'http://localhost:1', sessionId: 'agent-portal:x', script: '1', text: 'a' }, 'codex');
      expect(res.isError, tool).toBe(true);
    }
    expect(fakeState.views).toHaveLength(0);
  });
});

describe('a member in a worktree opens its own files (registered on demand)', () => {
  it('registers the session worktree before building the URL, and opens a file inside it', async () => {
    const res = await call('portal_open', { filePath: '/proj_worktrees/feat/index.html' }, 'wt');
    expect(res.isError, body(res)).toBe(false);
    expect(vi.mocked(registerWorktreeRoot)).toHaveBeenCalledWith('/proj_worktrees/feat');
    expect(vi.mocked(registerWorktreeRoot).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(buildPreviewUrlForFile).mock.invocationCallOrder.at(-1)!,
    );
    expect(vi.mocked(buildPreviewUrlForFile)).toHaveBeenLastCalledWith('/proj_worktrees/feat/index.html', '/proj_worktrees/feat', { confineToRoot: true });
    expect(lastWc().loaded[0]).toBe('nim-preview://776f726b74726565/index.html');
  });

  it('a worktree that is not a worktree of a registered project is still refused', async () => {
    const res = await call('portal_open', { filePath: '/elsewhere/feat/index.html' }, 'wtbad');
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });

  it('a file of the parent project is outside the worktree and is refused', async () => {
    expect((await call('portal_open', { filePath: '/proj/index.html' }, 'wt')).isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });

  it('the mark of the PARENT project gates click (and no other project\'s mark does)', async () => {
    const id = data(await call('portal_open', { filePath: '/proj_worktrees/feat/index.html' }, 'wt')).sessionId as string;
    expect(svc().getProjectPath(id)).toBe('/proj_worktrees/feat');
    mark('/other');
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 }, 'wt')).isError).toBe(true);
    expect(lastWc().inputs).toEqual([]);
    mark('/proj');
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 }, 'wt')).isError).toBe(false);
  });
});

describe('the opening project is recorded on every portal too', () => {
  it('stores openedByProject separately from the portal project', async () => {
    const id = await openPortal('solo');
    expect(svc().getOpenedByProject(id)).toBe('/proj');
    const other = data(await call('portal_open', { url: 'http://localhost:5173/' }, 'otherproj')).sessionId as string;
    expect(svc().getOpenedByProject(other)).toBe('/other');
  });
});

describe('interaction needs the mark AND a declared port; observing any localhost stays allowed', () => {
  const markWithPorts = (ports: number[], project = WS) =>
    stateByProject.set(project, { portalTestData: { enabled: true, markedAt: 1 }, portalInteractionPorts: ports });
  const open = async (url: string, session = 'solo') => data(await call('portal_open', { url }, session)).sessionId as string;

  it('observes localhost:3000 with no mark and no declared port', async () => {
    const id = await open('http://localhost:3000/');
    for (const [tool, args] of [['portal_page_info', {}], ['portal_screenshot', {}], ['portal_scroll', { dy: 10 }], ['portal_list', {}]] as const) {
      expect((await call(tool, { sessionId: id, ...args })).isError, tool).toBe(false);
    }
  });

  it('with port 5173 declared: click on localhost:5173 is allowed, on localhost:3000 refused, on 127.0.0.1:5173 allowed; observing :3000 still works', async () => {
    markWithPorts([5173]);
    const a = await open('http://localhost:5173/');
    const b = await open('http://localhost:3000/');
    expect((await call('portal_click', { sessionId: a, x: 1, y: 1 })).isError).toBe(false);
    expect((await call('portal_close', { sessionId: a })).isError).toBe(false);
    const inputsBefore = lastWc().inputs.length;
    for (const [tool, args] of [['portal_click', { x: 1, y: 1 }], ['portal_type', { text: 'a' }], ['portal_evaluate', { script: '1' }]] as const) {
      const res = await call(tool, { sessionId: b, ...args });
      expect(res.isError, tool).toBe(true);
      expect(body(res)).toMatch(/declared/i);
    }
    expect(lastWc().inputs.length).toBe(inputsBefore);
    expect((await call('portal_page_info', { sessionId: b })).isError).toBe(false);
    await call('portal_close', { sessionId: b });
    const c = await open('http://127.0.0.1:5173/');
    expect((await call('portal_click', { sessionId: c, x: 1, y: 1 })).isError).toBe(false);
  });

  it('an unmarked project refuses everywhere, declared port or not', async () => {
    stateByProject.set(WS, { portalInteractionPorts: [5173] });
    const id = await open('http://localhost:5173/');
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 })).isError).toBe(true);
  });

  it('a portal in a worktree uses the parent project list', async () => {
    markWithPorts([5173], '/proj');
    const id = data(await call('portal_open', { url: 'http://localhost:5173/' }, 'wt')).sessionId as string;
    expect((await call('portal_click', { sessionId: id, x: 1, y: 1 }, 'wt')).isError).toBe(false);
  });

  it('portal_click and portal_evaluate say declared ports limit the page UI, not the network', () => {
    for (const name of ['portal_click', 'portal_evaluate']) {
      const d = portalToolSchemas.find((t) => t.name === name)!.description;
      expect(d, name).toMatch(/not the network/i);
      expect(d, name).toMatch(/fetch any loopback port/i);
    }
  });

  it('the tool descriptions say interaction needs the mark and a declared port', () => {
    for (const name of ['portal_click', 'portal_type', 'portal_evaluate', 'portal_open']) {
      const d = portalToolSchemas.find((t) => t.name === name)!.description;
      expect(d, name).toMatch(/declared port/i);
      expect(d, name).toMatch(/test data/i);
    }
  });
});

describe('no agent path can set the mark, the ports, or open the native dialog', () => {
  it('no portal tool call, with any extra arguments, writes the mark or the ports or shows the dialog', async () => {
    const id = await openPortal('solo');
    const before = JSON.stringify([...stateByProject]);
    for (const tool of PORTAL_TOOL_NAMES) {
      await call(tool, {
        sessionId: id, filePath: '/proj/index.html', url: 'http://localhost:1/', script: '1', text: 'a', x: 1, y: 1,
        enabled: true, ports: [1, 2], portalTestData: true, portalInteractionPorts: [1, 2], confirm: true,
      });
    }
    for (const tool of ['portal_set_test_data', 'portal_set_ports', 'portal_confirm', 'portal_mark']) {
      expect((await call(tool, { enabled: true, ports: [1] })).isError).toBe(true);
    }
    expect(JSON.stringify([...stateByProject])).toBe(before);
    expect(vi.mocked(confirmPortalMark)).not.toHaveBeenCalled();
  });
});
