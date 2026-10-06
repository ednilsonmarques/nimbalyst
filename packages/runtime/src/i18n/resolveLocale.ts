/**
 * UI language resolution.
 *
 * The user picks a `UiLanguagePreference` ('system' or an explicit language).
 * `resolveLocale` turns that preference plus the OS locale list into one of the
 * languages we ship resources for. English is the default and the fallback:
 * any unsupported locale resolves to 'en'.
 *
 * Pure and dependency-free so the Electron main process, the renderer and
 * tests can all share it.
 */

export const SUPPORTED_LANGUAGES = ['en', 'pt-BR'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const UI_LANGUAGE_PREFERENCES = ['system', ...SUPPORTED_LANGUAGES] as const;
export type UiLanguagePreference = (typeof UI_LANGUAGE_PREFERENCES)[number];

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

export function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Map a single OS/browser locale (e.g. 'pt-BR', 'pt_BR.UTF-8', 'en-US') to a
 * supported language, or null when we don't ship it.
 *
 * Exact region matches win. Otherwise the base language decides, so 'pt-PT'
 * and plain 'pt' resolve to 'pt-BR' (our only Portuguese) and 'en-GB' to 'en'.
 */
export function matchSupportedLanguage(locale: string | null | undefined): SupportedLanguage | null {
  if (typeof locale !== 'string') return null;
  // Strip POSIX encoding/modifier suffixes ('pt_BR.UTF-8', 'de_DE@euro').
  const normalized = locale.trim().split(/[.@]/)[0].replace(/_/g, '-').toLowerCase();
  if (!normalized) return null;

  const exact = SUPPORTED_LANGUAGES.find((lang) => lang.toLowerCase() === normalized);
  if (exact) return exact;

  const base = normalized.split('-')[0];
  return SUPPORTED_LANGUAGES.find((lang) => lang.toLowerCase().split('-')[0] === base) ?? null;
}

/**
 * Resolve the language the UI should render in.
 *
 * @param preference    Persisted `uiLanguage` value. Anything other than a
 *                      supported language (including 'system', undefined or
 *                      garbage from disk) means "follow the system".
 * @param systemLocales OS locales in priority order. The first supported one wins.
 */
export function resolveLocale(
  preference: unknown,
  systemLocales: ReadonlyArray<string | null | undefined> = [],
): SupportedLanguage {
  if (isSupportedLanguage(preference)) return preference;
  for (const locale of systemLocales) {
    const match = matchSupportedLanguage(locale);
    if (match) return match;
  }
  return DEFAULT_LANGUAGE;
}
