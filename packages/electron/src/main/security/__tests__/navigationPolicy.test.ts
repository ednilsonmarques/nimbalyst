/**
 * NIB.85 stage d1: pure policies for (a) main-frame navigation of app windows
 * and (b) which IPC senders are accepted. Both share one definition of "the
 * app's own renderer": the dev server origin, or files under the renderer
 * bundle directory.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  buildAppOriginConfig,
  isAppUrl,
  decideNavigation,
  decideIpcSender,
  type AppOriginConfig,
} from '../navigationPolicy';

const APP_PATH = path.resolve('/opt/app/resources/app.asar');
const RENDERER_DIR = path.join(APP_PATH, 'out', 'renderer');

function fileUrl(p: string): string {
  return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, '');
}

const packaged: AppOriginConfig = buildAppOriginConfig({ env: {}, appPath: APP_PATH });
const dev: AppOriginConfig = buildAppOriginConfig({
  env: { ELECTRON_RENDERER_URL: 'http://localhost:5173', NODE_ENV: 'development' },
  appPath: path.resolve('/repo/packages/electron'),
});
const devPort: AppOriginConfig = buildAppOriginConfig({
  env: { NODE_ENV: 'development', VITE_PORT: '5399' },
  appPath: path.resolve('/repo/packages/electron'),
});

describe('isAppUrl', () => {
  it('accepts files under the packaged renderer bundle, with query and hash', () => {
    expect(isAppUrl(fileUrl(path.join(RENDERER_DIR, 'index.html')) + '?theme=dark', packaged)).toBe(true);
    expect(isAppUrl(fileUrl(path.join(RENDERER_DIR, 'about.html')) + '#x', packaged)).toBe(true);
  });

  it('rejects other files, including a sibling directory that shares the prefix', () => {
    expect(isAppUrl(fileUrl(path.resolve('/etc/passwd')), packaged)).toBe(false);
    expect(isAppUrl(fileUrl(RENDERER_DIR + '-evil/index.html'), packaged)).toBe(false);
    expect(isAppUrl(fileUrl(path.join(RENDERER_DIR, '..', '..', 'secret.html')), packaged)).toBe(false);
  });

  it('accepts only the dev server origin in development', () => {
    expect(isAppUrl('http://localhost:5173/index.html?theme=dark', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('http://evil.example/', dev)).toBe(false);
    expect(isAppUrl('http://localhost:5173.evil.example/', dev)).toBe(false);
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false);
  });

  it('accepts the VITE_PORT dev origin (default 5273 when unset) only when NODE_ENV is development', () => {
    expect(isAppUrl('http://localhost:5399/island.html', devPort)).toBe(true);
    const dflt = buildAppOriginConfig({ env: { NODE_ENV: 'development' }, appPath: '/x' });
    expect(isAppUrl('http://localhost:5273/', dflt)).toBe(true);
    expect(isAppUrl('http://localhost:5273/', packaged)).toBe(false);
  });

  it('ignores every env-derived root (dev origin, ELECTRON_RENDERER_URL) in a packaged build', () => {
    const p = buildAppOriginConfig({
      env: { ELECTRON_RENDERER_URL: 'http://localhost:5173', NODE_ENV: 'development', VITE_PORT: '5399' },
      appPath: APP_PATH,
      isPackaged: true,
    });
    expect(isAppUrl('http://localhost:5173/', p)).toBe(false);
    expect(isAppUrl('http://localhost:5399/', p)).toBe(false);
    expect(isAppUrl('http://localhost:5273/', p)).toBe(false);
    expect(isAppUrl(fileUrl(path.join(RENDERER_DIR, 'index.html')), p)).toBe(true);
    const fileEnv = buildAppOriginConfig({ env: { ELECTRON_RENDERER_URL: fileUrl(path.resolve('/tmp/h/renderer/index.html')) }, appPath: APP_PATH, isPackaged: true });
    expect(isAppUrl(fileUrl(path.resolve('/tmp/h/renderer/index.html')), fileEnv)).toBe(false);
  });

  it('treats a file: ELECTRON_RENDERER_URL (test harness) as a root for its directory', () => {
    const harness = buildAppOriginConfig({
      env: { ELECTRON_RENDERER_URL: fileUrl(path.resolve('/tmp/h/renderer/index.html')) },
      appPath: '/x',
    });
    expect(isAppUrl(fileUrl(path.resolve('/tmp/h/renderer/index.html')) + '?theme=light', harness)).toBe(true);
    expect(isAppUrl(fileUrl(path.resolve('/tmp/h/other/index.html')), harness)).toBe(false);
  });

  it('rejects data:, javascript:, blob:, about: and garbage', () => {
    for (const u of ['data:text/html,x', 'javascript:alert(1)', 'blob:http://localhost:5173/abc', 'about:blank', 'not a url', '']) {
      expect(isAppUrl(u, dev)).toBe(false);
    }
  });
});

describe('decideNavigation', () => {
  it('lets the app navigate within its own renderer (reload, theme query)', () => {
    expect(decideNavigation('http://localhost:5173/?theme=light', dev)).toBe('allow');
    expect(decideNavigation(fileUrl(path.join(RENDERER_DIR, 'index.html')) + '?theme=dark', packaged)).toBe('allow');
  });

  it('sends external http(s) and mailto to the system', () => {
    expect(decideNavigation('https://example.com/docs', dev)).toBe('open-external');
    expect(decideNavigation('http://example.com/', packaged)).toBe('open-external');
    expect(decideNavigation('mailto:team@example.com', packaged)).toBe('open-external');
  });

  it('blocks everything else: file:, data:, javascript:, collab-asset:', () => {
    expect(decideNavigation(fileUrl(path.resolve('/etc/hosts')), packaged)).toBe('block');
    expect(decideNavigation('data:text/html,<script>1</script>', dev)).toBe('block');
    expect(decideNavigation('javascript:alert(1)', dev)).toBe('block');
    expect(decideNavigation('collab-asset://x/y', dev)).toBe('block');
    expect(decideNavigation('::::', dev)).toBe('block');
  });

  it('routes nimbalyst: links into the app (NIB.98); other custom schemes stay blocked', () => {
    expect(decideNavigation('nimbalyst://action/open-project-manager', dev)).toBe('app-route');
    expect(decideNavigation('nimbalyst://doc/abc?orgId=o1', packaged)).toBe('app-route');
    for (const u of ['vscode://file/C:/x', 'cursor://x', 'tel:+5511999999999', 'sms:123', 'ms-settings:privacy', 'slack://open', 'collab-asset://x/y', 'nimbalyst-evil://x', 'nimbalyst.evil:foo']) {
      expect(decideNavigation(u, dev)).toBe('block');
    }
  });

  it('never routes the team-invitation link in-app, whatever the spelling (NIB.98)', () => {
    for (const u of [
      'nimbalyst://invite/org1?email=a@b.c',
      'nimbalyst:///invite/org1',
      'NIMBALYST://INVITE/org1',
      'nimbalyst://%69nvite/org1',
      'nimbalyst://%49NVITE/org1',
      'nimbalyst://x/%69nvite/org1',
      'nimbalyst:///INVITE/org1',
      'nimbalyst://invite',
    ]) {
      expect(decideNavigation(u, dev), u).toBe('block-invite');
    }
    // the handler's own predicate (shared) agrees on the plain forms
    expect(new URL('nimbalyst://invite/org1').host).toBe('invite');
    expect(decideNavigation('nimbalyst://action/open-project-manager', dev)).toBe('app-route');
    expect(decideNavigation('nimbalyst://install/com.x.y', dev)).toBe('app-route');
    expect(decideNavigation('nimbalyst://invitees/x', dev)).toBe('app-route');
  });

  it('does not treat a different localhost port as the app', () => {
    expect(decideNavigation('http://localhost:5174/', dev)).toBe('open-external');
  });
});

describe('decideIpcSender', () => {
  const ok = { hasFrame: true, isTopFrame: true, inAppWindow: true, frameUrl: 'http://localhost:5173/?theme=dark' };

  it('accepts the top frame of an app window at the app origin', () => {
    expect(decideIpcSender(ok, dev)).toEqual({ allowed: true });
    expect(decideIpcSender({ ...ok, frameUrl: fileUrl(path.join(RENDERER_DIR, 'index.html')) }, packaged)).toEqual({ allowed: true });
  });

  it('rejects a renderer message whose frame is gone, even when the window document is the app', () => {
    expect(decideIpcSender({ ...ok, hasFrame: false }, dev)).toEqual({ allowed: false, reason: 'no-frame' });
  });

  it('rejects a missing frame, a subframe, a window that is not an app window and a foreign URL', () => {
    expect(decideIpcSender({ ...ok, hasFrame: false }, dev)).toEqual({ allowed: false, reason: 'no-frame' });
    expect(decideIpcSender({ ...ok, hasFrame: false }, dev)).toEqual({ allowed: false, reason: 'no-frame' });
    expect(decideIpcSender({ ...ok, hasFrame: false, inAppWindow: false }, dev)).toEqual({ allowed: false, reason: 'no-frame' });
    expect(decideIpcSender({ ...ok, isTopFrame: false }, dev)).toEqual({ allowed: false, reason: 'subframe' });
    expect(decideIpcSender({ ...ok, inAppWindow: false }, dev)).toEqual({ allowed: false, reason: 'not-app-window' });
    expect(decideIpcSender({ ...ok, frameUrl: 'https://evil.example/' }, dev)).toEqual({ allowed: false, reason: 'foreign-url' });
    expect(decideIpcSender({ ...ok, frameUrl: 'about:blank' }, dev)).toEqual({ allowed: false, reason: 'foreign-url' });
    expect(decideIpcSender({ ...ok, frameUrl: '' }, dev)).toEqual({ allowed: false, reason: 'foreign-url' });
  });
});
