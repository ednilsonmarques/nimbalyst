// @vitest-environment jsdom
/**
 * Editor header pieces render their tooltips and the AI-sessions menu in the
 * active language: English stays byte-identical, pt-BR has no raw keys.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { DocumentSessionControl, type FileSession } from '../DocumentSessionControl';
import { FilePathBreadcrumb } from '../../common/FilePathBreadcrumb';

const WORKSPACE = '/Users/dev/proj';
const DOC = `${WORKSPACE}/src/foo.md`;
const invoke = vi.fn();

function session(overrides: Partial<FileSession> & Pick<FileSession, 'id'>): FileSession {
  return {
    title: overrides.id,
    provider: 'claude-code',
    createdAt: 1,
    updatedAt: Date.now(),
    messageCount: 1,
    isCurrentWorkspace: true,
    ...overrides,
  };
}

async function openSessionMenu(rows: FileSession[]) {
  invoke.mockResolvedValue(rows);
  render(
    <JotaiProvider store={createStore()}>
      <DocumentSessionControl filePath={DOC} workspaceId={WORKSPACE} actions={{ openInChat: vi.fn(), startNew: vi.fn() }} />
    </JotaiProvider>,
  );
  fireEvent.click(await screen.findByTestId('document-session-caret'));
  return screen.findByTestId('document-session-menu');
}

const ROWS = [
  session({ id: 'here', fileAttribution: 'inferred' }),
  session({ id: 'elsewhere', isCurrentWorkspace: false }),
];

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  invoke.mockReset();
  await setLanguage('en');
});

describe('editor header i18n', () => {
  it('keeps the English AI-sessions menu text', async () => {
    const menu = await openSessionMenu(ROWS);
    expect(screen.getByTestId('document-session-caret').getAttribute('title')).toBe('AI sessions for this document');
    expect(menu.textContent).toContain('This project');
    expect(menu.textContent).toContain('Other sessions');
    expect(menu.textContent).toContain('Current');
    expect(menu.textContent).toContain('just now');
    expect(screen.getByText('Inferred edit').getAttribute('title')).toBe(
      'Inferred from a shell command and a file change during its execution. Other external writers may not be detected.',
    );
    expect(screen.getByText('Start new session on this file')).toBeTruthy();
  });

  it('translates the AI-sessions menu to pt-BR without raw keys', async () => {
    await setLanguage('pt-BR');
    const menu = await openSessionMenu(ROWS);
    expect(screen.getByTestId('document-session-caret').getAttribute('title')).toBe('Sessões de IA deste documento');
    expect(menu.textContent).toContain('Este projeto');
    expect(menu.textContent).toContain('Outras sessões');
    expect(menu.textContent).toContain('Atual');
    expect(menu.textContent).toContain('agora');
    expect(screen.getByText('Edição inferida')).toBeTruthy();
    expect(screen.getByText('Iniciar nova sessão neste arquivo')).toBeTruthy();
    expect(menu.textContent).not.toMatch(/contextMenu\.|documentSessions\./);
  });

  it('formats relative times and the agent-mode action in both languages', async () => {
    const rows = [session({ id: 'older', updatedAt: Date.now() - 5 * 60_000 })];
    const view = async () => {
      invoke.mockResolvedValue(rows);
      render(
        <JotaiProvider store={createStore()}>
          <DocumentSessionControl filePath={DOC} workspaceId={WORKSPACE} actions={{ openInChat: vi.fn(), openInAgentMode: vi.fn() }} />
        </JotaiProvider>,
      );
      fireEvent.click(await screen.findByTestId('document-session-caret'));
      return screen.findByTestId('document-session-menu');
    };
    expect((await view()).textContent).toContain('5m ago');
    expect(screen.getByLabelText('Open in Agent mode')).toBeTruthy();
    cleanup();
    await setLanguage('pt-BR');
    expect((await view()).textContent).toContain('há 5 min');
    expect(screen.getByLabelText('Abrir no modo agente').getAttribute('title')).toBe('Abrir no modo agente');
  });

  it('translates the empty AI-sessions menu', async () => {
    await setLanguage('pt-BR');
    invoke.mockResolvedValue([]);
    render(
      <JotaiProvider store={createStore()}>
        <DocumentSessionControl filePath={DOC} workspaceId={WORKSPACE} />
      </JotaiProvider>,
    );
    fireEvent.click(await screen.findByTestId('ai-sessions-button'));
    expect(await screen.findByText('Nenhuma sessão de IA abriu este arquivo ainda')).toBeTruthy();
    expect(screen.getByTestId('ai-sessions-button').getAttribute('title')).toBe('Sessões de IA');
  });

  it('interpolates the breadcrumb tooltip in both languages', async () => {
    const view = () =>
      render(
        <JotaiProvider store={createStore()}>
          <FilePathBreadcrumb filePath={DOC} workspacePath={WORKSPACE} />
        </JotaiProvider>,
      );
    view();
    expect(screen.getByText('src').closest('[title]')?.getAttribute('title')).toBe('Go to src in file tree');
    cleanup();
    await setLanguage('pt-BR');
    view();
    expect(screen.getByText('src').closest('[title]')?.getAttribute('title')).toBe('Ir para src na árvore de arquivos');
  });
});
