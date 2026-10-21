import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * NIB.85 stage d2: the capture window and the AI usage report window carry the
 * app preload, so they must run it sandboxed like the main windows (which omit
 * `sandbox` and get Electron's default of true). Runtime proof is in
 * nib81/smoke/staged2.cjs; this pins the setting so it is not flipped back.
 */
function webPreferencesBlock(file: string): string {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('webPreferences: {');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('}', start));
}

describe('windows that carry the app preload are sandboxed', () => {
  const main = path.resolve(__dirname, '..', '..');
  it.each([
    ['AIUsageReportWindow', path.join(main, 'window', 'AIUsageReportWindow.ts')],
    ['OffscreenEditorManager', path.join(main, 'services', 'OffscreenEditorManager.ts')],
  ])('%s sets sandbox: true and keeps contextIsolation', (_name, file) => {
    const block = webPreferencesBlock(file);
    expect(block).toMatch(/sandbox:\s*true/);
    expect(block).not.toMatch(/sandbox:\s*false/);
    expect(block).toMatch(/contextIsolation:\s*true/);
    expect(block).not.toMatch(/nodeIntegration:\s*true/);
  });
});
