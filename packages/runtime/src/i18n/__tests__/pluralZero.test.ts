/**
 * CLDR puts 0 in Portuguese's "one" category, so without an explicit `_zero`
 * form pt-BR renders "0 arquivo". Every plural pair carries `_zero`; in English
 * it must equal `_other` so the English output is unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { I18N_RESOURCES, setLanguage, t } from '../index';

type Tree = { [key: string]: string | Tree };

function pluralBases(tree: Tree, prefix = '', out: string[] = []): string[] {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object') pluralBases(value, path, out);
    else if (key.endsWith('_one') && `${key.slice(0, -4)}_other` in tree) out.push(path.slice(0, -4));
  }
  return out;
}

function lookup(tree: Tree, path: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of path.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}

afterEach(async () => {
  await setLanguage('en');
});

describe('zero plural forms', () => {
  for (const [ns, tree] of Object.entries(I18N_RESOURCES.en)) {
    it(`${ns}: every plural pair has a _zero form; English _zero equals _other`, () => {
      for (const base of pluralBases(tree as Tree)) {
        expect(lookup(tree as Tree, `${base}_zero`), `en ${ns}:${base}_zero`).toBe(lookup(tree as Tree, `${base}_other`));
        const pt = I18N_RESOURCES['pt-BR'][ns as keyof (typeof I18N_RESOURCES)['pt-BR']] as Tree;
        expect(lookup(pt, `${base}_zero`), `pt-BR ${ns}:${base}_zero`).toBe(lookup(pt, `${base}_other`));
      }
    });
  }

  it('renders zero counts with the plural form in pt-BR', async () => {
    expect(t('workspace:workspaceHistory.filesHeader', { count: 0 })).toBe('Files with History (0 files)');
    await setLanguage('pt-BR');
    expect(t('workspace:workspaceHistory.filesHeader', { count: 0 })).toBe('Arquivos com histórico (0 arquivos)');
    expect(t('workspace:workspaceHistory.filesHeader', { count: 1 })).toBe('Arquivos com histórico (1 arquivo)');
  });
});
