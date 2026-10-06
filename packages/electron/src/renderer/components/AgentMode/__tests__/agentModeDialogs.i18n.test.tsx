// @vitest-environment jsdom
/**
 * Agent-mode dialogs and panel labels follow the UI language: rich-text
 * confirmations keep their <strong> markup, counts pluralize, and the
 * right-panel options are resolved per call.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

import { ArchiveWorktreeDialog } from '../ArchiveWorktreeDialog';
import { MergeConfirmDialog } from '../MergeConfirmDialog';
import { agentRightPanelOptions } from '../agentRightPanelOptions';

const RAW_KEY = /\b(archiveWorktree|mergeConfirm|rightPanel)\.[\w.]+/;

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR', ui: React.ReactElement) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(<I18nProvider>{ui}</I18nProvider>);
}

describe('ArchiveWorktreeDialog i18n', () => {
  const single = (
    <ArchiveWorktreeDialog
      worktreeName="swift-rabbit"
      onArchive={() => {}}
      onKeep={() => {}}
      hasUncommittedChanges
      uncommittedFileCount={1}
      hasUnmergedChanges
      unmergedCommitCount={3}
    />
  );

  it('keeps the original English text', async () => {
    const { container } = await renderIn('en', single);
    expect(screen.getByText('Archive Worktree')).toBeTruthy();
    expect(container.textContent).toContain('Are you sure you want to archive swift-rabbit?');
    expect(container.querySelector('strong')?.textContent).toBe('swift-rabbit');
    expect(container.textContent).toContain('This worktree has 1 file with uncommitted changes. These changes will be permanently deleted.');
    expect(container.textContent).toContain("This branch has 3 commits that haven't been merged to the base branch.");
    expect(screen.getByText('Keep Worktree')).toBeTruthy();
  });

  it('renders pt-BR text with markup and plurals', async () => {
    const { container } = await renderIn('pt-BR', single);
    expect(screen.getByText('Arquivar worktree')).toBeTruthy();
    expect(container.textContent).toContain('Tem certeza de que deseja arquivar swift-rabbit?');
    expect(container.querySelector('strong')?.textContent).toBe('swift-rabbit');
    expect(container.textContent).toContain('Este worktree tem 1 arquivo com alterações não commitadas.');
    expect(container.textContent).toContain('Este branch tem 3 commits que ainda não passaram por merge no branch base.');
    expect(screen.getByText('Manter worktree')).toBeTruthy();
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it('pluralizes the bulk variant', async () => {
    const { container } = await renderIn('pt-BR', (
      <ArchiveWorktreeDialog worktreeCount={4} onArchive={() => {}} onKeep={() => {}} />
    ));
    expect(screen.getByText('Arquivar 4 worktrees')).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('4 worktrees');
    expect(screen.getByText('Arquivar tudo')).toBeTruthy();
  });
});

describe('MergeConfirmDialog i18n', () => {
  it('interpolates both bold names in pt-BR', async () => {
    const { container } = await renderIn('pt-BR', (
      <MergeConfirmDialog worktreePath="/repo/worktrees/swift-rabbit" workspacePath="/repo/app" hasUncommittedChanges={false} onConfirm={() => {}} onCancel={() => {}} />
    ));
    const strongs = Array.from(container.querySelectorAll('strong')).map((s) => s.textContent);
    expect(strongs.length).toBe(2);
    expect(screen.getByText('Fazer merge na main')).toBeTruthy();
    expect(container.textContent).not.toMatch(RAW_KEY);
  });
});

describe('agentRightPanelOptions i18n', () => {
  it('resolves labels in the active language', async () => {
    expect(agentRightPanelOptions('review', () => {}).map((o) => o.label)).toEqual(['Edited Files', 'Review', 'Chat with Session', 'File viewer']);
    await setLanguage('pt-BR');
    const options = agentRightPanelOptions('review', () => {});
    expect(options.map((o) => o.label)).toEqual(['Arquivos editados', 'Revisão', 'Conversar com a sessão', 'Visualizador de arquivos']);
    expect(options.find((o) => o.id === 'review')?.selected).toBe(true);
  });
});
