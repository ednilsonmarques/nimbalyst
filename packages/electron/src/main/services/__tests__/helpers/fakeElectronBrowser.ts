/**
 * Minimal fake of the Electron surface BrowserSessionService touches
 * (WebContentsView, BrowserWindow, session.fromPartition). Lets the ownership,
 * view-guard and screenshot tests drive the real service and the real IPC
 * handlers without a live Electron runtime.
 *
 * Usage (vi.mock factories are hoisted, so the helper is loaded lazily):
 *   vi.mock('electron', async () => (await import('./helpers/fakeElectronBrowser')).createElectronMock());
 */
import { EventEmitter } from 'events';

let nextId = 1;

export class FakeWebContents extends EventEmitter {
  id = nextId++;
  loaded: string[] = [];
  reloads = 0;
  closed = false;
  scripts: string[] = [];
  inputs: unknown[] = [];
  windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null;
  navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {},
  };
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void {
    this.windowOpenHandler = handler;
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    return Promise.resolve();
  }
  reload(): void {
    this.reloads++;
  }
  close(): void {
    this.closed = true;
  }
  executeJavaScript(script: string): Promise<unknown> {
    this.scripts.push(script);
    return Promise.resolve({ x: 1, y: 1 });
  }
  sendInputEvent(event: unknown): void {
    this.inputs.push(event);
  }
  capturePage(): Promise<{ toPNG: () => Buffer }> {
    return Promise.resolve({ toPNG: () => Buffer.from('png-bytes') });
  }
}

export class FakeSession extends EventEmitter {
  storagePath: string | null = null;
  requestHandler:
    | ((wc: unknown, permission: string, cb: (ok: boolean) => void, details: unknown) => void)
    | null = null;
  checkHandler:
    | ((wc: unknown, permission: string, origin: string, details: unknown) => boolean)
    | null = null;
  setPermissionRequestHandler(handler: FakeSession['requestHandler']): void {
    this.requestHandler = handler;
  }
  setPermissionCheckHandler(handler: FakeSession['checkHandler']): void {
    this.checkHandler = handler;
  }
  /** Fire a permission request and return what the installed handler answered. */
  request(permission: string, details: unknown = {}, webContents: unknown = null): boolean {
    let result = false;
    this.requestHandler?.(webContents, permission, (ok) => {
      result = ok;
    }, details);
    return result;
  }
  check(
    permission: string,
    details: unknown = {},
    webContents: unknown = null,
    origin = 'https://example.com',
  ): boolean {
    return this.checkHandler ? this.checkHandler(webContents, permission, origin, details) : true;
  }
}

export const fakeState = {
  views: [] as FakeWebContentsView[],
  sessions: new Map<string, FakeSession>(),
  windows: [] as FakeBrowserWindow[],
  reset(): void {
    this.views.length = 0;
    this.sessions.clear();
    this.windows.length = 0;
  },
};

export class FakeWebContentsView {
  webContents = new FakeWebContents();
  bounds: unknown = null;
  constructor(public options: unknown) {
    fakeState.views.push(this);
  }
  setBounds(bounds: unknown): void {
    this.bounds = bounds;
  }
}

export class FakeBrowserWindow {
  static getAllWindows(): FakeBrowserWindow[] {
    return [];
  }
  static fromWebContents(): FakeBrowserWindow {
    return new FakeBrowserWindow();
  }
  id = nextId++;
  children: unknown[] = [];
  contentView = {
    addChildView: (view: unknown) => {
      this.children.push(view);
    },
    removeChildView: (view: unknown) => {
      this.children = this.children.filter((c) => c !== view);
    },
  };
  webContents = { getZoomFactor: () => 1, send: () => {} };
  constructor() {
    fakeState.windows.push(this);
  }
  isDestroyed(): boolean {
    return false;
  }
  once(): void {}
  showInactive(): void {}
  setContentSize(): void {}
  setOpacity(): void {}
  setIgnoreMouseEvents(): void {}
  getContentSize(): [number, number] {
    return [1280, 800];
  }
  getBounds(): Record<string, number> {
    return { x: 0, y: 0, width: 1280, height: 800 };
  }
  destroy(): void {}
}

export function createElectronMock() {
  return {
    WebContentsView: FakeWebContentsView,
    BrowserWindow: FakeBrowserWindow,
    session: {
      fromPartition: (name: string) => {
        let ses = fakeState.sessions.get(name);
        if (!ses) {
          ses = new FakeSession();
          fakeState.sessions.set(name, ses);
        }
        return ses;
      },
    },
    systemPreferences: { getMediaAccessStatus: () => 'denied' },
  };
}
