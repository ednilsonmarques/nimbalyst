// @vitest-environment jsdom
/** Walkthrough definitions hold i18n keys; the callout resolves them in the UI language. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { i18n, setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('../WalkthroughService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../WalkthroughService')>();
  return {
    ...actual,
    resolveTarget: () => document.body,
    isTargetValid: () => true,
    calculateCalloutPosition: () => ({ top: 0, left: 0, arrowPosition: 'top', arrowOffset: 10 }),
  };
});

import { WalkthroughCallout } from '../components/WalkthroughCallout';
import { walkthroughs } from '../definitions';
import { agentModeIntro, filesModeIntro } from '../definitions/navigation-intro';
import type { WalkthroughDefinition } from '../types';

const twoSteps: WalkthroughDefinition = {
  ...agentModeIntro,
  steps: [agentModeIntro.steps[0], filesModeIntro.steps[0]],
};

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderCallout(language: 'en' | 'pt-BR', stepIndex = 0) {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <WalkthroughCallout
        definition={twoSteps}
        stepIndex={stepIndex}
        onNext={vi.fn()}
        onBack={vi.fn()}
        onDismiss={vi.fn()}
        onComplete={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe('WalkthroughCallout i18n', () => {
  it('renders the original English copy', async () => {
    await renderCallout('en');
    expect(screen.getByText('Agent Mode')).toBeTruthy();
    expect(screen.getByText(/A focused coding agent management interface\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    expect(screen.getByText('1 of 2')).toBeTruthy();
  });

  it('renders pt-BR copy without raw keys', async () => {
    await renderCallout('pt-BR', 1);
    expect(screen.getByText('Modo Arquivos')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dispensar' })).toBeTruthy();
    expect(screen.getByText('2 de 2')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/walkthroughs\.|onboarding:/);
  });

  it('every walkthrough step points at keys present in both languages', () => {
    for (const definition of walkthroughs) {
      for (const step of definition.steps) {
        for (const key of [step.title, step.body]) {
          expect(i18n.exists(key, { ns: 'onboarding', lng: 'en' }), `${definition.id}: ${key}`).toBe(true);
          expect(i18n.getResource('pt-BR', 'onboarding', key), `${definition.id}: ${key}`).toBeTruthy();
        }
      }
    }
  });
});
