/**
 * Portal F1.2 -- the test-data mark IPC answers with an error CODE, never UI
 * text. The settings panel maps each code to an i18n key (en and pt-BR) and
 * falls back to the generic message, so no raw English from main reaches the UI.
 */
import { describe, expect, it } from 'vitest';
import en from '../../../../../../../runtime/src/i18n/locales/en/settings.json';
import ptBR from '../../../../../../../runtime/src/i18n/locales/pt-BR/settings.json';
import enDialogs from '../../../../../../../runtime/src/i18n/locales/en/dialogs.json';
import ptBRDialogs from '../../../../../../../runtime/src/i18n/locales/pt-BR/dialogs.json';
import { PORTAL_TEST_DATA_ERROR_KEYS, parsePortInput, portalTestDataErrorKey, shouldShowPortalTestDataError } from '../portalTestDataErrors';

const lookup = (bundle: any, key: string) => key.split('.').reduce((o, k) => o?.[k], bundle);

describe('portalTestDataErrorKey', () => {
  it('maps each code main returns to its own key', () => {
    expect(portalTestDataErrorKey('notProjectWindow')).toBe('projectPermissions.errors.portalTestDataNotProjectWindow');
    expect(portalTestDataErrorKey('noUserInput')).toBe('projectPermissions.errors.portalTestDataNoUserInput');
  });

  it('uses the generic message for invalidRequest, an unknown code, or no code', () => {
    for (const code of ['invalidRequest', 'something-new', '', undefined, null, 42]) {
      expect(portalTestDataErrorKey(code as never)).toBe('projectPermissions.errors.portalTestData');
    }
  });

  it('never returns text from main: only keys that exist in both locales', () => {
    const keys = new Set([...Object.values(PORTAL_TEST_DATA_ERROR_KEYS), portalTestDataErrorKey(undefined)]);
    expect(keys.size).toBeGreaterThanOrEqual(3);
    for (const key of keys) {
      expect(typeof lookup(en, key), `en ${key}`).toBe('string');
      expect(typeof lookup(ptBR, key), `pt-BR ${key}`).toBe('string');
      expect(lookup(ptBR, key)).not.toBe(lookup(en, key));
    }
  });
});

describe('port input in the settings card', () => {
  it.each([['5173', 5173], [' 80 ', 80], ['65535', 65535], ['1', 1]])('accepts %j', (text, port) => {
    expect(parsePortInput(text)).toBe(port);
  });
  it.each([[''], ['0'], ['65536'], ['-1'], ['1.5'], ['abc'], ['80a'], ['1e3'], ['0x50'], ['  ']])('rejects %j', (text) => {
    expect(parsePortInput(text)).toBeNull();
  });
  it('a cancelled native confirmation is not an error to show', () => {
    expect(shouldShowPortalTestDataError('notConfirmed')).toBe(false);
    expect(shouldShowPortalTestDataError('noUserInput')).toBe(true);
    expect(shouldShowPortalTestDataError(undefined)).toBe(true);
  });
  it('the new port strings exist in both locales and differ between them', () => {
    for (const key of [
      'projectPermissions.portalTestData.ports.title', 'projectPermissions.portalTestData.ports.description',
      'projectPermissions.portalTestData.ports.placeholder', 'projectPermissions.portalTestData.ports.add',
      'projectPermissions.portalTestData.ports.remove', 'projectPermissions.portalTestData.ports.empty',
      'projectPermissions.errors.portalPortInvalid', 'projectPermissions.messages.portalPortsUpdated',
    ]) {
      expect(typeof lookup(en, key), 'en ' + key).toBe('string');
      expect(typeof lookup(ptBR, key), 'pt ' + key).toBe('string');
      expect(lookup(ptBR, key)).not.toBe(lookup(en, key));
    }
  });
});

describe('wording of the test-data card and dialog (reviewer: content)', () => {
  const card = (b: any) => b.projectPermissions.portalTestData;

  it('the card description does not claim agents can only look "everywhere else"', () => {
    expect(card(en).description).not.toMatch(/Everywhere else/);
    expect(card(ptBR).description).not.toMatch(/Em qualquer outro lugar/);
    expect(card(en).description).toContain('On other localhost pages they can only look.');
    expect(card(ptBR).description).toContain('Nas demais páginas do localhost, eles só podem olhar.');
  });

  it('keeps the rest of the description', () => {
    expect(card(en).description).toContain("click, type and run scripts in previews of this project's files and on the localhost ports you declare below.");
    expect(card(en).description).toContain('Nimbalyst asks you to confirm it in a system dialog.');
    expect(card(ptBR).description).toContain('pede sua confirmação em uma caixa de diálogo do sistema.');
  });

  it('pt-BR says "somente visualização", never "somente leitura", for view-only', () => {
    const texts = [card(ptBR).ports.empty, ...Object.values(ptBRDialogs.portalTestData)] as string[];
    for (const t of texts) expect(t).not.toMatch(/somente leitura/);
    expect(card(ptBR).ports.empty).toContain('somente visualização');
    expect(ptBRDialogs.portalTestData.detailEnable).toContain('somente visualização');
    expect(ptBRDialogs.portalTestData.detailEnableNoPorts).toContain('somente visualização');
    expect(card(en).ports.empty).toContain('view-only');
    expect(enDialogs.portalTestData.detailEnable).toContain('view-only');
    expect(enDialogs.portalTestData.detailEnableNoPorts).toContain('view-only');
  });

  it('detailEnableNoPorts says "they can change data there" right after the first sentence, then the localhost sentence', () => {
    const e = enDialogs.portalTestData.detailEnableNoPorts;
    const p = ptBRDialogs.portalTestData.detailEnableNoPorts;
    expect(e.indexOf('They can change data there')).toBeGreaterThan(e.indexOf('previews of its files.'));
    expect(e.indexOf('They can change data there')).toBeLessThan(e.indexOf('Localhost pages stay view-only'));
    expect(e).toMatch(/previews of its files\. They can change data there, so continue only if those previews hold test data\. Localhost pages stay view-only until you declare ports\.$/);
    expect(p.indexOf('Eles podem alterar dados ali')).toBeLessThan(p.indexOf('As páginas do localhost'));
    expect(p).toMatch(/dos arquivos dele\. Eles podem alterar dados ali, então continue somente se essas prévias contiverem apenas dados de teste\. As páginas do localhost ficam em somente visualização até você declarar portas\.$/);
  });
});
