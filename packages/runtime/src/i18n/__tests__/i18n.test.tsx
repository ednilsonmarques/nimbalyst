import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { getLanguage, i18n, onLanguageChanged, setLanguage, t } from '../index';
import { I18nProvider, useTranslation } from '../react';

afterEach(async () => {
  await setLanguage('en');
});

describe('i18n core', () => {
  it('starts in English', () => {
    expect(getLanguage()).toBe('en');
    expect(t('common:save')).toBe('Save');
    expect(t('settings:language.title')).toBe('Language');
  });

  it('translates to pt-BR', async () => {
    await setLanguage('pt-BR');
    expect(getLanguage()).toBe('pt-BR');
    expect(t('common:cancel')).toBe('Cancelar');
    expect(t('settings:language.english')).toBe('Inglês');
    expect(t('settings:language.portugueseBrazil')).toBe('Português (Brasil)');
  });

  it('falls back to English for keys missing in pt-BR', async () => {
    i18n.addResource('en', 'common', 'testOnlyEnglish', 'Only in English');
    try {
      await setLanguage('pt-BR');
      expect(t('common:testOnlyEnglish')).toBe('Only in English');
    } finally {
      i18n.removeResourceBundle('en', 'common');
      i18n.addResourceBundle('en', 'common', (await import('../locales/en/common.json')).default);
    }
  });

  it('notifies listeners when the language changes', async () => {
    const listener = vi.fn();
    const unsubscribe = onLanguageChanged(listener);
    await setLanguage('pt-BR');
    unsubscribe();
    await setLanguage('en');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('pt-BR');
  });
});

describe('React bindings', () => {
  function LanguageTitle() {
    const { t: translate } = useTranslation('settings');
    return <span>{translate('language.title')}</span>;
  }

  it('re-renders components when the language changes', async () => {
    const { unmount } = render(
      <I18nProvider>
        <LanguageTitle />
      </I18nProvider>,
    );
    expect(screen.getByText('Language')).toBeTruthy();

    await act(async () => {
      await setLanguage('pt-BR');
    });
    expect(screen.getByText('Idioma')).toBeTruthy();
    unmount();
  });
});
