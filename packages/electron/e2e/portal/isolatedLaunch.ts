/**
 * The ONE wrapper every Portal fixture launch goes through (M-9, NIB.110).
 *
 * A launch of the app, packaged or not, can reach three things of the real
 * user: the profile and DB under %APPDATA%\@nimbalyst, the single-instance lock
 * and the `nimbalyst://` registration in HKCU. This wrapper refuses to launch
 * unless every guard below holds, and it always puts the registry back.
 *
 *  1. The entry is the separate build `out2/main/index.js` (never `out/`, which
 *     the developer's `electron-vite dev` uses); its renderer sits beside it.
 *  2. userData (NIMBALYST_USER_DATA_DIR) and the DB (NIMBALYST_USER_DATA_PATH)
 *     are fresh directories under the run's temp root (`%TEMP%\nib-portal-run-*\nib-portal-*`);
 *     analytics is switched off in that profile before the first start;
 *     APPDATA/LOCALAPPDATA/USERPROFILE/HOME point into the same tree; provider,
 *     credential and service variables (CLAUDE*, CODEX*, ANTHROPIC*, ...) are dropped.
 *  3. NODE_ENV=production: an unpackaged main opens a CDP port (9222 by default, the
 *     developer's own app uses it) unless NODE_ENV says production (remoteDebugging.ts).
 *     The wrapper adds no debugging switch of its own.
 *  4. The registry key is backed up by globalSetup (runner process), restored here
 *     after every launch, by globalTeardown, and synchronously on exit/SIGINT/SIGTERM
 *     (runGuard.ts). A launch is refused when the key already points at a test build.
 *
 * Playwright's `_electron.launch` opens its own debugging channel to drive the
 * unpackaged app; that is allowed for this test run only (the spec records the
 * TCP listeners the app tree opens and asserts 9222 is not one of them).
 */
import { _electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { launchTree, listeningPorts, stillAlive, terminateRecorded, type ProcInfo, type Refusal } from './processes';
import {
  ENV,
  guardState,
  installExitRestore,
  manualRestoreCommand,
  pointsAtTestBuild,
  readRegistryKey,
  recordProcs,
  restoreRegistry,
  runAllow,
  runTempDir,
} from './runGuard';

export { listeningPorts, readRegistryKey, stillAlive };

export const PACKAGE_ROOT = path.resolve(__dirname, '../..');
export const OUT2_ENTRY = path.join(PACKAGE_ROOT, 'out2', 'main', 'index.js');

export interface IsolatedLaunch {
  app: ElectronApplication;
  tempRoot: string;
  userDataDir: string;
  dbDir: string;
  pids: number[];
  /** The vetted app tree recorded at launch (pid + creation time + executable). */
  procs: ProcInfo[];
  /** Tree members that failed the identity checks at launch (never killed). */
  launchRefused: Array<{ pid: number; exe: string | null; reason: string }>;
  /** Environment variables the wrapper kept out of the app. */
  droppedEnv: string[];
  /** Close the app, restore the registry, return the evidence. */
  shutdown(): Promise<ShutdownEvidence>;
}

export interface ShutdownEvidence {
  registryRestored: boolean;
  registryAfterRestore: string;
  survivingPids: number[];
  /** Processes that failed the identity checks at shutdown: not killed, leftovers. */
  refusals: Array<{ pid: number; exe: string | null; reason: string }>;
}

function assertInside(label: string, value: string, root: string): void {
  const resolved = path.resolve(value);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) {
    throw new Error(`Isolation guard: ${label} (${resolved}) is not inside ${root}`);
  }
}

/** Environment variables that name a provider home/config, a credential or a service: none reach the app. */
const ENV_DENY =
  /^(ELECTRON_(RUN_AS_NODE|NO_ATTACH_CONSOLE|RENDERER_URL|ENTRY)|NODE_(PATH|OPTIONS)|VITE_|NIMBALYST|PLAYWRIGHT|CLAUDE|ANTHROPIC|CODEX|OPENAI|GEMINI|GOOGLE_|GH_|GITHUB|GITLAB|NPM_TOKEN|AWS_|AZURE_|GCLOUD|CLOUDSDK|HF_|MISTRAL|XAI_|GROQ|OPENROUTER|COPILOT|CURSOR|STYTCH|POSTHOG|SENTRY|XDG_|SSH_|GPG_|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)/i;

export async function launchIsolated(opts: {
  workspace: string;
  /**
   * A folder holding prebuilt extensions (`<id>/manifest.json` + `<id>/dist`). They are copied into the
   * temp profile's extensions dir (NIMBALYST_E2E_EXTENSIONS_DIR), so the repo's own `dist` folders,
   * which the developer's running app also reads, are never created or touched.
   */
  extensionsFrom?: string;
}): Promise<IsolatedLaunch> {
  const tmp = os.tmpdir();

  // Guard 0: only under the runner that took the registry backup (playwright.portal.config.ts).
  const guard = guardState();
  if (!guard || process.env[ENV.fixture] !== '1') {
    throw new Error('Isolation guard: no registry backup from globalSetup. Use playwright.portal.config.ts.');
  }
  if (!fs.existsSync(guard.backup)) {
    throw new Error(`Isolation guard: registry backup ${guard.backup} is missing. Restore by hand: ${manualRestoreCommand(guard.backup)}`);
  }
  // A launch rewrites the key; if a previous launch left it on a test build, stop before making it worse.
  if (pointsAtTestBuild(readRegistryKey())) {
    throw new Error(`Isolation guard: the registry already points at a test build. Restore it first: ${manualRestoreCommand(guard.backup)}`);
  }
  installExitRestore(guard.backup, guard.original);

  // Guard 1: the separate build, never `out/`.
  if (path.relative(PACKAGE_ROOT, OUT2_ENTRY).replace(/\\/g, '/') !== 'out2/main/index.js') {
    throw new Error('Isolation guard: entry is not out2/main/index.js');
  }
  if (!fs.existsSync(OUT2_ENTRY) || !fs.existsSync(path.join(PACKAGE_ROOT, 'out2', 'renderer', 'index.html'))) {
    throw new Error('Isolation guard: out2 build is missing (see e2e/portal/README.md, Build)');
  }

  // Guard 2: fresh temp profile (under the run's temp root, removed by globalTeardown).
  const tempRoot = runTempDir('nib-portal-');
  const userDataDir = path.join(tempRoot, 'userdata');
  const dbDir = path.join(tempRoot, 'db');
  const fakeHome = path.join(tempRoot, 'home');
  for (const dir of [userDataDir, dbDir, fakeHome, path.join(fakeHome, 'AppData', 'Roaming'), path.join(fakeHome, 'AppData', 'Local')]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const [label, dir] of [['userData', userDataDir], ['db', dbDir], ['home', fakeHome], ['workspace', opts.workspace]] as const) {
    assertInside(label, dir, tmp);
  }
  if (!path.basename(tempRoot).startsWith('nib-portal-')) throw new Error('Isolation guard: temp root name');
  // Analytics off BEFORE the first start (same shape as the real analytics-settings.json).
  fs.writeFileSync(
    path.join(userDataDir, 'analytics-settings.json'),
    JSON.stringify({ analyticsEnabled: false, analyticsId: 'nib-portal-fixture', launchCount: 0, sessionsCreated: 0 }),
  );
  fs.writeFileSync(path.join(userDataDir, 'app-settings.json'), JSON.stringify({ uiLanguage: 'en' }));

  const extensionsDir = path.join(tempRoot, 'extensions');
  fs.mkdirSync(extensionsDir, { recursive: true });
  if (opts.extensionsFrom && fs.existsSync(opts.extensionsFrom)) {
    fs.cpSync(opts.extensionsFrom, extensionsDir, { recursive: true });
  }

  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_DENY.test(key)) {
      dropped.push(key);
      continue;
    }
    env[key] = value;
  }
  Object.assign(env, {
    NODE_ENV: 'production',
    PLAYWRIGHT: '1',
    NIMBALYST_USER_DATA_DIR: userDataDir,
    NIMBALYST_USER_DATA_PATH: dbDir,
    NIMBALYST_PERMISSION_MODE: 'allow-all',
    NIMBALYST_E2E_EXTENSIONS_DIR: extensionsDir,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    // `out2/main` is not the `out/main` layout WindowManager recognises, so point the renderer at the
    // built file explicitly (the variable exists for Playwright runs). No dev server is involved.
    ELECTRON_RENDERER_URL: pathToFileURL(path.join(PACKAGE_ROOT, 'out2', 'renderer', 'index.html')).toString(),
    APPDATA: path.join(fakeHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local'),
    USERPROFILE: fakeHome,
    HOME: fakeHome,
  });
  assertInside('NIMBALYST_USER_DATA_DIR', env.NIMBALYST_USER_DATA_DIR, tmp);
  assertInside('NIMBALYST_USER_DATA_PATH', env.NIMBALYST_USER_DATA_PATH, tmp);
  assertInside('NIMBALYST_E2E_EXTENSIONS_DIR', env.NIMBALYST_E2E_EXTENSIONS_DIR, tmp);

  const args = [OUT2_ENTRY, '--workspace', opts.workspace];
  if (args.some((a) => /remote-debugging|inspect/.test(a))) throw new Error('Isolation guard: debugging switch in args');

  let app: ElectronApplication;
  const launchStartedAt = Date.now() - 2000;
  try {
    app = await _electron.launch({ args, cwd: PACKAGE_ROOT, env, timeout: 60_000 });
  } catch (err) {
    restoreRegistry(guard.backup, guard.original);
    throw err;
  }
  const launched = app;
  const rootPid = launched.process().pid ?? 0;
  const allow = runAllow();
  let procs: ProcInfo[] = [];
  let launchRefused: Refusal[] = [];
  try {
    // Playwright's root pid can be a launcher that exits while the app keeps running, so the tree is taken from
    // the root AND from the app's main process (electron.exe whose command line names out2, created after this
    // launch started). Every entry is recorded as pid + creation time + executable, and vetted
    // (processSelect.ts); teardown re-checks all of it before it kills anything.
    const tree = launchTree(rootPid, allow, launchStartedAt);
    procs = tree.procs;
    launchRefused = tree.refused;
    recordProcs(tree.recorded);
  } catch (err) {
    await launched.close().catch(() => undefined);
    restoreRegistry(guard.backup, guard.original);
    throw err;
  }

  if (process.env[ENV.simulateWorkerCrash] === '1') {
    // Test of the guard itself: the worker dies hard AFTER the app has rewritten the registry and BEFORE any finally.
    await new Promise((r) => setTimeout(r, 7000));
    const line = readRegistryKey().split('\n').filter((l) => l.includes('REG_SZ')).pop();
    process.stderr.write(`[portal fixture] simulating a worker crash; registry now: ${line}\n`);
    process.kill(process.pid, 'SIGKILL');
  }

  return {
    app: launched,
    tempRoot,
    userDataDir,
    dbDir,
    pids: procs.map((p) => p.pid),
    procs,
    launchRefused: launchRefused.map((r) => ({ pid: r.proc.pid, exe: r.proc.exe, reason: r.reason })),
    droppedEnv: dropped.sort(),
    async shutdown(): Promise<ShutdownEvidence> {
      let surviving: number[] = [];
      let refusals: Array<{ pid: number; exe: string | null; reason: string }> = [];
      try {
        try {
          await launched.close();
        } catch {
          // already gone
        }
        await new Promise((r) => setTimeout(r, 1500));
        // Same identity-checked kill as the teardown: recorded pid + creation time, younger children, the repo's
        // electron.exe, out2 / this run's temp root in the command line, never 9222. What fails the check is
        // NOT killed and counts as a leftover (it fails the run).
        const recorded = procs.map((p) => ({ pid: p.pid, created: p.created, exe: p.exe }));
        const t = terminateRecorded(recorded, allow);
        surviving = [...t.survivors.map((p) => p.pid), ...t.refused.map((r) => r.proc.pid)];
        refusals = t.refused.map((r) => ({ pid: r.proc.pid, exe: r.proc.exe, reason: r.reason }));
        const stillThere = stillAlive(procs);
        surviving = Array.from(new Set([...surviving, ...stillThere.map((p) => p.pid)]));
        // Launch-time refusals (Playwright's cmd.exe launcher) are never killed; they are a leftover only if still running now.
        for (const r of stillAlive(launchRefused.map((x) => x.proc))) {
          refusals.push({ pid: r.pid, exe: r.exe, reason: 'refused at launch (identity check) and still running at shutdown' });
        }
      } finally {
        restoreRegistry(guard.backup, guard.original);
      }
      const after = readRegistryKey();
      return { registryRestored: after === guard.original, registryAfterRestore: after, survivingPids: surviving, refusals };
    },
  };
}
