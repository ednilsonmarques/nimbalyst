import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'jotai';
import { getLanguage, setLanguage } from '@nimbalyst/runtime/i18n';
import { settingAtom } from '../../atoms/settingAtomFamily';
import { initUiLanguageListeners } from '../uiLanguageListeners';

let teardown: (() => void) | null = null;

afterEach(async () => {
  teardown?.();
  teardown = null;
  vi.restoreAllMocks();
  await setLanguage('en');
  document.documentElement.lang = '';
});

function mockSystemLanguages(languages: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0] ?? '');
}

describe('initUiLanguageListeners', () => {
  it('applies the persisted language and sets <html lang>', async () => {
    mockSystemLanguages(['en-US']);
    const store = createStore();
    await store.set(settingAtom('app.uiLanguage'), 'pt-BR');

    teardown = initUiLanguageListeners(store);

    await vi.waitFor(() => expect(getLanguage()).toBe('pt-BR'));
    expect(document.documentElement.lang).toBe('pt-BR');
  });

  it('resolves "system" from the OS locale', async () => {
    mockSystemLanguages(['pt-BR', 'en-US']);
    const store = createStore();

    teardown = initUiLanguageListeners(store);

    await vi.waitFor(() => expect(getLanguage()).toBe('pt-BR'));
  });

  it('falls back to English for an unsupported system locale', async () => {
    mockSystemLanguages(['de-DE']);
    const store = createStore();

    teardown = initUiLanguageListeners(store);

    await vi.waitFor(() => expect(getLanguage()).toBe('en'));
    expect(document.documentElement.lang).toBe('en');
  });

  it('switches live when the setting changes', async () => {
    mockSystemLanguages(['en-US']);
    const store = createStore();
    teardown = initUiLanguageListeners(store);
    await vi.waitFor(() => expect(getLanguage()).toBe('en'));

    await store.set(settingAtom('app.uiLanguage'), 'pt-BR');
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('pt-BR'));

    await store.set(settingAtom('app.uiLanguage'), 'system');
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('en'));
  });
});
