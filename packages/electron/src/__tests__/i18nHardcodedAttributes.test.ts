// @vitest-environment node
/**
 * Static guard: user-facing `title`, `aria-label` and `placeholder`
 * attributes in the renderer go through i18n. A new literal English attribute
 * (for example one arriving with an upstream sync) fails here instead of
 * shipping untranslated. Brand names, technical tokens, developer-only screens
 * and unused components are allowlisted below.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const RENDERER = path.resolve(__dirname, '../renderer');
const LITERAL_ATTRIBUTE = /\b(title|aria-label|placeholder)="([A-Z][a-z]+[ a-z][^"]*)"/g;

/** Developer-only or unused surfaces that stay English. */
const SKIPPED_PATHS = [
  'components/DatabaseBrowser/',
  'components/DeveloperDashboard/',
  'devtools/',
  // Not imported anywhere.
  'components/WelcomeModal/',
  'components/ClaudeCommandsLearnMoreDialog.tsx',
];

/** Brand names and technical tokens, not prose. */
const ALLOWED_VALUES = new Set(['Cursor Agent', 'Grok Build', 'Header-Name']);

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : tsxFiles(full);
    return entry.name.endsWith('.tsx') ? [full] : [];
  });
}

describe('renderer i18n attributes', () => {
  it('has no literal English title/aria-label/placeholder outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(RENDERER)) {
      const relative = path.relative(RENDERER, file).split(path.sep).join('/');
      if (SKIPPED_PATHS.some((skipped) => relative.startsWith(skipped))) continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(LITERAL_ATTRIBUTE)) {
        if (!ALLOWED_VALUES.has(match[2])) offenders.push(`${relative}: ${match[1]}="${match[2]}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
