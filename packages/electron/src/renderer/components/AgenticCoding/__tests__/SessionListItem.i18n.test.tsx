// @vitest-environment jsdom
/**
 * Session list rows follow the UI language: fallback title, phase badge,
 * uncommitted-changes tooltip (plural) and the row aria-label.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('jotai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('jotai')>()),
  useAtomValue: () => undefined,
  useSetAtom: () => () => {},
}));
vi.mock('@nimbalyst/runtime', () => ({ MaterialSymbol: () => null, ProviderIcon: () => null }));
vi.mock('../../../store', () => ({
  sessionOrChildProcessingAtom: () => ({}),
  sessionUnreadAtom: () => ({}),
  sessionPendingPromptAtom: () => ({}),
  sessionHasPendingInteractivePromptAtom: () => ({}),
  reparentSessionAtom: () => ({}),
  refreshSessionListAtom: () => ({}),
  sessionShareAtom: () => ({}),
  sessionWakeupAtom: () => ({}),
  sessionLastActivityAtom: () => ({}),
}));
vi.mock('../../../store/atoms/sessions', () => ({ convertToWorkstreamAtom: () => ({}), sessionRegistryAtom: {} }));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));

import { SessionListItem } from '../SessionListItem';

const RAW_KEY = /\b(sessionItem|phases)\.[\w.]+/;

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderIn(language: 'en' | 'pt-BR', props: Partial<React.ComponentProps<typeof SessionListItem>> = {}) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <SessionListItem
        id="s1"
        title=""
        createdAt={Date.now()}
        isActive={false}
        onClick={() => {}}
        phase="implementing"
        uncommittedCount={2}
        sortBy="created"
        isArchived
        {...props}
      />
    </I18nProvider>,
  );
}

describe('SessionListItem i18n', () => {
  it('keeps the original English strings', async () => {
    const { container } = await renderIn('en');
    expect(screen.getAllByText('Untitled Session').length).toBeGreaterThan(0);
    expect(screen.getByText('Implementing')).toBeTruthy();
    expect(container.querySelector('[title="2 uncommitted changes"]')).toBeTruthy();
    const row = screen.getByTestId('session-list-item');
    expect(row.getAttribute('aria-label')).toMatch(/^Session: Untitled Session, created .+ \(archived\)$/);
  });

  it('renders pt-BR strings without raw keys', async () => {
    const { container } = await renderIn('pt-BR');
    expect(screen.getAllByText('Sessão sem título').length).toBeGreaterThan(0);
    expect(screen.getByText('Implementação')).toBeTruthy();
    expect(container.querySelector('[title="2 alterações não commitadas"]')).toBeTruthy();
    const row = screen.getByTestId('session-list-item');
    expect(row.getAttribute('aria-label')).toMatch(/^Sessão: Sessão sem título, criada .+ \(arquivada\)$/);
    expect(container.textContent).not.toMatch(RAW_KEY);
  });

  it('uses the singular form for one uncommitted change', async () => {
    const { container } = await renderIn('pt-BR', { uncommittedCount: 1, title: 'Fix bug' });
    expect(container.querySelector('[title="1 alteração não commitada"]')).toBeTruthy();
    // Real titles are never translated.
    expect(screen.getAllByText('Fix bug').length).toBeGreaterThan(0);
  });
});
