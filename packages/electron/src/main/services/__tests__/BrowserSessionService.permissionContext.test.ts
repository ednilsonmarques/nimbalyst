// @vitest-environment node
/**
 * Permission decisions when the requesting web contents cannot be identified
 * (NIB.116 item 2). Chromium passes a null `webContents` to some permission
 * checks, and a request can name contents that are gone or were never ours.
 *
 * Agent portals must deny in every such case: their partition is locked down
 * as a whole, so the decision never depends on finding the requester. The
 * user's own tabs keep Electron's allow-by-default answer, and a null
 * requester there gets exactly the answer a known user tab gets.
 *
 * `fromPartition` is wrapped to run the same microphone gate that index.ts
 * installs from `app.on('session-created')`, which fires before the service
 * applies its own handlers to a new partition.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

import { session as electronSession } from 'electron';
import { BrowserSessionService } from '../BrowserSessionService';
import { isAgentPartitionName, __resetAgentPartitionsForTests } from '../BrowserAuthority';
import { installMicrophoneGate } from '../../mediaPermissionGate';
import { fakeState, FakeBrowserWindow, FakeSession, FakeWebContents } from './helpers/fakeElectronBrowser';

const NON_AUDIO = ['geolocation', 'notifications', 'clipboard-read', 'midi', 'fullscreen', 'openExternal'];
const realPlatform = process.platform;
const setPlatform = (platform: string) =>
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

const svc = () => BrowserSessionService.getInstance();
const sessionApi = electronSession as unknown as { fromPartition: (name: string) => FakeSession };
const originalFromPartition = sessionApi.fromPartition;

/** Mirrors index.ts: every new non-default session gets the deny-audio gate first. */
function emulateSessionCreatedHook(): void {
  sessionApi.fromPartition = (name: string) => {
    const isNew = !fakeState.sessions.has(name);
    const ses = originalFromPartition(name);
    if (isNew) installMicrophoneGate(ses as never, { allowWhenGranted: false, label: name });
    return ses;
  };
}

function openAgent(id: string, owner = 'ai-session-A') {
  svc().createSession({ sessionId: id, url: 'https://example.com', headless: true, ownerSessionId: owner });
  const view = fakeState.views[fakeState.views.length - 1];
  const name = svc().getPartitionName(id)!;
  return { name, ses: fakeState.sessions.get(name) as FakeSession, wc: view.webContents };
}

function openUser(id = 'browser:doc.html:1', partition?: string) {
  svc().createSession({ sessionId: id, url: 'about:blank', partition });
  const view = fakeState.views[fakeState.views.length - 1];
  const name = svc().getPartitionName(id)!;
  return { name, ses: fakeState.sessions.get(name) as FakeSession, wc: view.webContents };
}

/** Every way of naming the requester: unknown, foreign, missing. */
function requesters(own: unknown): Array<[string, unknown]> {
  return [
    ['its own web contents', own],
    ['null', null],
    ['undefined', undefined],
    ['web contents no portal owns', new FakeWebContents()],
  ];
}

function expectDeniesEverything(ses: FakeSession, own: unknown): void {
  for (const [label, wc] of requesters(own)) {
    for (const permission of NON_AUDIO) {
      expect(ses.request(permission, {}, wc), `request ${permission} from ${label}`).toBe(false);
      expect(ses.check(permission, {}, wc), `check ${permission} from ${label}`).toBe(false);
    }
    expect(ses.request('media', { mediaTypes: ['audio', 'video'] }, wc), `request media from ${label}`).toBe(false);
    expect(ses.check('media', { mediaType: 'video' }, wc), `check video from ${label}`).toBe(false);
    expect(ses.check('audioCapture', {}, wc), `check audioCapture from ${label}`).toBe(false);
    expect(ses.deviceHandler?.({ deviceType: 'usb' }), `device from ${label}`).toBe(false);
  }
}

beforeEach(() => {
  protocolHook.fail = false;
  BrowserSessionService.__resetForTests();
  __resetAgentPartitionsForTests();
  fakeState.reset();
  setPlatform('darwin');
  emulateSessionCreatedHook();
});
afterAll(() => {
  sessionApi.fromPartition = originalFromPartition;
  setPlatform(realPlatform);
});

describe('the session-created gate alone', () => {
  it('allows non-audio permissions with a null requester, so an agent partition cannot rely on it', () => {
    const ses = originalFromPartition('agent-portal-standalone');
    installMicrophoneGate(ses as never, { allowWhenGranted: false, label: 'agent-portal-standalone' });
    expect(ses.check('geolocation', {}, null)).toBe(true);
    expect(ses.request('notifications', {}, null)).toBe(true);
    expect(ses.check('audioCapture', {}, null)).toBe(false);
  });
});

describe('agent portal: no verifiable requester means deny', () => {
  it('replaces the session-created gate with deny-all before any view exists', () => {
    const { ses, wc } = openAgent('agent-browser:1');
    expectDeniesEverything(ses, wc);
  });

  it.each(['win32', 'linux'])(
    'denies audio on %s too, where the session-created gate alone would allow it',
    (platform) => {
      setPlatform(platform);
      const standalone = originalFromPartition(`agent-portal-standalone-${platform}`);
      installMicrophoneGate(standalone as never, { allowWhenGranted: false, label: platform });
      expect(standalone.check('audioCapture', {}, null)).toBe(true);

      const { ses, wc } = openAgent('agent-browser:1');
      expectDeniesEverything(ses, wc);
      for (const [label, requester] of requesters(wc)) {
        expect(ses.request('media', { mediaTypes: ['audio'] }, requester), `request audio from ${label}`).toBe(false);
        expect(ses.request('audioCapture', {}, requester), `request audioCapture from ${label}`).toBe(false);
      }
    },
  );

  it('answers each request synchronously and exactly once, so no decision is left pending', () => {
    const { ses, wc } = openAgent('agent-browser:1');
    for (const requester of [wc, null]) {
      const callback = vi.fn();
      ses.requestHandler!(requester, 'geolocation', callback, {});
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(false);
    }
  });

  it('keeps denying after the portal is closed, for its old contents and a null requester', () => {
    const { ses, wc } = openAgent('agent-browser:1');
    svc().destroySession('agent-browser:1');
    expect(svc().hasSession('agent-browser:1')).toBe(false);
    expectDeniesEverything(ses, wc);
  });

  it('keeps denying after the host window closes', () => {
    const { ses, wc } = openAgent('agent-browser:1');
    const win = new FakeBrowserWindow();
    svc().attachToWindow('agent-browser:1', win as never, { x: 0, y: 0, width: 10, height: 10 });
    win.fireClosed();
    expect(svc().hasSession('agent-browser:1')).toBe(false);
    expectDeniesEverything(ses, wc);
  });

  it('keeps denying on the partition of a create that failed after the partition existed', () => {
    protocolHook.fail = true;
    expect(() => openAgent('agent-browser:1')).toThrow(/protocol setup failed/);
    expect(svc().hasSession('agent-browser:1')).toBe(false);
    const agentPartitions = [...fakeState.sessions.entries()].filter(([name]) => isAgentPartitionName(name));
    expect(agentPartitions).toHaveLength(1);
    expectDeniesEverything(agentPartitions[0][1], null);
  });

  it("never lets one portal's teardown loosen another portal's partition", () => {
    const a = openAgent('agent-browser:1', 'ai-session-A');
    const b = openAgent('agent-browser:2', 'ai-session-B');
    expect(a.ses).not.toBe(b.ses);
    svc().destroySession('agent-browser:1');
    expectDeniesEverything(b.ses, b.wc);
    // B's contents named on A's partition, and the reverse, are still denied.
    expect(a.ses.check('geolocation', {}, b.wc)).toBe(false);
    expect(b.ses.check('geolocation', {}, a.wc)).toBe(false);
  });
});

describe("user tabs: a null requester gets the same answer as a known user tab", () => {
  it('allows non-audio permissions for a known tab and for a null or unknown requester alike', () => {
    const { ses, wc } = openUser();
    for (const [label, requester] of requesters(wc)) {
      for (const permission of NON_AUDIO) {
        expect(ses.request(permission, {}, requester), `request ${permission} from ${label}`).toBe(true);
        expect(ses.check(permission, {}, requester), `check ${permission} from ${label}`).toBe(true);
      }
      expect(ses.check('audioCapture', {}, requester), `check audioCapture from ${label}`).toBe(false);
    }
  });

  it('denies a user partition request that names an agent portal web contents', () => {
    const user = openUser();
    const agent = openAgent('agent-browser:1');
    expect(user.ses.request('geolocation', {}, agent.wc)).toBe(false);
    expect(user.ses.check('notifications', {}, agent.wc)).toBe(false);
  });
});

describe('no agent contents can reach a user partition', () => {
  it('maps every user-requested partition name outside the agent namespace', () => {
    for (const requested of [undefined, 'preview', 'agent-portal-x', 'persist:agent-portal-x', ' agent-portal-y ']) {
      const { name } = openUser(`browser:doc:${String(requested)}`, requested);
      expect(isAgentPartitionName(name), String(requested)).toBe(false);
    }
  });

  it('refuses an agent that asks for any partition, so it cannot join a user one', () => {
    expect(() =>
      svc().createSession({
        sessionId: 'agent-browser:1',
        url: 'https://example.com',
        headless: true,
        ownerSessionId: 'ai-session-A',
        partition: 'preview',
      }),
    ).toThrow(/cannot choose a browser partition/i);
    expect(fakeState.views.length).toBe(0);
  });

  it('puts every agent portal in an agent partition, never in the partition of an open user tab', () => {
    const user = openUser();
    const agent = openAgent('agent-browser:1');
    expect(isAgentPartitionName(agent.name)).toBe(true);
    expect(agent.ses).not.toBe(user.ses);
  });
});
