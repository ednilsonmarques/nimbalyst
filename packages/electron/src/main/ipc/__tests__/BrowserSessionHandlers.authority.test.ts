// @vitest-environment node
/**
 * Portal F1.1 -- at the IPC boundary an agent is whoever holds a token main
 * issued for the call. The renderer-supplied `actorSessionId` is no longer
 * trusted as an identity: a bare id, a forged or revoked token, or a token of
 * another agent never reaches (or creates) a session.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: any) => Promise<any>>(),
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
// These tests are about identity and ownership; the test-data mark (click/type/evaluate
// for an agent actor) has its own suite, BrowserSessionHandlers.testDataMark.test.ts.
vi.mock('../../services/portalTestData', () => ({ assertAgentMayExercise: async () => undefined, assertAgentMayExerciseOn: async () => undefined }));
vi.mock('../../services/WorktreeStore', () => ({
  createWorktreeStore: () => ({ getByPath: async () => null }),
}));

import { BrowserSessionService } from '../../services/BrowserSessionService';
import { issueActorToken, revokeActorToken, EXTENSION_DEV_TEST_ACTOR, __resetActorTokensForTests } from '../../services/BrowserAuthority';
import { fakeState } from '../../services/__tests__/helpers/fakeElectronBrowser';
import { registerBrowserSessionHandlers } from '../BrowserSessionHandlers';

const AGENT_ID = 'agent-browser:a1';
const EDITOR_ID = 'browser:doc.html:1111';

function call(channel: string, payload: Record<string, unknown>): Promise<any> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({ sender: {} }, payload);
}

const open = (actor: string | undefined, sessionId: string, extra: Record<string, unknown> = {}) =>
  call('browser-session:create', { sessionId, url: 'https://example.com', headless: actor !== undefined, actorSessionId: actor, ...extra });

const SESSION_CHANNELS: Array<[string, Record<string, unknown>]> = [
  ['browser-session:navigate', { url: 'https://example.org' }],
  ['browser-session:reload', {}],
  ['browser-session:go-back', {}],
  ['browser-session:go-forward', {}],
  ['browser-session:screenshot', {}],
  ['browser-session:evaluate', { script: 'document.title' }],
  ['browser-session:get-page-info', {}],
  ['browser-session:click', { selector: '#go' }],
  ['browser-session:type', { selector: '#q', text: 'x' }],
  ['browser-session:scroll', { dy: 100 }],
  ['browser-session:set-bounds', { bounds: { x: 0, y: 0, width: 10, height: 10 } }],
  ['browser-session:detach', {}],
  ['browser-session:destroy', {}],
];

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  __resetActorTokensForTests();
  fakeState.reset();
  handlers.clear();
  registerBrowserSessionHandlers();
});

describe('unattributed or forged agent calls', () => {
  it.each(['ai-session-A', EXTENSION_DEV_TEST_ACTOR, 'unattributed-ai-session', 'nimactor_' + 'f'.repeat(48)])(
    'create with actor %s (not a main-issued token) is refused and opens nothing',
    async (actor) => {
      const res = await open(actor, AGENT_ID);
      expect(res.success).toBe(false);
      expect(fakeState.views).toHaveLength(0);
      expect(BrowserSessionService.getInstance().hasSession(AGENT_ID)).toBe(false);
    },
  );

  it('a revoked token can no longer create', async () => {
    const token = issueActorToken('ai-session-A');
    revokeActorToken(token);
    expect((await open(token, AGENT_ID)).success).toBe(false);
    expect(fakeState.views).toHaveLength(0);
  });

  it('list-sessions with a bare id is refused rather than answered as the user', async () => {
    await open(undefined, EDITOR_ID, { headless: false });
    const res = await call('browser-session:list-sessions', { actorSessionId: 'ai-session-A' });
    expect(res.success).toBe(false);
    expect(res.sessionIds).toBeUndefined();
  });

  it.each(SESSION_CHANNELS)('%s with a bare session id cannot act on the user session', async (channel, extra) => {
    await open(undefined, EDITOR_ID, { headless: false });
    const view = fakeState.views[0];
    const res = await call(channel, { sessionId: EDITOR_ID, actorSessionId: 'ai-session-A', ...extra });
    expect(res.success).toBe(false);
    expect(view.webContents.loaded).toEqual(['https://example.com']);
    expect(view.webContents.scripts).toEqual([]);
    expect(view.webContents.inputs).toEqual([]);
    expect(view.webContents.closed).toBe(false);
  });

  it.each(SESSION_CHANNELS)('%s with a bare session id cannot act on that agent\'s own session either', async (channel, extra) => {
    const token = issueActorToken('ai-session-A');
    expect((await open(token, AGENT_ID)).success).toBe(true);
    const view = fakeState.views[0];
    const scriptsBefore = view.webContents.scripts.length;
    const res = await call(channel, { sessionId: AGENT_ID, actorSessionId: 'ai-session-A', ...extra });
    expect(res.success).toBe(false);
    expect(view.webContents.scripts.length).toBe(scriptsBefore);
    expect(view.webContents.inputs).toEqual([]);
    expect(view.webContents.closed).toBe(false);
  });
});

describe('a main-issued token', () => {
  it('opens a session owned by the real actor id, not by the token', async () => {
    const token = issueActorToken('ai-session-A');
    expect((await open(token, AGENT_ID)).success).toBe(true);
    expect(BrowserSessionService.getInstance().getOwner(AGENT_ID)).toBe('ai-session-A');
  });

  it('lets the same agent act with a later token and lists only its sessions', async () => {
    expect((await open(issueActorToken('ai-session-A'), AGENT_ID)).success).toBe(true);
    await open(undefined, EDITOR_ID, { headless: false });
    const res = await call('browser-session:list-sessions', { actorSessionId: issueActorToken('ai-session-A') });
    expect(res.sessionIds).toEqual([AGENT_ID]);
    const nav = await call('browser-session:navigate', {
      sessionId: AGENT_ID,
      url: 'https://example.org',
      actorSessionId: issueActorToken('ai-session-A'),
    });
    expect(nav.success).toBe(true);
  });

  it("does not let another agent's token reach it, including the extension-test actor", async () => {
    expect((await open(issueActorToken('ai-session-A'), AGENT_ID)).success).toBe(true);
    for (const other of ['ai-session-B', EXTENSION_DEV_TEST_ACTOR]) {
      const token = issueActorToken(other);
      for (const [channel, extra] of SESSION_CHANNELS) {
        const res = await call(channel, { sessionId: AGENT_ID, actorSessionId: token, ...extra });
        expect(res.success, `${other} ${channel}`).toBe(false);
      }
    }
    expect(BrowserSessionService.getInstance().hasSession(AGENT_ID)).toBe(true);
    const view = fakeState.views[0];
    expect(view.webContents.scripts).toEqual([]);
    expect(view.webContents.closed).toBe(false);
  });

  it('keeps the extension-test actor working on its own sessions only', async () => {
    const token = issueActorToken(EXTENSION_DEV_TEST_ACTOR);
    expect((await open(token, 'agent-browser:dev')).success).toBe(true);
    expect(BrowserSessionService.getInstance().getOwner('agent-browser:dev')).toBe(EXTENSION_DEV_TEST_ACTOR);
  });
});

describe('partitions over IPC', () => {
  it.each(['preview', 'browser-preview', 'persist:work'])('an agent asking for %s is refused', async (partition) => {
    const res = await open(issueActorToken('ai-session-A'), AGENT_ID, { partition });
    expect(res.success).toBe(false);
    expect(fakeState.views).toHaveLength(0);
  });

  it('an agent portal is created on a main-chosen partition, never browser-preview', async () => {
    await open(issueActorToken('ai-session-A'), AGENT_ID);
    expect([...fakeState.sessions.keys()]).not.toContain('browser-preview');
    expect(BrowserSessionService.getInstance().getPartitionName(AGENT_ID)).toMatch(/^agent-portal-/);
  });
});

describe("the user's UI is unchanged", () => {
  it('opens, lists and drives any session with no actor', async () => {
    expect((await open(undefined, EDITOR_ID, { headless: false })).success).toBe(true);
    expect((await open(issueActorToken('ai-session-A'), AGENT_ID)).success).toBe(true);
    const list = await call('browser-session:list-sessions', {});
    expect(list.sessionIds.sort()).toEqual([AGENT_ID, EDITOR_ID].sort());
    expect((await call('browser-session:navigate', { sessionId: EDITOR_ID, url: 'https://example.org' })).success).toBe(true);
    expect(BrowserSessionService.getInstance().getPartitionName(EDITOR_ID)).toBe('browser-preview');
  });
});
