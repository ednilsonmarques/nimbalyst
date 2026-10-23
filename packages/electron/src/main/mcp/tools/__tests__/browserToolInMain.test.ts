// @vitest-environment node
/**
 * Portal F1.2 -- agent `browser.*` calls run in main.
 *
 * Until F1.1 the renderer ran the browser tool and carried an actor token back
 * to the browser IPC; a hop that dropped the field was read as the user's own
 * UI. Now main executes the whole tool, with the actor taken from the MCP
 * connection, so there is no hop to drop it. The same mark, scope and role
 * rules as `portal_*` apply, and the fixed actors obey the mark too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestFromRenderer, stateByProject } = vi.hoisted(() => ({
  requestFromRenderer: vi.fn(),
  stateByProject: new Map<string, Record<string, unknown>>(),
}));

vi.mock('electron', async () => {
  const mock = (await import('../../../services/__tests__/helpers/fakeElectronBrowser')).createElectronMock();
  // handleExtensionTool looks the target window up for renderer-run tools.
  (mock.BrowserWindow as unknown as { fromId: () => object }).fromId = () => ({});
  return mock;
});
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  McpError: class McpError extends Error {},
  ErrorCode: { MethodNotFound: -32601 },
}));
vi.mock('../../mcpWorkspaceResolver', () => ({
  findWindowIdForWorkspacePath: async () => 1,
  getAvailableExtensionTools: async () => [
    'open_session', 'open_local_preview', 'list_sessions', 'close_session', 'navigate', 'reload', 'go_back',
    'go_forward', 'get_page_info', 'click', 'type', 'scroll', 'evaluate', 'screenshot',
  ].map((n) => ({ name: `browser.${n}`, extensionId: 'com.nimbalyst.browser' })).concat([{ name: 'browser.invented', extensionId: 'com.nimbalyst.browser' }]),
  documentStateBySession: new Map(),
}));
vi.mock('../../rendererRequest', () => ({ requestFromRenderer }));
vi.mock('../../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../../protocols/nimPreviewProtocol', () => ({ ensureNimPreviewProtocolForSession: vi.fn() }));
vi.mock('../../../utils/ipcRegistry', () => ({ safeHandle: vi.fn() }));
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
  resolveWorkspacePathForPermissions: async (p: string) => p,
}));
vi.mock('../../../window/WindowManager', () => ({ findWorkspaceWindowMatch: () => null }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn() },
}));
vi.mock('../../../services/BrowserAgentFiles', () => ({
  // /ws is the marked-or-not project of these tests (hex of '/ws'); anything else is another, unmarked project.
  buildPreviewUrlForFile: vi.fn(async (filePath: string) => 'nim-preview://' + (filePath.startsWith('/ws/') ? '2f7773' : '2f756e6d61726b6564') + '/' + filePath.split('/').pop()),
  captureScreenshotToFile: vi.fn(async () => '/ws/.nimbalyst/transcript-images/s.png'),
  resolveRegisteredWorkspace: vi.fn(),
  getBrowserTranscriptImageDir: vi.fn(),
  BROWSER_TRANSCRIPT_IMAGE_DIRNAME: 'transcript-images',
}));

import { handleExtensionTool } from '../extensionToolHandler';
import { runBrowserToolInMain } from '../browserToolInMain';
import { BrowserSessionService } from '../../../services/BrowserSessionService';
import { fakeState } from '../../../services/__tests__/helpers/fakeElectronBrowser';
import { __resetActorTokensForTests, EXTENSION_DEV_TEST_ACTOR, MOBILE_VOICE_ACTOR } from '../../../services/BrowserAuthority';
import { resetSessionToolPolicies, setSessionToolPolicyReader } from '../../sessionToolPolicy';

const WS = '/ws';
const ROWS: Record<string, { agentRole: string; provider: string; workspacePath: string; metadata: Record<string, unknown> }> = {
  solo: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: {} },
  other: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: {} },
  impl: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'write', teamChild: { role: 'implementer', rootSessionId: 'r', depth: 1 } } },
  full: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'full', teamChild: { role: 'other', rootSessionId: 'r', depth: 1 } } },
  rev: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'review', teamChild: { role: 'reviewer', rootSessionId: 'r', depth: 1 } } },
  reader: { agentRole: 'standard', provider: 'claude-code', workspacePath: WS, metadata: { toolScope: 'read' } },
  // A solo session of ANOTHER project, which is not marked.
  projB: { agentRole: 'standard', provider: 'claude-code', workspacePath: '/unmarked', metadata: {} },
};

const svc = () => BrowserSessionService.getInstance();
const mark = () => stateByProject.set(WS, { portalTestData: { enabled: true, markedAt: 1 }, portalInteractionPorts: [80, 3000, 5173, 8080] });
/** `sessionId` null means "no MCP session id" (undefined would pick the default). */
const run = (tool: string, args: Record<string, unknown>, sessionId: string | null = 'solo') =>
  handleExtensionTool(tool, tool, args, sessionId ?? undefined, WS);
const text = (r: { content: Array<{ text: string }> }) => r.content[0].text;
const lastWc = () => fakeState.views[fakeState.views.length - 1].webContents;

// A LOCAL page (loopback): the test-data mark applies to it.
async function openSession(sessionId = 'solo', url = 'http://localhost:5173/'): Promise<string> {
  const res = await run('browser.open_session', { url }, sessionId);
  expect(res.isError, text(res)).toBe(false);
  return /(agent-browser:[^\s"]+)/.exec(text(res))![1];
}

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  __resetActorTokensForTests();
  fakeState.reset();
  stateByProject.clear();
  requestFromRenderer.mockReset();
  requestFromRenderer.mockResolvedValue({ status: 'ok', response: { success: true, message: 'renderer ran it' } });
  resetSessionToolPolicies();
  setSessionToolPolicyReader(async (id) => ROWS[id] ?? null);
});
afterEach(() => setSessionToolPolicyReader(null));

const BROWSER_TOOLS = [
  'open_session', 'open_local_preview', 'list_sessions', 'close_session', 'navigate', 'reload', 'go_back',
  'go_forward', 'get_page_info', 'click', 'type', 'scroll', 'evaluate', 'screenshot',
].map((n) => `browser.${n}`);

describe('no renderer hop for agent browser tools', () => {
  it.each(BROWSER_TOOLS)('%s never reaches the renderer, so no hop can drop the actor', async (tool) => {
    await run(tool, { url: 'https://example.com', filePath: '/ws/a.html', sessionId: 'agent-browser:none', script: '1', text: 'x', selector: '#a' });
    expect(requestFromRenderer).not.toHaveBeenCalled();
  });

  it('an invented browser.* tool is refused, not forwarded to the renderer', async () => {
    const res = await run('browser.invented', {});
    expect(res.isError).toBe(true);
    expect(requestFromRenderer).not.toHaveBeenCalled();
  });

  it('a call with no MCP session id is still refused and runs nothing', async () => {
    const res = await run('browser.open_session', { url: 'https://example.com' }, null);
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });

  it('non-browser extension tools still go through the renderer with a token', async () => {
    const mod = await import('../../mcpWorkspaceResolver');
    vi.spyOn(mod, 'getAvailableExtensionTools').mockResolvedValueOnce([{ name: 'other.tool', extensionId: 'x' } as never]);
    await run('other.tool', {});
    expect(requestFromRenderer).toHaveBeenCalledTimes(1);
  });
});

describe('the actor is the MCP session; ownership holds', () => {
  it('opens a session owned by the calling MCP session', async () => {
    const id = await openSession('solo');
    expect(svc().getOwner(id)).toBe('solo');
  });

  it('another MCP session cannot list, drive or close it', async () => {
    const id = await openSession('solo');
    mark();
    expect(text(await run('browser.list_sessions', {}, 'other'))).not.toContain(id);
    for (const [tool, args] of [
      ['browser.navigate', { sessionId: id, url: 'https://example.org' }],
      ['browser.get_page_info', { sessionId: id }],
      ['browser.click', { sessionId: id, x: 1, y: 1 }],
      ['browser.evaluate', { sessionId: id, script: '1' }],
      ['browser.close_session', { sessionId: id }],
    ] as const) {
      expect((await run(tool, args as Record<string, unknown>, 'other')).isError, tool).toBe(true);
    }
    expect(svc().hasSession(id)).toBe(true);
  });

  it("never reaches the user's tabs", async () => {
    svc().createSession({ sessionId: 'browser:doc.html:1', url: 'about:blank' });
    mark();
    expect((await run('browser.get_page_info', { sessionId: 'browser:doc.html:1' })).isError).toBe(true);
    expect((await run('browser.close_session', { sessionId: 'browser:doc.html:1' })).isError).toBe(true);
    expect(svc().hasSession('browser:doc.html:1')).toBe(true);
    expect(text(await run('browser.list_sessions', {}))).not.toContain('browser:doc.html:1');
  });

  it('keeps the agent partition rules (fresh in-memory partition, no choice)', async () => {
    const id = await openSession('solo');
    expect(svc().getPartitionName(id)).toMatch(/^agent-portal-/);
  });

  it('opens a local preview from a workspace file', async () => {
    const res = await run('browser.open_local_preview', { filePath: '/ws/index.html' });
    expect(res.isError, text(res)).toBe(false);
    expect(lastWc().loaded[0]).toBe('nim-preview://2f7773/index.html');
  });
});

describe('the mark gates click, type and evaluate for agents', () => {
  it.each([
    ['browser.click', { selector: '#go' }],
    ['browser.type', { selector: '#q', text: 'x' }],
    ['browser.evaluate', { script: 'document.title' }],
  ] as const)('refuses %s without the mark and sends nothing to the page', async (tool, args) => {
    const id = await openSession();
    const scripts = lastWc().scripts.length;
    const res = await run(tool, { sessionId: id, ...args });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/test data/i);
    expect(lastWc().inputs).toEqual([]);
    expect(lastWc().scripts.length).toBe(scripts);
  });

  it.each([
    ['browser.click', { x: 1, y: 1 }],
    ['browser.type', { text: 'x' }],
    ['browser.evaluate', { script: '1' }],
  ] as const)('allows %s with the mark', async (tool, args) => {
    const id = await openSession();
    mark();
    const res = await run(tool, { sessionId: id, ...args });
    expect(res.isError, text(res)).toBe(false);
  });

  it('observation is not gated', async () => {
    const id = await openSession();
    for (const [tool, args] of [
      ['browser.get_page_info', {}], ['browser.screenshot', {}], ['browser.scroll', { dy: 5 }],
      ['browser.reload', {}], ['browser.navigate', { url: 'https://example.org' }],
    ] as const) {
      const res = await run(tool, { sessionId: id, ...args });
      expect(res.isError, tool + text(res)).toBe(false);
    }
  });
});

describe('the fixed actors obey the same rule', () => {
  it('mobile-voice (through the MCP tool path) cannot click, type or evaluate without the mark', async () => {
    const opened = await run('browser.open_session', { url: 'http://localhost:5173/' }, MOBILE_VOICE_ACTOR);
    const id = /(agent-browser:[^\s"]+)/.exec(text(opened))![1];
    for (const [tool, args] of [['browser.click', { x: 1, y: 1 }], ['browser.type', { text: 'a' }], ['browser.evaluate', { script: '1' }]] as const) {
      expect((await run(tool, { sessionId: id, ...args }, MOBILE_VOICE_ACTOR)).isError, tool).toBe(true);
    }
    mark();
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 }, MOBILE_VOICE_ACTOR)).isError).toBe(false);
  });

  it('extension-dev-test (extension_test_ai_tool path) cannot click, type or evaluate without the mark', async () => {
    const opened = await runBrowserToolInMain('browser.open_session', { url: 'http://localhost:5173/' }, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId: 'solo' });
    expect(opened.success).toBe(true);
    const id = (opened.data as { sessionId: string }).sessionId;
    for (const [tool, args] of [['browser.click', { x: 1, y: 1 }], ['browser.type', { text: 'a' }], ['browser.evaluate', { script: '1' }]] as const) {
      const res = await runBrowserToolInMain(tool, { sessionId: id, ...args }, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId: 'solo' });
      expect(res.success, tool).toBe(false);
    }
    mark();
    expect((await runBrowserToolInMain('browser.evaluate', { sessionId: id, script: '1' }, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId: 'solo' })).success).toBe(true);
  });

  it('a fixed actor still sees only the sessions it opened', async () => {
    const mine = await runBrowserToolInMain('browser.open_session', { url: 'http://localhost:5173/' }, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId: 'solo' });
    const theirs = await openSession('solo');
    const list = await runBrowserToolInMain('browser.list_sessions', {}, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId: 'solo' });
    const ids = (list.data as { sessionIds: string[] }).sessionIds;
    expect(ids).toEqual([(mine.data as { sessionId: string }).sessionId]);
    expect(ids).not.toContain(theirs);
  });
});

describe('team members lose browser.*; scope applies at execution', () => {
  it.each(['impl', 'full', 'rev', 'reader'])('%s is refused every browser tool and opens nothing', async (sessionId) => {
    mark();
    for (const tool of BROWSER_TOOLS) {
      const res = await run(tool, { url: 'https://example.com', filePath: '/ws/a.html', sessionId: 'agent-browser:x', script: '1', text: 'a', x: 1, y: 1 }, sessionId);
      expect(res.isError, `${sessionId} ${tool}`).toBe(true);
    }
    expect(fakeState.views).toHaveLength(0);
  });

  it('a solo session (no scope, no role) keeps browser.*', async () => {
    expect(await openSession('solo')).toMatch(/^agent-browser:/);
  });

  it('fails closed when the policy cannot be read', async () => {
    setSessionToolPolicyReader(async () => { throw new Error('db down'); });
    resetSessionToolPolicies();
    const res = await run('browser.open_session', { url: 'https://example.com' }, 'solo');
    expect(res.isError).toBe(true);
    expect(fakeState.views).toHaveLength(0);
  });
});

describe('the mark gates LOCAL previews only, for every agent actor (N5)', () => {
  it('solo browser.click / type / evaluate on a non-local site is not gated by the mark (pre-F1.2 behaviour, ownership still enforced)', async () => {
    const id = await openSession('solo', 'https://example.com');
    for (const [tool, args] of [
      ['browser.click', { x: 1, y: 1 }], ['browser.type', { text: 'a' }], ['browser.evaluate', { script: '1' }],
    ] as const) {
      const res = await run(tool, { sessionId: id, ...args });
      expect(res.isError, tool + text(res)).toBe(false);
    }
    // ownership is still enforced on that site
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 }, 'other')).isError).toBe(true);
  });

  it('marking the project never unlocks anything beyond local previews: a marked project does not change the non-local rule', async () => {
    const id = await openSession('solo', 'https://example.com');
    mark();
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 })).isError).toBe(false);
  });

  it('solo browser.click on a nim-preview of an UNMARKED project is refused, even if the caller\'s own project is marked', async () => {
    mark(); // /ws is marked
    const opened = await run('browser.open_local_preview', { filePath: '/unmarked/index.html' });
    expect(opened.isError, text(opened)).toBe(false);
    const id = /(agent-preview:[^\s"]+)/.exec(text(opened))![1];
    const res = await run('browser.click', { sessionId: id, x: 1, y: 1 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/test data/i);
    expect(lastWc().inputs).toEqual([]);
  });

  it('solo browser.click on a nim-preview of the caller\'s marked project is allowed', async () => {
    mark();
    const opened = await run('browser.open_local_preview', { filePath: '/ws/index.html' });
    const id = /(agent-preview:[^\s"]+)/.exec(text(opened))![1];
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 })).isError).toBe(false);
  });

  it('the page is judged at the moment of the call: a session that moved from a site to a local preview becomes gated', async () => {
    const id = await openSession('solo', 'https://example.com');
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 })).isError).toBe(false);
    svc().navigate(id, 'http://localhost:5173/');
    lastWc().loaded.length = 0;
    // the view reports where it now is
    (lastWc() as unknown as { getURL: () => string }).getURL = () => 'http://localhost:5173/';
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 })).isError).toBe(true);
  });
});

describe('extension_test_ai_tool applies the CALLING session\'s policy (N1)', () => {
  const asDevTest = (tool: string, args: Record<string, unknown>, policySessionId?: string) =>
    runBrowserToolInMain(tool, args, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId });

  it.each(['full', 'impl', 'rev', 'reader'])('a team member / scoped session (%s) is refused browser.open_session through it', async (caller) => {
    const res = await asDevTest('browser.open_session', { url: 'http://localhost:5173/' }, caller);
    expect(res.success).toBe(false);
    expect(fakeState.views).toHaveLength(0);
  });

  it('a solo session is allowed', async () => {
    expect((await asDevTest('browser.open_session', { url: 'http://localhost:5173/' }, 'solo')).success).toBe(true);
  });

  it('with no calling session it fails closed', async () => {
    expect((await asDevTest('browser.open_session', { url: 'http://localhost:5173/' }, undefined)).success).toBe(false);
    expect(fakeState.views).toHaveLength(0);
  });

  it('still owns only its own sessions', async () => {
    const mine = await asDevTest('browser.open_session', { url: 'http://localhost:5173/' }, 'solo');
    const solo = await openSession('solo');
    const list = await asDevTest('browser.list_sessions', {}, 'solo');
    expect((list.data as { sessionIds: string[] }).sessionIds).toEqual([(mine.data as { sessionId: string }).sessionId]);
    expect((list.data as { sessionIds: string[] }).sessionIds).not.toContain(solo);
  });
});

describe('every loopback spelling is a local preview for the mark (solo, no mark)', () => {
  it.each([
    'http://app.localhost:5173/',
    'http://127.0.0.2/',
    'http://0.0.0.0:3000/',
    'http://[::ffff:127.0.0.1]/',
  ])('browser.click on %s is refused', async (url) => {
    const id = await openSession('solo', url);
    const res = await run('browser.click', { sessionId: id, x: 1, y: 1 });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/test data/i);
    expect(lastWc().inputs).toEqual([]);
    mark();
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 })).isError).toBe(false);
  });

  it('a look-alike host is still an ordinary site', async () => {
    const id = await openSession('solo', 'http://localhost.evil.com/');
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 })).isError).toBe(false);
  });
});

describe('two projects share a fixed actor: the opening project is recorded and isolates callers (Consultor gap)', () => {
  const LOOPBACK = 'http://localhost:5173/';
  const asDevTest = (tool: string, args: Record<string, unknown>, caller: string, workspacePath: string) =>
    runBrowserToolInMain(tool, args, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath, policySessionId: caller });
  const scripts = () => lastWc().scripts.length;

  it('records the opening project on every agent-opened browser session, from the session record', async () => {
    const solo = await openSession('solo', 'https://example.com');
    expect(svc().getOpenedByProject(solo)).toBe('/ws');
    const b = await openSession('projB');
    expect(svc().getOpenedByProject(b)).toBe('/unmarked');
    const viaTest = await asDevTest('browser.open_session', { url: LOOPBACK }, 'projB', '/wrong-transport-path');
    expect(svc().getOpenedByProject((viaTest.data as { sessionId: string }).sessionId)).toBe('/unmarked');
    const preview = await run('browser.open_local_preview', { filePath: '/ws/index.html' });
    expect(svc().getOpenedByProject(/(agent-preview:[^\s"]+)/.exec(text(preview))![1])).toBe('/ws');
  });

  it('extension-test callers are isolated: the owner key carries the caller', async () => {
    const b = await asDevTest('browser.open_session', { url: LOOPBACK }, 'projB', '/unmarked');
    const bId = (b.data as { sessionId: string }).sessionId;
    expect(svc().getOwner(bId)).toBe(`${EXTENSION_DEV_TEST_ACTOR}:projB`);
  });

  it('B opens a loopback session through extension-test; marked A cannot list it nor click, type or evaluate in it', async () => {
    const b = await asDevTest('browser.open_session', { url: LOOPBACK }, 'projB', '/unmarked');
    expect(b.success).toBe(true);
    const bId = (b.data as { sessionId: string }).sessionId;
    mark(); // project A (/ws) is marked; B is not
    const list = await asDevTest('browser.list_sessions', {}, 'solo', WS);
    expect((list.data as { sessionIds: string[] }).sessionIds).not.toContain(bId);
    const scriptsBefore = scripts();
    for (const [tool, args] of [
      ['browser.click', { x: 1, y: 1 }], ['browser.type', { text: 'a' }], ['browser.evaluate', { script: 'document.cookie' }],
    ] as const) {
      const res = await asDevTest(tool, { sessionId: bId, ...args }, 'solo', WS);
      expect(res.success, tool).toBe(false);
    }
    expect(lastWc().inputs).toEqual([]);
    expect(scripts()).toBe(scriptsBefore);
  });

  it('mobile voice (one shared owner, no caller id): the mark still follows the opening project, not the caller', async () => {
    // B's workspace opens a loopback session as mobile-voice; A (marked) drives it as the same shared owner.
    const opened = await handleExtensionTool('browser.open_session', 'browser.open_session', { url: LOOPBACK }, MOBILE_VOICE_ACTOR, '/unmarked');
    expect(opened.isError, text(opened)).toBe(false);
    const id = /(agent-browser:[^\s"]+)/.exec(text(opened))![1];
    expect(svc().getOwner(id)).toBe(MOBILE_VOICE_ACTOR); // no caller id exists on this path
    expect(svc().getOpenedByProject(id)).toBe('/unmarked');
    mark();
    const scriptsBefore = scripts();
    for (const [tool, args] of [
      ['browser.click', { x: 1, y: 1 }], ['browser.type', { text: 'a' }], ['browser.evaluate', { script: '1' }],
    ] as const) {
      const res = await handleExtensionTool(tool, tool, { sessionId: id, ...args }, MOBILE_VOICE_ACTOR, WS);
      expect(res.isError, tool).toBe(true);
      expect(text(res)).toMatch(/test data/i);
    }
    expect(lastWc().inputs).toEqual([]);
    expect(scripts()).toBe(scriptsBefore);
  });

  it('the marked project\'s own session is still usable (control)', async () => {
    const a = await asDevTest('browser.open_session', { url: LOOPBACK }, 'solo', WS);
    const aId = (a.data as { sessionId: string }).sessionId;
    mark();
    expect((await asDevTest('browser.click', { sessionId: aId, x: 1, y: 1 }, 'solo', WS)).success).toBe(true);
  });

  it('non-local solo behaviour is unchanged by the recorded project: no gate, no unlock', async () => {
    const id = await openSession('projB', 'https://example.com');
    expect((await run('browser.click', { sessionId: id, x: 1, y: 1 }, 'projB')).isError).toBe(false);
    mark();
    expect((await run('browser.evaluate', { sessionId: id, script: '1' }, 'projB')).isError).toBe(false);
  });
});

describe('browser.* needs a declared port on loopback; observing any localhost stays allowed', () => {
  const markWithPorts = (ports: number[]) =>
    stateByProject.set(WS, { portalTestData: { enabled: true, markedAt: 1 }, portalInteractionPorts: ports });

  it('observes localhost:3000 with an unmarked project', async () => {
    const id = await openSession('solo', 'http://localhost:3000/');
    for (const [tool, args] of [['browser.get_page_info', {}], ['browser.screenshot', {}], ['browser.scroll', { dy: 5 }]] as const) {
      expect((await run(tool, { sessionId: id, ...args })).isError, tool).toBe(false);
    }
  });

  it('marked with 5173 declared: :5173 and 127.0.0.1:5173 allowed, :3000 refused with zero inputs and scripts', async () => {
    markWithPorts([5173]);
    const ok1 = await openSession('solo', 'http://localhost:5173/');
    const ok2 = await openSession('solo', 'http://127.0.0.1:5173/');
    expect((await run('browser.click', { sessionId: ok1, x: 1, y: 1 })).isError).toBe(false);
    expect((await run('browser.click', { sessionId: ok2, x: 1, y: 1 })).isError).toBe(false);
    await run('browser.close_session', { sessionId: ok1 });
    await run('browser.close_session', { sessionId: ok2 });
    const bad = await openSession('solo', 'http://localhost:3000/');
    const wc = lastWc();
    const scriptsBefore = wc.scripts.length;
    const inputsBefore = wc.inputs.length;
    for (const [tool, args] of [['browser.click', { x: 1, y: 1 }], ['browser.type', { text: 'a' }], ['browser.evaluate', { script: '1' }]] as const) {
      const res = await run(tool, { sessionId: bad, ...args });
      expect(res.isError, tool).toBe(true);
      expect(text(res)).toMatch(/declared/i);
    }
    expect(wc.inputs.length).toBe(inputsBefore);
    expect(wc.scripts.length).toBe(scriptsBefore);
  });

  it('extension-test and mobile-voice obey the same port rule', async () => {
    markWithPorts([5173]);
    const t = await runBrowserToolInMain('browser.open_session', { url: 'http://localhost:3000/' }, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId: 'solo' });
    const id = (t.data as { sessionId: string }).sessionId;
    expect((await runBrowserToolInMain('browser.click', { sessionId: id, x: 1, y: 1 }, { actor: EXTENSION_DEV_TEST_ACTOR, workspacePath: WS, policySessionId: 'solo' })).success).toBe(false);
    const m = await run('browser.open_session', { url: 'http://localhost:3000/' }, MOBILE_VOICE_ACTOR);
    const mid = /(agent-browser:[^\s"]+)/.exec(text(m))![1];
    expect((await run('browser.click', { sessionId: mid, x: 1, y: 1 }, MOBILE_VOICE_ACTOR)).isError).toBe(true);
  });
});
