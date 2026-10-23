import { defineConfig } from '@playwright/test';
import * as os from 'os';
import * as path from 'path';

/**
 * Portal fixture (M-9): real Electron, isolated profile. Run with
 *   npx playwright test -c playwright.portal.config.ts
 * after building out2 (see e2e/portal/README.md). This config is the only thing that
 * sets NIMBALYST_PORTAL_FIXTURE, which the spec requires; the default configs ignore e2e/portal.
 *
 * globalSetup / globalTeardown run in the runner process (it outlives its workers): they take the
 * `nimbalyst://` registry backup, restore it, kill the app trees of this run and remove its temp root.
 */
process.env.NIMBALYST_PORTAL_FIXTURE = '1';

export default defineConfig({
  testDir: './e2e/portal',
  testMatch: '**/*.spec.ts',
  outputDir: path.join(os.tmpdir(), 'nib-portal-playwright-results'),
  globalSetup: require.resolve('./e2e/portal/globalSetup'),
  globalTeardown: require.resolve('./e2e/portal/globalTeardown'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
});
