// @vitest-environment node
/**
 * Static guard: every literal i18n key used in the Settings UI must exist in
 * the English resources. A missing key renders as the raw key (e.g.
 * `notifications.title`) instead of text.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { I18N_RESOURCES } from '@nimbalyst/runtime/i18n';

const COMPONENTS_DIR = path.resolve(__dirname, '../..');
const SCANNED_DIRS = ['Settings', 'GlobalSettings'];

type Tree = { [key: string]: string | Tree };

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
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

const KNOWN: Record<string, Set<string>> = {
  settings: flatten(I18N_RESOURCES.en.settings as Tree),
  common: flatten(I18N_RESOURCES.en.common as Tree),
};

// t('key'), translate('ns:key'), i18nT('key'), i18nKey="key", i18nKey={'key'}
const KEY_USAGE = /(?:\b(?:t|translate|i18nT)\(\s*|i18nKey=\{?\s*)(['"])([^'"`$]+)\1/g;

function hasKey(namespace: string, key: string): boolean {
  const keys = KNOWN[namespace];
  return keys.has(key) || keys.has(`${key}_one`) || keys.has(`${key}_other`);
}

describe('Settings i18n keys', () => {
  const files = SCANNED_DIRS.flatMap((dir) => sourceFiles(path.join(COMPONENTS_DIR, dir)));

  it('scans the Settings UI', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('every literal key used in Settings exists in the English resources', () => {
    const missing: string[] = [];
    let used = 0;
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(KEY_USAGE)) {
        const raw = match[2];
        const [namespace, key] = raw.includes(':') ? raw.split(':', 2) : ['settings', raw];
        if (!KNOWN[namespace]) continue;
        used++;
        if (!hasKey(namespace, key)) missing.push(`${path.relative(COMPONENTS_DIR, file)}: ${namespace}:${key}`);
      }
    }
    expect(used).toBeGreaterThan(1000);
    expect(missing).toEqual([]);
  });
});
