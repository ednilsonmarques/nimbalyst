// @vitest-environment node
/**
 * Portal F1.1 (post-review) -- at most 2 open portals per agent, and every path
 * that ends an agent portal (close, idle reaper, host-window close, a failed
 * create) wipes its storage, releases its handlers and drops it from the
 * main-side registry. Electron has no public API to destroy a Session, so the
 * registry is what makes "released" observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { protocolHook } = vi.hoisted(() => ({ protocolHook: { fail: false } }));

vi.mock('electron', async () => (await import('./helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../protocols/nimPreviewProtocol', () => ({
  ensureNimPreviewProtocolForSession: vi.fn(() => {
    if (protocolHook.fail) throw new Error('protocol setup failed');
  }),
}));

import { BrowserSessionService } from '../BrowserSessionService';
import {
  agentPartitionCount,
  MAX_PORTALS_PER_AGENT,
  releaseAgentPartition,
  __resetAgentPartitionsForTests,
} from '../BrowserAuthority';
import { fakeState, FakeBrowserWindow, FakeSession, FakeWebContents } from './helpers/fakeElectronBrowser';

const svc = () => BrowserSessionService.getInstance();

function openAgent(id: string, owner: string, headless = true) {
  svc().createSession({ sessionId: id, url: 'https://example.com', headless, ownerSessionId: owner });
  const name = svc().getPartitionName(id)!;
  return fakeState.sessions.get(name) as FakeSession;
}

/**
 * Released = data wiped and registry entry dropped. The deny-all handlers and the
 * download-cancel listener stay on the Session for its whole life: Electron
 * cannot destroy it, and without handlers it would fall back to allow and save.
 */
function expectReleased(ses: FakeSession) {
  expect(ses.storageCleared).toBe(1);
  expect(ses.requestHandler).not.toBeNull();
  expect(ses.checkHandler).not.toBeNull();
  expect(ses.deviceHandler).not.toBeNull();
  const wc = fakeState.views[0]?.webContents ?? {};
  expect(ses.request('geolocation', {}, wc)).toBe(false);
  expect(ses.check('geolocation', {}, null)).toBe(false);
  expect(ses.check('media', { mediaType: 'audio' }, null)).toBe(false);
  expect(ses.deviceHandler?.({})).toBe(false);
  const event = { preventDefault: vi.fn() };
  ses.emit('will-download', event, {}, wc);
  expect(event.preventDefault).toHaveBeenCalled();
}

beforeEach(() => {
  protocolHook.fail = false;
  BrowserSessionService.__resetForTests();
  __resetAgentPartitionsForTests();
  fakeState.reset();
});
afterEach(() => vi.useRealTimers());

describe('portal cap', () => {
  it('is 2 per agent', () => expect(MAX_PORTALS_PER_AGENT).toBe(2));

  it('refuses the third create, with a clear message, and opens nothing', () => {
    openAgent('agent-browser:1', 'ai-session-A');
    openAgent('agent-browser:2', 'ai-session-A');
    const views = fakeState.views.length;
    expect(() =>
      svc().createSession({ sessionId: 'agent-browser:3', url: 'https://example.com', headless: true, ownerSessionId: 'ai-session-A' }),
    ).toThrow(/at most 2 open browser portals/i);
    expect(fakeState.views.length).toBe(views);
    expect(svc().hasSession('agent-browser:3')).toBe(false);
    expect(agentPartitionCount()).toBe(2);
  });

  it('allows a new one after one closes', () => {
    openAgent('agent-browser:1', 'ai-session-A');
    openAgent('agent-browser:2', 'ai-session-A');
    svc().destroySession('agent-browser:1');
    expect(() => openAgent('agent-browser:3', 'ai-session-A')).not.toThrow();
  });

  it('counts per agent: another agent and the user are not limited by it', () => {
    openAgent('agent-browser:1', 'ai-session-A');
    openAgent('agent-browser:2', 'ai-session-A');
    expect(() => openAgent('agent-browser:3', 'ai-session-B')).not.toThrow();
    for (let i = 0; i < 4; i++) svc().createSession({ sessionId: `browser:doc:${i}`, url: 'about:blank' });
    expect(svc().listSessions().length).toBe(7);
  });

  it('re-creating an existing portal at the cap is the idempotent no-op it always was', () => {
    openAgent('agent-browser:1', 'ai-session-A');
    openAgent('agent-browser:2', 'ai-session-A');
    expect(() => openAgent('agent-browser:2', 'ai-session-A')).not.toThrow();
  });
});

describe('agent portal cleanup', () => {
  it('wipes, releases handlers and leaves the registry on close', () => {
    const ses = openAgent('agent-browser:1', 'ai-session-A');
    expect(agentPartitionCount()).toBe(1);
    svc().destroySession('agent-browser:1');
    expectReleased(ses);
    expect(agentPartitionCount()).toBe(0);
  });

  it('collects an idle agent portal that is NOT headless, via the reaper', () => {
    vi.useFakeTimers();
    const ses = openAgent('agent-browser:1', 'ai-session-A', false);
    vi.advanceTimersByTime(5 * 60 * 1000 + 60 * 1000);
    expect(svc().hasSession('agent-browser:1')).toBe(false);
    expectReleased(ses);
    expect(agentPartitionCount()).toBe(0);
  });

  it('collects an idle headless agent portal via the reaper', () => {
    vi.useFakeTimers();
    const ses = openAgent('agent-browser:1', 'ai-session-A', true);
    vi.advanceTimersByTime(5 * 60 * 1000 + 60 * 1000);
    expect(svc().hasSession('agent-browser:1')).toBe(false);
    expectReleased(ses);
  });

  it('never reaps the global user tabs, however idle', () => {
    vi.useFakeTimers();
    svc().createSession({ sessionId: 'browser:doc:1', url: 'about:blank' });
    openAgent('agent-browser:1', 'ai-session-A', false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(svc().hasSession('browser:doc:1')).toBe(true);
    expect(svc().hasSession('agent-browser:1')).toBe(false);
  });

  it('keeps an agent portal that is in use', () => {
    vi.useFakeTimers();
    openAgent('agent-browser:1', 'ai-session-A', false);
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(2 * 60 * 1000);
      svc().reload('agent-browser:1');
    }
    expect(svc().hasSession('agent-browser:1')).toBe(true);
  });

  it('cleans up when the host window closes', () => {
    const ses = openAgent('agent-browser:1', 'ai-session-A', false);
    const win = new FakeBrowserWindow();
    svc().attachToWindow('agent-browser:1', win as any, { x: 0, y: 0, width: 10, height: 10 });
    win.fireClosed();
    expect(svc().hasSession('agent-browser:1')).toBe(false);
    expectReleased(ses);
    expect(agentPartitionCount()).toBe(0);
  });

  it('cleans up when create fails after the partition was created', () => {
    protocolHook.fail = true;
    expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/protocol setup failed/);
    const [ses] = [...fakeState.sessions.values()] as FakeSession[];
    expectReleased(ses);
    expect(svc().hasSession('agent-browser:1')).toBe(false);
    expect(agentPartitionCount()).toBe(0);
    // and the slot is not leaked: two portals still fit
    protocolHook.fail = false;
    openAgent('agent-browser:2', 'ai-session-A');
    openAgent('agent-browser:3', 'ai-session-A');
  });

  it('a successful create keeps its storage: nothing is wiped or released', () => {
    const ses = openAgent('agent-browser:1', 'ai-session-A');
    expect(ses.storageCleared).toBe(0);
    expect(agentPartitionCount()).toBe(1);
    expect(svc().hasSession('agent-browser:1')).toBe(true);
  });

  it('a failed create leaves another portal (same agent, other agent, user tab) untouched', () => {
    const own = openAgent('agent-browser:1', 'ai-session-A');
    const other = openAgent('agent-browser:2', 'ai-session-B');
    svc().createSession({ sessionId: 'browser:doc:1', url: 'about:blank' });
    const user = fakeState.sessions.get('browser-preview') as FakeSession;
    protocolHook.fail = true;
    expect(() => openAgent('agent-browser:3', 'ai-session-A')).toThrow(/protocol setup failed/);
    expect(own.storageCleared).toBe(0);
    expect(other.storageCleared).toBe(0);
    expect(user.storageCleared).toBe(0);
    expect(agentPartitionCount()).toBe(2);
    expect(svc().hasSession('agent-browser:1')).toBe(true);
    expect(svc().hasSession('agent-browser:2')).toBe(true);
    expect(svc().hasSession('browser:doc:1')).toBe(true);
    expect(svc().hasSession('agent-browser:3')).toBe(false);
  });

  it('cleanup is idempotent: destroying a failed create again wipes nothing twice', () => {
    protocolHook.fail = true;
    expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/protocol setup failed/);
    const [ses] = [...fakeState.sessions.values()] as FakeSession[];
    svc().destroySession('agent-browser:1');
    releaseAgentPartition([...fakeState.sessions.keys()][0]);
    expect(ses.storageCleared).toBe(1);
    expect(agentPartitionCount()).toBe(0);
  });

  it('a wipe that rejects does not mask the create error and is not an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      vi.spyOn(FakeSession.prototype, 'clearStorageData').mockImplementation(() => Promise.reject(new Error('wipe rejected')));
      protocolHook.fail = true;
      expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/protocol setup failed/);
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(agentPartitionCount()).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
      vi.restoreAllMocks();
    }
  });

  it('a failure after the headless host window exists removes the session, the view and the host window', () => {
    vi.spyOn(FakeBrowserWindow.prototype, 'getContentSize').mockImplementation(() => {
      throw new Error('attach failed');
    });
    const destroy = vi.spyOn(FakeBrowserWindow.prototype, 'destroy');
    try {
      expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/attach failed/);
      const [ses] = [...fakeState.sessions.values()] as FakeSession[];
      expect(ses.storageCleared).toBe(1);
      expect(agentPartitionCount()).toBe(0);
      expect(svc().hasSession('agent-browser:1')).toBe(false);
      expect(fakeState.views[0].webContents.closed).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(fakeState.windows[0].children).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  describe('when the rest of the teardown throws during a failed create', () => {
    afterEach(() => vi.restoreAllMocks());
    const failAttach = () =>
      vi.spyOn(FakeBrowserWindow.prototype, 'getContentSize').mockImplementation(() => {
        throw new Error('attach failed');
      });

    it('reports the ORIGINAL create error when destroying the host window throws', () => {
      failAttach();
      vi.spyOn(FakeBrowserWindow.prototype, 'destroy').mockImplementation(() => {
        throw new Error('host destroy exploded');
      });
      expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/attach failed/);
      const [ses] = [...fakeState.sessions.values()] as FakeSession[];
      expect(svc().hasSession('agent-browser:1')).toBe(false);
      expect(agentPartitionCount()).toBe(0);
      expect(ses.storageCleared).toBe(1);
    });

    it('a failed headless USER create with a throwing host destroy keeps the original error and the shared partition', () => {
      failAttach();
      vi.spyOn(FakeBrowserWindow.prototype, 'destroy').mockImplementation(() => {
        throw new Error('host destroy exploded');
      });
      expect(() =>
        svc().createSession({ sessionId: 'browser:doc:1', url: 'about:blank', headless: true }),
      ).toThrow(/attach failed/);
      const user = fakeState.sessions.get('browser-preview') as FakeSession;
      expect(svc().hasSession('browser:doc:1')).toBe(false);
      expect(user.storageCleared).toBe(0);
      expect(agentPartitionCount()).toBe(0);
    });

    it('reports the ORIGINAL create error when webContents.close throws', () => {
      failAttach();
      vi.spyOn(FakeWebContents.prototype, 'close').mockImplementation(() => {
        throw new Error('close exploded');
      });
      expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/attach failed/);
      expect(svc().hasSession('agent-browser:1')).toBe(false);
      expect(agentPartitionCount()).toBe(0);
    });
  });

  describe('when the wipe itself throws synchronously', () => {
    afterEach(() => vi.restoreAllMocks());
    const breakWipe = () =>
      vi.spyOn(FakeSession.prototype, 'clearStorageData').mockImplementation(() => {
        throw new Error('wipe exploded');
      });

    it('reports the ORIGINAL create error, not the cleanup error (before the view exists)', () => {
      breakWipe();
      protocolHook.fail = true;
      expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/protocol setup failed/);
      expect(agentPartitionCount()).toBe(0);
    });

    it('reports the ORIGINAL create error and still tears down view, host window and registry (after the view exists)', () => {
      breakWipe();
      vi.spyOn(FakeBrowserWindow.prototype, 'getContentSize').mockImplementation(() => {
        throw new Error('attach failed');
      });
      const destroy = vi.spyOn(FakeBrowserWindow.prototype, 'destroy');
      expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow(/attach failed/);
      expect(svc().hasSession('agent-browser:1')).toBe(false);
      expect(fakeState.views[0].webContents.closed).toBe(true);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(agentPartitionCount()).toBe(0);
    });

    it('does not leak the portal slot: the agent can still open two portals', () => {
      breakWipe();
      protocolHook.fail = true;
      expect(() => openAgent('agent-browser:1', 'ai-session-A')).toThrow();
      vi.restoreAllMocks();
      protocolHook.fail = false;
      openAgent('agent-browser:2', 'ai-session-A');
      openAgent('agent-browser:3', 'ai-session-A');
    });
  });

  it('a failed user create does not touch the registry or wipe anything', () => {
    protocolHook.fail = true;
    expect(() => svc().createSession({ sessionId: 'browser:doc:1', url: 'about:blank' })).toThrow();
    const ses = fakeState.sessions.get('browser-preview') as FakeSession;
    expect(ses.storageCleared).toBe(0);
  });

  it('returns the registry to 0 after N open/close cycles', () => {
    for (let i = 0; i < 25; i++) {
      openAgent(`agent-browser:${i}`, 'ai-session-A');
      expect(agentPartitionCount()).toBe(1);
      svc().destroySession(`agent-browser:${i}`);
    }
    expect(agentPartitionCount()).toBe(0);
    for (const ses of fakeState.sessions.values()) expectReleased(ses as FakeSession);
  });

  it('cleanup() releases every agent portal', () => {
    openAgent('agent-browser:1', 'ai-session-A');
    openAgent('agent-browser:2', 'ai-session-B');
    svc().cleanup();
    expect(agentPartitionCount()).toBe(0);
  });
});
