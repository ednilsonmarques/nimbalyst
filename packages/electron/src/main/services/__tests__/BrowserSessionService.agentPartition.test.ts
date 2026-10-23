// @vitest-environment node
/**
 * Portal F1.1 -- every agent portal gets a partition chosen by main: fresh,
 * in-memory, never a user partition. Across agent partitions every permission,
 * download and popup forward is denied; the user's own tabs are unchanged.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../protocols/nimPreviewProtocol', () => ({
  ensureNimPreviewProtocolForSession: vi.fn(),
}));

import { BrowserSessionService } from '../BrowserSessionService';
import { fakeState, type FakeSession } from './helpers/fakeElectronBrowser';

const PERMISSIONS = ['geolocation', 'notifications', 'clipboard-read', 'midi', 'fullscreen', 'openExternal', 'media'];
const realPlatform = process.platform;
const setPlatform = (platform: string) =>
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

const svc = () => BrowserSessionService.getInstance();

function openAgent(id: string, owner: string) {
  svc().createSession({ sessionId: id, url: 'https://example.com', headless: true, ownerSessionId: owner });
  const view = fakeState.views[fakeState.views.length - 1];
  const name = svc().getPartitionName(id)!;
  return { name, ses: fakeState.sessions.get(name) as FakeSession, wc: view.webContents };
}

function openUser(id = 'browser:doc.html:1') {
  svc().createSession({ sessionId: id, url: 'about:blank' });
  const view = fakeState.views[fakeState.views.length - 1];
  return { ses: fakeState.sessions.get('browser-preview') as FakeSession, wc: view.webContents };
}

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  fakeState.reset();
  setPlatform('darwin');
});
afterAll(() => setPlatform(realPlatform));

describe('partition choice', () => {
  it('gives each agent portal its own fresh non-persistent partition, never browser-preview', () => {
    const a1 = openAgent('agent-browser:1', 'ai-session-A');
    const a2 = openAgent('agent-browser:2', 'ai-session-A');
    const b1 = openAgent('agent-browser:3', 'ai-session-B');
    const names = [a1.name, a2.name, b1.name];
    expect(new Set(names).size).toBe(3);
    for (const n of names) {
      expect(n).not.toBe('browser-preview');
      expect(n.startsWith('persist:')).toBe(false);
    }
    expect(a1.ses).not.toBe(a2.ses);
    expect(fakeState.sessions.has('browser-preview')).toBe(false);
  });

  it('refuses an agent that asks for a partition (user, persisted or any other)', () => {
    for (const partition of ['preview', 'browser-preview', 'persist:work', 'anything']) {
      expect(() =>
        svc().createSession({
          sessionId: `agent-browser:${partition}`,
          url: 'https://example.com',
          partition,
          headless: true,
          ownerSessionId: 'ai-session-A',
        }),
      ).toThrow(/partition/i);
    }
    expect(fakeState.views).toHaveLength(0);
  });

  it("keeps the user's partition choice as today", () => {
    svc().createSession({ sessionId: 'browser:a', url: 'about:blank' });
    svc().createSession({ sessionId: 'browser:b', url: 'about:blank', partition: 'persist:work' });
    expect([...fakeState.sessions.keys()].sort()).toEqual(['browser-preview', 'persist:work']);
    expect(svc().getPartitionName('browser:a')).toBe('browser-preview');
  });

  it('does not leak cookies between agent portals or into the user partition', async () => {
    const a = openAgent('agent-browser:1', 'ai-session-A');
    const b = openAgent('agent-browser:2', 'ai-session-B');
    const user = openUser();
    await a.ses.cookies.set({ name: 'sid', value: 'secret-A' });
    expect(await b.ses.cookies.get()).toEqual([]);
    expect(await user.ses.cookies.get()).toEqual([]);
    expect(await a.ses.cookies.get()).toEqual([{ name: 'sid', value: 'secret-A' }]);
  });

  it('wipes the portal storage when the agent portal is destroyed', () => {
    const a = openAgent('agent-browser:1', 'ai-session-A');
    svc().destroySession('agent-browser:1');
    expect(a.ses.storageCleared).toBe(1);
  });

  it("does not wipe the user's storage when a user tab is destroyed", () => {
    const user = openUser();
    svc().destroySession('browser:doc.html:1');
    expect(user.ses.storageCleared).toBe(0);
  });
});

describe('agent partitions deny every permission', () => {
  it.each(PERMISSIONS)('denies %s (request and check)', (permission) => {
    const { ses, wc } = openAgent('agent-browser:1', 'ai-session-A');
    expect(ses.request(permission, {}, wc)).toBe(false);
    expect(ses.check(permission, {}, wc)).toBe(false);
  });

  it.each(['darwin', 'win32', 'linux'])('denies the microphone on %s too', (platform) => {
    setPlatform(platform);
    const { ses, wc } = openAgent('agent-browser:1', 'ai-session-A');
    expect(ses.request('media', { mediaTypes: ['audio'] }, wc)).toBe(false);
    expect(ses.request('audioCapture', {}, wc)).toBe(false);
    expect(ses.check('media', { mediaType: 'audio' }, wc)).toBe(false);
  });

  it('denies a check that arrives with a null webContents', () => {
    const { ses } = openAgent('agent-browser:1', 'ai-session-A');
    expect(ses.check('geolocation', {}, null)).toBe(false);
    expect(ses.check('media', { mediaType: 'audio' }, null)).toBe(false);
    expect(ses.request('geolocation', {}, null)).toBe(false);
  });

  it('denies device permissions', () => {
    const { ses } = openAgent('agent-browser:1', 'ai-session-A');
    expect(ses.deviceHandler?.({})).toBe(false);
  });
});

describe('agent partitions deny downloads and popup forwarding', () => {
  it('cancels every download, whatever web contents reports it', () => {
    const { ses } = openAgent('agent-browser:1', 'ai-session-A');
    for (const wc of [fakeState.views[0].webContents, null, {}]) {
      const event = { preventDefault: vi.fn() };
      ses.emit('will-download', event, {}, wc);
      expect(event.preventDefault).toHaveBeenCalled();
    }
  });

  it('denies a popup and never forwards it to the external browser', () => {
    const forwarded: string[] = [];
    svc().on('external-navigation-requested', (p: { url: string }) => forwarded.push(p.url));
    const { wc } = openAgent('agent-browser:1', 'ai-session-A');
    expect(wc.windowOpenHandler!({ url: 'https://example.com/next' })).toEqual({ action: 'deny' });
    expect(forwarded).toEqual([]);
  });
});

describe("the user's own tabs are unchanged", () => {
  it('keeps allow-by-default permissions and downloads', () => {
    const { ses, wc } = openUser();
    for (const permission of ['geolocation', 'notifications', 'clipboard-read']) {
      expect(ses.request(permission, {}, wc)).toBe(true);
      expect(ses.check(permission, {}, wc)).toBe(true);
    }
    const event = { preventDefault: vi.fn() };
    ses.emit('will-download', event, {}, wc);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('still forwards an allowed popup URL externally', () => {
    const forwarded: string[] = [];
    svc().on('external-navigation-requested', (p: { url: string }) => forwarded.push(p.url));
    const { wc } = openUser();
    wc.windowOpenHandler!({ url: 'https://example.com/next' });
    expect(forwarded).toEqual(['https://example.com/next']);
  });

  it('is not affected by an agent portal opening next to it', () => {
    const user = openUser();
    openAgent('agent-browser:1', 'ai-session-A');
    expect(user.ses.request('geolocation', {}, user.wc)).toBe(true);
  });
});
