// @vitest-environment jsdom
/**
 * App passes the title-bar pane and create labels in English (they double as
 * identifiers); the bar translates them for display only.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { WindowTopBar } from '../WindowTopBar';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span aria-hidden="true">{icon}</span>,
}));

function renderBar() {
  return render(
    <WindowTopBar
      workspaceName="Repo"
      activeModeLabel="Files"
      gitStatus={null}
      gitActions={{ onPull: () => {}, onPush: () => {}, onOpenLog: () => {} }}
      newSessionControl={{ label: 'New session', onCreate: () => {} }}
      newInTreeControl={{ label: 'New file', onCreate: () => {} }}
      panelControls={{
        left: { label: 'Files sidebar', collapsed: true, onToggle: () => {} },
        right: { label: 'Extension pane', collapsed: false, onToggle: () => {} },
      }}
    />,
  );
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('WindowTopBar i18n', () => {
  it('keeps the English labels', () => {
    renderBar();
    expect(screen.getByTestId('window-top-bar-left-pane').getAttribute('aria-label')).toBe('Show Files sidebar');
    expect(screen.getByTestId('window-top-bar-create-right').textContent).toContain('New session');
    expect(screen.getByTestId('window-top-bar-create-left').getAttribute('title')).toBe('New file');
  });

  it('translates known labels in pt-BR and passes unknown ones through', async () => {
    await setLanguage('pt-BR');
    renderBar();
    expect(screen.getByTestId('window-top-bar-left-pane').getAttribute('aria-label')).toBe('Mostrar barra lateral de arquivos');
    expect(screen.getByTestId('window-top-bar-create-right').textContent).toContain('Nova sessão');
    expect(screen.getByTestId('window-top-bar-create-left').getAttribute('title')).toBe('Novo arquivo');
    expect(screen.getByTestId('window-top-bar-right-pane').getAttribute('aria-label')).toBe('Ocultar Extension pane');
    expect(screen.getByTestId('window-top-bar-mode-label').textContent).toBe('Arquivos');
  });
});
