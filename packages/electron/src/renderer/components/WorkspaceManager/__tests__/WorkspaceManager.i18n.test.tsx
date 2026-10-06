// @vitest-environment jsdom
/**
 * The Project Manager follows the UI language: toolbar, search, empty and
 * welcome states, the selected-project stats and the relative "last opened"
 * labels render in pt-BR, while English stays byte-identical.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

const getRecentWorkspaces = vi.fn();
const getWorkspaceStats = vi.fn();

(window as unknown as { electronAPI: unknown }).electronAPI = {
  getResolvedThemeSync: () => 'dark',
  onThemeChange: vi.fn(),
  workspaceManager: { getRecentWorkspaces, getWorkspaceStats },
  tutorial: { getStatus: vi.fn().mockResolvedValue({ success: true, exists: false }), start: vi.fn() },
};

const { WorkspaceManager } = await import('../WorkspaceManager');

const RAW_KEY = /\bworkspace[.:][\w.]+|\bworkspaceManager\.[\w.]+/;
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  getRecentWorkspaces.mockResolvedValue([]);
  getWorkspaceStats.mockResolvedValue({ fileCount: 12, markdownCount: 3, totalSize: 2048, recentFiles: ['a.md'] });
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  return render(<I18nProvider><WorkspaceManager /></I18nProvider>);
}

describe('WorkspaceManager i18n', () => {
  it('keeps the English welcome card and toolbar', async () => {
    await renderIn('en');
    await screen.findByText('No recent projects');
    screen.getByText('Welcome to Nimbalyst');
    screen.getByText('Open Folder');
    screen.getByText('New Folder');
    expect(screen.getByTestId('workspace-manager-welcome-card').textContent).toContain(
      'Everything in Nimbalyst lives in a project: a folder of related files on your computer.',
    );
  });

  it('renders the welcome card, toolbar and empty state in pt-BR', async () => {
    const { container } = await renderIn('pt-BR');
    await screen.findByText('Nenhum projeto recente');
    screen.getByText('Boas-vindas ao Nimbalyst');
    screen.getByText('Abrir pasta');
    screen.getByText('Nova pasta');
    screen.getByText('Experimente o tutorial interativo');
    const card = screen.getByTestId('workspace-manager-welcome-card');
    expect(card.textContent).toContain('Tudo no Nimbalyst fica em um projeto');
    expect(card.querySelector('strong')?.textContent).toBe('projeto');
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it('translates the project list, stats and relative dates with plurals', async () => {
    getRecentWorkspaces.mockResolvedValue([
      { path: '/p/alpha', name: 'alpha', lastOpened: Date.now() - 3 * DAY, exists: true, markdownCount: '16+' },
      { path: '/p/beta', name: 'beta', lastOpened: Date.now() - 8 * DAY, exists: true, markdownCount: 1 },
    ]);
    await renderIn('pt-BR');
    expect(await screen.findByPlaceholderText('Pesquisar projetos...')).toBeTruthy();
    screen.getByText('16+ arquivos markdown');
    screen.getByText('há 3 dias');
    screen.getByText('há 1 semana');

    fireEvent.click(screen.getByText('alpha'));
    await screen.findByText('Total de arquivos');
    screen.getByText('Arquivos Markdown');
    screen.getByText('Abrir projeto');
    screen.getByText('Remover dos recentes');
    screen.getByText('Arquivos recentes');
  });

  it('keeps English relative dates and counts', async () => {
    getRecentWorkspaces.mockResolvedValue([
      { path: '/p/beta', name: 'beta', lastOpened: Date.now() - 8 * DAY, exists: true, markdownCount: 7 },
    ]);
    await renderIn('en');
    await screen.findByText('7 markdown files');
    screen.getByText('1 week ago');
  });
});
