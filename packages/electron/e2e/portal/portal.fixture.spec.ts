/**
 * Portal fixture (M-9, gate before agents may use the Portal): the F0-F1.2
 * behaviours against REAL Electron 43, in an isolated profile.
 *
 *   build out2 first (exact commands: e2e/portal/README.md, Build)
 *   npx playwright test -c playwright.portal.config.ts
 *
 * Everything goes through `launchIsolated` (isolatedLaunch.ts): a separate
 * build (`out2`), a temp profile and DB, analytics off, a NODE_ENV that keeps
 * the app from opening its own CDP port, and the nimbalyst:// registry key
 * exported before and restored after. Agents are real MCP connections
 * (`/mcp/core?sessionId=...`) against the app's own HTTP server, with sessions
 * created through the app's own IPC. Page-side facts are read from the portal's
 * web contents in main (the test acts as the inspector, never as an agent).
 *
 * Every case records {expected, observed, status} in the file named by
 * PORTAL_FIXTURE_RESULTS (default: a temp file) so the report is generated
 * from what ran, not from what was meant to run.
 */
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchIsolated, listeningPorts, readRegistryKey, stillAlive, type IsolatedLaunch } from './isolatedLaunch';
import { ENV, runTempDir } from './runGuard';
import { deadOrigin, OBS_CANARIES, startOtherServer, startPrimaryServer, type FixtureServer } from './fixtureServers';
import { installCapture, PortalCapture } from './capture';
import { McpConnection } from './mcpClient';
import {
  evalInPartition,
  installProbes,
  invoke,
  probePartitionStorage,
  queueDialogAnswers,
  realUserClick,
  sessionCount,
  snapshot,
  urlInPartition,
  waitInPartition,
  webContentsCount,
} from './portalHost';

// Only playwright.portal.config.ts sets this; the default `test:e2e` configs ignore e2e/portal and, if it were
// ever picked up, this skips everything before any hook can launch the app.
test.skip(process.env[ENV.fixture] !== '1', 'Portal fixture: run with playwright.portal.config.ts');

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// result recording
// ---------------------------------------------------------------------------
interface Check { desc: string; ok: boolean; observed: string }
interface CaseRecord { id: string; title: string; expected: string; checks: Check[]; status: 'PASS' | 'FAIL' | 'NOT RUN' | 'PARTIAL'; note?: string }
const cases = new Map<string, CaseRecord>();
const RESULTS_FILE = process.env.PORTAL_FIXTURE_RESULTS || path.join(os.tmpdir(), 'nib-portal-fixture-results.json');
const evidence: Record<string, unknown> = {};

function begin(id: string, title: string, expected: string): CaseRecord {
  const rec: CaseRecord = { id, title, expected, checks: [], status: 'PASS' };
  cases.set(id, rec);
  return rec;
}
function check(rec: CaseRecord, desc: string, ok: boolean, observed: unknown): void {
  const text = typeof observed === 'string' ? observed : JSON.stringify(observed);
  rec.checks.push({ desc, ok, observed: text.length > 600 ? `${text.slice(0, 600)}...` : text });
  if (!ok) rec.status = 'FAIL';
  // No assertion here: a failed check must not stop the remaining cases (serial mode would skip them).
  // The SUMMARY test at the end fails the run when any check failed.
}
function flush(): void {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify({ cases: [...cases.values()], evidence }, null, 2));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A case that throws is recorded as FAIL and the run goes on (serial mode would skip the rest). */
function guarded(prefix: string, body: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await body();
    } catch (err) {
      const rec = [...cases.values()].filter((c) => c.id === prefix).pop() ?? begin(prefix, prefix, '(case aborted)');
      check(rec, 'case ran to completion without an unexpected exception', false, err instanceof Error ? `${err.message}`.slice(0, 500) : String(err));
      flush();
    }
  };
}

// ---------------------------------------------------------------------------
// shared state
// ---------------------------------------------------------------------------
let run: IsolatedLaunch;
let app: ElectronApplication;
let host: Page;
let s1: FixtureServer; // the preview origin
let other: FixtureServer; // another origin
let ws1: string; // project P1 (has the window)
let ws2: string; // project P2 (no window)
let mcpPort: number;
let mcpToken: string;
const conns: Record<string, McpConnection> = {};
const EXT_BUILD = path.join(os.tmpdir(), 'nib-portal-extbuild');
// F1.3a: console and network capture (capture.ts). Observes only; it never fails a case by itself.
let capture: PortalCapture | undefined;

/** Write the capture artifacts; a failure to write is evidence, not a crash of the case. */
function writeCapture(): ReturnType<PortalCapture['write']> | undefined {
  try {
    return capture?.write();
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    evidence.captureWriteError = (capture ? capture.redact(message) : '(capture unavailable)').slice(0, 300);
    return undefined;
  }
}

async function agent(id: string, workspace: string): Promise<McpConnection> {
  const created = await invoke(host, 'sessions:create', { session: { id, provider: 'claude-code', title: id }, workspaceId: workspace });
  expect(created.success, `create session ${id}`).toBe(true);
  const conn = new McpConnection(mcpPort, mcpToken, '/mcp/core', id, workspace);
  await conn.initialize();
  conns[id] = conn;
  return conn;
}

/** portal_open through MCP; returns the portal id and the partition main chose for it. */
async function openPortal(conn: McpConnection, url: string, readyWaitMs = 15_000): Promise<{ id: string; partition: string }> {
  const before = (await snapshot(app)).partitions.length;
  const opened = await conn.callJson<{ sessionId: string }>('portal_open', { url });
  const after = (await snapshot(app)).partitions;
  const partition = after.slice(before).filter((p) => p.startsWith('agent-portal-')).pop() ?? '';
  await waitInPartition(app, partition, `document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(url.split('?')[0].replace(/\/$/, ''))})`, readyWaitMs);
  return { id: opened.sessionId, partition };
}

async function listIds(conn: McpConnection): Promise<string[]> {
  return (await conn.callJson<{ sessionIds: string[] }>('portal_list')).sessionIds;
}

async function closeAll(conn: McpConnection): Promise<void> {
  for (const id of await listIds(conn)) await conn.call('portal_close', { sessionId: id });
}

async function setMark(project: string, enabled: boolean, answers: number[] = []): Promise<any> {
  await queueDialogAnswers(app, answers);
  await realUserClick(host);
  return invoke(host, 'portal:set-test-data', project, enabled);
}
async function setPorts(project: string, ports: number[], answers: number[] = []): Promise<any> {
  await queueDialogAnswers(app, answers);
  await realUserClick(host);
  return invoke(host, 'portal:set-interaction-ports', project, ports);
}
async function getMark(project: string): Promise<{ enabled: boolean; ports: number[] }> {
  const r = await invoke(host, 'portal:get-test-data', project);
  return { enabled: r.enabled, ports: r.ports };
}

test.beforeAll(async () => {
  other = await startOtherServer();
  s1 = await startPrimaryServer(() => other.origin);
  capture = new PortalCapture(() => ({ s1, other }));
  ws1 = runTempDir('nib-portal-ws-');
  ws2 = runTempDir('nib-portal-ws-');
  fs.writeFileSync(path.join(ws1, 'index.html'), '<!doctype html><title>ws1 index</title><button id="b" onclick="document.title=\'ws1 clicked\'">b</button>');
  fs.writeFileSync(path.join(ws2, 'index.html'), '<!doctype html><title>ws2 index</title><button id="b">b</button>');

  run = await launchIsolated({ workspace: ws1, extensionsFrom: EXT_BUILD });
  app = run.app;
  host = await app.firstWindow();
  await installCapture(app);
  await host.waitForLoadState('domcontentloaded');
  await host.waitForSelector('.workspace-sidebar', { timeout: 60_000 });
  await sleep(5000); // let the extension system and MCP config settle
  mcpPort = (await invoke(host, 'mcp:get-server-port')).port;
  mcpToken = (await invoke(host, 'mcp:get-auth-token')).token;
  capture.addSecrets(mcpToken);
  await installProbes(app);

  evidence.startup = {
    pids: run.pids,
    listenersAfterStartup: listeningPorts(run.pids),
    mainArgv: await app.evaluate(() => process.argv),
    nodeEnv: await app.evaluate(() => process.env.NODE_ENV),
    userData: await app.evaluate(({ app: a }) => a.getPath('userData')),
    isPackaged: await app.evaluate(({ app: a }) => a.isPackaged),
    ports: { s1: s1.port, other: other.port, mcp: mcpPort },
    workspaces: { ws1, ws2 },
    registryAtLaunch: readRegistryKey(),
  };

  await agent('sess-A', ws1);
  await agent('sess-B', ws1);
  await agent('sess-C', ws2);
  await agent('sess-D', ws1);
  flush();
});

// Each case's time window lets the capture attribute events to it; the buffer in main is emptied after every case.
test.beforeEach(async ({}, testInfo) => {
  capture?.caseStart(testInfo.title.split(' ')[0]);
});
test.afterEach(async () => {
  capture?.caseEnd();
  await capture?.pull(app);
  writeCapture();
});

test.afterAll(async () => {
  try {
    await capture?.pull(app); // before the app goes away
    evidence.listenersAtEnd = listeningPorts(run?.pids ?? []);
    evidence.registryBeforeShutdown = readRegistryKey();
  } catch {
    // evidence only
  }
  let shutdown;
  try {
    shutdown = await run?.shutdown();
  } finally {
    await s1?.close();
    await other?.close();
    const written = writeCapture();
    if (written) {
      // "Did the Portal err while the case passed?": portal-context failures of cases whose own checks passed.
      const portalErrorsInPassingCases = Object.entries(written.summary.portalFailuresByCase)
        .filter(([id]) => cases.get(id)?.status === 'PASS')
        .map(([id, n]) => ({ case: id, portalFailures: n }));
      evidence.capture = { dir: capture?.dir, policy: written.summary.policy, answers: written.summary.answers, portal: written.summary.portal, portalErrorsInPassingCases, health: written.summary.capture };
    }
  }
  if (shutdown) {
    evidence.shutdown = shutdown;
    evidence.droppedEnv = run?.droppedEnv;
    evidence.launchTree = run?.procs.map((p) => ({ pid: p.pid, ppid: p.ppid, created: p.created, exe: p.exe, cmd: (p.cmd ?? '').slice(0, 160) }));
    evidence.launchRefused = run?.launchRefused;
    const rec = begin('ISO', 'Process cleanup and registry restore', 'registry equals the pre-launch value; no process of the run survives');
    check(rec, 'registry restored to the pre-launch value', shutdown.registryRestored, { restored: shutdown.registryRestored });
    check(rec, 'no process of the launched tree survives', shutdown.survivingPids.length === 0, shutdown.survivingPids);
    check(rec, 'tree processes gone (same pid AND creation time)', stillAlive(run.procs).length === 0, stillAlive(run.procs).map((p) => p.pid));
    check(rec, 'no process failed the identity checks (nothing left that the run could not safely kill)', shutdown.refusals.length === 0, { stillRunningAndRefused: shutdown.refusals, refusedAtLaunchAndGoneByShutdown: run.launchRefused });
    flush();
    // An unrestored registry or a leftover process FAILS the run (not only a line in results.json).
    if (!shutdown.registryRestored || shutdown.survivingPids.length > 0 || stillAlive(run.procs).length > 0 || shutdown.refusals.length > 0) {
      throw new Error(`Isolation failure at shutdown: registryRestored=${shutdown.registryRestored}, surviving=${JSON.stringify(shutdown.survivingPids)}`);
    }
  }
  flush();
});

// ---------------------------------------------------------------------------
// C0 isolation of the launch itself
// ---------------------------------------------------------------------------
test('C0 launch isolation: separate build, temp profile, no app-opened debug port', async () => {
  const rec = begin('C0', 'Launch isolation', 'out2 entry, userData under %TEMP%\\nib-portal-*, no 9222 listener, app opened no CDP port of its own');
  const ev = evidence.startup as any;
  check(rec, 'userData is inside the temp profile', String(ev.userData).startsWith(run.userDataDir), ev.userData);
  check(rec, 'app is unpackaged out2 build (argv[1] is out2/main/index.js)', /out2[\\/]main[\\/]index\.js$/.test(String(ev.mainArgv[1])), ev.mainArgv.slice(0, 3));
  check(rec, 'NODE_ENV=production keeps the app from opening its own CDP port', ev.nodeEnv === 'production', ev.nodeEnv);
  const ports = (ev.listenersAfterStartup as Array<{ port: number }>).map((p) => p.port);
  check(rec, 'nothing listens on 9222', !ports.includes(9222), ports);
  const debugArgs = (ev.mainArgv as string[]).filter((a) => /remote-debugging|inspect/.test(a));
  evidence.debugArgsInMainArgv = debugArgs;
  rec.checks.push({ desc: "Playwright's own channel (allowed, unpackaged test run only)", ok: true, observed: JSON.stringify({ argvDebugSwitches: debugArgs, listeners: ev.listenersAfterStartup }) });
  flush();
});

// ---------------------------------------------------------------------------
// C1 cross-agent isolation (+ user tab, + cap of 2)
// ---------------------------------------------------------------------------
test('C1 two agents: B cannot list, drive or close A\'s portal; neither reaches a user tab', guarded('C1', async () => {
  const rec = begin('C1', 'Cross-agent isolation', 'B (and A) are refused on every portal_* operation targeting the other agent\'s portal or a user tab; the portal is unchanged');
  const A = conns['sess-A'];
  const B = conns['sess-B'];
  const pa = await openPortal(A, `${s1.origin}/`);
  const pb = await openPortal(B, `${s1.origin}/`);
  check(rec, 'each agent got its own in-memory agent-portal partition', pa.partition.startsWith('agent-portal-') && pb.partition.startsWith('agent-portal-') && pa.partition !== pb.partition, [pa.partition, pb.partition]);

  check(rec, 'A lists only its portal', JSON.stringify(await listIds(A)) === JSON.stringify([pa.id]), await listIds(A));
  check(rec, 'B lists only its portal', JSON.stringify(await listIds(B)) === JSON.stringify([pb.id]), await listIds(B));

  // a user tab (no actor), created through the app's own IPC the way the UI does
  const userTab = await invoke(host, 'browser-session:create', { sessionId: 'user-tab-1', url: `${s1.origin}/`, headless: true });
  check(rec, 'user tab created by the UI path', userTab.success === true, userTab);
  await waitInPartition(app, 'browser-preview', `document.readyState === 'complete'`, 15_000);

  const targets: Array<[string, string, Record<string, unknown>]> = [
    ['portal_navigate', 'navigate', { url: `${s1.origin}/idb.html` }],
    ['portal_page_info', 'page_info', {}],
    ['portal_screenshot', 'screenshot', {}],
    ['portal_scroll', 'scroll', { dy: 10 }],
    ['portal_close', 'close', {}],
  ];
  for (const [victim, victimId] of [['A\'s portal (as B)', pa.id], ['A\'s portal (as C)', pa.id], ['user tab (as A)', 'user-tab-1'], ['user tab (as B)', 'user-tab-1'], ['B\'s portal (as A)', pb.id]] as const) {
    const attacker = victim.endsWith('(as B)') ? B : victim.endsWith('(as C)') ? conns['sess-C'] : A;
    for (const [tool, , extra] of targets) {
      const res = await attacker.call(tool, { sessionId: victimId, ...extra });
      check(rec, `${tool} on ${victim} is refused as "No browser session"`, res.isError === true && /No browser session/.test(res.text), res.text.slice(0, 160));
    }
  }
  // click/type/evaluate on a foreign portal: refused (mark off here; the marked variant is in C6)
  for (const tool of ['portal_click', 'portal_type', 'portal_evaluate']) {
    const res = await B.call(tool, { sessionId: pa.id, selector: '#btn', text: 'x', script: '1+1' });
    check(rec, `${tool} on A's portal (as B) is refused as "No browser session"`, res.isError === true && /No browser session/.test(res.text), res.text.slice(0, 160));
  }

  // nothing changed
  check(rec, 'A\'s portal still alive, same URL, untouched', (await listIds(A)).includes(pa.id) && (await urlInPartition(app, pa.partition)) === `${s1.origin}/`, await urlInPartition(app, pa.partition));
  check(rec, 'B\'s portal still alive (A\'s attempts did not close it)', (await listIds(B)).includes(pb.id), await listIds(B));
  check(rec, 'user tab still alive at its URL', (await urlInPartition(app, 'browser-preview')) === `${s1.origin}/`, await urlInPartition(app, 'browser-preview'));
  const ownList = await A.call('portal_page_info', { sessionId: pa.id });
  check(rec, 'A can still use its own portal', ownList.isError === false, ownList.text.slice(0, 120));

  // cap: a third portal for one agent is refused (fixture case 17)
  const second = await openPortal(A, `${s1.origin}/`);
  const third = await A.call('portal_open', { url: `${s1.origin}/` });
  check(rec, '3rd portal for one agent is refused with the limit message', third.isError === true && /at most 2/.test(third.text), third.text.slice(0, 200));
  await A.call('portal_close', { sessionId: second.id });
  const afterClose = await A.call('portal_open', { url: `${s1.origin}/` });
  check(rec, 'after closing one, the next opens', afterClose.isError === false, afterClose.text.slice(0, 120));

  await closeAll(A);
  await closeAll(B);
  await invoke(host, 'browser-session:destroy', { sessionId: 'user-tab-1' });
  flush();
}));

// ---------------------------------------------------------------------------
// C2 legacy paths
// ---------------------------------------------------------------------------
test('C2 legacy: agent browser_* runs in main; browser-session IPC refuses forged/stale actors', guarded('C2', async () => {
  const rec = begin('C2', 'Legacy paths', 'browser_* from an MCP agent never hops to the renderer; browser-session:* with a forged/bare/garbage actor is refused');

  // (a) browser_* tools of the (temp-profile) browser extension over MCP, solo session A
  const E = new McpConnection(mcpPort, mcpToken, '/mcp/ext/browser', 'sess-A', ws1);
  await E.initialize();
  const tools = await E.listTools();
  check(rec, 'browser extension tools are served to a session', tools.includes('browser_open_session'), tools);
  const sendsBefore = (await snapshot(app)).sends.length;
  const opened = await E.call('browser_open_session', { url: `${s1.origin}/` });
  check(rec, 'browser_open_session by an agent succeeds', opened.isError === false, opened.text.slice(0, 200));
  let browserId = '';
  try {
    browserId = JSON.parse(opened.text).sessionId ?? '';
  } catch {
    const m = /"sessionId":\s*"([^"]+)"/.exec(opened.text);
    browserId = m?.[1] ?? '';
  }
  const listed = await E.call('browser_list_sessions', {});
  check(rec, 'it lists only the sessions it owns', listed.text.includes(browserId) && browserId !== '', listed.text.slice(0, 200));
  const sendsAfter = (await snapshot(app)).sends.slice(sendsBefore);
  const hops = sendsAfter.filter((s) => s.channel === 'mcp:executeExtensionTool');
  check(rec, 'no mcp:executeExtensionTool (renderer hop) was sent for browser_* calls', hops.length === 0, { channels: sendsAfter.map((s) => s.channel).slice(0, 12) });
  const parts = (await snapshot(app)).partitions.filter((p) => p.startsWith('agent-portal-'));
  check(rec, 'the agent session got a fresh agent-portal partition (main-chosen)', parts.length >= 1, parts.slice(-2));
  // B cannot see or close A's browser_* session
  const EB = new McpConnection(mcpPort, mcpToken, '/mcp/ext/browser', 'sess-B', ws1);
  await EB.initialize();
  const bList = await EB.call('browser_list_sessions', {});
  check(rec, 'another agent does not list it', !bList.text.includes(browserId), bList.text.slice(0, 160));
  const bClose = await EB.call('browser_close_session', { sessionId: browserId });
  check(rec, 'another agent cannot close it', bClose.isError === true, bClose.text.slice(0, 160));
  await E.call('browser_close_session', { sessionId: browserId });

  // (b) forged / bare / garbage actors on the browser-session IPC (from the host renderer)
  const pa = await openPortal(conns['sess-A'], `${s1.origin}/`);
  const forged = `nimactor_${'ab'.repeat(24)}`;
  const probes: Array<[string, Record<string, unknown>]> = [
    ['browser-session:list-sessions', { actorSessionId: forged }],
    ['browser-session:list-sessions', { actorSessionId: 'sess-A' }],
    ['browser-session:list-sessions', { actorSessionId: 'nimactor_' }],
    ['browser-session:list-sessions', { actorSessionId: 12345 }],
    ['browser-session:get-state', { sessionId: pa.id, actorSessionId: forged }],
    ['browser-session:navigate', { sessionId: pa.id, url: `${s1.origin}/idb.html`, actorSessionId: forged }],
    ['browser-session:screenshot', { sessionId: pa.id, actorSessionId: 'sess-A' }],
    ['browser-session:destroy', { sessionId: pa.id, actorSessionId: forged }],
    ['browser-session:create', { sessionId: 'forged-1', url: `${s1.origin}/`, actorSessionId: forged }],
  ];
  for (const [channel, payload] of probes) {
    const res = await invoke(host, channel, payload);
    // get-state answers "no such session" (state null) to a caller that does not own it: nothing leaks.
    const refused = channel === 'browser-session:get-state' ? res?.success === false || res?.state === null : res?.success === false;
    check(rec, `${channel} with actor ${JSON.stringify(payload.actorSessionId)} is refused`, refused, res);
  }
  check(rec, 'the portal survived every forged call', (await listIds(conns['sess-A'])).includes(pa.id) && (await urlInPartition(app, pa.partition)) === `${s1.origin}/`, await urlInPartition(app, pa.partition));
  const ownState = await invoke(host, 'browser-session:get-state', { sessionId: pa.id });
  check(rec, 'control: get-state with NO actor (the UI) returns a non-null state for the same portal, so the null above is a refusal', ownState?.success === true && ownState.state !== null && ownState.state?.sessionId === pa.id, ownState);
  const control = await invoke(host, 'browser-session:list-sessions', {});
  check(rec, 'control: the UI itself (no actor field) is not refused (documented: the host renderer is trusted)', control?.success === true, control);

  rec.checks.push({ desc: 'expired (previously valid) token', ok: true, observed: 'NOT RUN: tokens are minted only for renderer-executed extension tools and revoked at call end; no extension in this profile runs a renderer tool that echoes aiSessionId. Forged/bare/garbage/type-wrong are covered above; expiry/revocation is covered by BrowserAuthority.test.ts (fakes) only.' });
  rec.note = 'expired-token sub-case not exercised in real Electron';
  await closeAll(conns['sess-A']);
  flush();
}));

// ---------------------------------------------------------------------------
// C3 per-portal partition, wipe, cycles
// ---------------------------------------------------------------------------
test('C3 partition: cookie/IndexedDB/service worker stay in their portal and vanish with it; N cycles', guarded('C3', async () => {
  const rec = begin('C3', 'Per-portal partition and wipe', 'A\'s storage is invisible to B and to a user tab; after A closes nothing of A survives; N open/close cycles leave no portal web contents');
  const A = conns['sess-A'];
  const B = conns['sess-B'];
  const pa = await openPortal(A, `${s1.origin}/set-cookie?v=A`);
  const wrote = await evalInPartition<any>(app, pa.partition, `(async () => {
    await new Promise((res, rej) => { const r = indexedDB.open('fx', 1); r.onupgradeneeded = () => r.result.createObjectStore('s');
      r.onsuccess = () => { const tx = r.result.transaction('s', 'readwrite'); tx.objectStore('s').put('A', 'k'); tx.oncomplete = () => { r.result.close(); res(1); }; };
      r.onerror = () => rej(r.error); });
    localStorage.setItem('ls', 'A');
    await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; await caches.open('c-A');
    return { cookie: document.cookie, idb: (await indexedDB.databases()).map((d) => d.name), sw: (await navigator.serviceWorker.getRegistrations()).length, ls: Object.keys(localStorage), caches: await caches.keys() };
  })()`);
  check(rec, 'A really holds cookie + IndexedDB + localStorage + service worker + cache', /fixture_sid=A/.test(wrote.cookie) && wrote.idb.includes('fx') && wrote.sw === 1 && wrote.ls.includes('ls'), wrote);

  const pb = await openPortal(B, `${s1.origin}/`);
  const seenByB = await evalInPartition<any>(app, pb.partition, `(async () => ({ cookie: document.cookie, idb: (await indexedDB.databases()).map((d) => d.name), sw: (await navigator.serviceWorker.getRegistrations()).length, ls: Object.keys(localStorage), caches: await caches.keys() }))()`);
  check(rec, 'B (same origin, other portal) sees none of it', seenByB.cookie === '' && seenByB.idb.length === 0 && seenByB.sw === 0 && seenByB.ls.length === 0 && seenByB.caches.length === 0, seenByB);
  const bRequest = [...s1.requests].reverse().find((r) => r.url === '/');
  check(rec, 'B\'s HTTP request carried no cookie', !bRequest?.headers.cookie, bRequest?.headers.cookie ?? '(none)');

  await invoke(host, 'browser-session:create', { sessionId: 'user-tab-2', url: `${s1.origin}/`, headless: true });
  await waitInPartition(app, 'browser-preview', `document.readyState === 'complete'`, 15_000);
  const seenByUser = await evalInPartition<any>(app, 'browser-preview', `(async () => ({ cookie: document.cookie, idb: (await indexedDB.databases()).map((d) => d.name), sw: (await navigator.serviceWorker.getRegistrations()).length, ls: Object.keys(localStorage) }))()`);
  check(rec, 'a user tab (browser-preview partition) sees none of it', seenByUser.cookie === '' && seenByUser.idb.length === 0 && seenByUser.sw === 0 && seenByUser.ls.length === 0, seenByUser);
  await invoke(host, 'browser-session:destroy', { sessionId: 'user-tab-2' });
  await closeAll(B);

  // close A and look for any survivor in the same partition name
  await A.call('portal_close', { sessionId: pa.id });
  await sleep(1500);
  const survivors = await probePartitionStorage(app, pa.partition, `${s1.origin}/idb.html`);
  check(rec, 'after close, a fresh page in A\'s partition sees no cookie, IndexedDB, service worker, localStorage or cache', survivors.cookie === '' && survivors.idbDatabases.length === 0 && survivors.swRegistrations === 0 && survivors.localStorageKeys.length === 0 && survivors.cacheNames.length === 0 && survivors.cookieJar === 0, survivors);

  // N open/close cycles
  const N = 25;
  const wcBefore = await webContentsCount(app);
  const sessionsBefore = await sessionCount(app);
  const partsBefore = (await snapshot(app)).partitions.length;
  const cyclePartitions: string[] = [];
  for (let i = 0; i < N; i++) {
    const p = await openPortal(A, `${s1.origin}/set-cookie?v=cycle${i}`);
    cyclePartitions.push(p.partition);
    await A.call('portal_close', { sessionId: p.id });
  }
  await sleep(2000);
  const wcAfter = await webContentsCount(app);
  const sessionsAfter = await sessionCount(app);
  const jar = await app.evaluate(async ({ session }, names) => {
    let total = 0;
    for (const n of names) total += (await session.fromPartition(n).cookies.get({})).length;
    return total;
  }, cyclePartitions);
  check(rec, `${N} cycles: every cycle used a distinct partition`, new Set(cyclePartitions).size === N && cyclePartitions.every((p) => p.startsWith('agent-portal-')), { distinct: new Set(cyclePartitions).size });
  check(rec, `${N} cycles: no portal web contents remain (host + user-tab windows only)`, wcAfter <= wcBefore, { before: wcBefore, after: wcAfter });
  check(rec, `${N} cycles: A holds no portal`, (await listIds(A)).length === 0, await listIds(A));
  check(rec, `${N} cycles: all cookies of all ${N} partitions wiped`, jar === 0, { cookiesLeft: jar });
  const sample = await probePartitionStorage(app, cyclePartitions[0], `${s1.origin}/idb.html`);
  check(rec, 'first cycle partition re-opened shows nothing', sample.cookie === '' && sample.cookieJar === 0, sample);
  evidence.cycles = {
    N,
    electronSessionObjectsBefore: sessionsBefore,
    electronSessionObjectsAfter: sessionsAfter,
    sessionObjectsGrowth: sessionsAfter - sessionsBefore,
    growthPerCycle: (sessionsAfter - sessionsBefore) / N,
    partitionsRequestedFromElectron: (await snapshot(app)).partitions.length - partsBefore,
    webContentsBefore: wcBefore,
    webContentsAfter: wcAfter,
  };
  rec.checks.push({
    desc: 'Session objects remaining after the cycles (reported, not asserted)',
    ok: true,
    observed: JSON.stringify(evidence.cycles),
  });
  rec.checks.push({
    desc: 'main\'s agentPartitions registry count (BrowserAuthority.agentPartitionCount) returns to 0',
    ok: true,
    observed: 'NOT OBSERVABLE from outside: the function is module-private and tree-shaken out of the bundle (no caller outside tests). Proven indirectly: every partition\'s storage is wiped, portals are gone and no portal web contents remains. A direct read needs a test-only seam in production code (not added).',
  });
  rec.note = 'registry count not directly readable (see check)';
  flush();
}));

// ---------------------------------------------------------------------------
// C4 lockdown
// ---------------------------------------------------------------------------
test('C4 lockdown: permissions, devices, downloads, window.open', guarded('C4', async () => {
  const rec = begin('C4', 'Lockdown', 'geolocation/notifications/camera/mic/USB/HID/serial/Bluetooth/getDisplayMedia denied incl. permissions.query; downloads cancelled; window.open never reaches the external browser');
  const D = conns['sess-D'];
  const pl = await openPortal(D, `${s1.origin}/hostile.html`);
  const hostile = await waitInPartition<any>(app, pl.partition, `window.__hostile && window.__hostile.done ? window.__hostile : null`, 20_000);
  evidence.hostile = hostile;
  check(rec, 'hostile page finished its probes', !!hostile, hostile ?? null);
  const pq = hostile?.permissionsQuery ?? {};
  for (const name of ['geolocation', 'notifications', 'camera', 'microphone']) {
    check(rec, `permissions.query(${name}) is "denied"`, pq[name] === 'denied', pq[name]);
  }
  check(rec, 'navigator.geolocation.getCurrentPosition fails with PERMISSION_DENIED (code 1)', hostile?.geolocation === 'error code 1', hostile?.geolocation);
  check(rec, 'Notification.requestPermission() is "denied"', hostile?.notification === 'denied', hostile?.notification);
  check(rec, 'getUserMedia({audio}) is rejected with NotAllowedError (permission, not a missing device)', /^NotAllowedError/.test(hostile?.getUserMediaAudio ?? ''), hostile?.getUserMediaAudio);
  check(rec, 'getUserMedia({video}) is rejected with NotAllowedError', /^NotAllowedError/.test(hostile?.getUserMediaVideo ?? ''), hostile?.getUserMediaVideo);

  // device APIs and screen capture need a user gesture to reach the chooser; give them one
  const wcBefore = await webContentsCount(app);
  const dialogsBefore = (await snapshot(app)).dialogCalls.length;
  const devices = await evalInPartition<any>(app, pl.partition, `(async () => {
    const run = async (name, f) => { if (!f) return 'absent'; try { const v = await Promise.race([f(), new Promise((_, rj) => setTimeout(() => rj(new Error('HUNG-5s')), 5000))]); return Array.isArray(v) ? 'RESOLVED:n=' + v.length : 'RESOLVED:' + (v ? 'a-device-or-stream' : 'empty'); } catch (e) { return e.name + ':' + String(e.message || '').slice(0, 90); } };
    return {
      usb: await run('usb', navigator.usb && (() => navigator.usb.requestDevice({ filters: [] }))),
      hid: await run('hid', navigator.hid && (() => navigator.hid.requestDevice({ filters: [] }))),
      serial: await run('serial', navigator.serial && (() => navigator.serial.requestPort())),
      bluetooth: await run('bluetooth', navigator.bluetooth && (() => navigator.bluetooth.requestDevice({ acceptAllDevices: true }))),
      displayMedia: await run('dm', navigator.mediaDevices.getDisplayMedia && (() => navigator.mediaDevices.getDisplayMedia({ video: true }))),
    };
  })()`, true);
  evidence.deviceApis = devices;
  for (const key of ['usb', 'hid', 'serial', 'bluetooth', 'displayMedia'] as const) {
    const v: string = devices[key];
    // WebHID resolves with an empty list when nothing was chosen (spec behaviour): that grants nothing.
    check(rec, `${key}: no device/stream was granted (rejected, absent or an empty list), no hang`, (!v.startsWith('RESOLVED') || v === 'RESOLVED:n=0') && !/HUNG/.test(v), v);
  }
  check(rec, 'no chooser/dialog was shown and no window appeared for the device calls', (await snapshot(app)).dialogCalls.length === dialogsBefore && (await webContentsCount(app)) === wcBefore, { dialogs: (await snapshot(app)).dialogCalls.length - dialogsBefore });

  // downloads: main-initiated, page navigation, and <a download> with a user gesture
  const dlBefore = (await snapshot(app)).downloads.length;
  const dlName = 'nib-portal-fixture-download';
  const appDownloads = await app.evaluate(({ app: a }) => { try { return a.getPath('downloads'); } catch (e) { return `unavailable (${(e as Error).message})`; } });
  // Real Downloads folder (this test process keeps the real USERPROFILE) and the redirected one the app sees.
  const dirs = [path.join(os.homedir(), 'Downloads'), path.join(run.tempRoot, 'home', 'Downloads')];
  evidence.downloadsChecked = { appGetPathDownloads: appDownloads, dirs };
  await app.evaluate(({ session, webContents }, arg) => {
    const ses = session.fromPartition(arg.name);
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === ses);
    wc!.downloadURL(`${arg.origin}/download`);
  }, { name: pl.partition, origin: s1.origin });
  await sleep(1200);
  await evalInPartition(app, pl.partition, `(() => { const a = document.createElement('a'); a.href = '/download'; a.download = 'x.txt'; document.body.appendChild(a); a.click(); return 1; })()`, true);
  await sleep(1200);
  await evalInPartition(app, pl.partition, `(() => { location.href = '/download'; return 1; })()`, true);
  await sleep(2500);
  const snap = await snapshot(app);
  const newDownloads = snap.downloads.slice(dlBefore);
  check(rec, 'downloads were attempted and reached will-download', newDownloads.length >= 1, newDownloads);
  check(rec, 'every download was prevented/cancelled by the lockdown, none progressing', newDownloads.every((d) => d.stateAfter === 'cancelled' || d.stateAfter.startsWith('prevented')), newDownloads.map((d) => d.stateAfter));
  const leaked = dirs.flatMap((d) => (fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.startsWith(dlName)).map((f) => path.join(d, f)) : []));
  for (const f of leaked) fs.rmSync(f, { force: true }); // it is this fixture's own file
  check(rec, 'no file was written to the Downloads folder(s)', leaked.length === 0, { checked: dirs, leaked });
  check(rec, 'no save dialog was shown', snap.dialogCalls.length === dialogsBefore, snap.dialogCalls.slice(dialogsBefore));
  check(rec, 'the portal is still on its page (an attachment does not navigate away)', (await urlInPartition(app, pl.partition))?.startsWith(s1.origin) === true, await urlInPartition(app, pl.partition));

  // window.open / target=_blank: never forwarded
  await D.call('portal_navigate', { sessionId: pl.id, url: '/popup.html' });
  await waitInPartition(app, pl.partition, `location.pathname === '/popup.html' && document.readyState === 'complete'`, 10_000);
  const sendsBefore = (await snapshot(app)).sends.length;
  const extBefore = (await snapshot(app)).openExternal.length;
  const wc2 = await webContentsCount(app);
  const otherHitsBefore = other.requests.length;
  await evalInPartition(app, pl.partition, `(() => { window.open('${other.origin}/popup-target', '_blank'); document.getElementById('blank').click(); return 1; })()`, true);
  await sleep(2000);
  const after = await snapshot(app);
  check(rec, 'shell.openExternal was never called for the portal', after.openExternal.length === extBefore, after.openExternal);
  check(rec, 'no browser-session:external-nav event reached the renderer', !after.sends.slice(sendsBefore).some((s) => s.channel === 'browser-session:external-nav'), after.sends.slice(sendsBefore).map((s) => s.channel));
  check(rec, 'no popup window/web contents was created', (await webContentsCount(app)) === wc2, { before: wc2, after: await webContentsCount(app) });
  check(rec, 'the other origin saw no request from the popup', other.requests.length === otherHitsBefore, other.requests.slice(otherHitsBefore).map((r) => r.url));

  // control: the same click in a USER tab does produce external-nav (proves the spy sees it)
  await invoke(host, 'browser-session:create', { sessionId: 'user-tab-3', url: `${s1.origin}/popup.html`, headless: true });
  await waitInPartition(app, 'browser-preview', `location.pathname === '/popup.html' && document.readyState === 'complete'`, 15_000);
  const ctlBefore = (await snapshot(app)).sends.length;
  await evalInPartition(app, 'browser-preview', `(() => { document.getElementById('blank').click(); return 1; })()`, true);
  await sleep(1500);
  const ctlSends = (await snapshot(app)).sends.slice(ctlBefore).filter((s) => s.channel === 'browser-session:external-nav');
  check(rec, 'control: a user tab\'s popup DOES emit browser-session:external-nav (today\'s behaviour, spy works)', ctlSends.length >= 1, ctlSends);
  await invoke(host, 'browser-session:destroy', { sessionId: 'user-tab-3' });

  await closeAll(D);
  flush();
}));

// ---------------------------------------------------------------------------
// C5 navigation confinement
// ---------------------------------------------------------------------------
test('C5 confinement: top-level, redirects (initial and later), frames blocked; subresource allowed', guarded('C5', async () => {
  const rec = begin('C5', 'Navigation confinement', 'navigation to another origin never happens (top, redirect, frame); the other origin sees no page request; a subresource fetch to it IS allowed (user decision)');
  const D = conns['sess-D'];
  const noPage = (marker: string) => !other.requests.some((r) => r.url.includes(marker));

  // top-level: tool and page-initiated
  let p = await openPortal(D, `${s1.origin}/`);
  const nav = await D.call('portal_navigate', { sessionId: p.id, url: `${other.origin}/top-tool` });
  check(rec, 'portal_navigate to another origin is refused', nav.isError === true, nav.text.slice(0, 160));
  await evalInPartition(app, p.partition, `(() => { location.href = '${other.origin}/top-page'; return 1; })()`, true);
  await sleep(1500);
  check(rec, 'page-initiated top-level navigation is blocked (URL unchanged, other origin saw nothing)', (await urlInPartition(app, p.partition)) === `${s1.origin}/` && noPage('/top-'), { url: await urlInPartition(app, p.partition), otherHits: other.requests.map((r) => r.url) });
  const ok = await D.call('portal_navigate', { sessionId: p.id, url: '/idb.html' });
  check(rec, 'control: same-origin portal_navigate works', ok.isError === false, ok.text.slice(0, 120));

  // later redirect: same-origin URL that 302s to the other origin (and to file:/data:)
  await waitInPartition(app, p.partition, `location.pathname === '/idb.html' && document.readyState === 'complete'`, 10_000);
  for (const [label, to] of [['other origin', `${other.origin}/redir-later`], ['file:', 'file:///C:/Windows/win.ini'], ['data:', 'data:text/html,<title>x</title>'], ['javascript:', 'javascript:document.title=1']] as const) {
    await D.call('portal_navigate', { sessionId: p.id, url: `/redir?to=${encodeURIComponent(to)}` });
    await sleep(1500);
    const url = await urlInPartition(app, p.partition);
    check(rec, `later redirect to ${label} is blocked (portal did not land there)`, !!url && url.startsWith(s1.origin) && !url.startsWith('file:') && !url.startsWith('data:') && !url.startsWith('javascript:'), url);
  }
  for (const scheme of ['file%3A', 'data%3A', 'javascript%3A']) {
    check(rec, `the ${decodeURIComponent(scheme)} redirect was really issued by the preview server (the block is the browser's/app's, not a navigation that never started)`, s1.requests.some((r) => r.url.startsWith(`/redir?to=${scheme}`)), s1.requests.filter((r) => r.url.includes(scheme)).map((r) => r.url.slice(0, 60)));
  }
  check(rec, 'other origin saw no /redir-later request', noPage('redir-later'), other.requests.map((r) => r.url));
  await closeAll(D);

  // initial redirect (the first load itself redirects away)
  p = await openPortal(D, `${s1.origin}/redir?to=${encodeURIComponent(`${other.origin}/redir-initial`)}`, 2500).catch(async () => ({ id: '', partition: '' }));
  await sleep(1500);
  const ids = await listIds(D);
  const landed = ids.length ? await urlInPartition(app, (await snapshot(app)).partitions.filter((x) => x.startsWith('agent-portal-')).pop()!) : null;
  check(rec, 'initial-load redirect to another origin is blocked', noPage('redir-initial') && !(landed ?? '').startsWith(other.origin), { landed, otherHits: other.requests.map((r) => r.url) });
  await closeAll(D);

  // frames: initial cross-origin iframe, and a later one
  p = await openPortal(D, `${s1.origin}/frame-other.html`);
  await sleep(1500);
  check(rec, 'initial cross-origin iframe is blocked (other origin saw no /frame-doc)', noPage('/frame-doc'), other.requests.map((r) => r.url));
  await D.call('portal_navigate', { sessionId: p.id, url: '/frame-same.html' });
  await waitInPartition(app, p.partition, `location.pathname === '/frame-same.html' && document.readyState === 'complete'`, 10_000);
  const s1Before = s1.requests.length;
  await evalInPartition(app, p.partition, `(() => { document.getElementById('f').src = '/frame-doc?same=1'; return 1; })()`, true);
  await sleep(1200);
  check(rec, 'control: same-origin frame navigation is allowed', s1.requests.slice(s1Before).some((r) => r.url.startsWith('/frame-doc?same=1')), s1.requests.slice(s1Before).map((r) => r.url));
  await evalInPartition(app, p.partition, `(() => { document.getElementById('f').src = '${other.origin}/frame-later'; return 1; })()`, true);
  await sleep(1500);
  check(rec, 'later frame navigation to another origin is blocked', noPage('frame-later'), other.requests.map((r) => r.url));
  await closeAll(D);

  // subresource: allowed, by the user's decision (it documents that this does NOT confine the network)
  const before = other.requests.length;
  p = await openPortal(D, `${s1.origin}/subresource.html`);
  const fetched = await waitInPartition<string>(app, p.partition, `window.__fetched || null`, 10_000);
  check(rec, 'subresource fetch to another origin is allowed (documents R4: navigation is confined, the network is not)', fetched === 'ok' && other.requests.slice(before).some((r) => r.url === '/api'), { fetched, otherHits: other.requests.slice(before).map((r) => r.url) });
  await closeAll(D);
  flush();
}));

// ---------------------------------------------------------------------------
// C6 test-data mark
// ---------------------------------------------------------------------------
test('C6 mark: refused without it; only a confirmed OK enables; declared ports; revoke is immediate; per project', guarded('C6', async () => {
  const rec = begin('C6', 'Test-data mark and ports', 'click/type/evaluate refused without the mark; only OK enables; interaction only on declared ports; revoke blocks an open portal at once; project A\'s mark does not apply to project B\'s portal');
  const A = conns['sess-A'];
  const B = conns['sess-B'];
  const C = conns['sess-C'];
  const interact = async (conn: McpConnection, id: string) => ({
    click: await conn.call('portal_click', { sessionId: id, selector: '#btn' }),
    type: await conn.call('portal_type', { sessionId: id, selector: '#inp', text: 'hello' }),
    evaluate: await conn.call('portal_evaluate', { sessionId: id, script: 'document.title' }),
  });

  const pa = await openPortal(A, `${s1.origin}/`);
  // (a) no mark
  check(rec, 'precondition: project P1 is not marked, no ports', JSON.stringify(await getMark(ws1)) === JSON.stringify({ enabled: false, ports: [] }), await getMark(ws1));
  let r = await interact(A, pa.id);
  check(rec, 'no mark: click refused', r.click.isError === true, r.click.text.slice(0, 200));
  check(rec, 'no mark: type refused', r.type.isError === true, r.type.text.slice(0, 200));
  check(rec, 'no mark: evaluate refused', r.evaluate.isError === true, r.evaluate.text.slice(0, 200));
  check(rec, 'no mark: the page was not touched (title unchanged)', (await evalInPartition(app, pa.partition, 'document.title')) === 'Fixture index', await evalInPartition(app, pa.partition, 'document.title'));
  const obs = await A.call('portal_scroll', { sessionId: pa.id, dy: 5 });
  const info = await A.call('portal_page_info', { sessionId: pa.id });
  check(rec, 'no mark: observing (scroll, page_info) still works', obs.isError === false && info.isError === false, [obs.text.slice(0, 60), info.text.slice(0, 60)]);

  // (b) Cancel then OK, through the real IPC + real input + stubbed native dialog
  const d0 = (await snapshot(app)).dialogCalls.length;
  const cancelled = await setMark(ws1, true, [1]);
  check(rec, 'native dialog answered Cancel: mark NOT enabled', cancelled.success === false && cancelled.code === 'notConfirmed' && (await getMark(ws1)).enabled === false, cancelled);
  const dlg = (await snapshot(app)).dialogCalls.slice(d0);
  check(rec, 'exactly one native dialog was shown, Cancel is the default and the Esc answer', dlg.length === 1 && dlg[0].defaultId === 1 && dlg[0].cancelId === 1 && dlg[0].buttons?.length === 2, dlg);
  check(rec, 'dialog names the project', JSON.stringify(dlg[0]).includes(path.basename(ws1)), dlg[0]?.message);
  r = await interact(A, pa.id);
  check(rec, 'after Cancel: still refused', r.click.isError && r.type.isError && r.evaluate.isError, [r.click.text.slice(0, 80)]);

  const ok = await setMark(ws1, true, [0]);
  check(rec, 'native dialog answered OK: mark enabled', ok.success === true && ok.enabled === true && (await getMark(ws1)).enabled === true, ok);

  // marked, but no ports declared: a loopback page is still view-only
  r = await interact(A, pa.id);
  check(rec, 'marked, no declared port: click/type/evaluate on loopback still refused', r.click.isError && r.type.isError && r.evaluate.isError, r.click.text.slice(0, 200));

  // nim-preview page of the project: allowed with the mark alone
  const pf = await A.call('portal_open', { filePath: path.join(ws1, 'index.html') });
  let previewId = '';
  if (!pf.isError) {
    previewId = JSON.parse(pf.text).sessionId;
    const parts = (await snapshot(app)).partitions.filter((x) => x.startsWith('agent-portal-'));
    const part = parts[parts.length - 1];
    await waitInPartition(app, part, `document.readyState === 'complete'`, 10_000);
    const click = await A.call('portal_click', { sessionId: previewId, selector: '#b' });
    check(rec, 'marked: click on the project\'s own file preview (nim-preview) is allowed', click.isError === false && (await evalInPartition(app, part, 'document.title')) === 'ws1 clicked', click.text.slice(0, 160));
    await A.call('portal_close', { sessionId: previewId });
  } else {
    check(rec, 'portal_open filePath works for the marked project', false, pf.text.slice(0, 300));
  }

  // (c) ports
  const widened = await setPorts(ws1, [s1.port], [0]);
  check(rec, 'declaring a port asks natively and OK stores it', widened.success === true && JSON.stringify(widened.ports) === JSON.stringify([s1.port]), widened);
  const clickRes = await A.call('portal_click', { sessionId: pa.id, selector: '#btn' });
  check(rec, 'marked + declared port: click is allowed and acted', clickRes.isError === false && (await evalInPartition(app, pa.partition, 'document.title')) === 'clicked', { text: clickRes.text.slice(0, 80), title: await evalInPartition(app, pa.partition, 'document.title') });
  const typeRes = await A.call('portal_type', { sessionId: pa.id, selector: '#inp', text: 'hello' });
  check(rec, 'marked + declared port: type is allowed and acted', typeRes.isError === false && (await evalInPartition(app, pa.partition, 'document.title')) === 'typed:hello', { text: typeRes.text.slice(0, 80), title: await evalInPartition(app, pa.partition, 'document.title') });
  const evalRes = await A.call('portal_evaluate', { sessionId: pa.id, script: 'document.title' });
  check(rec, 'marked + declared port: evaluate is allowed (solo full session) and returns the page value', evalRes.isError === false && /typed:hello/.test(evalRes.text), evalRes.text.slice(0, 160));
  // another loopback port: observe yes, interact no
  const po = await A.call('portal_open', { url: `${other.origin}/` });
  const otherId = JSON.parse(po.text).sessionId;
  const otherPart = (await snapshot(app)).partitions.filter((x) => x.startsWith('agent-portal-')).pop()!;
  await waitInPartition(app, otherPart, `document.readyState === 'complete'`, 10_000);
  const oi = await interact(A, otherId);
  check(rec, 'another loopback port: observing is allowed (portal opened)', po.isError === false, po.text.slice(0, 100));
  check(rec, 'another loopback port (undeclared): click/type/evaluate refused', oi.click.isError && oi.type.isError && oi.evaluate.isError, oi.click.text.slice(0, 200));
  await A.call('portal_close', { sessionId: otherId });

  // cross-agent while marked: B (same project) cannot drive A's portal
  const bx = await interact(B, pa.id);
  check(rec, 'marked: agent B still cannot click/type/evaluate in A\'s portal (ownership, not the mark)', bx.click.isError && bx.type.isError && bx.evaluate.isError && /No browser session/i.test(bx.click.text), bx.click.text.slice(0, 200));

  // (e) other project: C belongs to P2 (unmarked) and opens a portal on the SAME port
  const pc = await openPortal(C, `${s1.origin}/`);
  const cr = await interact(C, pc.id);
  check(rec, 'project P2\'s portal on the declared port: refused (P1\'s mark does not apply)', cr.click.isError && cr.type.isError && cr.evaluate.isError, cr.click.text.slice(0, 200));
  check(rec, 'P2 stays unmarked', (await getMark(ws2)).enabled === false, await getMark(ws2));
  await C.call('portal_close', { sessionId: pc.id });

  // (d) revoke: an already-open portal is blocked at once; revoking asks nothing
  const dBefore = (await snapshot(app)).dialogCalls.length;
  const revoked = await setMark(ws1, false);
  check(rec, 'revoking succeeds and shows no dialog', revoked.success === true && revoked.enabled === false && (await snapshot(app)).dialogCalls.length === dBefore, revoked);
  r = await interact(A, pa.id);
  check(rec, 'after revoke: the ALREADY-OPEN portal refuses click/type/evaluate immediately', r.click.isError && r.type.isError && r.evaluate.isError, r.click.text.slice(0, 200));
  check(rec, 'ports survive a revoke but need the mark', JSON.stringify((await getMark(ws1)).ports) === JSON.stringify([s1.port]), await getMark(ws1));

  // tidy: clear ports (narrowing asks nothing)
  await setPorts(ws1, []);
  await closeAll(A);
  flush();
}));

// ---------------------------------------------------------------------------
// C7 input recency cannot be faked
// ---------------------------------------------------------------------------
test('C7 recency: portal sendInputEvent and synthetic DOM events do not satisfy the mark\'s input gate', guarded('C7', async () => {
  const rec = begin('C7', 'Input recency', 'only input delivered to the host window counts, once; a portal\'s sendInputEvent and synthetic DOM events never do; the gate expires after 5 s');
  const A = conns['sess-A'];
  const attempt = async (label: string) => {
    await queueDialogAnswers(app, [1]);
    const res = await invoke(host, 'portal:set-test-data', ws1, true);
    return { label, res };
  };

  // (a) the portal's own real-input tool (needs a marked project): drive sendInputEvent on a portal, then try the IPC
  await setMark(ws1, true, [0]);
  await setPorts(ws1, [s1.port], [0]);
  const pa = await openPortal(A, `${s1.origin}/`);
  const click = await A.call('portal_click', { sessionId: pa.id, selector: '#btn' });
  check(rec, 'precondition: portal_click (sendInputEvent on the portal) really clicked', click.isError === false && (await evalInPartition(app, pa.partition, 'document.title')) === 'clicked', click.text.slice(0, 100));
  await A.call('portal_type', { sessionId: pa.id, selector: '#inp', text: 'abc' });
  await setMark(ws1, false); // back to unmarked (consumes its own input) so the IPC below would have to ENABLE
  let a1 = await attempt('after portal_click/portal_type');
  check(rec, 'portal sendInputEvent (click+type) did not satisfy the gate', a1.res.code === 'noUserInput', a1.res);
  // direct portal.sendInputEvent from the test process too
  await app.evaluate(({ session, webContents }, name) => {
    const ses = session.fromPartition(name);
    const wc = webContents.getAllWebContents().find((w) => !w.isDestroyed() && w.session === ses)!;
    wc.sendInputEvent({ type: 'mouseDown', x: 20, y: 20, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: 20, y: 20, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'A' });
    wc.sendInputEvent({ type: 'char', keyCode: 'A' });
  }, pa.partition);
  a1 = await attempt('after raw portal wc.sendInputEvent');
  check(rec, 'raw sendInputEvent on the portal did not satisfy the gate', a1.res.code === 'noUserInput', a1.res);
  await closeAll(A);

  // (b) synthetic DOM events inside the host renderer
  await host.evaluate(() => {
    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 300, clientY: 300 }));
    document.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 300, clientY: 300 }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    document.body.click();
    (document.activeElement as HTMLElement | null)?.click?.();
  });
  const b1 = await attempt('after synthetic DOM mouse/keyboard/pointer events + element.click()');
  check(rec, 'synthetic DOM events in the host renderer did not satisfy the gate', b1.res.code === 'noUserInput', b1.res);

  // (c) no input at all
  const c1 = await attempt('no input');
  check(rec, 'no input: refused', c1.res.code === 'noUserInput', c1.res);

  // (d) real input reaches the dialog (passes the gate), and is consumed
  await realUserClick(host);
  await queueDialogAnswers(app, [1, 1]);
  const first = await invoke(host, 'portal:set-test-data', ws1, true);
  const second = await invoke(host, 'portal:set-test-data', ws1, true);
  check(rec, 'real input to the host window passes the gate (reaches the native dialog -> notConfirmed)', first.code === 'notConfirmed', first);
  check(rec, 'that input is single-use: the second call is refused', second.code === 'noUserInput', second);

  // (e) expiry
  await realUserClick(host);
  await sleep(5600);
  const expired = await attempt('real input then 5.6 s');
  check(rec, 'real input older than 5 s no longer counts', expired.res.code === 'noUserInput', expired.res);

  // (f) informational: what the privileged test process itself can do (not an agent path)
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('file:'))!.webContents;
    wc.sendInputEvent({ type: 'mouseDown', x: 300, y: 300, button: 'left', clickCount: 1 });
  });
  const f1 = await attempt('INFO main-process host wc.sendInputEvent');
  rec.checks.push({ desc: 'INFO (not an agent path): sendInputEvent on the HOST web contents from the main process', ok: true, observed: `${JSON.stringify(f1.res)} (a privileged process - Playwright's debugger channel or a dev renderer_eval/CDP - can supply input the gate accepts; the gate defends against page/renderer-level fakes, not against the debugger)` });
  const none = await getMark(ws1);
  check(rec, 'the mark was never enabled by any fake', none.enabled === false, none);
  await setPorts(ws1, []);
  flush();
}));

// ---------------------------------------------------------------------------
// C8 MCP connection without a session id
// ---------------------------------------------------------------------------
test('C8 no session id: no extension tools listed, forced calls refused, no portal born', guarded('C8', async () => {
  const rec = begin('C8', 'MCP without session id', 'a connection without ?sessionId sees no extension/portal tools and cannot call them');
  const wcBefore = await webContentsCount(app);
  const s1Before = s1.requests.length;
  const withId = new McpConnection(mcpPort, mcpToken, '/mcp/ext/browser', 'sess-A', ws1);
  await withId.initialize();
  const withTools = await withId.listTools();
  check(rec, 'control: with a session id the browser extension tools ARE listed', withTools.includes('browser_open_session'), withTools.slice(0, 4));

  for (const endpoint of ['/mcp/ext/browser', '/mcp', '/mcp/core']) {
    const anon = new McpConnection(mcpPort, mcpToken, endpoint, undefined, ws1);
    await anon.initialize();
    const tools = await anon.listTools();
    check(rec, `${endpoint}: no browser_* extension tools and no portal_* tools are listed`, !tools.some((t) => /^browser[._]/.test(t) || t.startsWith('portal_')), tools.filter((t) => /browser|portal/.test(t)));
  }
  const anonExt = new McpConnection(mcpPort, mcpToken, '/mcp/ext/browser', undefined, ws1);
  await anonExt.initialize();
  const forcedBrowser = await anonExt.call('browser_open_session', { url: `${s1.origin}/` });
  check(rec, 'forced browser_open_session without a session id is refused', forcedBrowser.isError === true, forcedBrowser.text.slice(0, 200));
  const anonCore = new McpConnection(mcpPort, mcpToken, '/mcp/core', undefined, ws1);
  await anonCore.initialize();
  const forcedPortal = await anonCore.call('portal_open', { url: `${s1.origin}/` });
  check(rec, 'forced portal_open without a session id is refused', forcedPortal.isError === true, forcedPortal.text.slice(0, 200));
  await sleep(1200);
  check(rec, 'no portal/web contents was created and the preview server saw no request', (await webContentsCount(app)) === wcBefore && s1.requests.length === s1Before, { wc: [wcBefore, await webContentsCount(app)], s1Hits: s1.requests.length - s1Before });
  flush();
}));

// ---------------------------------------------------------------------------
// OBS console and network capture (F1.3a, test-only)
// ---------------------------------------------------------------------------
const readJsonl = (file: string): any[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

test('OBS capture: a portal page\'s console and network are recorded, classified and redacted', guarded('OBS', async () => {
  const rec = begin(
    'OBS',
    'Console and network capture (F1.3a)',
    'known stimuli of a portal page appear in portal-console.jsonl / portal-network.jsonl with the right kind, level, status, context and class; no planted secret, token or personal path is written; the capture lost nothing',
  );
  if (!capture) throw new Error('capture not installed');
  const D = conns['sess-D'];
  await closeAll(D);
  capture.addSecrets(OBS_CANARIES.known); // the only planted value the capture is told about; the rest must be caught by the rules
  const dead = await deadOrigin(); // a fixture-range port with nothing listening: a real connection refused
  const p = await openPortal(D, `${s1.origin}/obs.html?token=${OBS_CANARIES.query}&q=ok&dead=${encodeURIComponent(dead)}`);
  const ran = await waitInPartition<string>(app, p.partition, 'window.__obs && window.__obs.done && JSON.stringify(window.__obs)', 20_000);
  check(rec, 'the stimuli page ran to the end', !!ran, ran ?? 'not done');
  await sleep(1500); // console and load events are delivered to main asynchronously
  await capture.pull(app);
  const written = capture.write();
  const [consoleFile, networkFile, summaryFile] = written.files;
  const lines = readJsonl(consoleFile).filter((r) => r.case === 'OBS');
  const net = readJsonl(networkFile).filter((r) => r.case === 'OBS');
  const mine = (r: any) => r.partition === p.partition;
  const line = (text: string) => lines.find((r) => mine(r) && String(r.message).includes(text));
  const brief = (r: any) => (r ? { kind: r.kind, level: r.level, class: r.class, rule: r.rule, context: r.context, page: r.page, message: r.message } : 'missing');

  // console
  const log = line('obs log line');
  check(rec, 'console.log is captured from the portal page (level info, context portal, its partition)', log?.level === 'info' && log?.context === 'portal' && log?.class === 'event', brief(log));
  const info = line('obs info line');
  check(rec, 'console.info is captured (level info)', info?.level === 'info', brief(info));
  const warn = line('obs warn line');
  check(rec, 'console.warn is captured (level warning, class event)', warn?.level === 'warning' && warn?.class === 'event', brief(warn));
  const err = line('obs error line');
  check(rec, 'console.error is captured (level error, class failure)', err?.level === 'error' && err?.class === 'failure', brief(err));
  const uncaught = line('obs uncaught exception');
  check(rec, 'an uncaught exception is captured (kind uncaught-exception)', uncaught?.kind === 'uncaught-exception' && uncaught?.class === 'failure', brief(uncaught));
  const rejection = line('obs unhandled rejection');
  check(rec, 'an unhandled rejection is captured (kind unhandled-rejection)', rejection?.kind === 'unhandled-rejection' && rejection?.class === 'failure', brief(rejection));
  const debug = line('obs debug line');
  rec.checks.push({ desc: 'INFO console.debug (Chromium delivers log and info at the same level)', ok: true, observed: JSON.stringify(brief(debug)) });

  // network
  const doc = net.find((r) => r.source === 'webcontents' && mine(r) && r.kind === 'response' && r.frame === 'main' && String(r.url).includes('/obs.html'));
  check(rec, 'the portal document load is captured with its HTTP status (webcontents, main frame, 200)', doc?.status === 200 && doc?.context === 'portal', doc ?? 'missing');
  const server = (pathPrefix: string) => net.find((r) => r.source === 'fixture-server:s1' && String(r.url).startsWith(`${s1.origin}${pathPrefix}`));
  const api = server('/obs-api?api_key=');
  check(rec, 'a fetch is captured by the fixture server log with method and status (GET 200, context fixture-server)', api?.method === 'GET' && api?.status === 200 && api?.context === 'fixture-server', api ?? 'missing');
  const e500 = server('/obs-500');
  check(rec, 'a 5xx response is captured and classified as failure', e500?.status === 500 && e500?.class === 'failure', e500 ?? 'missing');
  const redir = server('/redir?to=%2Fobs-api');
  const afterRedir = server('/obs-api?after=redirect');
  check(rec, 'a redirect is captured (302, then the target answered 200)', redir?.status === 302 && afterRedir?.status === 200, { redir: redir ?? 'missing', target: afterRedir ?? 'missing' });
  const frameRedirect = net.find((r) => r.source === 'webcontents' && mine(r) && r.kind === 'redirect' && r.frame === 'sub' && String(r.url).includes('/frame-doc?obs=1'));
  check(rec, 'a frame redirect is captured from the portal web contents (kind redirect, sub frame)', !!frameRedirect, frameRedirect ?? net.filter((r) => mine(r) && r.frame === 'sub').map((r) => `${r.kind} ${r.url}`));
  const refusedSub = net.filter((r) => mine(r) && String(r.url).startsWith(`${dead}/obs-refused`));
  rec.checks.push({
    desc: 'INFO limit: a refused SUBRESOURCE (fetch/img to a dead port) is not observable without webRequest/CDP/NetLog (Chromium does not emit its "Failed to load resource" line as console-message); the page itself saw it fail',
    ok: true,
    observed: JSON.stringify({ capturedRecords: refusedSub.length, pageSaw: ran ? { fetch: JSON.parse(ran).refusedFetch, img: JSON.parse(ran).refusedImg } : null }),
  });
  // A refused DOCUMENT load is observable: a second portal opened on the dead port.
  const refusedDesc = 'a refused request (document load on a dead port) is captured as a failed request with its net error (class failure)';
  let latest = written;
  try {
    const deadPortal = await openPortal(D, `${dead}/obs-refused-doc`, 4000);
    // Poll the capture until the failed load arrives (no fixed wait), at most ~8 s.
    let after: any[] = [];
    let refusedDoc: any;
    for (const deadline = Date.now() + 8000; Date.now() < deadline; await sleep(250)) {
      await capture.pull(app);
      latest = capture.write();
      after = readJsonl(latest.files[1]).filter((r) => r.case === 'OBS');
      refusedDoc = after.find((r) => r.partition === deadPortal.partition && r.kind === 'load-failed' && r.frame === 'main' && String(r.url).startsWith(`${dead}/obs-refused-doc`));
      if (refusedDoc) break;
    }
    check(rec, refusedDesc, !!refusedDoc && /\(-102\)/.test(refusedDoc.error) && refusedDoc.class === 'failure', refusedDoc ?? after.filter((r) => r.partition === deadPortal.partition).map((r) => `${r.kind} ${r.url} ${r.error ?? ''}`));
  } catch (e) {
    check(rec, refusedDesc, false, `portal_open on ${dead} failed: ${(e as Error).message.slice(0, 200)}`);
  }
  const sources = new Set(net.filter((r) => String(r.url ?? '').includes('/obs')).map((r) => `${r.source}|${r.context}`));
  check(rec, 'fixture-server traffic and portal-page events are kept apart (source and context)', [...sources].every((s) => s === 'fixture-server:s1|fixture-server' || s.endsWith('|portal')) && sources.has('fixture-server:s1|fixture-server') && [...sources].some((s) => s.startsWith('webcontents|portal')), [...sources]);
  const misattributed = lines.filter((r) => String(r.message).startsWith('obs ') && !mine(r));
  check(rec, 'every OBS console line is attributed to the portal page that printed it', misattributed.length === 0, misattributed.map(brief));

  // redaction: the raw text of the three artifacts
  const text = [consoleFile, networkFile, summaryFile].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // Every value is searched as written, with forward slashes, and as it appears inside JSON text (backslashes doubled).
  const forms = (v: string) => Array.from(new Set([v, v.replace(/\\/g, '/'), JSON.stringify(v).slice(1, -1)]));
  const planted: Array<[string, string]> = [
    ...Object.entries(OBS_CANARIES).map(([k, v]) => [`canary ${k}`, v] as [string, string]),
    ['MCP auth token', mcpToken],
    ['home directory', os.homedir()],
    ['temp directory', os.tmpdir()],
  ];
  const lower = text.toLowerCase();
  const leaked = planted.filter(([, v]) => v && forms(v).some((f) => lower.includes(f.toLowerCase()))).map(([k]) => k);
  const user = os.userInfo().username;
  // The user name as a whole token (the `<user>` marker itself must not count as a hit for a user called "user").
  if (user.length >= 4 && new RegExp(`(?<![A-Za-z0-9_<-])${user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_>-])`, 'i').test(text)) leaked.push('user name');
  check(rec, 'no planted secret, token, personal path or user name is in the artifacts', leaked.length === 0, leaked);
  check(rec, 'no header field is written', !/"headers"\s*:/.test(text), 'searched for a "headers" key');
  const markers = ['token=REDACTED', 'api_key=REDACTED', 'Authorization: [REDACTED]', 'password=[REDACTED]', 'obs_sid=[REDACTED]', 'obs leak plain [REDACTED]', '<HOME>'];
  const missing = markers.filter((m) => !text.includes(m));
  check(rec, 'the planted values were replaced by redaction markers (not just dropped lines)', missing.length === 0, { missing });

  // capture health
  const health = latest.summary.capture;
  check(
    rec,
    'the capture lost nothing (no listener error, no drain error, nothing dropped in main, in the test process or at write)',
    health.listenerErrors.length === 0 && health.drainErrors.length === 0 && health.mainDropped === 0 && health.rawDropped === 0 && health.linesDropped.console === 0 && health.linesDropped.network === 0 &&
      Object.values(health.summaryListsCut).every((n) => n === 0),
    health,
  );
  rec.checks.push({ desc: 'INFO OBS summary (report-only policy)', ok: true, observed: JSON.stringify({ portal: written.summary.portal, answers: written.summary.answers }) });

  await closeAll(D);
  flush();
}));

// ---------------------------------------------------------------------------
// SUMMARY
// ---------------------------------------------------------------------------
test('SUMMARY every recorded check passed', async () => {
  flush();
  const failed = [...cases.values()].flatMap((c) => c.checks.filter((k) => !k.ok).map((k) => `${c.id}: ${k.desc} -> ${k.observed}`));
  expect(failed, failed.join(' | ')).toEqual([]);
});

// ---------------------------------------------------------------------------
// C9 first-request capture
// ---------------------------------------------------------------------------
test('C9 capture of the first request', async () => {
  const rec = begin('C9', 'Capture of the first request', 'F1.3 (capture) is not built yet');
  rec.status = 'NOT RUN';
  rec.note = 'Not applicable to F0-F1.2: capture belongs to F1.3.';
  flush();
});
