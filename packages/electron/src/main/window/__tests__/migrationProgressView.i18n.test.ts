// @vitest-environment node
/** The database-migration splash text resolves in the active UI language on every frame. */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';

import { buildSplashView } from '../migrationProgressView';
import type { MigrationProgress, MigrationPhase } from '../../database/sqlite/PGLiteToSQLiteMigrator';

function progress(over: Partial<MigrationProgress> & { phase: MigrationPhase }): MigrationProgress {
  return {
    rowsCopied: 0,
    rowsExpected: 0,
    tableRowsCopied: 0,
    tableRowsExpected: 0,
    tablesCompleted: 0,
    tablesTotal: 1,
    percentOfTotal: 0,
    elapsedMs: 0,
    ...over,
  };
}

const copying = progress({
  phase: 'copying',
  rowsCopied: 100,
  rowsExpected: 900,
  currentTable: 'ai_agent_messages',
  percentOfTotal: 11,
});

const copyingWithEta = progress({
  phase: 'copying',
  rowsCopied: 100_000,
  rowsExpected: 900_000,
  elapsedMs: 60_000,
  percentOfTotal: 11,
});

afterEach(async () => {
  await setLanguage('en');
});

describe('migration splash i18n', () => {
  it('keeps the English labels', () => {
    expect(buildSplashView(copying)).toMatchObject({
      primary: '100 of 900 rows',
      phase: 'Copying ai_agent_messages',
    });
    expect(buildSplashView(progress({ phase: 'verifying-integrity' })))
      .toMatchObject({ primary: 'Checking integrity', phase: 'Checking integrity', eta: '' });
    expect(buildSplashView(copyingWithEta).eta).toMatch(/ min left$/);
  });

  it('renders pt-BR labels', async () => {
    await setLanguage('pt-BR');
    expect(buildSplashView(copying)).toMatchObject({
      primary: '100 de 900 linhas',
      phase: 'Copiando ai_agent_messages',
    });
    expect(buildSplashView(progress({ phase: 'finalizing' })))
      .toMatchObject({ primary: 'Finalizando', phase: 'Finalizando' });
    expect(buildSplashView(copyingWithEta).eta).toMatch(/ min restantes$/);
  });
});
