/**
 * Runner-process setup of the Portal fixture: take the registry backup, create
 * the run's temp root and PID file, install the exit/signal restore.
 * Refuses to start (nothing launched, nothing overwritten) when a previous run
 * left the registry on a test build.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ENV,
  fileSha256,
  installExitRestore,
  manualRestoreCommand,
  pointsAtTestBuild,
  readRegistryKey,
} from './runGuard';

export default async function globalSetup(): Promise<void> {
  if (process.env[ENV.fixture] !== '1') {
    throw new Error('Portal fixture must be started with playwright.portal.config.ts');
  }
  const dir = process.env.PORTAL_FIXTURE_DIR || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  const primary = path.join(dir, 'reg-backup-run.reg');
  const current = readRegistryKey();

  if (current === '') {
    throw new Error('Portal fixture: HKCU\\Software\\Classes\\nimbalyst is absent; nothing to protect or restore. Refusing to launch.');
  }
  if (fs.existsSync(primary) && pointsAtTestBuild(current)) {
    throw new Error(
      `Portal fixture REFUSED: ${primary} exists and the registry still points at a test build (a previous run did not restore it).\n` +
        `The backup was left untouched. Restore with:\n  ${manualRestoreCommand(primary)}\nthen move or delete the backup and run again.`,
    );
  }
  if (pointsAtTestBuild(current)) {
    throw new Error(
      'Portal fixture REFUSED: the registry points at a test build and there is no backup of the original. Fix it by hand before running.',
    );
  }

  // Never overwrite: an existing backup (from a run whose registry is fine now) is kept; this run gets its own name.
  const backup = fs.existsSync(primary) ? path.join(dir, `reg-backup-run-${Date.now()}.reg`) : primary;
  execFileSync('reg', ['export', 'HKCU\\Software\\Classes\\nimbalyst', backup], { windowsHide: true }); // no /y
  if (!fs.existsSync(backup) || fs.statSync(backup).size < 20) throw new Error('Portal fixture: registry backup was not written.');

  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nib-portal-run-'));
  process.env[ENV.backupFile] = backup;
  process.env[ENV.originalB64] = Buffer.from(current, 'utf8').toString('base64');
  process.env[ENV.runRoot] = runRoot;
  process.env[ENV.pidFile] = path.join(runRoot, 'pids.txt');
  fs.writeFileSync(process.env[ENV.pidFile]!, '');
  installExitRestore(backup, current);

  fs.writeFileSync(
    path.join(dir, 'registry-hashes.txt'),
    `before: ${fileSha256(backup)}  (${backup})\n`,
  );
}
