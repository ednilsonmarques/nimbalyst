// @vitest-environment jsdom
/**
 * The Office is an alternative presentation of the Team view: same forest,
 * live state from the existing per-session atoms, and the caller's select
 * action as its only interaction. The Tree stays the default.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

const teamFlag = vi.hoisted(() => ({ enabled: true }));

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('../../../AgenticCoding/SessionListItem', () => ({ SessionStatusIndicator: () => null }));
vi.mock('../../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  const flagAtom = atom(() => teamFlag.enabled);
  return { alphaFeatureEnabledAtom: () => flagAtom };
});

import {
  activeSessionIdAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionPendingPromptsAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
  type PendingPrompt,
} from '../../../../store/atoms/sessions';
import { sessionErrorAtom } from '../../../../store/atoms/sessionTranscript';
import { AgentTeamView } from '../../AgentTeamView';

const RAW_KEY = /\bagentTeam\.[\w.]+/;

function session(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    provider: 'claude-code',
    model: 'claude-code:sonnet',
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

function pending(sessionId: string, promptType: PendingPrompt['promptType']): PendingPrompt {
  return { id: `${sessionId}-${promptType}`, sessionId, promptType, promptId: 'p1', data: {}, createdAt: 1 } as PendingPrompt;
}

let store: ReturnType<typeof createStore>;
let invoke: ReturnType<typeof vi.fn>;

function seedTeam() {
  store.set(
    sessionRegistryAtom,
    new Map(
      [
        session('lead', { teamMode: true, title: 'Coordenação', provider: 'claude-code', model: 'claude-code:opus' }),
        session('exp', { createdBySessionId: 'lead', teamRole: 'explorer', title: 'Explorer', createdAt: 2_000 }),
        session('rev', { createdBySessionId: 'lead', teamRole: 'reviewer', title: 'Reviewer', createdAt: 3_000 }),
        session('adv', {
          createdBySessionId: 'lead',
          teamRole: 'advisor',
          title: 'Consultor',
          provider: 'openai-codex',
          model: 'openai-codex:gpt-6.1-sol',
          createdAt: 4_000,
        }),
        session('solta', { title: 'Sessão solta' }),
      ].map((s) => [s.id, s]),
    ),
  );
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

function openOffice() {
  fireEvent.click(screen.getByTestId('agent-team-presentation-office'));
}

beforeEach(async () => {
  store = createStore();
  teamFlag.enabled = true;
  invoke = vi.fn(async () => ({ success: true, worktrees: {} }));
  // Only invoke exists: any other bridge call from the Office would throw.
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke };
  await act(async () => {
    await setLanguage('pt-BR');
  });
});

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('Office presentation of the Team view', () => {
  it('starts on the Tree, switches to the Office and back without losing the Tree', () => {
    seedTeam();
    renderView();
    expect(screen.getByTestId('agent-team-tree-lead')).toBeTruthy();
    expect(screen.queryByTestId('office-view')).toBeNull();
    expect(screen.getByTestId('agent-team-presentation-tree').getAttribute('aria-pressed')).toBe('true');

    openOffice();
    expect(screen.getByTestId('office-view')).toBeTruthy();
    expect(screen.queryByTestId('agent-team-tree-lead')).toBeNull();
    const room = screen.getByTestId('office-room-lead');
    for (const id of ['lead', 'exp', 'rev', 'adv']) {
      expect(within(room).getByTestId(`office-desk-${id}`)).toBeTruthy();
    }
    expect(screen.queryByTestId('office-desk-solta')).toBeNull();
    expect(screen.getByTestId('office-standalone-note').textContent).toBe('1 sessão avulsa aparece só na Árvore.');

    fireEvent.click(screen.getByTestId('agent-team-presentation-tree'));
    expect(screen.getByTestId('agent-team-tree-lead')).toBeTruthy();
    expect(screen.getByTestId('agent-team-standalone').textContent).toContain('Sessão solta');
  });

  it('shows role, provider and model from the session and no raw keys', () => {
    seedTeam();
    renderView();
    openOffice();
    const lead = screen.getByTestId('office-desk-lead');
    expect(lead.getAttribute('data-role')).toBe('coordinator');
    expect(lead.textContent).toContain('Coordenador');
    const advisor = screen.getByTestId('office-desk-adv');
    expect(advisor.getAttribute('data-role')).toBe('advisor');
    expect(advisor.textContent).toContain('Consultor Independente');
    expect(advisor.textContent).toContain('gpt-6.1-sol');
    expect(screen.getByTestId('office-view').textContent).not.toMatch(RAW_KEY);
  });

  it('derives principal state and the waiting marker from the existing atoms, live', () => {
    seedTeam();
    store.set(sessionProcessingAtom('exp'), true);
    store.set(sessionHasPendingInteractivePromptAtom('rev'), true);
    store.set(sessionPendingPromptsAtom('rev'), [pending('rev', 'permission_request')]);
    store.set(sessionErrorAtom('adv'), { message: 'boom' });
    renderView();
    openOffice();

    expect(screen.getByTestId('office-desk-exp').getAttribute('data-principal')).toBe('working');
    expect(screen.getByTestId('office-desk-rev').getAttribute('data-principal')).toBe('idle');
    expect(screen.getByTestId('office-desk-rev').getAttribute('data-waiting-user')).toBe('permission');
    expect(screen.getByTestId('office-desk-adv').getAttribute('data-principal')).toBe('error');
    // Members working do not make the coordinator "wait for" them.
    expect(screen.getByTestId('office-desk-lead').getAttribute('data-principal')).toBe('idle');
    expect(screen.getByTestId('office-desk-lead').getAttribute('data-waiting-user')).toBeNull();

    const attention = screen.getByTestId('office-attention');
    expect(attention.textContent).toContain('Precisa de você (2)');
    expect(within(attention).getByTestId('office-attention-rev').textContent).toContain('pedido de permissão');
    expect(within(attention).getByTestId('office-attention-adv').textContent).toContain('Erro não visto');
    expect(screen.getByTestId('office-room-summary').textContent).toBe('1 trabalhando · 1 aguardando você · 1 com erro não visto');

    act(() => {
      store.set(sessionProcessingAtom('exp'), false);
      store.set(sessionHasPendingInteractivePromptAtom('rev'), false);
      store.set(sessionErrorAtom('adv'), null);
    });
    expect(screen.getByTestId('office-desk-exp').getAttribute('data-principal')).toBe('idle');
    expect(screen.getByTestId('office-desk-rev').getAttribute('data-waiting-user')).toBeNull();
    expect(screen.getByTestId('office-attention-none').textContent).toContain('Nada precisa de você agora.');
  });

  it('keeps the principal state visible next to the waiting marker', () => {
    seedTeam();
    store.set(sessionProcessingAtom('exp'), true);
    store.set(sessionHasPendingInteractivePromptAtom('exp'), true);
    renderView();
    openOffice();
    const desk = screen.getByTestId('office-desk-exp');
    expect(desk.getAttribute('data-principal')).toBe('working');
    expect(desk.getAttribute('data-waiting-user')).toBe('unknown');
    // Same principal state, worded so it is not read as active work.
    expect(within(desk).getByTestId('office-desk-state').textContent).toBe('Turno aberto, parado em você');
    expect(within(desk).getByTestId('office-desk-waiting').textContent).toContain('Aguardando você');
    expect(screen.getByTestId('office-room-summary').textContent).toBe('0 trabalhando · 1 aguardando você');
  });

  it('shows the stored mission on the desk, clamped, with the whole text in the tooltip', () => {
    seedTeam();
    const long = 'Mapear todas as fontes de dados nativas do Team Mode e relatar riscos adjacentes '.repeat(4).trim();
    store.set(
      sessionRegistryAtom,
      new Map([...store.get(sessionRegistryAtom)].map(([id, s]) => [id, id === 'exp' ? { ...s, teamMission: long } : s])),
    );
    store.set(sessionProcessingAtom('exp'), true);
    renderView();
    openOffice();
    const desk = screen.getByTestId('office-desk-exp');
    const mission = within(desk).getByTestId('office-desk-mission');
    expect(mission.textContent).toBe(long);
    expect(mission.className).toContain('line-clamp-2');
    expect(mission.getAttribute('title')).toBe(`Missão: ${long}`);
    // The mission does not touch state, markers or the click.
    expect(desk.getAttribute('data-principal')).toBe('working');
    expect(desk.getAttribute('data-waiting-user')).toBeNull();
  });

  it('omits the mission line when the session has none', () => {
    seedTeam();
    renderView();
    openOffice();
    for (const id of ['lead', 'exp', 'rev', 'adv']) {
      expect(within(screen.getByTestId(`office-desk-${id}`)).queryByTestId('office-desk-mission')).toBeNull();
    }
  });

  it('keeps the click unchanged on a desk with a mission', () => {
    seedTeam();
    store.set(
      sessionRegistryAtom,
      new Map([...store.get(sessionRegistryAtom)].map(([id, s]) => [id, id === 'rev' ? { ...s, teamMission: 'Revisar a POC' } : s])),
    );
    const { onSessionOpen } = renderView();
    openOffice();
    fireEvent.click(within(screen.getByTestId('office-desk-rev')).getByTestId('office-desk-mission'));
    expect(onSessionOpen).toHaveBeenCalledTimes(1);
    expect(onSessionOpen).toHaveBeenLastCalledWith('rev');
  });

  it('marks the session open in the panel from activeSessionIdAtom', () => {
    seedTeam();
    store.set(activeSessionIdAtom, 'rev');
    renderView();
    openOffice();
    expect(screen.getByTestId('office-desk-rev').getAttribute('data-active-session')).toBe('true');
    expect(screen.getByTestId('office-desk-rev').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('office-desk-exp').getAttribute('data-active-session')).toBeNull();
    expect(screen.getByTestId('office-desk-exp').getAttribute('aria-current')).toBeNull();
  });

  it('keeps the active-session highlight when the same desk waits for the user', () => {
    seedTeam();
    store.set(activeSessionIdAtom, 'exp');
    store.set(sessionProcessingAtom('exp'), true);
    store.set(sessionHasPendingInteractivePromptAtom('exp'), true);
    renderView();
    openOffice();
    const desk = screen.getByTestId('office-desk-exp');
    expect(desk.getAttribute('aria-current')).toBe('true');
    expect(desk.className).toContain('office-desk--active');
    expect(desk.getAttribute('data-waiting-user')).toBe('unknown');
    // Stopped on the user: the working dot does not pulse.
    expect(desk.querySelector('.office-state-dot--stopped')).not.toBeNull();
  });

  it('lists attention entries from several teams without collisions', () => {
    seedTeam();
    store.set(
      sessionRegistryAtom,
      new Map([
        ...store.get(sessionRegistryAtom),
        ['other', session('other', { teamMode: true, title: 'Outra equipe' })],
        ['o-rev', session('o-rev', { createdBySessionId: 'other', teamRole: 'reviewer', title: 'Reviewer B', createdAt: 5_000 })],
      ]),
    );
    store.set(sessionHasPendingInteractivePromptAtom('rev'), true);
    store.set(sessionErrorAtom('o-rev'), { message: 'x' });
    renderView();
    openOffice();
    const attention = screen.getByTestId('office-attention');
    expect(attention.textContent).toContain('Precisa de você (2)');
    expect(within(attention).getByTestId('office-attention-rev').textContent).toContain('Coordenação');
    expect(within(attention).getByTestId('office-attention-o-rev').textContent).toContain('Outra equipe');
    expect(screen.getAllByTestId(/^office-room-(?!summary)/).length).toBe(2);
  });

  it('shows a waiting marker next to an unseen error without hiding either', () => {
    seedTeam();
    store.set(sessionHasPendingInteractivePromptAtom('rev'), true);
    store.set(sessionErrorAtom('rev'), { message: 'x' });
    renderView();
    openOffice();
    const desk = screen.getByTestId('office-desk-rev');
    expect(desk.getAttribute('data-principal')).toBe('error');
    expect(desk.getAttribute('data-waiting-user')).toBe('unknown');
    expect(screen.getByTestId('office-room-summary').textContent).toBe('0 trabalhando · 1 aguardando você · 1 com erro não visto');
  });

  it('opens a session only on click, through the caller\'s existing select action', () => {
    seedTeam();
    store.set(sessionHasPendingInteractivePromptAtom('rev'), true);
    const { onSessionOpen } = renderView();
    openOffice();
    const desk = screen.getByTestId('office-desk-exp');
    fireEvent.mouseEnter(desk);
    fireEvent.mouseOver(desk);
    fireEvent.focus(desk);
    expect(onSessionOpen).not.toHaveBeenCalled();

    fireEvent.click(desk);
    expect(onSessionOpen).toHaveBeenCalledTimes(1);
    expect(onSessionOpen).toHaveBeenLastCalledWith('exp');

    fireEvent.click(screen.getByTestId('office-attention-rev'));
    expect(onSessionOpen).toHaveBeenCalledTimes(2);
    expect(onSessionOpen).toHaveBeenLastCalledWith('rev');
  });

  it('adds no IPC and no operational control', async () => {
    seedTeam();
    store.set(sessionHasPendingInteractivePromptAtom('rev'), true);
    renderView();
    const callsBefore = invoke.mock.calls.length;
    openOffice();
    // Let any late asynchronous call surface before counting.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const office = screen.getByTestId('office-view');
    // Every IPC call of the board is the Tree's existing worktree lookup; the Office adds none.
    for (const [channel] of invoke.mock.calls) expect(channel).toBe('worktree:get-batch');
    expect(invoke.mock.calls.length).toBe(callsBefore);
    expect(office.querySelector('iframe, webview, object, embed, form, input, textarea, select')).toBeNull();
    // Every button opens a session: one per desk plus one per attention entry (one here).
    const desks = office.querySelectorAll('[data-testid^="office-desk-"][data-principal]');
    const attentionEntries = office.querySelectorAll('[data-testid^="office-attention-"]:not([data-testid="office-attention-none"])');
    expect(attentionEntries.length).toBe(1);
    expect(office.querySelectorAll('button').length).toBe(desks.length + attentionEntries.length);
  });

  it('renders the English copy with no raw keys', async () => {
    await act(async () => {
      await setLanguage('en');
    });
    seedTeam();
    store.set(sessionProcessingAtom('exp'), true);
    renderView();
    openOffice();
    const text = screen.getByTestId('office-view').textContent ?? '';
    expect(text).toContain('Nothing needs you right now.');
    expect(text).toContain('Working');
    expect(text).not.toMatch(RAW_KEY);
  });

  it('shows the empty-teams hint when there is no team', () => {
    store.set(sessionRegistryAtom, new Map([['solo', session('solo')]]));
    renderView();
    openOffice();
    expect(screen.getByTestId('office-empty').textContent).toContain('Nenhuma equipe ainda');
  });
});
