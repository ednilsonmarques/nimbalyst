// @vitest-environment jsdom
/** Usage popovers (Claude) follow the UI language; provider names stay as-is. */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { ClaudeUsagePopover } from '../ClaudeUsagePopover';
import { claudeUsageAtom } from '../../../store/atoms/claudeUsageAtoms';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  return { toggleGutterItemHiddenAtom: atom(null, () => {}) };
});
vi.mock('../../../hooks/useFloatingMenu', () => ({
  FloatingPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useFloatingMenu: () => ({
    refs: { setReference: () => {}, setFloating: () => {} },
    floatingStyles: {},
    getFloatingProps: () => ({}),
  }),
}));

afterEach(async () => {
  cleanup();
  await act(async () => {
    await setLanguage('en');
  });
});

const inFiveHours = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

async function renderPopover(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
  const store = createStore();
  store.set(claudeUsageAtom, {
    fiveHour: { utilization: 42, resetsAt: inFiveHours },
    sevenDay: { utilization: 10, resetsAt: inFiveHours },
    weeklyModelLimits: [{ model: 'Sonnet', utilization: 5, resetsAt: inFiveHours }],
    lastUpdated: Date.now(),
  } as never);
  const anchorRef = { current: document.createElement('button') };
  return render(
    <Provider store={store}>
      <I18nProvider>
        <ClaudeUsagePopover anchorRef={anchorRef} onClose={vi.fn()} onRefresh={vi.fn(async () => {})} />
      </I18nProvider>
    </Provider>,
  );
}

describe('ClaudeUsagePopover i18n', () => {
  it('keeps the English copy', async () => {
    await renderPopover('en');
    screen.getByText('Claude Usage');
    screen.getByText('Session');
    screen.getByText('5-hour window');
    screen.getByText('Sonnet (Weekly)');
    screen.getByText('Updated just now');
    screen.getByText('Disable');
    screen.getByLabelText('Refresh usage');
  });

  it('renders pt-BR copy without raw keys', async () => {
    const { container } = await renderPopover('pt-BR');
    screen.getByText('Uso do Claude');
    screen.getByText('Sessão');
    screen.getByText('Janela de 5 horas');
    screen.getByText('Sonnet (semanal)');
    screen.getByText('Atualizado agora');
    screen.getByText('Desativar');
    screen.getByLabelText('Atualizar uso');
    screen.getByText('Página de status da Anthropic');
    expect(container.textContent).not.toMatch(/\b(usage|claudeUsage)\.[a-zA-Z]/);
  });
});
