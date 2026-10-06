// @vitest-environment jsdom
/**
 * The navigation gutter, project rail neighbours and account surfaces follow
 * the UI language: English stays byte-identical to the original copy, pt-BR
 * renders translated text (never a raw `workspace.*` key), and plurals and
 * interpolated names survive the trip.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('../../../hooks/useProjectOrg', () => ({
  useProjectOrg: () => ({ org: null, loading: false }),
}));
vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span data-icon={icon} />,
}));
vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../../../extensions/panels/usePanels', () => ({
  useExtensionGutterButtons: () => [],
  useExtensionBottomPanelButtons: () => [],
}));
vi.mock('../AgentSessionsPopover', () => ({ AgentSessionsPopover: () => null }));
vi.mock('../../Accounts/AccountInspectorPopover', () => ({ AccountInspectorPopover: () => null }));
vi.mock('../../ThemeToggleButton/ThemeToggleButton', () => ({ ThemeToggleButton: () => null }));
vi.mock('../../SyncStatusButton/SyncStatusButton', () => ({ SyncStatusButton: () => null }));
vi.mock('../../TrustIndicator', () => ({ TrustIndicator: () => null }));
vi.mock('../../ExtensionDevIndicator', () => ({ ExtensionDevIndicator: () => null }));
vi.mock('../../ClaudeUsageIndicator', () => ({ ClaudeUsageIndicator: () => null }));
vi.mock('../../CodexUsageIndicator', () => ({ CodexUsageIndicator: () => null }));
vi.mock('../../GeminiUsageIndicator', () => ({ GeminiUsageIndicator: () => null }));
vi.mock('../../UnifiedAI/VoiceModeButton', () => ({ VoiceModeButton: () => null }));

import { NavigationGutter } from '../NavigationGutter';
import { AccountExpiryBanner } from '../../Accounts/AccountExpiryBanner';
import { AccountLoginForm } from '../../Accounts/AccountLoginForm';
import { FileTreeFilterMenu } from '../../FileTreeFilterMenu';

const RAW_KEY = /\bworkspace[.:][\w.]+|\b(gutter|agentSessions|accountLogin|accountExpiry|fileTreeFilter)\.[\w.]+/;

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

function gutter() {
  return (
    <Provider store={createStore()}>
      <NavigationGutter contentMode="files" onContentModeChange={vi.fn()} workspacePath="/workspace" />
    </Provider>
  );
}

describe('NavigationGutter i18n', () => {
  it('keeps the English mode and action labels', async () => {
    await renderIn('en', gutter());
    expect(screen.getByTestId('files-mode-button').getAttribute('aria-label')).toMatch(/^Files \(.+\)$/);
    expect(screen.getByTestId('agent-mode-button').getAttribute('aria-label')).toMatch(/^Agent \(.+\)$/);
    expect(screen.getByTestId('gutter-feedback-button').getAttribute('aria-label')).toBe('Send Feedback');
    expect(screen.getByTestId('gutter-user-button').getAttribute('aria-label')).toMatch(/^User menu/);
  });

  it('translates mode labels and aria-labels to pt-BR without raw keys', async () => {
    const { container } = await renderIn('pt-BR', gutter());
    expect(screen.getByTestId('files-mode-button').getAttribute('aria-label')).toMatch(/^Arquivos \(.+\)$/);
    expect(screen.getByTestId('agent-mode-button').getAttribute('aria-label')).toMatch(/^Agente \(.+\)$/);
    expect(screen.getByTestId('tracker-mode-button').getAttribute('aria-label')).toMatch(/^Rastreador \(.+\)$/);
    expect(screen.getByTestId('gutter-feedback-button').getAttribute('aria-label')).toBe('Enviar feedback');
    expect(screen.getByTestId('gutter-user-button').getAttribute('aria-label')).toMatch(/^Menu do usuário/);
    const labels = [...container.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label') ?? '');
    expect(labels.filter((label) => RAW_KEY.test(label))).toEqual([]);
  });
});

describe('Account surfaces i18n', () => {
  const expired = {
    personalOrgId: 'p1',
    email: 'work@example.com',
    sessionStatus: 'expired',
  } as never;

  it('renders the expiry banner in English and pt-BR with the email interpolated', async () => {
    await renderIn('en', <AccountExpiryBanner accounts={[expired]} organizations={[]} onReconnect={vi.fn()} />);
    expect(screen.getByTestId('account-expiry-banner').textContent).toContain("work@example.com's session expired");
    expect(screen.getByRole('button', { name: 'Reconnect work@example.com' }).textContent).toBe('Reconnect');
    cleanup();

    await renderIn('pt-BR', <AccountExpiryBanner accounts={[expired]} organizations={[]} onReconnect={vi.fn()} />);
    const banner = screen.getByTestId('account-expiry-banner');
    expect(banner.textContent).toContain('A sessão de work@example.com expirou');
    expect(banner.querySelector('strong')?.textContent).toBe('work@example.com');
    expect(screen.getByRole('button', { name: 'Reconectar work@example.com' }).textContent).toBe('Reconectar');
    expect(banner.textContent).not.toMatch(RAW_KEY);
  });

  it('translates the login form copy', async () => {
    await renderIn('en', <AccountLoginForm mode="first-sign-in" />);
    screen.getByText('Sign in to get started');
    screen.getByRole('button', { name: /Continue with Google/ });
    screen.getByLabelText('Email');
    cleanup();

    const { container } = await renderIn('pt-BR', <AccountLoginForm mode="first-sign-in" />);
    screen.getByText('Entre para começar');
    screen.getByRole('button', { name: /Continuar com o Google/ });
    screen.getByLabelText('E-mail');
    screen.getByRole('button', { name: 'Enviar link mágico' });
    expect(container.textContent).not.toMatch(RAW_KEY);
  });
});

describe('File tree filter menu i18n', () => {
  const props = {
    x: 10, y: 10, currentFilter: 'all' as const, showIcons: true, showGitStatus: true, enableAutoScroll: true,
    onFilterChange: vi.fn(), onShowIconsChange: vi.fn(), onShowGitStatusChange: vi.fn(), onEnableAutoScrollChange: vi.fn(),
    hasActiveClaudeSession: false, claudeSessionFileCounts: { read: 0, written: 0 }, isGitRepo: false,
    gitUncommittedCount: 0, isGitWorktree: false, gitWorktreeCount: 0, onClose: vi.fn(),
  };

  it('renders English and pt-BR labels', async () => {
    await renderIn('en', <FileTreeFilterMenu {...props} />);
    screen.getByText('Markdown Only');
    screen.getByText('Auto-Scroll to Active File');
    cleanup();

    await renderIn('pt-BR', <FileTreeFilterMenu {...props} />);
    screen.getByText('Somente Markdown');
    screen.getByText('Não é um repositório git.');
    screen.getByText('Rolar automaticamente até o arquivo ativo');
    expect(document.body.textContent).not.toMatch(RAW_KEY);
  });
});
