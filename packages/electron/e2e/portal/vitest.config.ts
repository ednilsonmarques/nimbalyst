import { defineConfig } from 'vitest/config';

/**
 * Unit tests of the Portal harness itself (pure functions, no Electron, no registry, no process touched).
 * The package vitest config only includes src/**, so run this one explicitly:
 *   npx vitest run -c e2e/portal/vitest.config.ts --maxWorkers=1 --no-file-parallelism
 * Playwright never picks the file up (its testMatch is *.spec.ts).
 */
export default defineConfig({
  root: __dirname,
  test: {
    include: ['*.test.ts'],
    environment: 'node',
    pool: 'forks',
  },
});
