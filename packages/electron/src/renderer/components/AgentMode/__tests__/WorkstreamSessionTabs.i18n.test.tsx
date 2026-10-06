// @vitest-environment jsdom
/** Workstream session tabs follow the UI language (fallback title, new-session button, loading state). */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('jotai', () => ({ useAtomValue: (value: unknown) => value, useSetAtom: () => vi.fn() }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('@nimbalyst/runtime/store', () => ({ store: { get: vi.fn() } }));
vi.mock('../../../store/atoms/sessions', () => ({
  sessionArchivedAtom: () => false, sessionRegistryAtom: null, convertToWorkstreamAtom: null,
}));
vi.mock('../../../store', () => ({
  // Session "untitled" has no title so the tab falls back to the localized label.
  sessionTitleAtom: (id: string) => (id === 'untitled' ? '' : id), sessionProviderAtom: () => 'claude',
  sessionProcessingAtom: () => false, sessionUnreadAtom: () => false, createChildSessionAtom: null,
}));
vi.mock('../../../store/atoms/appSettings', () => ({ defaultAgentModelAtom: null }));
vi.mock('../../../store/atoms/workstreamState', () => ({ workstreamHasChildrenAtom: () => true }));
vi.mock('../AgentSessionPanel', () => ({ AgentSessionPanel: () => null }));
vi.mock('../../AgenticCoding/SessionContextMenu', () => ({ SessionContextMenu: () => null }));

import { WorkstreamSessionTabs } from '../WorkstreamSessionTabs';

const props = { workspacePath: '/test', workstreamId: 'a', sessions: ['a', 'untitled'], onSessionSelect: vi.fn() };
const RAW_KEY = /\bsessionTabs\.[\w.]+/;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR', activeSessionId?: string) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <WorkstreamSessionTabs {...props} activeSessionId={activeSessionId ?? null} />
    </I18nProvider>,
  );
}

describe('WorkstreamSessionTabs i18n', () => {
  it('keeps the original English labels', async () => {
    const { container } = await renderIn('en', 'a');
    expect(screen.getByText('Untitled')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    expect(container.querySelector('[title="New session in workstream"]')).toBeTruthy();
  });

  it('renders pt-BR labels without raw keys and keeps real titles', async () => {
    const { container } = await renderIn('pt-BR', 'a');
    expect(screen.getByText('Sem título')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    const newButton = container.querySelector('.session-tab-new')!;
    expect(newButton.getAttribute('title')).toBe('Nova sessão no fluxo de trabalho');
    expect(newButton.getAttribute('aria-label')).toBe('Nova sessão no fluxo de trabalho');
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it('localizes the loading state', async () => {
    await renderIn('en');
    expect(screen.getByText('Loading sessions...')).toBeTruthy();
    cleanup();
    await renderIn('pt-BR');
    expect(screen.getByText('Carregando sessões...')).toBeTruthy();
  });
});
