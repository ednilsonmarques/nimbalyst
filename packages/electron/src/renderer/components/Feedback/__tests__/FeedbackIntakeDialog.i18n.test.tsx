// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('posthog-js/react', () => ({ usePostHog: () => null }));

import { FeedbackIntakeDialog, buildFeedbackInitialDraft } from '../FeedbackIntakeDialog';

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

async function renderDialog(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  return render(
    <I18nProvider>
      <FeedbackIntakeDialog isOpen onClose={vi.fn()} onLaunch={vi.fn()} />
    </I18nProvider>,
  );
}

describe('FeedbackIntakeDialog i18n', () => {
  it('renders the original English copy', async () => {
    await renderDialog('en');
    expect(screen.getByText('Send better feedback with your Agent')).toBeTruthy();
    expect(screen.getByText('Bug report')).toBeTruthy();
    expect(screen.getByText('Feature request')).toBeTruthy();
    expect(screen.getByText('Choose a type to continue')).toBeTruthy();
    expect(screen.getByLabelText('Close')).toBeTruthy();
    expect(screen.getByText('Email private feedback to support@nimbalyst.com')).toBeTruthy();
    fireEvent.click(screen.getByTestId('feedback-intake-select-bug'));
    expect(screen.getByText('Start bug report')).toBeTruthy();
    expect(screen.getByText('Include logs and environment details')).toBeTruthy();
  });

  it('renders pt-BR copy, labels and per-kind detail', async () => {
    await renderDialog('pt-BR');
    expect(screen.getByText('Envie um feedback melhor com o seu agente')).toBeTruthy();
    expect(screen.getByText('Relatório de bug')).toBeTruthy();
    expect(screen.getByText('Solicitação de recurso')).toBeTruthy();
    expect(screen.getByText('Escolha um tipo para continuar')).toBeTruthy();
    expect(screen.getByLabelText('Fechar')).toBeTruthy();
    fireEvent.click(screen.getByTestId('feedback-intake-select-feature'));
    expect(screen.getByText('Iniciar solicitação de recurso')).toBeTruthy();
    expect(screen.getByText('Explorar a ideia com um mockup de UX primeiro')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/feedbackIntake\./);
  });

  it('keeps the agent draft (sent to the AI) in English', async () => {
    await setLanguage('pt-BR');
    expect(buildFeedbackInitialDraft('bug', { mayGatherLogs: true })).toBe('/feedback:bug-report\n\nLog gathering: allowed');
  });
});
