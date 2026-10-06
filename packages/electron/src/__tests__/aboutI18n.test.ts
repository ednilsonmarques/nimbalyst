// @vitest-environment node
/**
 * about.html has no i18n runtime: AboutWindow passes `system:about.*` strings in
 * the URL hash and the page falls back to its English markup. Keep the markup,
 * the key list and the English resource in lockstep.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { I18N_RESOURCES } from '@nimbalyst/runtime/i18n';

const ELECTRON = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(ELECTRON, 'about.html'), 'utf8');
const aboutWindow = fs.readFileSync(path.join(ELECTRON, 'src/main/window/AboutWindow.ts'), 'utf8');
const en = (I18N_RESOURCES.en.system as { about: Record<string, string> }).about;
const pt = (I18N_RESOURCES['pt-BR'].system as { about: Record<string, string> }).about;

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('about window i18n', () => {
  const textKeys = [...html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)].map((m) => ({ key: m[1], fallback: collapse(m[2]) }));
  const titleKeys = [...html.matchAll(/title="([^"]+)" data-i18n-title="([^"]+)"/g)].map((m) => ({ key: m[2], fallback: m[1] }));

  it('keeps the English resource identical to the HTML fallback text', () => {
    expect(textKeys.length).toBeGreaterThan(5);
    for (const { key, fallback } of [...textKeys, ...titleKeys]) {
      expect(en[key], key).toBe(fallback);
      expect(pt[key], key).toBeTruthy();
    }
  });

  it('sends every key the page reads, including the version template', () => {
    const sent = (aboutWindow.match(/for \(const key of \[([^\]]+)\]/) ?? [, ''])[1].match(/'([^']+)'/g)?.map((s) => s.slice(1, -1)) ?? [];
    for (const { key } of [...textKeys, ...titleKeys]) expect(sent).toContain(key);
    expect(sent).toContain('version');
    expect(en.version).toBe('Version {{version}}');
    expect(html).toContain("text('version', 'Version {{version}}')");
  });

  it('keeps the window title literal (ApplicationMenu identifies the window by it)', () => {
    expect(html).toContain('<title>About Nimbalyst</title>');
    expect(aboutWindow).toContain("title: 'About Nimbalyst'");
  });
});
