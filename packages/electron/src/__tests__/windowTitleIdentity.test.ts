// @vitest-environment node
/**
 * ApplicationMenu identifies some windows by comparing `window.getTitle()` with
 * an English literal. Those window titles must stay literal (never `t()`), or
 * the menu stops recognising the window in a translated UI.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const MAIN = path.resolve(__dirname, '../main');

describe('window titles used as identifiers', () => {
  it('are created with the same English literal the menu compares against', () => {
    const menu = fs.readFileSync(path.join(MAIN, 'menu/ApplicationMenu.ts'), 'utf8');
    const compared = [...menu.matchAll(/getTitle\(\)\s*===\s*'([^']+)'/g)].map((m) => m[1]);
    expect(compared.length).toBeGreaterThan(0);

    const windowSources = fs
      .readdirSync(path.join(MAIN, 'window'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => fs.readFileSync(path.join(MAIN, 'window', name), 'utf8'))
      .join('\n');
    for (const title of compared) {
      expect(windowSources, title).toContain(`title: '${title}'`);
    }
  });

  it('are not rewritten to another text after load (renderer setTitle and about.html)', () => {
    const app = fs.readFileSync(path.resolve(MAIN, '../renderer/App.tsx'), 'utf8');
    expect(app).toContain("setTitle('Project Manager - Nimbalyst')");
    const about = fs.readFileSync(path.resolve(MAIN, '../../about.html'), 'utf8');
    expect(about).toContain('<title>About Nimbalyst</title>');
  });
});
