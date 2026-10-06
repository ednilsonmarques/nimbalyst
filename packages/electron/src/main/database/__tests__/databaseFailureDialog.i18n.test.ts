// @vitest-environment node
/**
 * The startup database-failure dialog follows the UI language. Its buttons are
 * resolved back to actions by label, so the mapping must hold in every
 * language, and only the text may differ between languages.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { I18N_RESOURCES, i18n, setLanguage } from '@nimbalyst/runtime/i18n';
import { actionForChoice, buildDatabaseFailureDialog } from '../databaseFailureDialog';
import type { RestorableBackup } from '../sqlite/recoveryArtifacts';

const backup = (name: string, bytes: number): RestorableBackup => ({ name, bytes, path: `/data/db-backups/${name}` });
const OPTIONS = { rollbackSource: backup('pglite-db.migrated-1', 5000), diagnostics: 'details', retryStartup: true };
const RAW_KEY = /\b(dialogs|errors|common):|\b[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){2,}\b/;

function build() {
  return buildDatabaseFailureDialog([backup('current', 2_000_000)], OPTIONS);
}

function actions(content: ReturnType<typeof build>) {
  return content.buttons.map((_, index) => actionForChoice(content, index));
}

afterEach(async () => {
  await setLanguage('en');
});

describe('database failure dialog i18n', () => {
  it('renders in English', async () => {
    const content = build();
    expect(content.buttons).toEqual(expect.arrayContaining(['Restore Backup', 'Restore pre-migration database', 'Quit']));
  });

  it('renders in pt-BR with translated buttons and the same structure', async () => {
    // A click is resolved in the language the dialog was shown in (the dialog
    // is modal and synchronous, so the language cannot change while it is open).
    const en = build();
    const enActions = actions(en);
    await setLanguage('pt-BR');
    const pt = build();

    expect(pt.buttons).not.toEqual(en.buttons);
    expect(pt.title).not.toBe(en.title);
    expect(pt.buttons).toHaveLength(en.buttons.length);
    expect(pt.defaultId).toBe(en.defaultId);
    expect(pt.cancelId).toBe(en.cancelId);
    expect(pt.revealPath).toBe(en.revealPath);
    // The click is resolved by label: the same index must mean the same action.
    expect(actions(pt)).toEqual(enActions);
    expect(enActions).toEqual(expect.arrayContaining(['restore', 'rollback', 'quit']));
  });

  it('interpolates values and never shows a raw key', async () => {
    for (const language of ['en', 'pt-BR'] as const) {
      await setLanguage(language);
      const content = build();
      const text = [content.title, content.message, content.detail, ...content.buttons].join('\n');
      expect(text).not.toMatch(RAW_KEY);
      expect(text).not.toContain('{{');
      expect(content.detail + content.message).toContain('current');
    }
  });

  it('falls back to English when a pt-BR string is missing', async () => {
    const saved = structuredClone(I18N_RESOURCES['pt-BR'].dialogs);
    i18n.removeResourceBundle('pt-BR', 'dialogs');
    try {
      await setLanguage('pt-BR');
      expect(build().buttons).toEqual(expect.arrayContaining(['Restore Backup', 'Quit']));
    } finally {
      i18n.addResourceBundle('pt-BR', 'dialogs', saved);
    }
  });
});
