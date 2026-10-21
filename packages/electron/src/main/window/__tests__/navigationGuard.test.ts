import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import { attachNavigationGuard } from '../navigationGuard';
import { buildAppOriginConfig } from '../../security/navigationPolicy';

const cfg = buildAppOriginConfig({
  env: { ELECTRON_RENDERER_URL: 'http://localhost:5173', NODE_ENV: 'development' },
  appPath: '/x',
});

function makeContents(preload: string | undefined, type = 'window', withPrefs = true) {
  const wc = new EventEmitter() as EventEmitter & {
    getType: () => string;
    getLastWebPreferences?: () => { preload?: string };
  };
  wc.getType = () => type;
  if (withPrefs) wc.getLastWebPreferences = () => ({ preload });
  return wc;
}

function navEvent(extra: Record<string, unknown> = {}) {
  return { preventDefault: vi.fn(), ...extra };
}

describe('attachNavigationGuard', () => {
  const openExternal = vi.fn();
  const log = vi.fn();

  beforeEach(() => { openExternal.mockReset(); log.mockReset(); });

  it('blocks a main-frame navigation to a foreign file: URL and logs it', () => {
    const wc = makeContents('/app/preload.js');
    expect(attachNavigationGuard(wc as any, cfg, { openExternal, log })).toBe(true);
    const e = navEvent();
    wc.emit('will-navigate', e, 'file:///C:/Windows/win.ini');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('file:///C:/Windows/win.ini'));
  });

  it('sends an external https link to the system browser and keeps the window on the app', () => {
    const wc = makeContents('/app/preload.js');
    attachNavigationGuard(wc as any, cfg, { openExternal, log });
    const e = navEvent();
    wc.emit('will-navigate', e, 'https://example.com/page');
    expect(e.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/page');
  });

  it('allows navigation inside the app origin (reload, theme change)', () => {
    const wc = makeContents('/app/preload.js');
    attachNavigationGuard(wc as any, cfg, { openExternal, log });
    const e = navEvent();
    wc.emit('will-navigate', e, 'http://localhost:5173/?theme=light');
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('applies the same policy to a main-frame redirect and ignores subframe redirects', () => {
    const wc = makeContents('/app/preload.js');
    attachNavigationGuard(wc as any, cfg, { openExternal, log });
    const top = navEvent({ isMainFrame: true });
    wc.emit('will-redirect', top, 'https://example.com/r');
    expect(top.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://example.com/r');
    const sub = navEvent({ isMainFrame: false });
    wc.emit('will-redirect', sub, 'https://example.com/other');
    expect(sub.preventDefault).not.toHaveBeenCalled();
  });

  it('does not touch the embedded browser view or other non-window web contents', () => {
    const wc = makeContents(undefined, 'browserView');
    expect(attachNavigationGuard(wc as any, cfg, { openExternal, log })).toBe(false);
    expect(wc.listenerCount('will-navigate')).toBe(0);
    expect(wc.listenerCount('will-redirect')).toBe(0);
  });

  it('guards every BrowserWindow, whether or not getLastWebPreferences reports a preload (Electron omits it)', () => {
    for (const withPrefs of [true, false]) {
      const wc = makeContents(undefined, 'window', withPrefs);
      expect(attachNavigationGuard(wc as any, cfg, { openExternal, log })).toBe(true);
      const e = navEvent();
      wc.emit('will-navigate', e, 'file:///C:/Windows/win.ini');
      expect(e.preventDefault).toHaveBeenCalled();
    }
  });

  describe('embedded browser view (reports type "window" in Electron 43, seen at run time)', () => {
    it('does not police a web contents that no BrowserWindow owns, for navigations and redirects', () => {
      const wc = makeContents(undefined, 'window');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, isOwnedByWindow: () => false });
      const nav = navEvent();
      wc.emit('will-navigate', nav, 'https://example.com/linked');
      const redirect = navEvent({ isMainFrame: true });
      wc.emit('will-redirect', redirect, 'https://example.com/final');
      expect(nav.preventDefault).not.toHaveBeenCalled();
      expect(redirect.preventDefault).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    });

    it('decides ownership when the navigation happens, not when the web contents is created', () => {
      const wc = makeContents(undefined, 'window');
      let owned = false;
      attachNavigationGuard(wc as any, cfg, { openExternal, log, isOwnedByWindow: () => owned });
      const early = navEvent();
      wc.emit('will-navigate', early, 'file:///C:/Windows/win.ini');
      expect(early.preventDefault).not.toHaveBeenCalled();
      owned = true;
      const late = navEvent();
      wc.emit('will-navigate', late, 'file:///C:/Windows/win.ini');
      expect(late.preventDefault).toHaveBeenCalled();
    });

    it('fails closed when the ownership check throws: the contents is treated as owned and the policy applies', () => {
      const wc = makeContents(undefined, 'window');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, isOwnedByWindow: () => { throw new Error('window list unavailable'); } });
      const nav = navEvent();
      wc.emit('will-navigate', nav, 'https://example.com/linked');
      expect(nav.preventDefault).toHaveBeenCalled();
      expect(openExternal).toHaveBeenCalledWith('https://example.com/linked');
      const redirect = navEvent({ isMainFrame: true });
      wc.emit('will-redirect', redirect, 'file:///C:/Windows/win.ini');
      expect(redirect.preventDefault).toHaveBeenCalled();
      const sameOrigin = navEvent();
      wc.emit('will-navigate', sameOrigin, 'http://localhost:5173/?theme=dark');
      expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
    });

    it('still guards a web contents that a BrowserWindow owns', () => {
      const wc = makeContents(undefined, 'window');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, isOwnedByWindow: () => true });
      const nav = navEvent();
      wc.emit('will-navigate', nav, 'https://example.com/linked');
      expect(nav.preventDefault).toHaveBeenCalled();
      expect(openExternal).toHaveBeenCalledWith('https://example.com/linked');
    });
  });

  it('reads the target from event.url when Electron provides it, falling back to the positional url', () => {
    const wc = makeContents('/app/preload.js');
    attachNavigationGuard(wc as any, cfg, { openExternal, log });
    const viaEvent = navEvent({ url: 'file:///C:/Windows/win.ini' });
    wc.emit('will-navigate', viaEvent, undefined);
    expect(viaEvent.preventDefault).toHaveBeenCalled();
    const viaPositional = navEvent();
    wc.emit('will-navigate', viaPositional, 'file:///C:/Windows/win.ini');
    expect(viaPositional.preventDefault).toHaveBeenCalled();
    const sameOrigin = navEvent({ url: 'http://localhost:5173/?theme=dark' });
    wc.emit('will-navigate', sameOrigin, 'file:///C:/Windows/win.ini');
    expect(sameOrigin.preventDefault).not.toHaveBeenCalled();
  });

  describe('nimbalyst: links are routed to the in-app deep-link handler (NIB.98)', () => {
    const routeAppUrl = vi.fn();
    beforeEach(() => { routeAppUrl.mockReset(); });
    const withInput = (wc: any, type = 'mouseUp') => wc.emit('input-event', {}, { type });

    it('calls the handler once with the URL after a user input, without openExternal', () => {
      const wc = makeContents('/app/preload.js');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl });
      withInput(wc);
      const e = navEvent();
      wc.emit('will-navigate', e, 'nimbalyst://action/open-project-manager');
      expect(e.preventDefault).toHaveBeenCalled();
      expect(routeAppUrl).toHaveBeenCalledTimes(1);
      expect(routeAppUrl.mock.calls[0][0]).toBe('nimbalyst://action/open-project-manager');
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('blocks and logs team-invitation links after a user input, never calling the handler (NIB.98)', () => {
      for (const u of ['nimbalyst://invite/org1?email=a@b.c', 'nimbalyst:///invite/org1', 'NIMBALYST://INVITE/org1', 'nimbalyst://%69nvite/org1']) {
        const wc = makeContents('/app/preload.js');
        attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl });
        withInput(wc);
        const e = navEvent();
        wc.emit('will-navigate', e, u);
        expect(e.preventDefault, u).toHaveBeenCalled();
        expect(log.mock.calls.some((c: any[]) => /invite links are not routed in-app/.test(String(c[0]))), u).toBe(true);
        const r = navEvent({ isMainFrame: true });
        wc.emit('will-redirect', r, u);
        expect(r.preventDefault, u).toHaveBeenCalled();
      }
      expect(routeAppUrl).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('also routes a main-frame redirect to a nimbalyst: URL, and ignores subframe redirects', () => {
      const wc = makeContents('/app/preload.js');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl });
      withInput(wc, 'keyDown');
      const top = navEvent({ isMainFrame: true });
      wc.emit('will-redirect', top, 'nimbalyst://action/keyboard-shortcuts');
      expect(routeAppUrl).toHaveBeenCalledTimes(1);
      const sub = navEvent({ isMainFrame: false });
      wc.emit('will-redirect', sub, 'nimbalyst://action/keyboard-shortcuts');
      expect(routeAppUrl).toHaveBeenCalledTimes(1);
    });

    it('does not route a script-initiated navigation that follows no user input (Chromium required a gesture for the OS path)', () => {
      const wc = makeContents('/app/preload.js');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl });
      const e = navEvent();
      wc.emit('will-navigate', e, 'nimbalyst://invite/o1');
      expect(e.preventDefault).toHaveBeenCalled();
      expect(routeAppUrl).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('nimbalyst://invite/o1'));
    });

    it('stops routing once the last user input is older than the window', () => {
      let now = 1_000_000;
      const wc = makeContents('/app/preload.js');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl, now: () => now });
      withInput(wc);
      now += 10_000;
      const e = navEvent();
      wc.emit('will-navigate', e, 'nimbalyst://action/open-project-manager');
      expect(e.preventDefault).toHaveBeenCalled();
      expect(routeAppUrl).not.toHaveBeenCalled();
    });

    it('uses a monotonic clock: a wall-clock jump backwards does not keep the gate open', () => {
      const wall = vi.spyOn(Date, 'now');
      try {
        let mono = 5_000;
        wall.mockReturnValue(1_700_000_000_000);
        const wc = makeContents('/app/preload.js');
        attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl, now: () => mono });
        withInput(wc);
        mono += 3_001;
        wall.mockReturnValue(1_700_000_000_000 - 86_400_000); // wall clock set back one day
        const e = navEvent();
        wc.emit('will-navigate', e, 'nimbalyst://action/open-project-manager');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(routeAppUrl).not.toHaveBeenCalled();
        // still inside the window by the monotonic clock: routed, whatever the wall clock says
        const wc2 = makeContents('/app/preload.js');
        attachNavigationGuard(wc2 as any, cfg, { openExternal, log, routeAppUrl, now: () => mono });
        withInput(wc2);
        mono += 2_999;
        wall.mockReturnValue(1_700_000_000_000 + 86_400_000);
        wc2.emit('will-navigate', navEvent(), 'nimbalyst://action/open-project-manager');
        expect(routeAppUrl).toHaveBeenCalledTimes(1);
      } finally {
        wall.mockRestore();
      }
    });

    it('defaults to performance.now, not Date.now', () => {
      const wall = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now must not be used'); });
      const perf = vi.spyOn(performance, 'now');
      try {
        perf.mockReturnValue(10_000);
        const wc = makeContents('/app/preload.js');
        attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl });
        withInput(wc);
        perf.mockReturnValue(12_000);
        wc.emit('will-navigate', navEvent(), 'nimbalyst://action/open-project-manager');
        expect(routeAppUrl).toHaveBeenCalledTimes(1);
        perf.mockReturnValue(13_500);
        const e = navEvent();
        wc.emit('will-navigate', e, 'nimbalyst://action/open-project-manager');
        expect(e.preventDefault).toHaveBeenCalled();
        expect(routeAppUrl).toHaveBeenCalledTimes(1);
      } finally {
        wall.mockRestore();
        perf.mockRestore();
      }
    });

    it('ignores pointer movement as "user input"', () => {
      const wc = makeContents('/app/preload.js');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl });
      withInput(wc, 'mouseMove');
      withInput(wc, 'mouseEnter');
      wc.emit('will-navigate', navEvent(), 'nimbalyst://action/open-project-manager');
      expect(routeAppUrl).not.toHaveBeenCalled();
    });

    it('keeps other custom schemes blocked, even after user input, and never sends them to the OS', () => {
      const wc = makeContents('/app/preload.js');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl });
      withInput(wc);
      for (const u of ['vscode://file/x', 'tel:123', 'ms-settings:privacy']) {
        const e = navEvent();
        wc.emit('will-navigate', e, u);
        expect(e.preventDefault).toHaveBeenCalled();
      }
      expect(routeAppUrl).not.toHaveBeenCalled();
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('blocks (does not throw) when no handler is installed, and survives a handler that throws', () => {
      const bare = makeContents('/app/preload.js');
      attachNavigationGuard(bare as any, cfg, { openExternal, log });
      withInput(bare);
      const e1 = navEvent();
      expect(() => bare.emit('will-navigate', e1, 'nimbalyst://action/open-project-manager')).not.toThrow();
      expect(e1.preventDefault).toHaveBeenCalled();
      const throwing = makeContents('/app/preload.js');
      attachNavigationGuard(throwing as any, cfg, { openExternal, log, routeAppUrl: () => { throw new Error('boom'); } });
      withInput(throwing);
      const e2 = navEvent();
      expect(() => throwing.emit('will-navigate', e2, 'nimbalyst://action/open-project-manager')).not.toThrow();
      expect(e2.preventDefault).toHaveBeenCalled();
    });

    it('does not route for a web contents that no BrowserWindow owns (embedded browser)', () => {
      const wc = makeContents(undefined, 'window');
      attachNavigationGuard(wc as any, cfg, { openExternal, log, routeAppUrl, isOwnedByWindow: () => false });
      withInput(wc);
      const e = navEvent();
      wc.emit('will-navigate', e, 'nimbalyst://action/open-project-manager');
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(routeAppUrl).not.toHaveBeenCalled();
    });
  });

  it('keeps blocking when openExternal throws', () => {
    const wc = makeContents('/app/preload.js');
    attachNavigationGuard(wc as any, cfg, { openExternal: () => { throw new Error('no handler'); }, log });
    const e = navEvent();
    expect(() => wc.emit('will-navigate', e, 'mailto:a@b.c')).not.toThrow();
    expect(e.preventDefault).toHaveBeenCalled();
  });
});
