// @vitest-environment jsdom
/** Home/welcome screen follows the UI language; agent prompt seeds stay unchanged. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('../../tips/FilesEmptyTipDisplay', () => ({
  FilesEmptyTipDisplay: () => null,
}));

import { WorkspaceWelcome } from '../WorkspaceWelcome';

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  const onNewFile = vi.fn();
  const onInsertAgentPrompt = vi.fn();
  const view = render(
    <I18nProvider>
      <WorkspaceWelcome
        workspaceName="demo"
        hasWorkspace
        workspacePath="/tmp/demo"
        onNewFile={onNewFile}
        onInsertAgentPrompt={onInsertAgentPrompt}
      />
    </I18nProvider>,
  );
  return { ...view, onNewFile, onInsertAgentPrompt };
}

describe('WorkspaceWelcome i18n', () => {
  it('keeps the English copy', async () => {
    await renderIn('en');
    expect(screen.getByText('Files are saved automatically as you work')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create a new file' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Focus the agent chat' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Draft a plan for…' })).toBeTruthy();
  });

  it('renders pt-BR copy and keeps the quick-pick values', async () => {
    const { onNewFile, onInsertAgentPrompt, container } = await renderIn('pt-BR');
    expect(screen.getByText('Os arquivos são salvos automaticamente enquanto você trabalha')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Criar um novo arquivo' })).toBeTruthy();
    expect(screen.getByText('Pergunte ao agente')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Diagrama' }));
    expect(onNewFile).toHaveBeenCalledWith('diagram');

    fireEvent.click(screen.getByRole('button', { name: 'Resumir este projeto' }));
    expect(onInsertAgentPrompt).toHaveBeenCalledWith('Summarize this project');
    expect(container.textContent).not.toMatch(/workspaceWelcome\.|onboarding:/);
  });
});
