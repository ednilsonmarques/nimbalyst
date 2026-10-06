// @vitest-environment jsdom
/** The share-link dialog and its account picker follow the UI language. */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';

vi.mock('../../Accounts/AccountLoginForm', () => ({
  AccountLoginForm: () => <div data-testid="login-form" />,
}));

const { ShareDialog } = await import('../ShareDialog');
const { ShareAccountPicker } = await import('../ShareAccountPicker');

const accounts = [
  { personalOrgId: 'p1', email: 'a@example.com', isSyncAccount: true, sessionStatus: 'active' as const },
  { personalOrgId: 'p2', email: 'b@example.com', isSyncAccount: false, sessionStatus: 'active' as const },
];

async function inLanguage(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
}

function renderDialog() {
  return render(
    <I18nProvider>
      <ShareDialog isOpen onClose={vi.fn()} contentType="file" filePath="/tmp/notes.md" />
    </I18nProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('ShareDialog i18n', () => {
  it('keeps the English copy', async () => {
    await inLanguage('en');
    renderDialog();
    expect(screen.getByText('Share file')).toBeTruthy();
    expect(screen.getByText('Link expires after')).toBeTruthy();
    expect(screen.getByRole('option', { name: '7 days' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy link/ })).toBeTruthy();
  });

  it('renders pt-BR copy and pluralized expirations', async () => {
    await inLanguage('pt-BR');
    const { container } = renderDialog();
    expect(screen.getByText('Compartilhar arquivo')).toBeTruthy();
    expect(screen.getByText('O link expira após')).toBeTruthy();
    expect(screen.getByRole('option', { name: '30 dias' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copiar link/ })).toBeTruthy();
    expect(screen.getByLabelText('Fechar')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\b(share|common)\.[a-z]/);
  });
});

describe('ShareAccountPicker i18n', () => {
  it('translates labels and keeps emails', async () => {
    await inLanguage('pt-BR');
    render(
      <I18nProvider>
        <ShareAccountPicker accounts={accounts} selectedPersonalOrgId="p1" defaultSource="sync-account" onChange={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText('Criar link como')).toBeTruthy();
    expect(screen.getByText('Conta de sincronização')).toBeTruthy();
    expect(screen.getByText('Selecionada por padrão: a conta usada para sincronização.')).toBeTruthy();
    expect(screen.getByText('a@example.com')).toBeTruthy();
  });
});
