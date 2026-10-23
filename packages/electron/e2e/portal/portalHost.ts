/**
 * Test-process handles on the running app: probes installed in main through
 * Playwright's `electronApp.evaluate` (no production code is touched), and
 * helpers to read what a portal's page sees.
 *
 * The probes only OBSERVE or replace OS-level side effects the test must never
 * cause: `shell.openExternal` (would open the user's browser), `dialog.*`
 * (would block on a native dialog) are recorded and not forwarded.
 */
import type { ElectronApplication, Page } from '@playwright/test';

export interface ProbeSnapshot {
  partitions: string[];
  downloads: Array<{ partition: string; url: string; stateAfter: string }>;
  openExternal: string[];
  dialogCalls: Array<{ kind: string; message?: string; detail?: string; buttons?: string[]; defaultId?: number; cancelId?: number }>;
  sends: Array<{ channel: string; arg?: unknown }>;
}

export async function installProbes(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ session, shell, dialog, BrowserWindow, app: electronApp }) => {
    const g = globalThis as any;
    if (g.__nibProbe) return;
    const probe: any = (g.__nibProbe = {
      partitions: [] as string[],
      downloads: [] as any[],
      openExternal: [] as string[],
      dialogCalls: [] as any[],
      dialogQueue: [] as number[],
      sends: [] as any[],
    });

    // Every partition the app asks Electron for, and a download recorder on the agent ones. The recorder
    // is attached BEFORE the app's own lockdown listener, so it looks at the item's state a moment later.
    const original = session.fromPartition.bind(session);
    (session as any).fromPartition = (name: string, options?: unknown) => {
      const ses = original(name, options as never);
      if (!probe.partitions.includes(name)) {
        probe.partitions.push(name);
        if (name.startsWith('agent-portal-')) {
          ses.on('will-download', (event: any, item: any) => {
            const record = { partition: name, url: item.getURL(), stateAfter: 'pending' };
            probe.downloads.push(record);
            setTimeout(() => {
              // preventDefault() (the lockdown) destroys the item: reading it then throws. That is the
              // evidence of a cancelled download; an item that is still readable was NOT prevented.
              try {
                record.stateAfter = event.defaultPrevented ? `prevented (defaultPrevented=true)` : item.getState();
                if (!event.defaultPrevented && record.stateAfter !== 'cancelled') item.cancel(); // safety net: never let a file land
              } catch (e) {
                record.stateAfter = event.defaultPrevented ? 'prevented (defaultPrevented=true, item destroyed)' : `unreadable: ${(e as Error).message}`;
              }
            }, 800);
          });
        }
      }
      return ses;
    };

    (shell as any).openExternal = async (url: string) => {
      probe.openExternal.push(url);
    };

    const record = (kind: string, args: any[]) => {
      const opts = args.find((a) => a && typeof a === 'object' && !a.webContents && ('message' in a || 'buttons' in a || 'title' in a));
      const title = typeof args[0] === 'string' ? args[0] : undefined;
      probe.dialogCalls.push({ kind, message: opts?.message ?? title, detail: opts?.detail ?? (typeof args[1] === 'string' ? args[1] : undefined), buttons: opts?.buttons, defaultId: opts?.defaultId, cancelId: opts?.cancelId });
    };
    (dialog as any).showMessageBox = async (...args: any[]) => {
      record('showMessageBox', args);
      return { response: probe.dialogQueue.length ? probe.dialogQueue.shift() : 1, checkboxChecked: false };
    };
    (dialog as any).showMessageBoxSync = (...args: any[]) => { record('showMessageBoxSync', args); return 1; };
    (dialog as any).showSaveDialog = async (...args: any[]) => { record('showSaveDialog', args); return { canceled: true, filePath: '' }; };
    (dialog as any).showOpenDialog = async (...args: any[]) => { record('showOpenDialog', args); return { canceled: true, filePaths: [] }; };
    (dialog as any).showErrorBox = (...args: any[]) => { record('showErrorBox', args); };

    // Which channels main pushes to the host renderers (external-nav and friends).
    const wrap = (win: any) => {
      const wc = win.webContents;
      if (wc.__nibWrapped) return;
      wc.__nibWrapped = true;
      const send = wc.send.bind(wc);
      wc.send = (channel: string, ...rest: unknown[]) => {
        probe.sends.push({ channel, arg: rest[0] });
        return send(channel, ...rest);
      };
    };
    BrowserWindow.getAllWindows().forEach(wrap);
    electronApp.on('browser-window-created', (_e, win) => wrap(win));
  });
}

export async function snapshot(app: ElectronApplication): Promise<ProbeSnapshot> {
  return app.evaluate(() => {
    const p = (globalThis as any).__nibProbe;
    return JSON.parse(JSON.stringify({ partitions: p.partitions, downloads: p.downloads, openExternal: p.openExternal, dialogCalls: p.dialogCalls, sends: p.sends }));
  });
}

/** Answers for the next native dialogs, in order (0 = Allow, 1 = Cancel). Empty queue answers Cancel. */
export async function queueDialogAnswers(app: ElectronApplication, answers: number[]): Promise<void> {
  await app.evaluate((_m, list) => {
    (globalThis as any).__nibProbe.dialogQueue = list.slice();
  }, answers);
}

export async function webContentsCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((w) => !w.isDestroyed()).length);
}

/**
 * Live Electron `Session` objects in main's V8 heap (Electron has no public `getAllSessions`).
 * `v8.queryObjects` counts instances the garbage collector has not freed; -1 when unavailable.
 */
export async function sessionCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ session }) => {
    try {
      const v8 = (process as any).getBuiltinModule('v8');
      const ctor = Object.getPrototypeOf(session.defaultSession).constructor;
      return v8.queryObjects(ctor, { format: 'count' }) as number;
    } catch {
      return -1;
    }
  });
}

/** JS in the page of the web contents that belongs to partition `name`. `gesture` = as if a user gesture was active. */
export async function evalInPartition<T = unknown>(
  app: ElectronApplication,
  name: string,
  code: string,
  gesture = false,
): Promise<T> {
  return app.evaluate(
    async ({ session, webContents }, arg) => {
      const ses = session.fromPartition(arg.name);
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === ses);
      if (!wc) throw new Error(`no web contents in partition ${arg.name}`);
      // A page that failed to load (blocked redirect) can leave executeJavaScript pending forever.
      return Promise.race([
        wc.executeJavaScript(arg.code, arg.gesture),
        new Promise((_, reject) => setTimeout(() => reject(new Error('executeJavaScript timed out after 6s')), 6000)),
      ]);
    },
    { name, code, gesture },
  ) as Promise<T>;
}

export async function urlInPartition(app: ElectronApplication, name: string): Promise<string | null> {
  return app.evaluate(
    ({ session, webContents }, partition) => {
      const ses = session.fromPartition(partition);
      const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === ses);
      return wc ? wc.getURL() : null;
    },
    name,
  );
}

/** Poll `code` in the partition's page until it returns truthy (or time runs out). */
export async function waitInPartition<T = unknown>(
  app: ElectronApplication,
  name: string,
  code: string,
  timeoutMs = 15_000,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      last = await evalInPartition<T>(app, name, code);
      if (last) return last;
    } catch {
      // page not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
}

/** Input the app's recency tracker accepts as the user's: a click delivered to the host window. */
export async function realUserClick(host: Page): Promise<void> {
  await host.mouse.click(300, 300);
}

export async function invoke<T = any>(host: Page, channel: string, ...args: unknown[]): Promise<T> {
  return host.evaluate(({ ch, a }) => (window as any).electronAPI.invoke(ch, ...a), { ch: channel, a: args });
}

/**
 * What a fresh page in `partition` sees of storage. `url` is loaded in a hidden window that uses that
 * partition (the stored data of a closed portal could only be read this way, by the same partition name).
 */
export async function probePartitionStorage(
  app: ElectronApplication,
  partition: string,
  url: string,
): Promise<{ cookie: string; idbDatabases: string[]; swRegistrations: number; localStorageKeys: string[]; cacheNames: string[]; cookieJar: number }> {
  return app.evaluate(
    async ({ BrowserWindow, session }, arg) => {
      const ses = session.fromPartition(arg.partition);
      const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { partition: arg.partition, sandbox: true, contextIsolation: true } });
      try {
        await win.loadURL(arg.url);
        const page = await win.webContents.executeJavaScript(`(async () => ({
          cookie: document.cookie,
          idbDatabases: (await indexedDB.databases()).map((d) => d.name),
          swRegistrations: (await navigator.serviceWorker.getRegistrations()).length,
          localStorageKeys: Object.keys(localStorage),
          cacheNames: await caches.keys(),
        }))()`);
        const jar = await ses.cookies.get({});
        return { ...page, cookieJar: jar.length };
      } finally {
        win.destroy();
      }
    },
    { partition, url },
  );
}
