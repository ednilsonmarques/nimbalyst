// @vitest-environment jsdom
/**
 * File and folder history follow the UI language: headers, view toggles,
 * snapshot counts, snapshot types, empty states and diff viewer chrome render
 * in pt-BR, while English stays byte-identical to the original copy.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

const history = vi.hoisted(() => ({
  snapshots: [] as Array<{ timestamp: string; type: string; size: number; baseMarkdownHash: string }>,
}));

vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock('@nimbalyst/runtime', () => ({
  ProviderIcon: () => null,
  MarkdownEditor: () => null,
  MonacoEditor: () => null,
  generateUnifiedDiff: () => '',
}));
vi.mock('../../../hooks/useHistory', () => ({
  useHistory: () => ({
    snapshots: history.snapshots,
    loading: false,
    refreshSnapshots: vi.fn(),
    loadSnapshot: vi.fn(async () => ''),
    deleteSnapshot: vi.fn(),
  }),
}));
vi.mock('../DiffPreviewEditor', () => ({ DiffPreviewEditor: () => null }));
vi.mock('../MonacoDiffViewer', () => ({ MonacoDiffViewer: () => null }));

import { HistoryDialog } from '../HistoryDialog';
import { TextDiffViewer } from '../TextDiffViewer';
import { ImageDiffViewer } from '../ImageDiffViewer';
import { WorkspaceHistoryFileTree } from '../../WorkspaceHistoryDialog/WorkspaceHistoryFileTree';

const RAW_KEY = /\bworkspace[.:][\w.]+|\b(history|workspaceHistory)\.[\w.]+/;

afterEach(async () => {
  cleanup();
  history.snapshots = [];
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR', ui: React.ReactElement) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(<I18nProvider>{ui}</I18nProvider>);
}

const dialog = (filePath: string | null = '/ws/notes.md') => (
  <HistoryDialog isOpen onClose={vi.fn()} filePath={filePath} />
);

describe('HistoryDialog i18n', () => {
  it('keeps the English empty state and toggles', async () => {
    await renderIn('en', dialog(null));
    screen.getByText('Document History');
    screen.getByText('No history available for this document');
    screen.getByText('Snapshots (0)');
    expect(screen.getByText('Diff').getAttribute('title')).toBe('Show diff with previous version');
    screen.getByText('Select a snapshot to see diff, or Cmd+Click two to compare');
  });

  it('renders the empty state, toggles and snapshot types in pt-BR', async () => {
    const now = Date.now();
    history.snapshots = [
      { timestamp: new Date(now - 60_000).toISOString(), type: 'auto-save', size: 1, baseMarkdownHash: 'a' },
      { timestamp: new Date(now - 120_000).toISOString(), type: 'manual', size: 1, baseMarkdownHash: 'b' },
    ];
    const { container } = await renderIn('pt-BR', dialog());
    screen.getByText('Snapshots (2)');
    expect(screen.getByText('Salvamento automático').className).not.toContain('capitalize');
    expect(screen.getByText('Completo').getAttribute('title')).toBe('Ver conteúdo completo');
    expect(screen.getByText('Formatado').getAttribute('title')).toBe('Visualização renderizada');
    screen.getByText('Selecione um snapshot para ver o diff ou use Cmd+clique em dois para comparar');
    expect(screen.getByTestId('history-item-delete-0').getAttribute('title')).toBe('Excluir snapshot');
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it('shows the translated document fallback title', async () => {
    await renderIn('pt-BR', dialog(null));
    screen.getByText('Histórico do documento');
    screen.getByText('Nenhum histórico disponível para este documento');
  });
});

describe('Diff viewers i18n', () => {
  it('translates the text diff headers', async () => {
    await renderIn('en', <TextDiffViewer oldText="a" newText="b" />);
    screen.getByText('Old Version');
    cleanup();
    await renderIn('pt-BR', <TextDiffViewer oldText="a" newText="b" />);
    screen.getByText('Versão antiga');
    screen.getByText('Versão nova');
  });

  it('translates the image diff controls and alt text', async () => {
    await renderIn('pt-BR', <ImageDiffViewer oldImagePath="/a.png" newImagePath="/a.png" filePath="/a.png" />);
    screen.getByText('Lado a lado');
    screen.getByText('Deslizar');
    screen.getByText('Sobrepor');
    expect(screen.getAllByAltText('Versão antiga').length).toBeGreaterThan(0);
  });
});

describe('Folder history file tree i18n', () => {
  it('renders the empty state and deleted marker in both languages', async () => {
    await renderIn('en', (
      <WorkspaceHistoryFileTree files={[]} workspacePath="/ws" selectedFilePath={null} selectedDeletedFiles={new Set()} onFileSelect={vi.fn()} onDeletedFileToggle={vi.fn()} />
    ));
    screen.getByText('No files with history in this workspace');
    cleanup();

    await renderIn('pt-BR', (
      <WorkspaceHistoryFileTree
        files={[{ path: '/ws/gone.md', latestTimestamp: 1, snapshotCount: 1, exists: false }]}
        workspacePath="/ws"
        selectedFilePath={null}
        selectedDeletedFiles={new Set()}
        onFileSelect={vi.fn()}
        onDeletedFileToggle={vi.fn()}
      />
    ));
    screen.getByText('(excluído)');
  });
});
