/**
 * Main-process side of the interface language.
 *
 * Resolves the persisted `app.uiLanguage` setting against the OS locales and
 * keeps the shared i18n instance in sync, so main-process code (menus, tray,
 * native dialogs) can call `t()` from `@nimbalyst/runtime/i18n`.
 *
 * The renderer resolves the same setting independently (see
 * renderer/store/listeners/uiLanguageListeners.ts); both read the setting from
 * SettingsService and react to the same `settings:changed` change.
 */

import { app } from 'electron';
import { resolveLocale, setLanguage, type SupportedLanguage } from '@nimbalyst/runtime/i18n';
import { getSettingsService } from './SettingsService';
import { logger } from '../utils/logger';

let initialized = false;

/**
 * OS locales in priority order. The user's preferred display languages come
 * first; `getLocale()` is Chromium's UI locale and `getSystemLocale()` the
 * regional-format locale (the one the spellchecker setup uses).
 */
export function getSystemLocales(): string[] {
  const locales: string[] = [];
  try {
    locales.push(...(app.getPreferredSystemLanguages?.() ?? []));
  } catch {
    // Not available on every platform/version; fall through to the others.
  }
  locales.push(app.getLocale(), app.getSystemLocale?.() ?? '');
  return locales.filter(Boolean);
}

export function resolveUiLanguage(preference: unknown): SupportedLanguage {
  return resolveLocale(preference, getSystemLocales());
}

function apply(preference: unknown): void {
  const language = resolveUiLanguage(preference);
  setLanguage(language).catch((err) => {
    logger.main?.error?.('[uiLanguage] Failed to switch language', err);
  });
}

/**
 * Apply the saved language and follow later changes. Call once after
 * `app.whenReady()`, before menus and windows are built. Idempotent.
 */
export function initUiLanguage(): void {
  if (initialized) return;
  initialized = true;

  try {
    apply(getSettingsService().get('app.uiLanguage'));
  } catch (err) {
    // Never block startup on localization: English stays active.
    logger.main?.error?.('[uiLanguage] Failed to read app.uiLanguage', err);
  }

  getSettingsService().subscribe((key, value) => {
    if (key === 'app.uiLanguage') apply(value);
  });
}
