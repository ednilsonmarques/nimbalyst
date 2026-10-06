import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { getSaveFailureMessage } from '../fileSaveResult';

const ERROR_TYPES = ['permission', 'disk_full', 'not_found', 'is_directory', 'invalid_path', 'resource_limit', 'io', 'conflict', 'empty_write_blocked', 'unknown'];

afterEach(async () => {
  await setLanguage('en');
});

describe('getSaveFailureMessage i18n', () => {
  it('keeps the exact original English wording for every error type and source', () => {
    const reasons: Record<string, string> = {
      permission: ' because Nimbalyst does not have permission to write this file. Your edits remain unsaved.',
      disk_full: ' because the disk is full. Your edits remain unsaved.',
      not_found: ' because the file is no longer available. Your edits remain unsaved.',
      is_directory: ' because the file location is not writable. Your edits remain unsaved.',
      invalid_path: ' because the file location is not writable. Your edits remain unsaved.',
      resource_limit: ' because the operating system could not write the file. Your edits remain unsaved.',
      io: ' because the operating system could not write the file. Your edits remain unsaved.',
      conflict: ' because the file changed on disk. Your edits remain unsaved.',
      empty_write_blocked: ' because it would have emptied a file that still has content. Your edits remain unsaved — save manually if you meant to clear the file.',
      unknown: '. Your edits remain unsaved.',
    };
    for (const [errorType, rest] of Object.entries(reasons)) {
      expect(getSaveFailureMessage(errorType, 'auto')).toBe(`Autosave is blocked${rest}`);
      expect(getSaveFailureMessage(errorType, 'manual')).toBe(`Save failed${rest}`);
    }
  });

  it('translates every error type for both sources in pt-BR without raw keys', async () => {
    await setLanguage('pt-BR');
    for (const source of ['auto', 'manual'] as const) {
      for (const errorType of ERROR_TYPES) {
        const message = getSaveFailureMessage(errorType, source);
        expect(message).not.toMatch(/errors:|save\.(auto|manual)/);
        expect(message).toContain('Suas edições continuam sem salvar');
        expect(message.startsWith(source === 'auto' ? 'O salvamento automático está bloqueado' : 'Falha ao salvar')).toBe(true);
      }
    }
  });
});
