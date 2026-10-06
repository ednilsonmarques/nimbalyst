// @vitest-environment jsdom
/** The comment composer and its view model follow the UI language; surface names pass through. */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';

import { CommentComposer } from '../CommentComposer';
import { FULL_CAPABILITIES, READ_ONLY_CAPABILITIES, createCommentFixtures, createFixtureResolver } from '../commentFixtures';
import { describeComposerRestriction, formatRelativeTime } from '../commentViewModel';
import type { ConversationContext } from '../commentTypes';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

async function inLanguage(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
}

function renderComposer(context: Partial<ConversationContext> = {}, capabilities = FULL_CAPABILITIES) {
  const fixtures = createCommentFixtures({ now: NOW });
  return render(
    <I18nProvider>
      <CommentComposer
        capabilities={capabilities}
        context={{ ...fixtures.context, ...context }}
        directory={fixtures.directory}
        orgId={fixtures.orgId}
        resolver={createFixtureResolver()}
        resourceCandidates={fixtures.candidates}
        onSubmit={vi.fn()}
      />
    </I18nProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('CommentComposer i18n', () => {
  it('keeps the English composer copy', async () => {
    await inLanguage('en');
    const { container } = renderComposer();
    expect(container.querySelector('[aria-label="Message General"]')).toBeTruthy();
    expect(screen.getByText('Message General. Type @ to mention someone or an agent.')).toBeTruthy();
    expect(screen.getByTestId('comment-composer-send').textContent).toContain('Send');
  });

  it('renders pt-BR composer copy with the surface name untouched', async () => {
    await inLanguage('pt-BR');
    const { container } = renderComposer();
    expect(container.querySelector('[aria-label="Mensagem para General"]')).toBeTruthy();
    expect(screen.getByText('Mensagem para General. Digite @ para mencionar alguém ou um agente.')).toBeTruthy();
    expect(screen.getByTestId('comment-composer-send').textContent).toContain('Enviar');
    expect(container.textContent).not.toMatch(/comments\.[a-z]/);
  });

  it('explains archived and read-only conversations in pt-BR', async () => {
    await inLanguage('pt-BR');
    const { unmount } = renderComposer({ archived: true });
    expect(screen.getByTestId('comment-composer-restriction-title').textContent).toBe('Conversa arquivada: General');
    unmount();

    renderComposer({}, READ_ONLY_CAPABILITIES);
    expect(screen.getByTestId('comment-composer-restriction-detail').textContent)
      .toBe('Para publicar, é necessária a permissão "comment" em General. Seu papel concede apenas acesso de leitura.');
  });
});

describe('comment view model i18n', () => {
  it('keeps English strings and translates them in pt-BR', async () => {
    const fixtures = createCommentFixtures({ now: NOW });
    await inLanguage('en');
    expect(describeComposerRestriction(FULL_CAPABILITIES, { ...fixtures.context, archived: true })?.title).toBe('General is archived');
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h');

    await inLanguage('pt-BR');
    expect(formatRelativeTime(NOW - 1_000, NOW)).toBe('agora');
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 h');
  });
});
