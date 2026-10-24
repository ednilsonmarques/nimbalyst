/**
 * F1.3a: console and network observability of the Portal fixture (test-only).
 *
 * Main side (`installCapture`): listeners installed through Playwright's
 * `electronApp.evaluate` on every web contents (existing and future, via
 * `web-contents-created`). They only OBSERVE: no `session.webRequest` (one
 * listener per event, it would replace the product's guards), no debugging
 * port, no `preventDefault`, nothing injected into a page. Listened events:
 *   console-message                          -> console lines (all levels)
 *   did-start-navigation / did-redirect-navigation / did-frame-navigate
 *                                            -> document and frame navigations, redirects, HTTP status
 *   did-fail-load                            -> failed loads (net error code)
 *   will-navigate / will-frame-navigate / will-redirect
 *                                            -> read back after the product's guard ran: blocked navigations
 *   render-process-gone / preload-error      -> renderer failures
 * Events are buffered in main (capped) and drained by the test after every case.
 * Subresources (fetch, img) are seen only through the fixture servers' request
 * logs. A subresource that fails before reaching a server (connection refused)
 * is NOT observable here: Chromium keeps its "Failed to load resource" line for
 * DevTools and does not emit it as console-message (seen in real Electron 43).
 * Failed document and frame loads are observable (did-fail-load).
 *
 * Test side (`PortalCapture`): keeps the raw events in memory, assigns them to
 * cases by timestamp, redacts and classifies them (captureFormat.ts) and writes
 *   portal-console.jsonl, portal-network.jsonl, portal-capture-summary.json
 * into %TEMP%\nib-portal-capture (or PORTAL_FIXTURE_CAPTURE_DIR, which must be
 * under %TEMP%). Nothing raw is ever written. The capture never fails a test by
 * itself; the OBS case of the spec checks the capture against known stimuli.
 */
import type { ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRecords,
  makeSanitizer,
  toJsonl,
  type CaptureSummary,
  type CaseWindow,
  type RawEvent,
  type RawServerRequest,
} from './captureFormat';
import { FIXTURE_ORIGINS, type FixtureServer } from './fixtureServers';
import { isInsideTemp } from './runGuard';

export const CAPTURE_FILES = {
  console: 'portal-console.jsonl',
  network: 'portal-network.jsonl',
  summary: 'portal-capture-summary.json',
} as const;

/** Install the observe-only listeners in main. Idempotent. */
export async function installCapture(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, webContents, session }) => {
    const g = globalThis as any;
    if (g.__nibCapture) return;
    const MAX_EVENTS = 20_000;
    const cap: any = (g.__nibCapture = { events: [] as any[], dropped: 0, errors: [] as string[] });
    const push = (e: any) => {
      if (cap.events.length >= MAX_EVENTS) cap.dropped++;
      else cap.events.push(e);
    };
    const fail = (where: string, e: unknown) => {
      if (cap.errors.length < 50) cap.errors.push(`${where}: ${String((e as any)?.message ?? e).slice(0, 200)}`);
    };

    // Which page an event came from, resolved when it happens. The partition name comes from the probe's
    // WeakMap (portalHost.ts), so no Session object is kept alive by the capture.
    const contextOf = (wc: any): { context: string; partition?: string } => {
      try {
        if (wc.__nibHarness) return { context: 'harness' };
        const name = g.__nibProbe?.partitionOf?.get(wc.session);
        if (typeof name === 'string') {
          if (name.startsWith('agent-portal-')) return { context: 'portal', partition: name };
          if (name === 'browser-preview') return { context: 'user-tab', partition: name };
          return { context: 'other', partition: name };
        }
        if (wc.session === session.defaultSession) return { context: 'host' };
        return { context: 'other' };
      } catch {
        return { context: 'unknown' };
      }
    };
    const base = (wc: any) => {
      let pageUrl: string | undefined;
      try {
        pageUrl = wc.getURL();
      } catch {
        // destroyed
      }
      return { ts: Date.now(), wcId: wc.id, ...contextOf(wc), pageUrl };
    };
    const frameKind = (frame: any): 'main' | 'sub' | undefined => {
      try {
        return frame ? (frame.parent ? 'sub' : 'main') : undefined;
      } catch {
        return undefined;
      }
    };
    const LEVELS = ['debug', 'info', 'warning', 'error'];

    const attach = (wc: any) => {
      if (!wc || wc.__nibCaptureAttached) return;
      wc.__nibCaptureAttached = true;
      // A zero-arity wrapper: Electron decides which console-message signature to pass from the listeners' arity.
      const on = (name: string, fn: (...a: any[]) => void) =>
        wc.on(name, (...a: any[]) => {
          try {
            fn(...a);
          } catch (e) {
            fail(name, e);
          }
        });

      on('console-message', (e: any, lvl?: any, msg?: any, line?: any, src?: any) => {
        const level = typeof e?.level === 'string' ? e.level : typeof lvl === 'number' ? (LEVELS[lvl] ?? String(lvl)) : 'info';
        const message = typeof e?.message === 'string' ? e.message : String(msg ?? '');
        push({
          type: 'console',
          ...base(wc),
          level,
          message: message.slice(0, 4000),
          sourceUrl: typeof e?.sourceId === 'string' ? e.sourceId : typeof src === 'string' ? src : undefined,
          line: typeof e?.lineNumber === 'number' ? e.lineNumber : typeof line === 'number' ? line : undefined,
          frame: frameKind(e?.frame),
        });
      });
      on('did-start-navigation', (d: any, url?: any, inPlace?: any, isMain?: any) => {
        if (d?.isSameDocument ?? inPlace) return;
        push({ type: 'net', kind: 'navigation-start', ...base(wc), url: d?.url ?? url, frame: (d?.isMainFrame ?? isMain) ? 'main' : 'sub' });
      });
      on('did-redirect-navigation', (d: any, url?: any, inPlace?: any, isMain?: any) => {
        if (d?.isSameDocument ?? inPlace) return;
        push({ type: 'net', kind: 'redirect', ...base(wc), url: d?.url ?? url, frame: (d?.isMainFrame ?? isMain) ? 'main' : 'sub' });
      });
      on('did-frame-navigate', (_e: any, url: string, code: number, _text: string, isMain: boolean) => {
        push({ type: 'net', kind: 'response', ...base(wc), url, status: code > 0 ? code : undefined, frame: isMain ? 'main' : 'sub' });
      });
      on('did-fail-load', (_e: any, code: number, desc: string, url: string, isMain: boolean) => {
        push({ type: 'net', kind: 'load-failed', ...base(wc), url, errorCode: code, errorDescription: desc, frame: isMain ? 'main' : 'sub' });
      });
      // The product's guards run after these listeners (they attach later); read the verdict once emit returned.
      // For the main frame Electron emits will-navigate only when will-frame-navigate was not prevented, so a
      // blocked navigation is recorded once.
      for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
        on(name, (d: any, url?: any) => {
          const target = d?.url ?? url;
          const isMain = name === 'will-navigate' ? true : (d?.isMainFrame ?? true);
          const at = base(wc);
          setTimeout(() => {
            try {
              if (d?.defaultPrevented) push({ type: 'net', kind: 'navigation-blocked', ...at, url: target, errorDescription: name, frame: isMain ? 'main' : 'sub' });
            } catch (e) {
              fail(name, e);
            }
          }, 0);
        });
      }
      on('render-process-gone', (_e: any, details: any) => {
        push({ type: 'net', kind: 'renderer-gone', ...base(wc), errorDescription: `${details?.reason ?? 'gone'} (exit ${details?.exitCode ?? '?'})` });
      });
      on('preload-error', (_e: any, _preloadPath: string, error: any) => {
        push({ type: 'net', kind: 'preload-error', ...base(wc), errorDescription: String(error?.message ?? error).slice(0, 300) });
      });
    };

    webContents.getAllWebContents().forEach(attach);
    electronApp.on('web-contents-created', (_e, wc) => attach(wc));
  });
}

/** Take (and clear) the events buffered in main. */
export async function drainCapture(app: ElectronApplication): Promise<{ events: RawEvent[]; dropped: number; errors: string[] } | null> {
  return app.evaluate(() => {
    const c = (globalThis as any).__nibCapture;
    if (!c) return null;
    return JSON.parse(JSON.stringify({ events: c.events.splice(0), dropped: c.dropped, errors: c.errors.slice() }));
  });
}

export function captureDir(): string {
  const dir = path.resolve(process.env.PORTAL_FIXTURE_CAPTURE_DIR || path.join(os.tmpdir(), 'nib-portal-capture'));
  if (!isInsideTemp(dir)) throw new Error(`Portal capture: ${dir} is not under %TEMP% (artifacts never go into the repository)`);
  return dir;
}

export interface CaptureHealth {
  mainDropped: number;
  listenerErrors: string[];
  drainErrors: string[];
}

/** Bounds on what one run may hold and write (a page that loops on errors must not turn the artifacts into a dump). */
const MAX_RAW_EVENTS = 100_000;
const MAX_LINES_PER_FILE = 5_000;
const MAX_SUMMARY_LIST = 100;
const PULL_TIMEOUT_MS = 10_000;

export interface CaptureLimits {
  rawDropped: number;
  linesDropped: { console: number; network: number };
  summaryListsCut: Record<string, number>;
}

export class PortalCapture {
  readonly dir: string;
  private raw: RawEvent[] = [];
  private windows: CaseWindow[] = [];
  private openCase: { id: string; start: number } | null = null;
  private secrets = new Set<string>();
  private health: CaptureHealth = { mainDropped: 0, listenerErrors: [], drainErrors: [] };
  private rawDropped = 0;

  constructor(private readonly servers: () => Record<string, FixtureServer | undefined>) {
    this.dir = captureDir();
    fs.mkdirSync(this.dir, { recursive: true });
    // Only this capture's own files are replaced; nothing else in the folder is touched.
    for (const name of Object.values(CAPTURE_FILES)) fs.rmSync(path.join(this.dir, name), { force: true });
  }

  addSecrets(...values: Array<string | undefined>): void {
    for (const v of values) if (v) this.secrets.add(v);
  }

  caseStart(id: string): void {
    this.openCase = { id, start: Date.now() };
  }

  caseEnd(): void {
    if (this.openCase) this.windows.push({ ...this.openCase, end: Date.now() });
    this.openCase = null;
  }

  /**
   * Pull what main buffered. Never throws and never hangs: a failed or timed-out drain (app gone or stuck) is recorded
   * in the summary, so the caller (afterAll, before shutdown) always goes on.
   */
  async pull(app: ElectronApplication | undefined): Promise<void> {
    if (!app) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      const d = await Promise.race([
        drainCapture(app),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`drain timed out after ${PULL_TIMEOUT_MS} ms`)), PULL_TIMEOUT_MS);
        }),
      ]);
      if (!d) return;
      const room = Math.max(0, MAX_RAW_EVENTS - this.raw.length);
      this.raw.push(...d.events.slice(0, room));
      this.rawDropped += Math.max(0, d.events.length - room);
      this.health.mainDropped = d.dropped;
      this.health.listenerErrors = d.errors;
    } catch (err) {
      this.health.drainErrors.push(String((err as Error)?.message ?? err).slice(0, 200));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private serverRequests(): RawServerRequest[] {
    const out: RawServerRequest[] = [];
    for (const [name, server] of Object.entries(this.servers())) {
      for (const r of server?.requests ?? []) {
        out.push({ server: name, ts: r.ts, method: r.method, url: r.url, status: r.status, known: r.known, aborted: r.aborted, headers: r.headers });
      }
    }
    return out;
  }

  private sanitizer() {
    const tmp = os.tmpdir();
    let tmpLong = tmp;
    try {
      tmpLong = fs.realpathSync.native(tmp);
    } catch {
      // keep the short form only
    }
    return makeSanitizer({
      secrets: [...this.secrets],
      home: os.homedir(),
      tmpDirs: [tmp, tmpLong],
      repoRoot: path.resolve(__dirname, '..', '..', '..', '..'),
      user: os.userInfo().username,
    });
  }

  /** The capture's redaction, for text the spec writes elsewhere (results.json). Never throws. */
  redact(text: string): string {
    try {
      return this.sanitizer().text(text);
    } catch {
      return '(redaction unavailable)';
    }
  }

  /** Redact, classify and (re)write the three artifacts. */
  write(): { files: string[]; summary: CaptureSummary & { capture: CaptureHealth & CaptureLimits & { caseWindows: CaseWindow[] } } } {
    const servers = this.servers();
    const origins: Record<string, string> = {};
    for (const [name, server] of Object.entries(servers)) if (server) origins[name] = server.origin;
    const sanitizer = this.sanitizer();
    const windows = [...this.windows, ...(this.openCase ? [{ ...this.openCase, end: Date.now() }] : [])];
    const built = buildRecords(this.raw, this.serverRequests(), {
      windows,
      serverOrigins: origins,
      allowedOrigins: FIXTURE_ORIGINS,
      sanitizer,
    });
    // Records come out in time order, so a cut keeps the earliest ones; what was cut is counted, never silent.
    const lists = { http4xx5xx: built.summary.http4xx5xx, failedRequests: built.summary.failedRequests, unexpected: built.summary.unexpected };
    const summary = {
      ...built.summary,
      http4xx5xx: lists.http4xx5xx.slice(0, MAX_SUMMARY_LIST),
      failedRequests: lists.failedRequests.slice(0, MAX_SUMMARY_LIST),
      unexpected: lists.unexpected.slice(0, MAX_SUMMARY_LIST),
      capture: {
        mainDropped: this.health.mainDropped,
        listenerErrors: this.health.listenerErrors.map((e) => sanitizer.text(e)),
        drainErrors: this.health.drainErrors.map((e) => sanitizer.text(e)),
        rawDropped: this.rawDropped,
        linesDropped: {
          console: Math.max(0, built.console.length - MAX_LINES_PER_FILE),
          network: Math.max(0, built.network.length - MAX_LINES_PER_FILE),
        },
        summaryListsCut: Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, Math.max(0, v.length - MAX_SUMMARY_LIST)])),
        caseWindows: windows,
      },
    };
    const files = [CAPTURE_FILES.console, CAPTURE_FILES.network, CAPTURE_FILES.summary].map((f) => path.join(this.dir, f));
    fs.writeFileSync(files[0], toJsonl(built.console.slice(0, MAX_LINES_PER_FILE)));
    fs.writeFileSync(files[1], toJsonl(built.network.slice(0, MAX_LINES_PER_FILE)));
    fs.writeFileSync(files[2], `${JSON.stringify(summary, null, 2)}\n`);
    return { files, summary };
  }
}
