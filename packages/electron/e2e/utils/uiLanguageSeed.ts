/**
 * Pin the interface language of E2E launches to English.
 *
 * The specs look for English UI text ('Toggle Source Mode', `title="More
 * actions"`, ...). `app.uiLanguage` defaults to 'system', so on a machine whose
 * OS language is supported (e.g. pt-BR) the app would render translated text
 * and those selectors would miss. Seeding the setting in the test `userData`
 * directory before launch makes the run independent of the OS locale without
 * touching production code: main (`services/uiLanguage.ts`) and the renderer
 * (`store/listeners/uiLanguageListeners.ts`) both read the same persisted
 * value through SettingsService, and an explicit language wins over the OS
 * locales in `resolveLocale`.
 *
 * Storage mirrors the registry entry for `app.uiLanguage` in
 * `src/shared/settings/keys.ts` (store 'app-settings', path 'uiLanguage');
 * a unit test keeps the two in sync.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export const E2E_UI_LANGUAGE = 'en';
export const UI_LANGUAGE_SETTINGS_FILE = 'app-settings.json';
export const UI_LANGUAGE_SETTINGS_PATH = 'uiLanguage';

/**
 * Write `uiLanguage` into `<userDataDir>/app-settings.json` unless the file
 * already chooses one. An existing choice is kept so specs that relaunch with
 * `preserveTestDatabase` (or set the language themselves) are not overridden;
 * the rest of the file is preserved untouched.
 */
export async function seedE2EUiLanguage(
  userDataDir: string | undefined,
  language: string = E2E_UI_LANGUAGE,
): Promise<void> {
  if (!userDataDir) return;
  const file = path.join(userDataDir, UI_LANGUAGE_SETTINGS_FILE);

  let settings: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable: start from an empty store (the app's own
    // `clearInvalidConfig` would discard an invalid file anyway).
  }

  if (typeof settings[UI_LANGUAGE_SETTINGS_PATH] === 'string') return;

  settings[UI_LANGUAGE_SETTINGS_PATH] = language;
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, '\t'), { encoding: 'utf-8', mode: 0o600 });
}
