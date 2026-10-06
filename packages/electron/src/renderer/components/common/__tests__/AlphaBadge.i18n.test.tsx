// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../AlphaBadge';
import { TeamBetaNotice, TEAM_BETA_TOOLTIP } from '../TeamBetaNotice';

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

describe('AlphaBadge / TeamBetaNotice i18n', () => {
  it('keeps the English badge, aria-label and shared tooltip constants', async () => {
    await renderIn('en', <AlphaBadge tooltip={SETTINGS_ALPHA_TOOLTIP} />);
    const badge = screen.getByTestId('alpha-badge');
    expect(badge.getAttribute('aria-label')).toBe('Alpha feature');
    expect(badge.textContent).toBe('alpha');
    // The exported constants stay English (callers pass them as props).
    expect(SETTINGS_ALPHA_TOOLTIP.startsWith('Alpha features may be incomplete')).toBe(true);
    expect(TEAM_BETA_TOOLTIP.startsWith('Nimbalyst Teams is in beta.')).toBe(true);
  });

  it('renders the pt-BR badge and notice', async () => {
    await renderIn('pt-BR', (
      <>
        <AlphaBadge stage="beta" tooltip={TEAM_BETA_TOOLTIP} />
        <TeamBetaNotice />
      </>
    ));
    const badge = screen.getByTestId('alpha-badge');
    expect(badge.getAttribute('aria-label')).toBe('Recurso beta');
    expect(screen.getByTestId('team-beta-notice').textContent).toContain('O Nimbalyst Teams está em beta');
    expect(document.body.textContent).not.toMatch(/teamBetaNotice\.|alphaBadge\./);
  });

  it('renders the English beta notice unchanged', async () => {
    await renderIn('en', <TeamBetaNotice />);
    // The leading `info` is the MaterialSymbol ligature text.
    expect(screen.getByTestId('team-beta-notice').textContent?.replace(/^info/, '')).toBe(
      'Nimbalyst Teams is in beta — expect bugs. Organizations are free during beta and will require a paid Nimbalyst Teams subscription after launch; existing organizations get advance notice before any pricing change.',
    );
  });
});
