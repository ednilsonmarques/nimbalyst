// @vitest-environment jsdom
/**
 * Regression guard: real Settings screens must render translated text, never
 * raw i18n keys such as `sidebar.routes.notifications` or `notifications.title`.
 */
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage, type SupportedLanguage } from '@nimbalyst/runtime/i18n';
import { SettingsSidebar } from '../SettingsSidebar';
import { NotificationsPanel } from '../../GlobalSettings/panels/NotificationsPanel';

// A rendered i18n key looks like `segment.segment(.segment)*` in camelCase,
// e.g. `notifications.completionSounds.title`. Real UI text never does.
const RAW_KEY = /\b[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*){1,}\b/;

function findRawKeys(root: HTMLElement): string[] {
  const hits: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';
    const match = text.match(RAW_KEY);
    if (match && !/^[\w.-]+\.(json|md|ts|tsx|js)$/.test(match[0])) hits.push(text);
  }
  for (const el of Array.from(root.querySelectorAll('[aria-label],[title],[placeholder]'))) {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value && RAW_KEY.test(value) && value === value.trim() && !value.includes(' ')) hits.push(`${attr}=${value}`);
    }
  }
  return hits;
}

async function renderIn(language: SupportedLanguage, ui: React.ReactElement) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <Provider store={createStore()}>
      <I18nProvider>{ui}</I18nProvider>
    </Provider>,
  );
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe.each([
  ['en', { notifications: 'Notifications', themes: 'Themes', application: 'Application', completionSounds: 'Completion Sounds' }],
  ['pt-BR', { notifications: 'Notificações', themes: 'Temas', application: 'Aplicativo', completionSounds: 'Sons de conclusão' }],
] as const)('Settings renders translated text in %s', (language, expected) => {
  it('sidebar shows translated group and route labels, never raw keys', async () => {
    const { container, getByText } = await renderIn(
      language,
      <SettingsSidebar selectedCategory="notifications" onSelectCategory={() => {}} showDirectChatProviders />,
    );
    expect(getByText(expected.notifications)).toBeTruthy();
    expect(getByText(expected.themes)).toBeTruthy();
    expect(getByText(expected.application)).toBeTruthy();
    expect(container.textContent).not.toContain('sidebar.routes.');
    expect(container.textContent).not.toContain('sidebar.groups.');
    expect(findRawKeys(container)).toEqual([]);
  });

  it('Notifications panel shows translated text, never raw keys', async () => {
    const { container, getByText } = await renderIn(language, <NotificationsPanel />);
    expect(getByText(expected.notifications)).toBeTruthy();
    expect(getByText(expected.completionSounds)).toBeTruthy();
    expect(container.textContent).not.toContain('notifications.');
    expect(findRawKeys(container)).toEqual([]);
  });
});
