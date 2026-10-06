// @vitest-environment jsdom
/** Shared tray/island section chrome follows the UI language. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage, t } from '@nimbalyst/runtime/i18n';
import { TrayMarkAllReadButton, TraySessionSectionHeader } from '../traySessionSections';

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <TraySessionSectionHeader
        state="unread"
        count={3}
        actionSlot={<TrayMarkAllReadButton className="x" testId="mark" onClick={vi.fn()} />}
      />
      <TraySessionSectionHeader state="stalled" count={1} />
    </I18nProvider>,
  );
}

describe('tray session sections i18n', () => {
  it('keeps the English labels', async () => {
    await renderIn('en');
    expect(screen.getByText('Unread')).toBeTruthy();
    expect(screen.getByText('Not responding')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mark all as read' })).toBeTruthy();
  });

  it('renders pt-BR labels', async () => {
    const { container } = await renderIn('pt-BR');
    expect(screen.getByText('Não lidas')).toBeTruthy();
    expect(screen.getByText('Sem resposta')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Marcar todas como lidas' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/traySessions\./);
  });

  it('pluralizes the tray summary', async () => {
    expect(t('onboarding:trayPanel.summary.attention', { count: 1 })).toBe('1 need attention');
    await setLanguage('pt-BR');
    expect(t('onboarding:trayPanel.summary.attention', { count: 1 })).toBe('1 precisa de atenção');
    expect(t('onboarding:trayPanel.summary.attention', { count: 2 })).toBe('2 precisam de atenção');
    expect(t('onboarding:trayPanel.summary.unread', { count: 2 })).toBe('2 não lidas');
  });
});
