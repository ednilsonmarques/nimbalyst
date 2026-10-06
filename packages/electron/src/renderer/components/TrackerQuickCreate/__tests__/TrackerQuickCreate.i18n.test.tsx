// @vitest-environment jsdom
/**
 * Quick create i18n: the English popup is unchanged, pt-BR renders translated
 * chrome (never a raw key), and the user-defined type name is shown as is.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { globalRegistry, type TrackerDataModel } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { trackerQuickCreateRequestAtom } from '../../../store/atoms/appCommands';
import { TrackerQuickCreatePopup } from '../TrackerQuickCreatePopup';
import { TrackerDuplicateStrip } from '../TrackerDuplicateStrip';
import type { DuplicateMatch } from '../scoreTrackerDuplicates';

const bug: TrackerDataModel = {
  type: 'qci18n-bug',
  displayName: 'Bug',
  displayNamePlural: 'Bugs',
  icon: 'bug_report',
  color: '#f00',
  modes: { inline: true, fullDocument: false },
  idPrefix: 'qib',
  idFormat: 'uuid',
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'status', type: 'select', default: 'to-do', options: [{ value: 'to-do', label: 'To Do' }] },
  ],
};

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const RAW_KEY = /quickCreate\.|common:/;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  globalRegistry.register(bug);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      documentService: {
        createTrackerItem: vi.fn().mockResolvedValue({ success: true, item: { id: 'created' } }),
        listPendingTrackerCreations: vi.fn().mockResolvedValue([]),
        getTrackerCreationStatus: vi.fn().mockResolvedValue(null),
      },
      semanticSearch: {
        isAvailable: vi.fn().mockResolvedValue(false),
        query: vi.fn().mockResolvedValue([]),
      },
      settingsGetAll: vi.fn().mockResolvedValue({}),
      settingsSet: vi.fn().mockResolvedValue(undefined),
      extensions: { setEnabled: vi.fn().mockResolvedValue(undefined) },
    },
  });
});

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  globalRegistry.unregister('qci18n-bug');
  await setLanguage('en');
});

async function openPopup() {
  const store = createStore();
  render(
    <Provider store={store}>
      <TrackerQuickCreatePopup workspacePath="/workspace" />
    </Provider>,
  );
  act(() => store.set(trackerQuickCreateRequestAtom, 1));
  return (await screen.findByTestId('tracker-quick-create-type-search')) as HTMLInputElement;
}

async function pickBug(search: HTMLInputElement) {
  fireEvent.change(search, { target: { value: 'qci18n-bug' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  return (await screen.findByTestId('tracker-quick-create-title')) as HTMLInputElement;
}

describe('TrackerQuickCreatePopup i18n', () => {
  it('keeps the original English copy', async () => {
    const search = await openPopup();
    expect(search.placeholder).toBe('What kind of item?');
    expect(document.body.textContent).toContain('Type to filter, Enter to pick');
    const title = await pickBug(search);
    expect(title.placeholder).toBe('Title');
    expect(screen.getByTestId('tracker-quick-create-submit').textContent).toBe('Add');
    expect(screen.getByTestId('tracker-quick-create-type-chip').textContent).toContain('Bug');
    expect(document.body.textContent).toContain('New');
  });

  it('renders pt-BR without raw keys and keeps the type name as defined', async () => {
    await setLanguage('pt-BR');
    const search = await openPopup();
    expect(search.placeholder).toBe('Que tipo de item?');
    expect(document.body.textContent).toContain('Digite para filtrar, Enter para escolher');
    expect(document.body.textContent).toContain('↑↓ para mover');
    const title = await pickBug(search);
    expect(title.placeholder).toBe('Título');
    expect(screen.getByTestId('tracker-quick-create-submit').textContent).toBe('Adicionar');
    // A tracker type's display name is user/schema data, not UI copy.
    expect(screen.getByTestId('tracker-quick-create-type-chip').textContent).toContain('Bug');
    expect(screen.getByTestId('tracker-quick-create-type-chip').getAttribute('title')).toMatch(/^Alterar tipo \((Cmd|Ctrl)\+T\)$/);
    expect(document.body.textContent).toContain('Novo');
    expect(document.body.textContent).toContain('Adicionar captura de tela');
    expect(document.body.textContent).not.toMatch(RAW_KEY);
  });
});

describe('TrackerDuplicateStrip i18n', () => {
  const match = (id: string): DuplicateMatch => ({
    entry: { id, type: 'qci18n-bug', title: `Item ${id}`, displayKey: 'QIB.1', keyIsShared: false, status: 'open' },
    arms: ['lexical'],
  } as unknown as DuplicateMatch);

  function renderStrip(matches: DuplicateMatch[]) {
    return render(
      <TrackerDuplicateStrip
        matches={matches}
        expanded
        onToggleExpanded={vi.fn()}
        activeIndex={-1}
        onOpenItem={vi.fn()}
        onHoverItem={vi.fn()}
      />,
    );
  }

  it('pluralizes the duplicate count in both languages', async () => {
    renderStrip([match('a')]);
    expect(document.body.textContent).toContain('1 possible duplicate');
    expect(screen.getByText('QIB.1').getAttribute('title')).toBe('Local number — not a shared issue key');
    cleanup();
    renderStrip([match('a'), match('b')]);
    expect(document.body.textContent).toContain('2 possible duplicates');
    cleanup();

    await setLanguage('pt-BR');
    renderStrip([match('a')]);
    expect(document.body.textContent).toContain('1 possível duplicata');
    // The stored status value is shown as is.
    expect(document.body.textContent).toContain('open');
    cleanup();
    renderStrip([match('a'), match('b')]);
    expect(document.body.textContent).toContain('2 possíveis duplicatas');
    expect(screen.getAllByText('QIB.1')[0].getAttribute('title')).toBe('Número local — não é uma chave de issue compartilhada');
  });
});
