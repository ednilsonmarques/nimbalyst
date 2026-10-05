/**
 * React bindings for the shared i18n instance.
 *
 * `setI18n` registers our instance as react-i18next's default, so
 * `useTranslation()` works even outside `<I18nProvider>` (e.g. portals or
 * tests). Components re-render automatically on `languageChanged`.
 */

import { createElement, type ReactNode } from 'react';
import { I18nextProvider, setI18n, Trans, useTranslation } from 'react-i18next';
import { i18n } from './index';

setI18n(i18n);

export function I18nProvider({ children }: { children?: ReactNode }) {
  return createElement(I18nextProvider, { i18n }, children);
}

export { Trans, useTranslation };
