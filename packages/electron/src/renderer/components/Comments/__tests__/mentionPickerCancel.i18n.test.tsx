// @vitest-environment jsdom
/** The agent mention row and the composer's Cancel button follow the UI language. */
import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';

import { CommentComposer } from '../CommentComposer';
import { MentionPicker } from '../MentionPicker';
import { FULL_CAPABILITIES, createCommentFixtures, createFixtureResolver } from '../commentFixtures';
import type { MentionCandidate } from '../commentViewModel';

const NOW = Date.parse('2026-07-26T18:00:00.000Z');

const AGENT: MentionCandidate = {
  kind: 'agent',
  agent: {
    sessionId: 'session-1',
    sessionName: 'Refactor parser',
    handle: 'refactor-parser',
    ownerUserId: 'user-2',
    ownerDisplayName: 'Ada Lovelace',
  },
};

async function inLanguage(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
}

function renderPicker() {
  return render(
    <I18nProvider>
      <MentionPicker
        anchorRect={null}
        candidates={[AGENT]}
        activeIndex={0}
        onSelect={vi.fn()}
        onActiveIndexChange={vi.fn()}
      />
    </I18nProvider>,
  );
}

function renderComposerWithCancel() {
  const fixtures = createCommentFixtures({ now: NOW });
  return render(
    <I18nProvider>
      <CommentComposer
        capabilities={FULL_CAPABILITIES}
        context={fixtures.context}
        directory={fixtures.directory}
        orgId={fixtures.orgId}
        resolver={createFixtureResolver()}
        resourceCandidates={fixtures.candidates}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    </I18nProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('MentionPicker agent row i18n', () => {
  it('keeps the English owner line', async () => {
    await inLanguage('en');
    renderPicker();
    expect(screen.getByText('@refactor-parser · session of Ada Lovelace')).toBeTruthy();
  });

  it('renders the owner line in pt-BR with handle and name untouched', async () => {
    await inLanguage('pt-BR');
    renderPicker();
    expect(screen.getByText('@refactor-parser · sessão de Ada Lovelace')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/comments\.mention\./);
  });
});

describe('CommentComposer cancel button i18n', () => {
  it('keeps the English label', async () => {
    await inLanguage('en');
    renderComposerWithCancel();
    expect(screen.getByTestId('comment-composer-cancel').textContent).toBe('Cancel');
  });

  it('renders the pt-BR label', async () => {
    await inLanguage('pt-BR');
    renderComposerWithCancel();
    expect(screen.getByTestId('comment-composer-cancel').textContent).toBe('Cancelar');
  });
});
