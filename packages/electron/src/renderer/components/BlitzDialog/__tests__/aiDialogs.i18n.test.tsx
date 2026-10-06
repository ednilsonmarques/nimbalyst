// @vitest-environment jsdom
/** AI-related dialogs (API key, Windows Claude Code warning, Blitz) follow the UI language. */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { ApiKeyDialog } from '../../ApiKeyDialog/ApiKeyDialog';
import { WindowsClaudeCodeWarning } from '../../WindowsClaudeCodeWarning/WindowsClaudeCodeWarning';
import { BlitzDialog } from '../BlitzDialog';

vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ getProviderIcon: () => null }));
vi.mock('../../../utils/modelUtils', () => ({ getClaudeCodeModelLabel: (id: string) => id }));

beforeEach(() => {
  (window as any).electronAPI = {
    send: vi.fn(),
    invoke: vi.fn(),
    aiGetModels: vi.fn(async () => ({
      success: true,
      grouped: { 'claude-code': [{ id: 'claude-code:opus', name: 'Opus', provider: 'claude-code' }] },
    })),
  };
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await setLanguage('en');
  });
});

async function inLanguage(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
}

describe('ApiKeyDialog i18n', () => {
  it('keeps English copy', async () => {
    await inLanguage('en');
    render(<I18nProvider><ApiKeyDialog isOpen onClose={vi.fn()} onOpenPreferences={vi.fn()} /></I18nProvider>);
    screen.getByText('API Key Required');
    screen.getByRole('button', { name: 'Open AI Settings' });
    screen.getByText('Click "Open AI Settings" below');
  });

  it('renders pt-BR copy and keeps handlers', async () => {
    await inLanguage('pt-BR');
    const onClose = vi.fn();
    const onOpenPreferences = vi.fn();
    render(<I18nProvider><ApiKeyDialog isOpen onClose={onClose} onOpenPreferences={onOpenPreferences} /></I18nProvider>);
    screen.getByText('Chave de API necessária');
    // Provider names stay untranslated.
    screen.getByText('Anthropic');
    fireEvent.click(screen.getByRole('button', { name: 'Abrir configurações de IA' }));
    expect(onOpenPreferences).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('WindowsClaudeCodeWarning i18n', () => {
  it('renders pt-BR buttons and aria-label', async () => {
    await inLanguage('pt-BR');
    const onDismiss = vi.fn();
    render(
      <I18nProvider>
        <WindowsClaudeCodeWarning isOpen onClose={vi.fn()} onDismiss={onDismiss} onOpenSettings={vi.fn()} />
      </I18nProvider>,
    );
    screen.getByText('Instalação do Claude Code necessária');
    screen.getByLabelText('Fechar');
    screen.getByRole('button', { name: 'Lembrar mais tarde' });
    fireEvent.click(screen.getByRole('button', { name: 'Não mostrar novamente' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('BlitzDialog i18n', () => {
  it('keeps English copy and plural start label', async () => {
    await inLanguage('en');
    render(<I18nProvider><BlitzDialog isOpen onClose={vi.fn()} onCreated={vi.fn()} workspacePath="/ws" /></I18nProvider>);
    screen.getByText('New Blitz');
    await screen.findByText('Total: 1 worktree');
    screen.getByRole('button', { name: 'Start Blitz (1 worktree)' });
    screen.getByPlaceholderText('Enter the prompt to run across all sessions...');
  });

  it('renders pt-BR copy', async () => {
    await inLanguage('pt-BR');
    render(<I18nProvider><BlitzDialog isOpen onClose={vi.fn()} onCreated={vi.fn()} workspacePath="/ws" /></I18nProvider>);
    screen.getByText('Novo blitz');
    await screen.findByText('Total: 1 worktree');
    screen.getByRole('button', { name: 'Iniciar blitz (1 worktree)' });
    screen.getByRole('button', { name: 'Cancelar' });
    screen.getByPlaceholderText('Digite o prompt a ser executado em todas as sessões...');
  });
});
