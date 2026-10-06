/**
 * Entry for the menu bar island window.
 *
 * The island renders a few hundred DOM nodes from state main pushes over IPC,
 * so it has its own entry instead of `index.tsx`. Booting it through the full
 * app loaded ~2,600 modules and ~1 GB of heap, and in dev it competed with every
 * workspace window for the cold Vite server at startup. Keep this entry's import
 * graph small: no `@nimbalyst/runtime` barrel, no renderer store barrel.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '@nimbalyst/runtime/store/store';
import { resolveLocale, setLanguage } from '@nimbalyst/runtime/i18n';
import { MenuBarIslandApp } from './components/MenuBarIsland/MenuBarIslandApp';
import './index.css';

// Follow the `app.uiLanguage` setting like workspace windows do, without the
// settings atom family (`store/listeners/uiLanguageListeners.ts` pulls in the
// full settings registry). The i18n module itself is already in this graph via
// MenuBarIslandApp's `useTranslation`, so this adds one IPC read at startup
// plus a `settings:changed` subscription -- no extra modules.
function applyUiLanguage(preference: unknown): void {
  const language = resolveLocale(preference, [...(navigator.languages ?? []), navigator.language]);
  document.documentElement.lang = language;
  setLanguage(language).catch((err: unknown) => {
    console.error('[island] Failed to switch language:', err);
  });
}

try {
  const snapshot = await window.electronAPI.settingsGetAll();
  applyUiLanguage(snapshot['app.uiLanguage']);
} catch (err) {
  // Never block the island on this; it falls back to English.
  console.error('[island] Failed to read the UI language setting:', err);
}
window.electronAPI.onSettingsChanged(({ key, value }) => {
  if (key === 'app.uiLanguage') applyUiLanguage(value);
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <JotaiProvider store={store}>
    <MenuBarIslandApp />
  </JotaiProvider>,
);
