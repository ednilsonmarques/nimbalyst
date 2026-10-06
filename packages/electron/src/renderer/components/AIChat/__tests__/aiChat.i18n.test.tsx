// @vitest-environment jsdom
/** Session dropdown and chat banners follow the UI language. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { SessionDropdown } from '../SessionDropdown';
import { McpLockdownBanner } from '../McpLockdownBanner';
import { requestConfirmation } from '../../../dialogs/requestConfirmation';

vi.mock('../../../dialogs/requestConfirmation', () => ({ requestConfirmation: vi.fn(async () => false) }));
vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
  ProviderIcon: () => null,
  formatDate: (v: unknown) => String(v),
}));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('../../../utils/modelUtils', () => ({
  parseModelInfo: () => null,
  getProviderLabel: (p: string) => p,
}));
vi.mock('../../../store', async () => {
  const { atom } = await import('jotai');
  const off = atom(false);
  return { sessionProcessingAtom: () => off, sessionUnreadAtom: () => off };
});
vi.mock('../../../hooks/useFloatingMenu', async () => {
  const React = await import('react');
  return {
    FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useFloatingMenu: () => {
      const [isOpen, setIsOpen] = React.useState(false);
      return {
        isOpen,
        setIsOpen,
        refs: { setReference: () => {}, setFloating: () => {} },
        floatingStyles: {},
        getReferenceProps: () => ({}),
        getFloatingProps: () => ({}),
      };
    },
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

const sessions = [
  { id: 's1', createdAt: 1, title: 'Agent trust popup review', provider: 'claude-code', messageCount: 1 },
  { id: 's2', createdAt: 2, title: 'Draft release notes', provider: 'claude-code', messageCount: 3 },
];

describe('SessionDropdown i18n', () => {
  it('keeps English labels', async () => {
    await inLanguage('en');
    render(<I18nProvider><SessionDropdown currentSessionId="s1" sessions={sessions} onSessionSelect={vi.fn()} onDeleteSession={vi.fn()} onNewSession={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByTitle('Session History'));
    screen.getByText('New session');
    screen.getByText('1 turns');
    screen.getByText('3 turns');
  });

  it('renders pt-BR labels, plurals and confirmation copy', async () => {
    await inLanguage('pt-BR');
    render(<I18nProvider><SessionDropdown currentSessionId={null} sessions={sessions} onSessionSelect={vi.fn()} onDeleteSession={vi.fn()} onNewSession={vi.fn()} /></I18nProvider>);
    screen.getByText('Nova sessão');
    fireEvent.click(screen.getByTitle('Histórico de sessões'));
    screen.getByText('1 turno');
    screen.getByText('3 turnos');
    fireEvent.click(screen.getAllByTitle('Excluir')[0]);
    expect(requestConfirmation).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Excluir sessão',
      message: 'Excluir esta sessão?',
      confirmLabel: 'Excluir',
    }));
  });
});

describe('McpLockdownBanner i18n', () => {
  it('renders the pt-BR notice', async () => {
    (window as any).electronAPI = { invoke: vi.fn(async () => ({ active: true })) };
    await inLanguage('pt-BR');
    render(<I18nProvider><McpLockdownBanner provider="claude-code" /></I18nProvider>);
    await screen.findByText(/política corporativa de MCP do Claude Code/);
    fireEvent.click(screen.getByRole('button', { name: 'Dispensar' }));
    expect(screen.queryByText(/política corporativa/)).toBeNull();
  });
});
