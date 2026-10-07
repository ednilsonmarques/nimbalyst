// @vitest-environment jsdom
/**
 * The Team view is a read-only projection: it draws delegation trees from the
 * session registry, shows live status from the per-session atoms, and hands
 * clicks to the caller's select action.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

const teamFlag = vi.hoisted(() => ({ enabled: true }));

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('../../AgenticCoding/SessionListItem', () => ({ SessionStatusIndicator: () => null }));
vi.mock('../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  const flagAtom = atom(() => teamFlag.enabled);
  return { alphaFeatureEnabledAtom: () => flagAtom };
});

import {
  sessionHasPendingInteractivePromptAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  sessionWakeupAtom,
} from '../../../store/atoms/sessions';
import { AgentTeamView } from '../AgentTeamView';

const RAW_KEY = /\bagentTeam\.[\w.]+/;

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    model: 'claude-code:opus',
    sessionType: 'session',
    workspaceId: '/project',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...overrides,
  };
}

let store: ReturnType<typeof createStore>;
let invoke: ReturnType<typeof vi.fn>;

function seed(sessions: SessionMeta[]) {
  store.set(sessionRegistryAtom, new Map(sessions.map((s) => [s.id, s])));
}

function renderView(onSessionOpen = vi.fn()) {
  const view = render(
    <Provider store={store}>
      <I18nProvider>
        <AgentTeamView onSessionOpen={onSessionOpen} />
      </I18nProvider>
    </Provider>,
  );
  return { ...view, onSessionOpen };
}

beforeEach(async () => {
  store = createStore();
  teamFlag.enabled = true;
  invoke = vi.fn(async () => ({ success: true, worktrees: {} }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
  await act(async () => {
    await setLanguage('pt-BR');
  });
});

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('AgentTeamView', () => {
  it('renders nothing while the alpha flag is off', () => {
    teamFlag.enabled = false;
    seed([session('a')]);
    const { container } = renderView();
    expect(container.innerHTML).toBe('');
  });

  it('draws teams from createdBySessionId and lists unrelated sessions under Avulsas', () => {
    seed([
      session('arquiteto', { agentRole: 'meta-agent', title: 'Arquiteto' }),
      session('explorer', { createdBySessionId: 'arquiteto', title: 'Explorer SQL', createdAt: 2_000 }),
      session('revisor', { createdBySessionId: 'arquiteto', title: 'Revisor', createdAt: 3_000 }),
      session('solta', { title: 'Sessão solta' }),
    ]);
    renderView();

    const tree = screen.getByTestId('agent-team-tree-arquiteto');
    expect(tree.textContent).toContain('Arquiteto');
    expect(tree.textContent).toContain('Explorer SQL');
    expect(tree.textContent).toContain('Revisor');
    expect(tree.textContent).toContain('Meta-agente');
    expect(tree.textContent).toContain('Agentes: 3');
    expect(tree.textContent).toContain('opus');

    const standalone = screen.getByTestId('agent-team-standalone');
    expect(standalone.textContent).toContain('Avulsas (1)');
    expect(standalone.textContent).toContain('Sessão solta');
    expect(standalone.textContent).not.toContain('Explorer SQL');
    expect(screen.getByTestId('agent-team-view').textContent).not.toMatch(RAW_KEY);
  });

  it('renders the English copy with no raw keys', async () => {
    await act(async () => {
      await setLanguage('en');
    });
    seed([session('lead', { title: 'Lead' }), session('worker', { createdBySessionId: 'lead' }), session('alone')]);
    renderView();
    const text = screen.getByTestId('agent-team-view').textContent ?? '';
    expect(text).toContain('Teams (1)');
    expect(text).toContain('Standalone (1)');
    expect(text).toContain('Agents: 2');
    expect(text).not.toMatch(RAW_KEY);
  });

  it('shows the empty-teams hint but keeps standalone sessions visible', () => {
    seed([session('a', { title: 'Só eu' })]);
    renderView();
    expect(screen.getByTestId('agent-team-empty-teams').textContent).toContain('Nenhuma equipe ainda');
    expect(screen.getByTestId('agent-team-standalone').textContent).toContain('Só eu');
  });

  it('marks a delegated session whose creator is outside the view', () => {
    seed([session('orphan', { createdBySessionId: 'archived-parent', title: 'Órfã' })]);
    renderView();
    expect(screen.getByTestId('agent-team-node-orphan').textContent).toContain('Criada por uma sessão fora desta visualização');
  });

  it('caps Avulsas at 24 and toggles the rest', () => {
    seed(Array.from({ length: 26 }, (_, i) => session(`s${i}`, { updatedAt: i })));
    renderView();
    const standalone = () => screen.getByTestId('agent-team-standalone');
    expect(standalone().querySelectorAll('[data-testid^="agent-team-node-"]')).toHaveLength(24);
    fireEvent.click(screen.getByTestId('agent-team-standalone-toggle'));
    expect(standalone().querySelectorAll('[data-testid^="agent-team-node-"]')).toHaveLength(26);
    expect(screen.getByTestId('agent-team-standalone-toggle').textContent).toBe('Mostrar menos');
  });

  it('reflects live status from the same atoms as the status icon', () => {
    seed([session('lead'), session('worker', { createdBySessionId: 'lead' })]);
    renderView();
    const worker = screen.getByTestId('agent-team-node-worker');
    expect(worker.getAttribute('data-status')).toBe('idle');
    expect(worker.textContent).toContain('Ociosa');

    act(() => store.set(sessionWakeupAtom('worker'), { status: 'pending', fireAt: Date.now() + 60_000 } as never));
    expect(worker.getAttribute('data-status')).toBe('scheduled');
    expect(worker.textContent).toContain('Despertar agendado');

    act(() => store.set(sessionProcessingAtom('worker'), true));
    expect(worker.getAttribute('data-status')).toBe('running');
    expect(worker.textContent).toContain('Em execução');

    act(() => store.set(sessionHasPendingInteractivePromptAtom('worker'), true));
    expect(worker.getAttribute('data-status')).toBe('awaitingYou');
    expect(worker.textContent).toContain('Aguardando você');
  });

  it('keeps the card content as its accessible name', () => {
    seed([session('lead'), session('worker', { createdBySessionId: 'lead', title: 'Implementador' })]);
    renderView();
    const node = screen.getByTestId('agent-team-node-worker');
    expect(node.getAttribute('aria-label')).toBeNull();
    expect(node.getAttribute('title')).toBe('Abrir a sessão: Implementador');
  });

  it('opens the real session on click', () => {
    seed([session('lead'), session('worker', { createdBySessionId: 'lead' })]);
    const { onSessionOpen } = renderView();
    fireEvent.click(screen.getByTestId('agent-team-node-worker'));
    expect(onSessionOpen).toHaveBeenCalledWith('worker');
  });

  it('shows the worktree branch and only fetches worktrees it has not seen', async () => {
    invoke.mockImplementation(async (_channel: string, ids: string[]) => ({
      success: true,
      worktrees: Object.fromEntries(ids.map((id) => [id, { id, name: id, branch: `worktree/${id}` }])),
    }));
    seed([session('lead'), session('worker', { createdBySessionId: 'lead', worktreeId: 'wt-1' })]);
    renderView();
    await waitFor(() => {
      expect(screen.getByTestId('agent-team-node-worker').textContent).toContain('worktree/wt-1');
    });
    expect(invoke).toHaveBeenLastCalledWith('worktree:get-batch', ['wt-1']);

    act(() => seed([
      session('lead'),
      session('worker', { createdBySessionId: 'lead', worktreeId: 'wt-1' }),
      session('second', { createdBySessionId: 'lead', worktreeId: 'wt-2' }),
    ]));
    await waitFor(() => {
      expect(screen.getByTestId('agent-team-node-second').textContent).toContain('worktree/wt-2');
    });
    expect(invoke).toHaveBeenLastCalledWith('worktree:get-batch', ['wt-2']);
  });

  it('keeps rendering when the worktree lookup fails', async () => {
    invoke.mockRejectedValue(new Error('db down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    seed([session('lead'), session('worker', { createdBySessionId: 'lead', worktreeId: 'wt-1' })]);
    renderView();
    await waitFor(() => expect(consoleError).toHaveBeenCalled());
    expect(screen.getByTestId('agent-team-node-worker')).toBeTruthy();
    consoleError.mockRestore();
  });
});
