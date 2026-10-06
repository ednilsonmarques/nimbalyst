// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('posthog-js/react', () => ({ usePostHog: () => null }));
vi.mock('../../Terminal/TerminalPanel', () => ({ TerminalPanel: () => null }));
vi.mock('../../../store/atoms/terminals', async () => {
  const { atom } = await import('jotai');
  const idle = atom(false);
  return {
    terminalListAtom: atom([]),
    activeTerminalIdAtom: atom(null),
    terminalPanelVisibleAtom: atom(true),
    terminalPanelHeightAtom: atom(300),
    terminalPanelHydratedAtom: atom(false),
    closeTerminalPanelAtom: atom(null, () => {}),
    loadTerminals: vi.fn(),
    setActiveTerminal: vi.fn(),
    removeTerminalFromList: vi.fn(),
    initTerminalListeners: vi.fn(() => () => {}),
    setTerminalCommandRunning: vi.fn(),
    terminalCommandRunningAtom: () => idle,
  };
});
vi.mock('../../../store/atoms/sessions', async () => {
  const { atom } = await import('jotai');
  // Stable atoms: a fresh atom per render would resubscribe forever.
  const none = atom(null);
  return {
    selectedWorkstreamAtom: () => none,
    sessionWorktreeIdAtom: () => none,
  };
});

import { TerminalBottomPanel } from '../TerminalBottomPanel';

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    terminal: { onCommandRunning: () => () => {}, setPanelVisible: vi.fn(), setPanelHeight: vi.fn(), create: vi.fn() },
  };
});

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderPanel(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <TerminalBottomPanel workspacePath="/ws" />
    </I18nProvider>,
  );
}

describe('TerminalBottomPanel i18n', () => {
  it('renders the original English empty state', async () => {
    await renderPanel('en');
    expect(screen.getByText('No terminals open')).toBeTruthy();
    expect(screen.getAllByText('New Terminal').length).toBe(1);
    expect(screen.getByTitle('New Terminal')).toBeTruthy();
    expect(screen.getByTitle('Close panel')).toBeTruthy();
  });

  it('renders the pt-BR empty state', async () => {
    await renderPanel('pt-BR');
    expect(screen.getByText('Nenhum terminal aberto')).toBeTruthy();
    expect(screen.getByText('Novo terminal')).toBeTruthy();
    expect(screen.getByTitle('Fechar painel')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/terminal\.\w+/);
  });
});
