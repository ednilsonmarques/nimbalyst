// @vitest-environment jsdom
/** Org sidebar, inbox copy and admin tabs follow the UI language; ids and English stay intact. */
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';

import { OrgSidebar } from '../OrgSidebar';
import { visibleAdminTabs, type OrgSidebarModel } from '../orgSidebarViewModel';
import { InboxEmptyState } from '../Inbox/InboxEmptyState';
import { formatRelativeTimestamp, groupRows, inboxFilterLabel } from '../Inbox/inboxViewModel';
import type { InboxRowView } from '../Inbox/inboxTypes';

vi.mock('@nimbalyst/runtime', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <span>{icon}</span>,
}));

const model: OrgSidebarModel = {
  rooms: [
    { conversationId: 'general', kind: 'orgRoom', label: 'General', isPrivate: false, isGeneral: true, unreadCount: 0 },
  ],
  dms: [],
  gating: {
    roomsVisible: true,
    dmsVisible: true,
    canCreateRoom: true,
    canCreateDirectMessage: true,
  },
};

async function inLanguage(language: 'en' | 'pt-BR') {
  await act(async () => {
    await setLanguage(language);
  });
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('OrgSidebar i18n', () => {
  it('keeps the English labels', async () => {
    await inLanguage('en');
    render(<I18nProvider><OrgSidebar model={model} onNavigate={vi.fn()} /></I18nProvider>);
    expect(screen.getByPlaceholderText('Search conversations')).toBeTruthy();
    expect(screen.getByText('Rooms')).toBeTruthy();
    expect(screen.getByText('Direct messages')).toBeTruthy();
    expect(screen.getByText('Mentions')).toBeTruthy();
    expect(screen.getByText('No direct messages yet. Start one with +.')).toBeTruthy();
  });

  it('renders pt-BR labels and searches the translated row labels', async () => {
    await inLanguage('pt-BR');
    const { container } = render(<I18nProvider><OrgSidebar model={model} onNavigate={vi.fn()} /></I18nProvider>);
    expect(screen.getByPlaceholderText('Pesquisar conversas')).toBeTruthy();
    expect(screen.getByText('Salas')).toBeTruthy();
    expect(screen.getByText('Mensagens diretas')).toBeTruthy();
    expect(screen.getByText('Menções')).toBeTruthy();
    expect(screen.getByText('Ainda não há mensagens diretas. Inicie uma com +.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/\b(sidebar|inbox|team)\.[a-z]/);

    fireEvent.change(screen.getByPlaceholderText('Pesquisar conversas'), { target: { value: 'menç' } });
    expect(screen.getByTestId('org-inbox-mentions')).toBeTruthy();
    expect(screen.queryByTestId('team-tab-inbox')).toBeNull();
  });

  it('translates the directory load error around the subject', async () => {
    await inLanguage('en');
    const { unmount } = render(<I18nProvider><OrgSidebar model={model} directoryError="boom" onNavigate={vi.fn()} /></I18nProvider>);
    expect(screen.getByText('Couldn’t load rooms.')).toBeTruthy();
    unmount();

    await inLanguage('pt-BR');
    render(<I18nProvider><OrgSidebar model={model} directoryError="boom" onNavigate={vi.fn()} /></I18nProvider>);
    expect(screen.getByText('Não foi possível carregar as salas.')).toBeTruthy();
  });
});

const rows = (now: number) => [now, now - 60 * 86_400_000].map((createdAt) => ({ createdAt }) as InboxRowView);

describe('Inbox i18n', () => {
  it('renders filter empty states in pt-BR', async () => {
    await inLanguage('pt-BR');
    render(
      <I18nProvider>
        <InboxEmptyState filter="mentions" query="" scopeActive={false} onClearFilters={vi.fn()} onBrowse={vi.fn()} />
      </I18nProvider>,
    );
    expect(screen.getByText('Nenhuma menção')).toBeTruthy();
    expect(screen.getByText('Explorar salas')).toBeTruthy();
    expect(screen.getByText('Limpar filtros')).toBeTruthy();
  });

  it('keeps English view-model labels and translates them in pt-BR', async () => {
    const now = Date.parse('2026-07-26T18:00:00.000Z');
    await inLanguage('en');
    expect(inboxFilterLabel('assigned')).toBe('Assigned to me');
    expect(formatRelativeTimestamp(now - 5 * 60_000, now)).toBe('5m');
    expect(groupRows(rows(now), now).map((group) => group.label)).toEqual(['Today', 'Older']);

    await inLanguage('pt-BR');
    expect(inboxFilterLabel('assigned')).toBe('Atribuídas a mim');
    expect(formatRelativeTimestamp(now - 10_000, now)).toBe('agora');
    expect(formatRelativeTimestamp(now - 5 * 60_000, now)).toBe('5 min');
    expect(groupRows(rows(now), now).map((group) => group.label)).toEqual(['Hoje', 'Mais antigas']);
  });
});

describe('admin tabs i18n', () => {
  it('translates labels only, keeping the ids', async () => {
    await inLanguage('pt-BR');
    const tabs = visibleAdminTabs(true);
    expect(tabs.map((tab) => tab.id)).toEqual(['members', 'projects', 'settings', 'billing', 'danger']);
    expect(tabs.map((tab) => tab.label)).toEqual(['Membros', 'Projetos', 'Configurações', 'Cobrança', 'Zona de perigo']);

    await inLanguage('en');
    expect(visibleAdminTabs(false).map((tab) => tab.label)).toEqual(['Members', 'Projects', 'Settings']);
  });
});
