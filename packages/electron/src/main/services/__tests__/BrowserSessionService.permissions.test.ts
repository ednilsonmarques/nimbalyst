// @vitest-environment node
/**
 * Portal F0 -- permission denial is scoped to agent-owned views; the user's own
 * editor tabs keep today's behaviour. (F1.1: agent portals now sit in their own
 * partition, see BrowserSessionService.agentPartition.test.ts for the full
 * deny-all matrix; the microphone is denied for agents on every platform.)
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
import { fakeState } from './helpers/fakeElectronBrowser';

const AGENT = 'ai-session-A';
const NON_AUDIO = ['geolocation', 'notifications', 'clipboard-read', 'midi', 'fullscreen', 'openExternal'];

const realPlatform = process.platform;
const setPlatform = (platform: string) =>
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

function open(kind: 'agent' | 'user') {
  const service = BrowserSessionService.getInstance();
  if (kind === 'agent') {
    service.createSession({ sessionId: 'agent-browser:a1', url: 'https://example.com', headless: true, ownerSessionId: AGENT });
  } else {
    service.createSession({ sessionId: 'browser:doc.html:1', url: 'about:blank' });
  }
  const view = fakeState.views[fakeState.views.length - 1];
  // F1.1: an agent portal lives in its own partition; user tabs share browser-preview.
  const name = service.getPartitionName(kind === 'agent' ? 'agent-browser:a1' : 'browser:doc.html:1')!;
  return { ses: fakeState.sessions.get(name)!, wc: view.webContents };
}

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  fakeState.reset();
  setPlatform('darwin');
});
afterAll(() => setPlatform(realPlatform));

describe('agent-owned session', () => {
  it.each(NON_AUDIO)('denies %s (request and check)', (permission) => {
    const { ses, wc } = open('agent');
    expect(ses.request(permission, {}, wc)).toBe(false);
    expect(ses.check(permission, {}, wc)).toBe(false);
  });

  it('denies non-audio media (camera) too', () => {
    const { ses, wc } = open('agent');
    expect(ses.request('media', { mediaTypes: ['video'] }, wc)).toBe(false);
  });
});

describe("user's editor session keeps today's behaviour", () => {
  it.each(NON_AUDIO)('still allows %s (request and check)', (permission) => {
    const { ses, wc } = open('user');
    expect(ses.request(permission, {}, wc)).toBe(true);
    expect(ses.check(permission, {}, wc)).toBe(true);
  });
});

describe('agent and user views no longer share a partition', () => {
  it('denies the agent view and leaves the user view as today', () => {
    const user = open('user');
    const agent = open('agent');
    expect(user.ses).not.toBe(agent.ses);
    expect(agent.ses.request('geolocation', {}, agent.wc)).toBe(false);
    expect(user.ses.request('geolocation', {}, user.wc)).toBe(true);
    expect(user.ses.check('notifications', {}, user.wc)).toBe(true);
    expect(agent.ses.check('notifications', {}, agent.wc)).toBe(false);
  });

  it('opening an agent view later does not change what the user view gets', () => {
    const user = open('user');
    expect(user.ses.request('clipboard-read', {}, user.wc)).toBe(true);
    open('agent');
    expect(user.ses.request('clipboard-read', {}, user.wc)).toBe(true);
  });
});

describe('microphone handling', () => {
  it('the user tab: denied on macOS, not restricted elsewhere (unchanged)', () => {
    setPlatform('darwin');
    let u = open('user');
    expect(u.ses.request('media', { mediaTypes: ['audio'] }, u.wc)).toBe(false);
    BrowserSessionService.__resetForTests();
    fakeState.reset();
    setPlatform('win32');
    u = open('user');
    expect(u.ses.request('media', { mediaTypes: ['audio'] }, u.wc)).toBe(true);
    expect(u.ses.check('audioCapture', {}, u.wc)).toBe(true);
  });

  it.each(['darwin', 'win32'])('the agent portal: denied on %s (F1.1)', (platform) => {
    setPlatform(platform);
    const { ses, wc } = open('agent');
    expect(ses.request('media', { mediaTypes: ['audio'] }, wc)).toBe(false);
    expect(ses.check('audioCapture', {}, wc)).toBe(false);
  });
});
