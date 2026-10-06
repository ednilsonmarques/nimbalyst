// @vitest-environment jsdom
/** The invite dialog follows the UI language; role values sent to the server stay English ids. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';

vi.mock('../useTeamSharedContent', () => ({
  useTeamSharedContent: () => 'empty',
}));
vi.mock('../WorkspaceFolderPicker', () => ({
  WorkspaceFolderPicker: () => <div data-testid="folder-picker" />,
}));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => null,
}));

const { InviteToTeamDialog } = await import('../InviteToTeamDialog');
const { inviteActionLabel, summarizeInvitePlan } = await import('../inviteToTeamModel');

async function inLanguage(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
}

function renderDialog() {
  return render(
    <I18nProvider>
      <InviteToTeamDialog
        isOpen
        orgId="org-1"
        orgName="Acme"
        projects={[{ teamProjectId: 'tp-1', name: 'Acme', isPrimary: true }]}
        workspacePath="/tmp/workspace"
        onClose={() => {}}
        onInvited={() => {}}
      />
    </I18nProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('InviteToTeamDialog i18n', () => {
  it('keeps the English copy', async () => {
    await inLanguage('en');
    renderDialog();
    expect(screen.getByRole('dialog', { name: 'Invite to Acme' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email addresses'), { target: { value: 'teammate@example.com' } });
    expect(screen.getByText('1 person · nothing shared yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send invitation only' })).toBeTruthy();
  });

  it('renders pt-BR copy and role labels', async () => {
    await inLanguage('pt-BR');
    const { container } = renderDialog();
    expect(screen.getByRole('dialog', { name: 'Convidar para Acme' })).toBeTruthy();
    for (const role of ['Administrador', 'Membro', 'Visualizador']) {
      expect(screen.getByRole('button', { name: role })).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText('Endereços de e-mail'), { target: { value: 'teammate@example.com' } });
    expect(screen.getByText('1 pessoa · nada compartilhado ainda')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar apenas o convite' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeTruthy();
    expect(container.textContent).not.toMatch(/\b(invite|roles)\.[a-z]/);
  });

  it('pluralizes the plan summary in pt-BR', async () => {
    await inLanguage('pt-BR');
    expect(summarizeInvitePlan({ people: 0, extraProjects: 0, folders: 0 })).toBe('Adicione um endereço de e-mail para convidar alguém.');
    expect(summarizeInvitePlan({ people: 2, extraProjects: 1, folders: 3 })).toBe('2 pessoas · 1 projeto adicional · 3 pastas publicadas');
    expect(inviteActionLabel({ people: 2, extraProjects: 1, folders: 0 })).toBe('Enviar convites e compartilhar');
  });
});
