// @vitest-environment node
/**
 * Portal F1.2 -- the browser IPC also enforces the test-data mark for any agent
 * actor (a main-issued token): click, type and evaluate need the mark of the
 * project the token was issued for. The user's own UI (no actor) is unchanged,
 * and a token with no project fails closed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, stateByProject } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: any) => Promise<any>>(),
  stateByProject: new Map<string, Record<string, unknown>>(),
}));

vi.mock('electron', async () => (await import('../../services/__tests__/helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: unknown, payload: any) => Promise<any>) => {
    handlers.set(channel, fn);
  },
}));
vi.mock('../../protocols/nimPreviewProtocol', () => ({
  ensureNimPreviewProtocolForSession: vi.fn(),
  getNimPreviewWorkspaceRoots: () => [],
  encodeNimPreviewUrl: () => '',
  previewPathsEqual: () => false,
  previewPathInsideRoot: () => false,
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({}) }));
vi.mock('../../services/WorktreeStore', () => ({
  createWorktreeStore: () => ({ getByPath: async () => null }),
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
vi.mock('../../services/PermissionService', () => ({
  resolveWorkspacePathForPermissions: async (p: string) => p,
}));
vi.mock('../../window/WindowManager', () => ({ findWorkspaceWindowMatch: () => null }));

import { BrowserSessionService } from '../../services/BrowserSessionService';
import { issueActorToken, EXTENSION_DEV_TEST_ACTOR, __resetActorTokensForTests } from '../../services/BrowserAuthority';
import { fakeState } from '../../services/__tests__/helpers/fakeElectronBrowser';
import { registerBrowserSessionHandlers } from '../BrowserSessionHandlers';

const WS = '/ws';
const call = (channel: string, payload: Record<string, unknown>) => handlers.get(channel)!({ sender: {} }, payload);
const mark = () => stateByProject.set(WS, { portalTestData: { enabled: true, markedAt: 1 }, portalInteractionPorts: [80, 3000, 5173, 8080] });

const EXERCISE: Array<[string, Record<string, unknown>]> = [
  ['browser-session:click', { selector: '#go' }],
  ['browser-session:type', { selector: '#q', text: 'x' }],
  ['browser-session:evaluate', { script: '1' }],
];

async function agentSession(workspacePath: string | undefined, url = 'http://localhost:5173/') {
  const token = issueActorToken(EXTENSION_DEV_TEST_ACTOR, undefined, workspacePath ? { workspacePath } : undefined);
  const res = await call('browser-session:create', { sessionId: 'agent-browser:1', url, headless: true, actorSessionId: token });
  expect(res.success, JSON.stringify(res)).toBe(true);
  return token;
}

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  __resetActorTokensForTests();
  fakeState.reset();
  handlers.clear();
  stateByProject.clear();
  registerBrowserSessionHandlers();
});

describe('agent actors need the mark to click, type or evaluate', () => {
  it.each(EXERCISE)('%s is refused without the mark and reaches nothing', async (channel, extra) => {
    const token = await agentSession(WS);
    const wc = fakeState.views[0].webContents;
    const scripts = wc.scripts.length;
    const res = await call(channel, { sessionId: 'agent-browser:1', actorSessionId: token, ...extra });
    expect(res.success).toBe(false);
    expect(String(res.error)).toMatch(/test data/i);
    expect(wc.inputs).toEqual([]);
    expect(wc.scripts.length).toBe(scripts);
  });

  it.each(EXERCISE)('%s works with the mark', async (channel, extra) => {
    const token = await agentSession(WS);
    mark();
    const res = await call(channel, { sessionId: 'agent-browser:1', actorSessionId: token, ...extra });
    expect(res.success, JSON.stringify(res)).toBe(true);
  });

  it.each(EXERCISE)('%s fails closed when the token carries no project', async (channel, extra) => {
    const token = await agentSession(undefined);
    mark();
    const res = await call(channel, { sessionId: 'agent-browser:1', actorSessionId: token, ...extra });
    expect(res.success).toBe(false);
  });

  it('observation and navigation are not gated', async () => {
    const token = await agentSession(WS);
    for (const [channel, extra] of [
      ['browser-session:get-page-info', {}], ['browser-session:screenshot', {}], ['browser-session:scroll', { dy: 1 }],
      ['browser-session:navigate', { url: 'https://example.org' }],
    ] as const) {
      const res = await call(channel, { sessionId: 'agent-browser:1', actorSessionId: token, ...extra });
      expect(res.success, channel + JSON.stringify(res)).toBe(true);
    }
  });
});

describe('the mark gates local previews only (N5)', () => {
  it.each(EXERCISE)('%s on a non-local site is not gated, with or without the mark', async (channel, extra) => {
    const token = await agentSession(WS, 'https://example.com');
    const res = await call(channel, { sessionId: 'agent-browser:1', actorSessionId: token, ...extra });
    expect(res.success, JSON.stringify(res)).toBe(true);
  });

  it.each(EXERCISE)('%s on a nim-preview page is checked against the project that page serves', async (channel, extra) => {
    const unmarked = 'nim-preview://' + Buffer.from('/unmarked').toString('hex') + '/index.html';
    const token = await agentSession(WS, unmarked);
    mark(); // the token's own project is marked; the page belongs to another one
    const res = await call(channel, { sessionId: 'agent-browser:1', actorSessionId: token, ...extra });
    expect(res.success).toBe(false);
  });
});

describe('the opening project is recorded; a token of another project cannot borrow its own mark (Consultor gap)', () => {
  it.each(EXERCISE)('%s with a marked project token on a loopback session opened for an unmarked project is refused', async (channel, extra) => {
    const opener = issueActorToken(EXTENSION_DEV_TEST_ACTOR, undefined, { workspacePath: '/unmarked' });
    const created = await call('browser-session:create', { sessionId: 'agent-browser:1', url: 'http://localhost:5173/', headless: true, actorSessionId: opener });
    expect(created.success).toBe(true);
    mark(); // /ws marked, /unmarked not
    const borrower = issueActorToken(EXTENSION_DEV_TEST_ACTOR, undefined, { workspacePath: WS });
    const wc = fakeState.views[0].webContents;
    const scripts = wc.scripts.length;
    const res = await call(channel, { sessionId: 'agent-browser:1', actorSessionId: borrower, ...extra });
    expect(res.success).toBe(false);
    expect(wc.inputs).toEqual([]);
    expect(wc.scripts.length).toBe(scripts);
  });
});

describe("the user's own UI is unchanged", () => {
  it.each(EXERCISE)('%s with no actor needs no mark', async (channel, extra) => {
    await call('browser-session:create', { sessionId: 'browser:doc.html:1', url: 'about:blank' });
    const res = await call(channel, { sessionId: 'browser:doc.html:1', ...extra });
    expect(res.success, JSON.stringify(res)).toBe(true);
  });
});
