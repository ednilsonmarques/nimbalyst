// @vitest-environment jsdom
/**
 * Editor chrome (diff/approval bars, error states, shared-doc and collab
 * notices) renders in the active language: English stays byte-identical to the
 * original literals, pt-BR shows translated text with no raw keys.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { UnifiedDiffHeader } from '../../UnifiedDiffHeader/UnifiedDiffHeader';
import { CustomEditorAIEditedBar } from '../../UnifiedDiffHeader/CustomEditorAIEditedBar';
import { MonacoDiffApprovalBar } from '../../MonacoDiffApprovalBar/MonacoDiffApprovalBar';
import { DiffPreview } from '../../DiffPreview/DiffPreview';
import { TabEditorErrorBoundary } from '../../TabEditorErrorBoundary/TabEditorErrorBoundary';
import { SharedDocumentLinkActions } from '../SharedDocumentLinkActions';
import { MissingCollabEditorNotice } from '../MissingCollabEditorNotice';
import { canvasPathForMockupProject } from '../../CustomEditors/mockupProjectConversion';

const RAW_KEY = /\b(diff|errorBoundary|sharedLink|collab|mockupProject)\.[a-zA-Z]+/;
const noop = () => undefined;

function withStore(node: React.ReactElement) {
  return render(<JotaiProvider store={createStore()}>{node}</JotaiProvider>);
}

function diffHeader(options: { count?: number; currentIndex?: number | null; editedAt?: number } = {}) {
  return withStore(
    <UnifiedDiffHeader
      filePath="/w/notes.md"
      fileName="notes.md"
      editorType="lexical"
      readOnlyWhileReviewing
      sessionInfo={{ sessionId: 's1', sessionTitle: 'Refactor', editedAt: options.editedAt }}
      onGoToSession={noop}
      capabilities={{
        onAcceptAll: noop,
        onRejectAll: noop,
        changeGroups: {
          count: options.count ?? 3,
          currentIndex: options.currentIndex ?? null,
          onNavigatePrevious: noop,
          onNavigateNext: noop,
          onAcceptCurrent: noop,
          onRejectCurrent: noop,
        },
      }}
    />,
  );
}

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await setLanguage('en');
});

describe('editor chrome i18n', () => {
  it('keeps the English diff header text', () => {
    const { container } = diffHeader({ editedAt: Date.now() - 2 * 3_600_000 });
    expect(screen.getByLabelText('Previous change')).toBeTruthy();
    expect(screen.getByLabelText('Next change')).toBeTruthy();
    expect(container.textContent).toContain('3 changes');
    expect(container.textContent).toContain('edited 2 hours ago');
    expect(container.textContent).toContain('Read-only while reviewing. Keep or Revert to edit.');
    expect(screen.getByTestId('diff-revert-all').textContent).toBe('Revert All');
    expect(screen.getByTestId('diff-keep-all').textContent).toBe('Keep All');
    expect(screen.getByTitle('Revert this change').textContent).toBe('Revert');
    expect(screen.getByTitle('Keep this change').textContent).toBe('Keep');
    expect(screen.getByTitle('Open "Refactor" session')).toBeTruthy();
  });

  it('translates the diff header to pt-BR with plurals', async () => {
    await setLanguage('pt-BR');
    const { container } = diffHeader({ count: 1, editedAt: Date.now() - 1 * 86_400_000 - 1000 });
    expect(screen.getByLabelText('Alteração anterior')).toBeTruthy();
    expect(screen.getByLabelText('Próxima alteração')).toBeTruthy();
    expect(container.textContent).toContain('1 alteração');
    expect(container.textContent).toContain('editado há 1 dia');
    expect(screen.getByTestId('diff-revert-all').textContent).toBe('Reverter tudo');
    expect(screen.getByTestId('diff-keep-all').textContent).toBe('Manter tudo');
    expect(screen.getByTitle('Abrir a sessão "Refactor"')).toBeTruthy();
    expect(container.textContent).not.toMatch(RAW_KEY);
    cleanup();

    const second = diffHeader({ count: 4, currentIndex: 1 });
    expect(second.container.textContent).toContain('2 de 4');
  });

  it('translates the Monaco approval bar and the custom-editor AI bar', async () => {
    const monaco = () =>
      withStore(<MonacoDiffApprovalBar onAcceptAll={noop} onRejectAll={noop} fileName="a.ts" />);
    monaco();
    expect(screen.getByTestId('diff-revert-all-button').textContent).toBe('Reject All');
    expect(screen.getByTestId('diff-keep-all-button').textContent).toBe('Accept All');
    expect(screen.getByText('AI changes to a.ts')).toBeTruthy();
    cleanup();

    await setLanguage('pt-BR');
    monaco();
    expect(screen.getByTestId('diff-revert-all-button').textContent).toBe('Rejeitar tudo');
    expect(screen.getByTestId('diff-keep-all-button').textContent).toBe('Aceitar tudo');
    expect(screen.getByText('Alterações da IA em a.ts')).toBeTruthy();
    cleanup();

    const { container } = withStore(
      <CustomEditorAIEditedBar
        fileName="board.canvas"
        sessionInfo={{ sessionId: 's1' }}
        onGoToSession={noop}
        onViewHistory={noop}
      />,
    );
    expect(container.textContent).toContain('A IA editou board.canvas');
    expect(screen.getByTitle('Abrir a sessão de IA que fez estas alterações').textContent).toContain('Ir para a sessão');
    expect(screen.getByTitle('Ver alterações no histórico').textContent).toContain('Ver histórico');
  });

  it('translates the diff preview in both languages', async () => {
    const view = () => render(<DiffPreview original="a" modified="b" onAccept={noop} onReject={noop} />);
    view();
    expect(screen.getByText('Proposed Changes')).toBeTruthy();
    expect(screen.getByText('Accept Changes')).toBeTruthy();
    cleanup();
    await setLanguage('pt-BR');
    view();
    expect(screen.getByText('Alterações propostas')).toBeTruthy();
    expect(screen.getByText('Aceitar alterações')).toBeTruthy();
    expect(screen.getByText('Rejeitar')).toBeTruthy();
  });

  it('translates the tab editor error boundary', async () => {
    vi.spyOn(console, 'error').mockImplementation(noop);
    const Boom = () => {
      throw new Error('kaboom');
    };
    const view = () =>
      render(
        <TabEditorErrorBoundary filePath="/w/x.md" fileName="x.md" onClose={noop}>
          <Boom />
        </TabEditorErrorBoundary>,
      );
    view();
    expect(screen.getByText('Unable to Load Editor')).toBeTruthy();
    expect(screen.getByText('An error occurred while loading "x.md".')).toBeTruthy();
    expect(screen.getByText('Close Tab')).toBeTruthy();
    cleanup();
    await setLanguage('pt-BR');
    view();
    expect(screen.getByText('Não foi possível carregar o editor')).toBeTruthy();
    expect(screen.getByText('Ocorreu um erro ao carregar "x.md".')).toBeTruthy();
    expect(screen.getByText('Tentar novamente')).toBeTruthy();
    expect(screen.getByText('Fechar aba')).toBeTruthy();
  });

  it('translates the shared-link actions and the missing collab editor notice', async () => {
    vi.stubGlobal('electronAPI', { invoke: vi.fn().mockResolvedValue({ success: false }) });
    await setLanguage('pt-BR');
    render(
      <SharedDocumentLinkActions
        deepLink="nimbalyst://doc"
        target={{ documentId: 'd', orgId: 'o', teamProjectId: 'p' }}
        onClose={noop}
      />,
    );
    expect(screen.getByText('Abrir no navegador')).toBeTruthy();
    expect(screen.getByText('Copiar link')).toBeTruthy();
    cleanup();

    withStore(
      <MissingCollabEditorNotice
        availability={{ kind: 'extension-missing', extensionId: 'com.example.slides' }}
        documentType="slides.md"
      />,
    );
    expect(screen.getByText('com.example.slides não está instalado')).toBeTruthy();
    expect(screen.getByText('Abrir Marketplace de extensões')).toBeTruthy();
  });

  it('localizes mockup conversion errors while keeping English byte-identical', async () => {
    expect(() => canvasPathForMockupProject('/w/a.txt')).toThrow('Only .mockupproject files can be converted.');
    await setLanguage('pt-BR');
    expect(() => canvasPathForMockupProject('/w/a.txt')).toThrow('Somente arquivos .mockupproject podem ser convertidos.');
  });
});
