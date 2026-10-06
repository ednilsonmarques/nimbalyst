// @vitest-environment jsdom
/**
 * Tracker Mode i18n: the English UI is unchanged, and pt-BR renders translated
 * text (never a raw key) on the sidebar, the board, its selection bar and the
 * milestone picker. Stored values (priority/status ids) are never translated.
 */

import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { setLanguage, t } from '@nimbalyst/runtime/i18n';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { KanbanBoard } from '../KanbanBoard';
import { KanbanBoardSelectionBar } from '../KanbanBoardSelectionBar';
import { TrackerSidebar } from '../TrackerSidebar';
import { formatTrackerActivity } from '../trackerActivityPresentation';
import { PlanFilters } from '../../PlansPanel/PlanFilters';

beforeAll(() => {
  loadBuiltinTrackers();
});

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

function record(id: string, primaryType: string, title: string): TrackerRecord {
  return {
    id,
    primaryType,
    typeTags: [primaryType],
    source: 'native',
    archived: false,
    syncStatus: 'local',
    system: {
      workspace: '/w',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    fields: { title, status: 'draft' },
  } as unknown as TrackerRecord;
}

const RAW_KEY = /\b(sidebar|kanban|selectionBar|milestone|plans|priority)\.[a-zA-Z]+/;

function renderSidebar() {
  return render(
    <Provider store={createStore()}>
      <TrackerSidebar
        workspacePath="/w/project"
        workspaceName="project"
        trackerTypes={[]}
        navigationEntries={[]}
        selectedType="all"
        activeFilters={[]}
        tagFilter={[]}
        sourceFilter={[]}
        currentIdentity={null}
        favoriteItemIds={new Set()}
        viewedAtByItemId={new Map()}
        readinessByItemId={new Map()}
        personalStateHydrated
        recentlyViewedDays={null}
        columnFilters={null}
        statusScope="all"
        viewMode="list"
        onSelectType={vi.fn()}
        onViewModeChange={vi.fn()}
        savedViews={[]}
        activeSavedViewId={null}
        onApplyView={vi.fn()}
        onDeleteView={vi.fn()}
        onToggleShareView={vi.fn()}
        onSaveNavigationEntry={vi.fn().mockResolvedValue(undefined)}
        onDeleteFolder={vi.fn().mockResolvedValue(undefined)}
        team={null}
        teamMembers={[]}
      />
    </Provider>,
  );
}

function renderSelectionBar(items: TrackerRecord[]) {
  const store = createStore();
  store.set(trackerItemsMapAtom, new Map(items.map(item => [item.id, item])));
  return render(
    <Provider store={store}>
      <KanbanBoardSelectionBar items={items} onClearSelection={vi.fn()} />
    </Provider>,
  );
}

describe('TrackerSidebar i18n', () => {
  it('keeps the original English labels and tooltips', () => {
    renderSidebar();
    const sidebar = screen.getByTestId('tracker-sidebar');
    expect(sidebar.textContent).toContain('Trackers');
    expect(sidebar.textContent).toContain('Types');
    expect(screen.getByTestId('tracker-view-mode-list').getAttribute('title')).toBe('List view');
    expect(screen.getByTestId('tracker-view-mode-table').getAttribute('title')).toBe('Table view');
    expect(screen.getByTestId('tracker-view-mode-kanban').getAttribute('title')).toBe('Kanban view (alpha)');
    expect(screen.getByTestId('tracker-view-mode-inbox').getAttribute('title')).toBe('Triage inbox (alpha)');
    expect(screen.getByTestId('tracker-folder-add').getAttribute('title')).toBe('New tracker folder');
  });

  it('renders pt-BR without raw keys', async () => {
    await setLanguage('pt-BR');
    renderSidebar();
    const sidebar = screen.getByTestId('tracker-sidebar');
    expect(sidebar.textContent).toContain('Rastreadores');
    expect(sidebar.textContent).toContain('Tipos');
    expect(sidebar.textContent).not.toMatch(RAW_KEY);
    expect(screen.getByTestId('tracker-view-mode-list').getAttribute('title')).toBe('Visualização em lista');
    expect(screen.getByTestId('tracker-view-mode-kanban').getAttribute('title')).toBe('Visualização kanban (alfa)');
    expect(screen.getByTestId('tracker-folder-add').getAttribute('title')).toBe('Nova pasta de rastreadores');
    fireEvent.click(screen.getByTestId('tracker-folder-add'));
    expect(screen.getByPlaceholderText('Nome da pasta')).toBeDefined();
  });

  it('switches language on an already mounted sidebar', async () => {
    renderSidebar();
    expect(screen.getByTestId('tracker-view-mode-table').getAttribute('title')).toBe('Table view');
    await act(async () => { await setLanguage('pt-BR'); });
    expect(screen.getByTestId('tracker-view-mode-table').getAttribute('title')).toBe('Visualização em tabela');
  });
});

describe('Kanban board i18n', () => {
  it('translates the empty board message', async () => {
    const { unmount } = render(<Provider store={createStore()}><KanbanBoard filterType="all" overrideItems={[]} /></Provider>);
    expect(screen.getByText('No items to display')).toBeDefined();
    unmount();
    await setLanguage('pt-BR');
    render(<Provider store={createStore()}><KanbanBoard filterType="all" overrideItems={[]} /></Provider>);
    expect(screen.getByText('Nenhum item para exibir')).toBeDefined();
  });

  it('keeps the selection bar English and pluralizes it in pt-BR', async () => {
    const items = [record('plan_1', 'plan', 'One'), record('plan_2', 'plan', 'Two')];
    const { unmount } = renderSelectionBar(items);
    const bar = screen.getByTestId('tracker-board-selection-bar');
    expect(bar.textContent).toContain('2 selected');
    expect(bar.textContent).toContain('Shift-click for a range');
    expect(screen.getByTestId('tracker-board-bulk-milestone-button').textContent).toContain('Assign to milestone');
    expect(screen.getByTestId('tracker-board-clear-selection').textContent).toContain('Clear');
    unmount();

    await setLanguage('pt-BR');
    renderSelectionBar(items);
    const ptBar = screen.getByTestId('tracker-board-selection-bar');
    expect(ptBar.textContent).toContain('2 selecionados');
    expect(ptBar.textContent).toContain('Shift+clique para selecionar um intervalo');
    expect(screen.getByTestId('tracker-board-bulk-milestone-button').textContent).toContain('Atribuir a um marco');
    expect(screen.getByTestId('tracker-board-clear-selection').textContent).toContain('Limpar');
    expect(ptBar.textContent).not.toMatch(RAW_KEY);

    fireEvent.click(screen.getByTestId('tracker-board-bulk-milestone-button'));
    const popover = screen.getByTestId('tracker-board-bulk-milestone-popover');
    expect(popover.textContent).toContain('Atribuir 2 itens a');
    expect(popover.textContent).toContain('Remover do marco');
    expect(screen.getByLabelText('Pesquisar marcos').getAttribute('placeholder')).toBe('Pesquisar marcos…');
  });

  it('uses singular forms for a single selected card', async () => {
    await setLanguage('pt-BR');
    renderSelectionBar([record('plan_1', 'plan', 'One')]);
    expect(screen.getByTestId('tracker-board-selection-bar').textContent).toContain('1 selecionado');
    fireEvent.click(screen.getByTestId('tracker-board-bulk-milestone-button'));
    expect(screen.getByTestId('tracker-board-bulk-milestone-popover').textContent).toContain('Atribuir 1 item a');
  });
});

describe('tracker plurals and presentation strings', () => {
  it('keeps English delete confirmations byte-identical', () => {
    expect(t('tracker:deleteItems.title', { count: 1 })).toBe('Delete item?');
    expect(t('tracker:deleteItems.title', { count: 3 })).toBe('Delete items?');
    expect(t('tracker:deleteItems.message', { count: 1 })).toBe('Delete 1 item? This cannot be undone.');
    expect(t('tracker:deleteItems.message', { count: 3 })).toBe('Delete 3 items? This cannot be undone.');
    expect(t('tracker:kanban.itemsSelected', { count: 2 })).toBe('2 items selected');
    expect(t('tracker:grid.undo.paste', { count: 1 })).toBe('Paste 1 cell');
  });

  it('pluralizes in pt-BR', async () => {
    await setLanguage('pt-BR');
    expect(t('tracker:deleteItems.message', { count: 1 })).toBe('Excluir 1 item? Esta ação não pode ser desfeita.');
    expect(t('tracker:deleteItems.message', { count: 4 })).toBe('Excluir 4 itens? Esta ação não pode ser desfeita.');
    expect(t('tracker:hiddenByScope', { count: 2 })).toBe('2 itens fechados ocultos');
    expect(t('tracker:sessionKanban.sessionCount', { count: 1 })).toBe('1 sessão');
  });

  it('translates activity sentences but keeps stored values and field names', async () => {
    const entry = { action: 'updated', field: 'priority', oldValue: 'low', newValue: 'high' };
    expect(formatTrackerActivity(entry)).toBe('changed priority from “low” to “high”');
    await setLanguage('pt-BR');
    expect(formatTrackerActivity(entry)).toBe('alterou priority de “low” para “high”');
    expect(formatTrackerActivity({ action: 'created' })).toBe('criou este item');
  });
});

describe('PlanFilters i18n', () => {
  function renderFilters() {
    return render(
      <PlanFilters
        searchTerm=""
        onSearchChange={vi.fn()}
        statusFilter="all"
        onStatusChange={vi.fn()}
        priorityFilter="all"
        onPriorityChange={vi.fn()}
        hideCompleted={false}
        onHideCompletedChange={vi.fn()}
      />,
    );
  }

  it('translates option labels while keeping the stored option values', async () => {
    renderFilters();
    const englishReady = screen.getByRole('option', { name: 'Ready' }) as HTMLOptionElement;
    expect(englishReady.value).toBe('ready-for-development');
    expect(screen.getByPlaceholderText('Search plans...')).toBeDefined();
    cleanup();

    await setLanguage('pt-BR');
    renderFilters();
    const ready = screen.getByRole('option', { name: 'Pronto' }) as HTMLOptionElement;
    expect(ready.value).toBe('ready-for-development');
    const critical = screen.getByRole('option', { name: 'Crítica' }) as HTMLOptionElement;
    expect(critical.value).toBe('critical');
    expect(screen.getByPlaceholderText('Pesquisar planos...')).toBeDefined();
    expect(screen.getByText('Ocultar concluídos')).toBeDefined();
  });
});
