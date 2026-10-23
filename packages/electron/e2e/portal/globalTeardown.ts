/**
 * Runner-process teardown: the last line of defence. Kills only the app trees
 * this run started, puts the registry back (import first), proves the result
 * with a hash, removes the run's temp root. ANY leftover FAILS the run.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { terminateRecorded } from './processes';
import { ENV, fileSha256, guardState, manualRestoreCommand, readRecorded, restoreRegistry, runAllow } from './runGuard';

export default async function globalTeardown(): Promise<void> {
  const problems: string[] = [];
  const state = guardState();
  const pidFile = process.env[ENV.pidFile];
  const runRoot = process.env[ENV.runRoot];

  // 1. leftover app processes of THIS run (pids recorded at launch; a worker that was killed never reached its finally)
  // Identity-checked (processSelect.ts): recorded pid + creation time, children younger than their parent,
  // the repo's electron.exe, a command line naming out2 or this run's temp root, never port 9222.
  if (pidFile && fs.existsSync(pidFile)) {
    const t = terminateRecorded(readRecorded(), runAllow());
    if (t.killed.length) {
      problems.push(
        `teardown had to kill leftover processes of the run: ${t.killed.map((p) => p.pid).join(',')}` +
          (t.survivors.length ? ` (STILL ALIVE: ${t.survivors.map((p) => p.pid).join(',')})` : ''),
      );
    }
    for (const r of t.refused) {
      problems.push(`leftover process NOT killed (identity check failed: ${r.reason}): pid ${r.proc.pid} ${r.proc.exe ?? '?'}`);
    }
    if (t.reused.length) {
      // informational: those PIDs belong to other processes now; they were not touched
      process.stderr.write(`[portal fixture] recorded PIDs reused by other processes (left alone): ${t.reused.map((r) => r.pid).join(',')}\n`);
    }
  }

  // 2. registry
  if (state) {
    try {
      if (!restoreRegistry(state.backup, state.original)) {
        problems.push(`registry NOT restored to the original; run: ${manualRestoreCommand(state.backup)}`);
      } else {
        const dir = path.dirname(state.backup);
        const after = path.join(dir, 'reg-snapshot-after.reg');
        execFileSync('reg', ['export', 'HKCU\\Software\\Classes\\nimbalyst', after, '/y'], { windowsHide: true });
        const same = fileSha256(after) === fileSha256(state.backup);
        fs.appendFileSync(path.join(dir, 'registry-hashes.txt'), `after:  ${fileSha256(after)}  (${after})\nidentical: ${same}\n`);
        if (!same) problems.push('registry hash after restore differs from the backup');
        else {
          // verified: keep the backup as evidence under a name that cannot be mistaken for "unrestored"
          fs.renameSync(state.backup, state.backup.replace(/\.reg$/, `.restored-${Date.now()}.reg`));
        }
      }
    } catch (err) {
      problems.push(`registry restore threw: ${(err as Error).message}; run: ${manualRestoreCommand(state.backup)}`);
    }
  } else if (runRoot || pidFile) {
    problems.push('no registry guard state in teardown');
  } // else: globalSetup refused or failed before doing anything; nothing to undo

  // 3. temp root of the run (only ours, only under %TEMP%)
  if (runRoot) {
    const tmp = path.resolve(os.tmpdir());
    const resolved = path.resolve(runRoot);
    if (resolved.startsWith(tmp + path.sep) && path.basename(resolved).startsWith('nib-portal-run-')) {
      try {
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
      } catch (err) {
        problems.push(`temp root not removed (${(err as Error).message.slice(0, 120)}): ${resolved}`);
      }
      if (fs.existsSync(resolved) && !problems.some((p) => p.startsWith('temp root'))) problems.push(`temp root not removed: ${resolved}`);
    }
  }

  if (problems.length) throw new Error(`Portal fixture teardown FAILED:\n - ${problems.join('\n - ')}`);
}
