/**
 * Keeps the renderer's i18n language in sync with the `app.uiLanguage` setting.
 *
 * Call after `hydrateSettingsAtoms` (so the persisted value is already in the
 * atom) and before React mounts, so the first paint is in the right language.
 * Later changes -- from this window's selector or any other window -- arrive
 * through the `settings:changed` broadcast, update the atom, and switch the
 * language live. Components using `useTranslation()` re-render automatically.
 */

import type { createStore } from 'jotai';
import { getLanguage, onLanguageChanged, resolveLocale, setLanguage } from '@nimbalyst/runtime/i18n';
import { settingAtom } from '../atoms/settingAtomFamily';

type JotaiStore = ReturnType<typeof createStore>;

/** OS locales as Chromium reports them, in priority order. */
function getSystemLocales(): string[] {
  if (typeof navigator === 'undefined') return [];
  return [...(navigator.languages ?? []), navigator.language].filter(Boolean);
}

function setDocumentLang(language: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}

export function initUiLanguageListeners(jotaiStore: JotaiStore): () => void {
  const languageAtom = settingAtom('app.uiLanguage');

  const apply = () => {
    const language = resolveLocale(jotaiStore.get(languageAtom), getSystemLocales());
    setLanguage(language).catch((err: unknown) => {
      console.error('[i18n] Failed to switch language:', err);
    });
  };

  const unsubscribeLang = onLanguageChanged(setDocumentLang);
  apply();
  setDocumentLang(getLanguage());

  const unsubscribeSetting = jotaiStore.sub(languageAtom, apply);
  return () => {
    unsubscribeSetting();
    unsubscribeLang();
  };
}
