/**
 * Run-level guards of the Portal fixture: the `nimbalyst://` registry key, the
 * run's temp root and the PIDs the run started. Used by globalSetup /
 * globalTeardown (runner process) and by isolatedLaunch (worker).
 *
 * Why it lives in the runner and not in the test: a launch of the app rewrites
 * HKCU\Software\Classes\nimbalyst (NIB.110). A worker that dies between the
 * launch and its `finally` (a crash, a timeout kill, SIGKILL) must not leave the
 * developer's protocol handler pointing at a test build. The runner outlives
 * its workers, so it takes the backup, restores in teardown, restores
 * synchronously on exit/SIGINT/SIGTERM, and refuses to start when a previous
 * run left the registry pointing at the test build.
 *
 * Rules:
 *  - An existing backup file is NEVER overwritten (`reg export` without /y).
 *  - The restore imports first and only then removes leftovers, so a failed
 *    import can never leave the key missing.
 *  - SIGKILL of the RUNNER cannot be handled by anything: run the command in
 *    e2e/portal/README.md by hand.
 */
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeAllow, terminateRecorded, type Allow, type RecordedProc } from './processes';

export const REG_KEY = 'HKCU\\Software\\Classes\\nimbalyst';

export const ENV = {
  fixture: 'NIMBALYST_PORTAL_FIXTURE', // set only by playwright.portal.config.ts
  backupFile: 'NIMBALYST_PORTAL_REG_BACKUP',
  originalB64: 'NIMBALYST_PORTAL_REG_ORIGINAL_B64',
  runRoot: 'NIMBALYST_PORTAL_RUN_ROOT',
  pidFile: 'NIMBALYST_PORTAL_PIDFILE',
  simulateWorkerCrash: 'NIMBALYST_PORTAL_SIMULATE_WORKER_CRASH', // harness test of the guard itself
} as const;

function reg(args: string[]): string {
  return execFileSync('reg', args, { encoding: 'utf8', windowsHide: true });
}

/** The key as `reg query /s` prints it ('' when the key is absent). */
export function readRegistryKey(): string {
  try {
    return reg(['query', REG_KEY, '/s']).replace(/\r/g, '').trim();
  } catch {
    return '';
  }
}

/**
 * True when the key points at a test build: the app registers the entry it was started from, here
 * `...\packages\electron\out2\main\index.js`. Anchored to path segments so `layout2` or `about2` do not match.
 */
export function pointsAtTestBuild(text: string): boolean {
  return /[\\/]out2[\\/]main[\\/]index\.js|nib-portal-run-/i.test(text);
}

export function manualRestoreCommand(backup: string): string {
  return `reg import "${backup}"`;
}

/**
 * Put the key back to `original` (its `reg query /s` text) from `backup`.
 * Import FIRST (a failed import throws and nothing was deleted); only if
 * leftovers remain (a value or subkey the app added) delete and import again.
 */
export function restoreRegistry(backup: string, original: string): boolean {
  if (readRegistryKey() === original) return true;
  reg(['import', backup]);
  if (readRegistryKey() === original) return true;
  // leftovers: the import merged into a key that has extra entries
  reg(['delete', REG_KEY, '/f']);
  reg(['import', backup]);
  return readRegistryKey() === original;
}

export function fileSha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function guardState(): { backup: string; original: string } | null {
  const backup = process.env[ENV.backupFile];
  const b64 = process.env[ENV.originalB64];
  if (!backup || b64 === undefined) return null;
  return { backup, original: Buffer.from(b64, 'base64').toString('utf8') };
}

/** What may be killed: the repo's electron.exe whose command line names out2 or this run's temp root. */
export function runAllow(): Allow {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const electronExe = require('electron') as unknown as string; // the path to electron.exe
  const out2Entry = path.join(__dirname, '..', '..', 'out2', 'main', 'index.js');
  const markers = [out2Entry];
  const root = process.env[ENV.runRoot];
  if (root) {
    markers.push(root);
    try {
      markers.push(fs.realpathSync.native(root));
    } catch {
      // not created yet
    }
  }
  return makeAllow({ electronExe, markers });
}

export function readRecorded(): RecordedProc[] {
  const file = process.env[ENV.pidFile];
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const r = JSON.parse(line) as RecordedProc;
        return typeof r.pid === 'number' && typeof r.created === 'number' ? [r] : [];
      } catch {
        return [];
      }
    });
}

/** Append `pid + creation time + executable` of every process of the app tree (the identity teardown re-checks before killing). */
export function recordProcs(procs: RecordedProc[]): void {
  const file = process.env[ENV.pidFile];
  if (!file) return;
  for (const p of procs) fs.appendFileSync(file, `${JSON.stringify({ pid: p.pid, created: p.created, exe: p.exe })}\n`);
}

let exitHandlersInstalled = false;
/**
 * Restore synchronously when this process ends or is signalled. Idempotent.
 *
 * Ctrl+C / SIGTERM: kill the recorded app trees FIRST (synchronously, identity-checked, processSelect.ts), then
 * restore the registry. The RUNNER does not call process.exit afterwards: Playwright's own signal handling then
 * finishes the run and still executes globalTeardown. A WORKER has no such handling, so it exits.
 */
export function installExitRestore(backup: string, original: string): void {
  if (exitHandlersInstalled) return;
  exitHandlersInstalled = true;
  const killTrees = () => {
    try {
      terminateRecorded(readRecorded(), runAllow());
    } catch (err) {
      process.stderr.write(`[portal fixture] could not kill the recorded app trees: ${(err as Error).message}\n`);
    }
  };
  const restoreNow = () => {
    try {
      restoreRegistry(backup, original);
    } catch (err) {
      process.stderr.write(`[portal fixture] COULD NOT RESTORE THE REGISTRY: ${(err as Error).message}\nRun by hand: ${manualRestoreCommand(backup)}\n`);
    }
  };
  process.on('exit', restoreNow);
  const isWorker = process.env.TEST_WORKER_INDEX !== undefined;
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    process.on(signal, () => {
      killTrees();
      restoreNow();
      if (isWorker) process.exit(code);
    });
  }
}

/** A directory under the run's temp root (removed by globalTeardown). */
export function runTempDir(prefix: string): string {
  const root = process.env[ENV.runRoot];
  if (!root) throw new Error('Portal fixture: no run root. Run it with playwright.portal.config.ts.');
  return fs.mkdtempSync(path.join(root, prefix));
}

export function isInsideTemp(p: string): boolean {
  const tmp = path.resolve(os.tmpdir());
  return path.resolve(p).startsWith(tmp + path.sep);
}
