// @vitest-environment jsdom
/**
 * The session context menu follows the UI language: English stays identical to
 * the original labels, pt-BR renders translated labels (never raw keys), and
 * the phase submenu translates the visible label while keeping phase values.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: () => undefined,
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null, copyToClipboard: () => {} }));
vi.mock('../../../store', () => ({
  sessionShareAtom: () => ({}),
  shareKeysAtom: {},
  removeSessionShareAtom: {},
  buildShareUrl: () => '',
}));
vi.mock('../../../store/atoms/sessionKanban', () => ({
  setSessionPhaseAtom: {},
  SESSION_PHASE_COLUMNS: [
    { value: 'backlog', label: 'Backlog', color: '#6b7280' },
    { value: 'planning', label: 'Planning', color: '#60a5fa' },
    { value: 'implementing', label: 'Implementing', color: '#eab308' },
    { value: 'validating', label: 'Validating', color: '#a78bfa' },
    { value: 'complete', label: 'Complete', color: '#4ade80' },
  ],
}));
vi.mock('../../../services/ErrorNotificationService', () => ({ errorNotificationService: { showInfo: vi.fn(), showError: vi.fn() } }));
vi.mock('../../../dialogs', () => ({ dialogRef: { current: null }, DIALOG_IDS: { SHARE: 'share' } }));
vi.mock('../../../hooks/useFloatingMenu', () => ({
  useFloatingMenu: () => ({ refs: { setFloating: () => {} }, floatingStyles: {}, getFloatingProps: () => ({}) }),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  virtualElement: () => ({}),
}));

import { SessionContextMenu } from '../SessionContextMenu';

const RAW_KEY = /\b(sessionMenu|phases|sessionItem)\.[\w.]+/;

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR', props: Partial<React.ComponentProps<typeof SessionContextMenu>> = {}) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <SessionContextMenu
        sessionId="s1"
        title="My session"
        position={{ x: 10, y: 10 }}
        onClose={() => {}}
        onRename={() => {}}
        onPinToggle={() => {}}
        onBranch={() => {}}
        onArchive={() => {}}
        onDelete={() => {}}
        phase="planning"
        {...props}
      />
    </I18nProvider>,
  );
}

describe('SessionContextMenu i18n', () => {
  it('keeps the original English labels', async () => {
    await renderIn('en');
    for (const label of ['Rename', 'Pin', 'Set Phase', 'Branch conversation', 'Copy transcript', 'Copy Session ID', 'Share link', 'Export as HTML', 'Archive Session', 'Delete']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    // Current phase badge shows the English phase label.
    expect(screen.getByText('Planning')).toBeTruthy();
  });

  it('renders pt-BR labels without raw keys', async () => {
    const { container } = await renderIn('pt-BR');
    for (const label of ['Renomear', 'Fixar', 'Definir fase', 'Ramificar conversa', 'Copiar transcrição', 'Copiar ID da sessão', 'Compartilhar link', 'Exportar como HTML', 'Arquivar sessão', 'Excluir']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it('pluralizes the bulk archive label and names the item type', async () => {
    await renderIn('pt-BR', { selectedCount: 3 });
    expect(screen.getByText('Arquivar 3 sessões')).toBeTruthy();
    cleanup();
    await renderIn('pt-BR', { isArchived: true, isWorkstream: true, onUnarchive: () => {} });
    expect(screen.getByText('Desarquivar fluxo de trabalho')).toBeTruthy();
    cleanup();
    await renderIn('en', { selectedCount: 2 });
    expect(screen.getByText('Archive 2 Sessions')).toBeTruthy();
  });

  it('translates the phase submenu labels', async () => {
    await renderIn('pt-BR', { isPinned: true });
    expect(screen.getByText('Desafixar')).toBeTruthy();
    fireEvent.mouseEnter(screen.getByText('Definir fase').closest('div')!);
    for (const label of ['Backlog', 'Implementação', 'Validação', 'Concluído', 'Remover do quadro']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText('Planejamento').length).toBeGreaterThan(0);
  });
});
