// @vitest-environment jsdom
/** The first-run dialog follows the UI language; persisted option values never change. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { UnifiedOnboarding } from '../UnifiedOnboarding';

beforeEach(() => {
  (window as any).electronAPI = { invoke: vi.fn().mockResolvedValue({}) };
});

afterEach(async () => {
  cleanup();
  delete (window as any).electronAPI;
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  const onComplete = vi.fn();
  const view = render(
    <I18nProvider>
      <UnifiedOnboarding isOpen onComplete={onComplete} onSkip={() => {}} forcedMode="new" />
    </I18nProvider>,
  );
  return { ...view, onComplete };
}

describe('UnifiedOnboarding i18n', () => {
  it('keeps the English copy', async () => {
    await renderIn('en');
    expect(screen.getByText('Welcome to Nimbalyst')).toBeTruthy();
    expect(screen.getByText('Standard Mode')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start tutorial' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toBeTruthy();
    expect(screen.getByText(/By continuing, you agree to our/).textContent).toBe(
      'By continuing, you agree to our Terms of Service and Privacy Policy.',
    );
  });

  it('renders pt-BR labels while submitting the same persisted values', async () => {
    const { onComplete, container } = await renderIn('pt-BR');
    expect(screen.getByText('Boas-vindas ao Nimbalyst')).toBeTruthy();
    fireEvent.click(screen.getByText('Modo padrão'));

    const roleSelect = screen.getByLabelText('O que melhor descreve sua função?');
    const designer = within(roleSelect).getByRole('option', { name: 'Designer' }) as HTMLOptionElement;
    expect(designer.value).toBe('designer');
    expect(within(roleSelect).getByRole('option', { name: 'Gerente de produto' })).toBeTruthy();

    const referralSelect = screen.getByLabelText('Como você conheceu o Nimbalyst?');
    fireEvent.change(referralSelect, { target: { value: 'social' } });
    const platformSelect = screen.getByLabelText('Qual plataforma?');
    const other = within(platformSelect).getByRole('option', { name: 'Outra' }) as HTMLOptionElement;
    expect(other.value).toBe('Other');
    fireEvent.change(platformSelect, { target: { value: 'Other' } });

    fireEvent.change(screen.getByLabelText('Endereço de e-mail'), { target: { value: 'nope' } });
    expect(screen.getByText('Insira um endereço de e-mail válido')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Endereço de e-mail'), { target: { value: '' } });

    expect(screen.getByRole('link', { name: 'Termos de Serviço' }).getAttribute('href')).toBe(
      'https://nimbalyst.com/terms-of-service',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar tutorial' }));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ referralSource: 'social:Other', developerMode: false }),
      'tutorial',
    );
    expect(container.textContent).not.toMatch(/unifiedOnboarding\.|onboarding:/);
  });
});
