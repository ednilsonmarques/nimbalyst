// @vitest-environment node
/**
 * Portal F1.2 -- a portal is bound to the preview origin it was opened on.
 * Top-level navigation, redirects and frames may not leave that origin;
 * subresources and fetches are not touched (no request-level hook exists).
 * The user's own tabs keep today's rules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./helpers/fakeElectronBrowser')).createElectronMock());
vi.mock('../../utils/logger', () => ({
  logger: { main: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } },
}));
vi.mock('../../protocols/nimPreviewProtocol', () => ({
  ensureNimPreviewProtocolForSession: vi.fn(),
}));

import { BrowserSessionService, originKeyOf, isWithinOrigin } from '../BrowserSessionService';
import { fakeState, type FakeSession } from './helpers/fakeElectronBrowser';

const svc = () => BrowserSessionService.getInstance();
const PREVIEW = 'nim-preview://6162636465/index.html';
const PREVIEW_ORIGIN = 'nim-preview://6162636465';
const LOOPBACK = 'http://127.0.0.1:5173/app';

function openPortal(url = PREVIEW, id = 'agent-portal:1', owner = 'ai-A') {
  svc().createSession({ sessionId: id, url, headless: true, ownerSessionId: owner, confineToOrigin: true });
  const view = fakeState.views[fakeState.views.length - 1];
  const ses = fakeState.sessions.get(svc().getPartitionName(id)!) as FakeSession;
  return { wc: view.webContents, ses };
}

/** Fire a navigation-class event the way Electron does and report whether it was prevented. */
function fire(wc: { emit: (...a: any[]) => boolean }, name: string, url: string, extra: Record<string, unknown> = {}): boolean {
  let prevented = false;
  const event = { url, preventDefault: () => { prevented = true; }, ...extra };
  wc.emit(name, event, url);
  return prevented;
}

beforeEach(() => {
  BrowserSessionService.__resetForTests();
  fakeState.reset();
});

describe('origin helpers', () => {
  it('compares scheme + host + port, including custom schemes whose URL.origin is "null"', () => {
    expect(originKeyOf(PREVIEW)).toBe(PREVIEW_ORIGIN);
    expect(originKeyOf('http://127.0.0.1:5173/x')).toBe('http://127.0.0.1:5173');
    expect(isWithinOrigin('nim-preview://6162636465/other/page.html', PREVIEW_ORIGIN)).toBe(true);
    expect(isWithinOrigin('nim-preview://ffff/index.html', PREVIEW_ORIGIN)).toBe(false);
    expect(isWithinOrigin('http://127.0.0.1:5174/', 'http://127.0.0.1:5173')).toBe(false);
    expect(isWithinOrigin('https://127.0.0.1:5173/', 'http://127.0.0.1:5173')).toBe(false);
    expect(isWithinOrigin('not a url', PREVIEW_ORIGIN)).toBe(false);
  });
});

describe('the portal is bound to the origin it opened on', () => {
  it('records the bound origin', () => {
    openPortal();
    expect(svc().getBoundOrigin('agent-portal:1')).toBe(PREVIEW_ORIGIN);
  });

  it('blocks top-level navigation to another origin and allows the same origin', () => {
    const { wc } = openPortal();
    expect(fire(wc, 'will-navigate', 'https://evil.example/')).toBe(true);
    expect(fire(wc, 'will-navigate', 'http://127.0.0.1:5173/')).toBe(true);
    expect(fire(wc, 'will-navigate', 'nim-preview://ffff/index.html')).toBe(true);
    expect(fire(wc, 'will-navigate', 'nim-preview://6162636465/next.html')).toBe(false);
  });

  it('blocks a redirect out of the origin, and allows one inside it', () => {
    const { wc } = openPortal();
    expect(fire(wc, 'will-redirect', 'https://evil.example/landing')).toBe(true);
    expect(fire(wc, 'will-redirect', 'file:///C:/secret.txt')).toBe(true);
    expect(fire(wc, 'will-redirect', 'nim-preview://6162636465/moved.html')).toBe(false);
  });

  it('blocks a frame that navigates out of the origin (will-frame-navigate), allows one inside', () => {
    const { wc } = openPortal();
    expect(fire(wc, 'will-frame-navigate', 'https://evil.example/ad', { isMainFrame: false })).toBe(true);
    expect(fire(wc, 'will-frame-navigate', 'https://evil.example/', { isMainFrame: true })).toBe(true);
    expect(fire(wc, 'will-frame-navigate', 'nim-preview://6162636465/embed.html', { isMainFrame: false })).toBe(false);
  });

  it('allows about:blank / about:srcdoc only for sub-frames, never as a top-level destination', () => {
    const { wc } = openPortal();
    expect(fire(wc, 'will-frame-navigate', 'about:blank', { isMainFrame: false })).toBe(false);
    expect(fire(wc, 'will-frame-navigate', 'about:srcdoc', { isMainFrame: false })).toBe(false);
    expect(fire(wc, 'will-navigate', 'about:blank')).toBe(true);
  });

  it('also keeps the old scheme allow-list for a navigation inside the origin', () => {
    const { wc } = openPortal(LOOPBACK);
    expect(fire(wc, 'will-navigate', 'http://127.0.0.1:5173/other')).toBe(false);
    expect(fire(wc, 'will-navigate', 'javascript:alert(1)')).toBe(true);
  });

  it('refuses service.navigate() to another origin and never loads it', () => {
    const { wc } = openPortal();
    expect(() => svc().navigate('agent-portal:1', 'https://evil.example/')).toThrow(/origin/i);
    expect(() => svc().navigate('agent-portal:1', 'nim-preview://ffff/x.html')).toThrow(/origin/i);
    expect(wc.loaded).toEqual([PREVIEW]);
    svc().navigate('agent-portal:1', 'nim-preview://6162636465/next.html');
    expect(wc.loaded).toEqual([PREVIEW, 'nim-preview://6162636465/next.html']);
  });

  it('installs no request-level hook, so subresources and fetches stay free', () => {
    const { ses } = openPortal();
    expect(ses.webRequestHooks).toBe(0);
  });
});

describe('binding rules (N6) and the portal project (B1)', () => {
  it('refuses to bind a portal to a URL that has no usable origin, and creates nothing', () => {
    expect(() =>
      svc().createSession({ sessionId: 'agent-portal:x', url: 'about:blank', headless: true, ownerSessionId: 'ai-A', confineToOrigin: true }),
    ).toThrow(/origin/i);
    expect(fakeState.views).toHaveLength(0);
    expect(svc().hasSession('agent-portal:x')).toBe(false);
  });

  it('never leaves a confined portal with a null bound origin', () => {
    openPortal();
    expect(svc().getBoundOrigin('agent-portal:1')).toBeTruthy();
  });

  it('records the project an agent portal belongs to', () => {
    svc().createSession({ sessionId: 'agent-portal:2', url: PREVIEW, headless: true, ownerSessionId: 'ai-A', confineToOrigin: true, projectPath: '/proj' });
    expect(svc().getProjectPath('agent-portal:2')).toBe('/proj');
    expect(svc().getProjectPath('missing')).toBeUndefined();
  });

  it('reports the page the view is on now (falls back to the last known state)', () => {
    const { wc } = openPortal();
    expect(svc().getCurrentUrl('agent-portal:1')).toBe(PREVIEW);
    (wc as unknown as { getURL: () => string }).getURL = () => 'nim-preview://6162636465/moved.html';
    expect(svc().getCurrentUrl('agent-portal:1')).toBe('nim-preview://6162636465/moved.html');
  });
});

describe("the user's own tabs are unchanged", () => {
  it('a user tab is not confined: it may navigate anywhere the allow-list permits, and has no frame hook', () => {
    svc().createSession({ sessionId: 'browser:doc.html:1', url: 'about:blank' });
    const wc = fakeState.views[fakeState.views.length - 1].webContents;
    expect(svc().getBoundOrigin('browser:doc.html:1')).toBeUndefined();
    expect(fire(wc, 'will-navigate', 'https://example.com/')).toBe(false);
    expect(wc.listenerCount('will-frame-navigate')).toBe(0);
    svc().navigate('browser:doc.html:1', 'https://example.org/');
    expect(wc.loaded).toContain('https://example.org/');
  });

  it('a non-confined agent session (browser.open_session) keeps today\'s rules', () => {
    svc().createSession({ sessionId: 'agent-browser:1', url: 'https://example.com', headless: true, ownerSessionId: 'ai-A' });
    const wc = fakeState.views[fakeState.views.length - 1].webContents;
    expect(svc().getBoundOrigin('agent-browser:1')).toBeUndefined();
    expect(fire(wc, 'will-navigate', 'https://example.org/')).toBe(false);
  });

  it('a user session cannot ask to be confined', () => {
    expect(() =>
      svc().createSession({ sessionId: 'browser:x', url: PREVIEW, confineToOrigin: true }),
    ).toThrow(/confine/i);
  });
});
