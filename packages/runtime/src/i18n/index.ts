/**
 * Shared localization core for the Electron main process and the renderer.
 *
 * - English ('en') is the source of truth and the fallback: a key missing
 *   from another language renders the English text, never a blank or the key.
 * - Resources are bundled JSON (no network, no async backend), so the instance
 *   is usable synchronously right after this module loads.
 * - Keys are semantic and grouped by namespace (`settings:language.title`),
 *   never the English sentence itself.
 *
 * React-free on purpose: the main-process bundle must not pull in React.
 * Components use `@nimbalyst/runtime/i18n/react`.
 */

import i18next, { type i18n as I18nInstance } from 'i18next';
import enCommon from './locales/en/common.json';
import enMenu from './locales/en/menu.json';
import enSettings from './locales/en/settings.json';
import ptBRCommon from './locales/pt-BR/common.json';
import ptBRMenu from './locales/pt-BR/menu.json';
import ptBRSettings from './locales/pt-BR/settings.json';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, isSupportedLanguage, type SupportedLanguage } from './resolveLocale';

export * from './resolveLocale';

export const I18N_NAMESPACES = ['common', 'settings', 'menu'] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const I18N_RESOURCES = {
  en: { common: enCommon, settings: enSettings, menu: enMenu },
  'pt-BR': { common: ptBRCommon, settings: ptBRSettings, menu: ptBRMenu },
} as const satisfies Record<SupportedLanguage, Record<I18nNamespace, unknown>>;

/** Dedicated instance so nothing else on the global i18next singleton can interfere. */
export const i18n: I18nInstance = i18next.createInstance();

void i18n.init({
  resources: I18N_RESOURCES,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: DEFAULT_LANGUAGE,
  supportedLngs: [...SUPPORTED_LANGUAGES],
  // Only load the exact language; 'pt-BR' must not also try a 'pt' bundle.
  load: 'currentOnly',
  ns: [...I18N_NAMESPACES],
  defaultNS: 'common',
  // React already escapes rendered strings.
  interpolation: { escapeValue: false },
  // Resources are in memory; initialize synchronously.
  initAsync: false,
});

export function getLanguage(): SupportedLanguage {
  const current = i18n.language;
  return isSupportedLanguage(current) ? current : DEFAULT_LANGUAGE;
}

/** Switch the active language. No-op when it is already active. */
export async function setLanguage(language: SupportedLanguage): Promise<void> {
  if (i18n.language === language) return;
  await i18n.changeLanguage(language);
}

/** Translate outside React (main process, plain modules). Keys use `namespace:path`. */
export function t(key: string, options?: Record<string, unknown>): string {
  return (i18n.t as (key: string, options?: Record<string, unknown>) => string)(key, options);
}

/** Subscribe to language changes. Returns an unsubscribe function. */
export function onLanguageChanged(listener: (language: SupportedLanguage) => void): () => void {
  const handler = (language: string) => {
    listener(isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE);
  };
  i18n.on('languageChanged', handler);
  return () => i18n.off('languageChanged', handler);
}
