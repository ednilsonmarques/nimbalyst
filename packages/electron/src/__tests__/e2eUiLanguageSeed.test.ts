/**
 * E2E launches pin the interface language to English by seeding
 * `app.uiLanguage` in the test userData dir (e2e/utils/uiLanguageSeed.ts).
 * These checks keep the seed aligned with the settings registry and prove that
 * the seeded value beats a pt-BR OS locale.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resolveLocale } from '@nimbalyst/runtime/i18n';
import { SETTINGS_REGISTRY } from '../shared/settings/keys';
import {
  E2E_UI_LANGUAGE,
  UI_LANGUAGE_SETTINGS_FILE,
  UI_LANGUAGE_SETTINGS_PATH,
  seedE2EUiLanguage,
} from '../../e2e/utils/uiLanguageSeed';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimbalyst-ui-lang-seed-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function readSettings(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(dir, UI_LANGUAGE_SETTINGS_FILE), 'utf-8'));
}

describe('E2E uiLanguage seed', () => {
  it('targets the same store and path as the app.uiLanguage setting', () => {
    const { storage } = SETTINGS_REGISTRY['app.uiLanguage'];
    expect(`${storage.store}.json`).toBe(UI_LANGUAGE_SETTINGS_FILE);
    expect(storage.path).toBe(UI_LANGUAGE_SETTINGS_PATH);
    expect(SETTINGS_REGISTRY['app.uiLanguage'].schema.safeParse(E2E_UI_LANGUAGE).success).toBe(true);
  });

  it('writes English into a fresh userData dir, overriding a pt-BR OS locale', async () => {
    await seedE2EUiLanguage(path.join(dir, 'user-data'));
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'user-data', UI_LANGUAGE_SETTINGS_FILE), 'utf-8'));
    expect(raw).toEqual({ uiLanguage: 'en' });
    expect(resolveLocale(raw.uiLanguage, ['pt-BR', 'pt'])).toBe('en');
  });

  it('keeps other persisted settings and an existing language choice', async () => {
    const file = path.join(dir, UI_LANGUAGE_SETTINGS_FILE);
    await fs.writeFile(file, JSON.stringify({ theme: 'dark' }));
    await seedE2EUiLanguage(dir);
    expect(await readSettings()).toEqual({ theme: 'dark', uiLanguage: 'en' });

    await fs.writeFile(file, JSON.stringify({ theme: 'dark', uiLanguage: 'pt-BR' }));
    await seedE2EUiLanguage(dir);
    expect(await readSettings()).toEqual({ theme: 'dark', uiLanguage: 'pt-BR' });
  });

  it('replaces an unparseable settings file and ignores a missing dir option', async () => {
    await fs.writeFile(path.join(dir, UI_LANGUAGE_SETTINGS_FILE), '{not json');
    await seedE2EUiLanguage(dir);
    expect(await readSettings()).toEqual({ uiLanguage: 'en' });
    await expect(seedE2EUiLanguage(undefined)).resolves.toBeUndefined();
  });
});
