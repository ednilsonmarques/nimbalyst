// @vitest-environment node
/**
 * Static guard: every literal i18n key used anywhere in the desktop app
 * (`ns:key`, or a bare key resolved against the component's useTranslation
 * namespace) exists in the English resources, so no dialog, toast,
 * notification, menu or settings screen can show a raw key.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { I18N_RESOURCES } from '@nimbalyst/runtime/i18n';

type Tree = { [key: string]: string | Tree };
const SRC = path.resolve(__dirname, '..');

function flatten(tree: Tree, prefix = '', out = new Set<string>()): Set<string> {
  for (const [key, value] of Object.entries(tree)) {
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.add(keyPath);
    else flatten(value, keyPath, out);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const KNOWN: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(I18N_RESOURCES.en).map(([ns, tree]) => [ns, flatten(tree as Tree)]),
);
const KEY_USAGE = /(?:\b(?:t|translate|i18nT)\(\s*|i18nKey=\{?\s*)(['"])([^'"`$]+)\1/g;

const has = (ns: string, key: string) =>
  KNOWN[ns].has(key) || KNOWN[ns].has(`${key}_one`) || KNOWN[ns].has(`${key}_other`);

describe('desktop i18n keys', () => {
  it('every literal key used in the desktop app exists in English', () => {
    const missing: string[] = [];
    let used = 0;
    for (const file of sourceFiles(SRC)) {
      const source = fs.readFileSync(file, 'utf8');
      const defaultNs = source.match(/useTranslation\(\s*['"](\w+)['"]/)?.[1];
      for (const match of source.matchAll(KEY_USAGE)) {
        const raw = match[2];
        const [ns, key] = raw.includes(':') ? raw.split(':', 2) : [defaultNs, raw];
        if (!ns) continue;
        if (!KNOWN[ns]) {
          // `ns:key` with a namespace that does not exist would render the raw key.
          if (raw.includes(':') && /^[a-z][A-Za-z]*$/.test(ns)) missing.push(`${path.relative(SRC, file)}: unknown namespace ${raw}`);
          continue;
        }
        used++;
        if (!has(ns, key)) missing.push(`${path.relative(SRC, file)}: ${ns}:${key}`);
      }
    }
    expect(used).toBeGreaterThan(1500);
    expect(missing).toEqual([]);
  });

  it('pt-BR has every English dialogs/errors key', () => {
    for (const ns of ['dialogs', 'errors'] as const) {
      const pt = flatten(I18N_RESOURCES['pt-BR'][ns] as Tree);
      expect([...KNOWN[ns]].filter((key) => !pt.has(key))).toEqual([]);
    }
  });
});
