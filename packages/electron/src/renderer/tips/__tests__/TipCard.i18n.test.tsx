// @vitest-environment jsdom
// Text queries rather than role queries: the card's arbitrary-value Tailwind
// classes trip jsdom's selector engine inside accessible-name computation.
/** Tips keep English definitions (analytics) and translate at render. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { i18n, setLanguage } from '@nimbalyst/runtime/i18n';
import { TipCard } from '../TipCard';
import { tips } from '../definitions';
import { mobileKeepAwakeTip } from '../definitions/mobile-keep-awake';
import type { TipDefinition } from '../types';

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderTip(language: 'en' | 'pt-BR', tip: TipDefinition, variant: 'floating' | 'inline' = 'inline') {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <TipCard tip={tip} onAction={vi.fn()} onSecondaryAction={vi.fn()} onDismiss={vi.fn()} variant={variant} />
    </I18nProvider>,
  );
}

describe('TipCard i18n', () => {
  it('renders the English definition text unchanged', async () => {
    await renderTip('en', mobileKeepAwakeTip);
    expect(screen.getByText('Tip')).toBeTruthy();
    expect(screen.getByText('Keep your computer awake for mobile prompts')).toBeTruthy();
    expect(screen.getByText('Enable Keep-Awake')).toBeTruthy();
    expect(screen.getByText('Sync Settings')).toBeTruthy();
  });

  it('renders pt-BR title, body, actions and dismiss label', async () => {
    await renderTip('pt-BR', mobileKeepAwakeTip, 'floating');
    expect(screen.getByText('Mantenha o computador acordado para prompts do celular')).toBeTruthy();
    expect(screen.getByText('Ativar modo sempre ativo')).toBeTruthy();
    expect(screen.getByText('Configurações de sincronização')).toBeTruthy();
    expect(screen.getByLabelText('Dispensar dica')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/tips\.(content|ui)\./);
    // The definition itself (reported to analytics) stays English.
    expect(mobileKeepAwakeTip.content.action?.label).toBe('Enable Keep-Awake');
  });

  it('falls back to the definition text for tips without a translation entry', async () => {
    const custom: TipDefinition = {
      id: 'tip-test-only',
      name: 'Test',
      trigger: { condition: () => true },
      content: { title: 'Custom title', body: 'Custom body' },
    };
    await renderTip('pt-BR', custom);
    expect(screen.getByText('Custom title')).toBeTruthy();
    expect(screen.getByText('Custom body')).toBeTruthy();
  });

  it('every registered tip has English text identical to its definition and a pt-BR entry', () => {
    for (const tip of tips) {
      const fields: Array<[string, string | undefined]> = [
        ['title', tip.content.title],
        ['body', tip.content.body],
        ['action', tip.content.action?.label],
        ['secondaryAction', tip.content.secondaryAction?.label],
      ];
      for (const [field, source] of fields) {
        if (source === undefined) continue;
        const key = `tips.content.${tip.id}.${field}`;
        expect(i18n.getResource('en', 'onboarding', key), key).toBe(source);
        expect(i18n.getResource('pt-BR', 'onboarding', key), key).toBeTruthy();
      }
    }
  });
});
