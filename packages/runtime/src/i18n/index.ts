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
import enDialogs from './locales/en/dialogs.json';
import enErrors from './locales/en/errors.json';
import enMenu from './locales/en/menu.json';
import enSettings from './locales/en/settings.json';
import enWorkspace from './locales/en/workspace.json';
import enAgent from './locales/en/agent.json';
import enAi from './locales/en/ai.json';
import enEditor from './locales/en/editor.json';
import enTracker from './locales/en/tracker.json';
import enOnboarding from './locales/en/onboarding.json';
import enGeneral from './locales/en/general.json';
import enTeam from './locales/en/team.json';
import enPullRequest from './locales/en/pullRequest.json';
import enSystem from './locales/en/system.json';
import ptBRCommon from './locales/pt-BR/common.json';
import ptBRDialogs from './locales/pt-BR/dialogs.json';
import ptBRErrors from './locales/pt-BR/errors.json';
import ptBRMenu from './locales/pt-BR/menu.json';
import ptBRSettings from './locales/pt-BR/settings.json';
import ptBRWorkspace from './locales/pt-BR/workspace.json';
import ptBRAgent from './locales/pt-BR/agent.json';
import ptBRAi from './locales/pt-BR/ai.json';
import ptBREditor from './locales/pt-BR/editor.json';
import ptBRTracker from './locales/pt-BR/tracker.json';
import ptBROnboarding from './locales/pt-BR/onboarding.json';
import ptBRGeneral from './locales/pt-BR/general.json';
import ptBRTeam from './locales/pt-BR/team.json';
import ptBRPullRequest from './locales/pt-BR/pullRequest.json';
import ptBRSystem from './locales/pt-BR/system.json';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, isSupportedLanguage, type SupportedLanguage } from './resolveLocale';

export * from './resolveLocale';

export const I18N_NAMESPACES = ['common', 'settings', 'menu', 'dialogs', 'errors', 'workspace', 'agent', 'ai', 'editor', 'tracker', 'onboarding', 'general', 'team', 'pullRequest', 'system'] as const;
export type I18nNamespace = (typeof I18N_NAMESPACES)[number];

export const I18N_RESOURCES = {
  en: {
    common: enCommon, settings: enSettings, menu: enMenu, dialogs: enDialogs, errors: enErrors,
    workspace: enWorkspace, agent: enAgent, ai: enAi, editor: enEditor, tracker: enTracker, onboarding: enOnboarding,
    general: enGeneral, team: enTeam, pullRequest: enPullRequest, system: enSystem,
  },
  'pt-BR': {
    common: ptBRCommon, settings: ptBRSettings, menu: ptBRMenu, dialogs: ptBRDialogs, errors: ptBRErrors,
    workspace: ptBRWorkspace, agent: ptBRAgent, ai: ptBRAi, editor: ptBREditor, tracker: ptBRTracker, onboarding: ptBROnboarding,
    general: ptBRGeneral, team: ptBRTeam, pullRequest: ptBRPullRequest, system: ptBRSystem,
  },
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
