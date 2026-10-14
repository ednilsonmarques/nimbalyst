// @vitest-environment jsdom
/**
 * Team view: each block is identified by its root, a Team mode root is a team
 * even when it works alone, and every card states role, model, effort, tool
 * scope and status from the session's own data.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('../../AgenticCoding/SessionListItem', () => ({ SessionStatusIndicator: () => null }));
vi.mock('../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  const flagAtom = atom(() => true);
  return { alphaFeatureEnabledAtom: () => flagAtom };
});

import { sessionProcessingAtom, sessionRegistryAtom } from '../../../store/atoms/sessions';
import { AgentTeamView } from '../AgentTeamView';
import { buildDelegationGroups } from '../../AgenticCoding/sessionTeamGroups';

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

const SESSIONS: SessionMeta[] = [
  session('root-a', { title: 'Sistema Construtivo 2.0 retomada', teamMode: true, model: 'claude-code:opus', effortLevel: 'high', updatedAt: 9_000 }),
  session('a-exp', { title: 'S2-0 análise', createdBySessionId: 'root-a', teamRole: 'explorer', effortLevel: 'medium', toolScope: 'read', createdAt: 10 }),
  session('a-impl', { title: 'S2-0 sondas', createdBySessionId: 'root-a', teamRole: 'implementer', effortLevel: 'medium', createdAt: 20 }),
  session('a-rev', { title: 'Revisão sondas', createdBySessionId: 'root-a', teamRole: 'reviewer', effortLevel: 'high', toolScope: 'review', teamMission: 'Validar a segurança do Tracker e questionar a arquitetura se necessário.', createdAt: 30 }),
  session('root-b', { title: 'Auditoria Mayer', teamMode: true, model: 'claude-code:fable', effortLevel: 'max', updatedAt: 5_000 }),
  session('b-exp', { title: 'Estrutura', createdBySessionId: 'root-b', teamRole: 'explorer', effortLevel: 'medium', toolScope: 'read', createdAt: 40 }),
  session('root-solo', { title: 'Mensagem de erro do subtotal', teamMode: true, model: 'claude-code:opus', effortLevel: 'high', updatedAt: 2_000 }),
  session('plain', { title: 'Sessão comum', updatedAt: 1_500 }),
];

let store: ReturnType<typeof createStore>;

function renderView() {
  store.set(sessionRegistryAtom, new Map(SESSIONS.map((s) => [s.id, s])));
  return render(
    <Provider store={store}>
      <I18nProvider>
        <AgentTeamView onSessionOpen={vi.fn()} />
      </I18nProvider>
    </Provider>,
  );
}

const header = (id: string) => within(screen.getByTestId(`agent-team-header-${id}`));
const node = (id: string) => screen.getByTestId(`agent-team-node-${id}`);

beforeEach(async () => {
  store = createStore();
  (window as unknown as { electronAPI: unknown }).electronAPI = { invoke: vi.fn(async () => ({ success: true, worktrees: {} })) };
  await act(async () => {
    await setLanguage('pt-BR');
  });
});

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('Team view identity', () => {
  it('heads each block with the root title, the team size, active members and the root model/effort', () => {
    store.set(sessionProcessingAtom('a-impl'), true);
    store.set(sessionProcessingAtom('a-rev'), true);
    renderView();

    expect(header('root-a').getByTestId('agent-team-header-title').textContent).toBe('Sistema Construtivo 2.0 retomada');
    expect(header('root-a').getByTestId('team-summary-line').textContent).toBe(
      'Equipe • 3 membros • 2 ativos • 1 Explorer • 1 Implementer • 1 Reviewer • opus/high',
    );
    // The plain agent count stays, as a detail.
    expect(header('root-a').getByText('Agentes: 4')).toBeTruthy();

    expect(header('root-b').getByTestId('agent-team-header-title').textContent).toBe('Auditoria Mayer');
    expect(header('root-b').getByTestId('team-summary-line').textContent).toBe('Equipe • 1 membro • 1 Explorer • fable/max');
  });

  it('a Team mode root without members is a team marked Solo, not a standalone session', () => {
    renderView();
    const line = header('root-solo').getByTestId('team-summary-line');
    expect(line.textContent).toBe('Equipe • Solo • opus/high');
    expect(line.getAttribute('data-team-kind')).toBe('solo');

    const standalone = within(screen.getByTestId('agent-team-standalone'));
    expect(standalone.queryByTestId('agent-team-node-root-solo')).toBeNull();
    expect(standalone.getByTestId('agent-team-node-plain')).toBeTruthy();
    expect(screen.getByText('Equipes (3)')).toBeTruthy();
  });

  it('orders the teams by their most recent activity', () => {
    renderView();
    const order = screen.getAllByTestId('agent-team-header-title').map((el) => el.textContent);
    expect(order).toEqual(['Sistema Construtivo 2.0 retomada', 'Auditoria Mayer', 'Mensagem de erro do subtotal']);
  });

  it('states role, model, effort, tool scope and status on every member card', () => {
    store.set(sessionProcessingAtom('a-rev'), true);
    renderView();

    const reviewer = within(node('a-rev'));
    expect(reviewer.getByTestId('agent-team-node-role').textContent).toBe('Reviewer');
    expect(reviewer.getByText('sonnet')).toBeTruthy();
    expect(reviewer.getByTestId('agent-team-node-effort').textContent).toBe('high');
    expect(reviewer.getByTestId('agent-team-node-scope').textContent).toBe('revisão');
    expect(reviewer.getByTestId('agent-team-node-scope').getAttribute('title')).toBe('Escopo de ferramentas: revisão');
    expect(node('a-rev').getAttribute('data-status')).toBe('running');
    expect(reviewer.getByText('Em execução')).toBeTruthy();
    // The mission (teamChild.mission) is one line under the identity, whole in the tooltip, in Portuguese.
    const mission = reviewer.getByTestId('agent-team-node-mission');
    expect(mission.textContent).toBe('Validar a segurança do Tracker e questionar a arquitetura se necessário.');
    expect(mission.getAttribute('title')).toBe('Missão: Validar a segurança do Tracker e questionar a arquitetura se necessário.');

    const explorer = within(node('a-exp'));
    expect(explorer.getByTestId('agent-team-node-role').textContent).toBe('Explorer');
    expect(explorer.getByTestId('agent-team-node-scope').textContent).toBe('somente leitura');
    expect(node('a-exp').getAttribute('data-status')).toBe('idle');
    // A member without a mission shows no mission line; a root never does.
    expect(explorer.queryByTestId('agent-team-node-mission')).toBeNull();
    expect(within(node('root-a')).queryByTestId('agent-team-node-mission')).toBeNull();

    // No stored scope on a member means full tools.
    const implementer = within(node('a-impl'));
    expect(implementer.getByTestId('agent-team-node-role').textContent).toBe('Implementer');
    expect(implementer.getByTestId('agent-team-node-scope').textContent).toBe('todas as ferramentas');
  });

  it('takes the role from the session data, never from its title', () => {
    // Title says "Revisão", data says implementer.
    SESSIONS.push(session('a-odd', { title: 'Revisão do reviewer', createdBySessionId: 'root-a', teamRole: 'implementer', createdAt: 35 }));
    try {
      renderView();
      expect(within(node('a-odd')).getByTestId('agent-team-node-role').textContent).toBe('Implementer');
    } finally {
      SESSIONS.pop();
    }
  });

  it('draws the root apart from its members: coordinator role and its own frame', () => {
    renderView();
    const root = node('root-a');
    expect(within(root).getByTestId('agent-team-node-role').textContent).toBe('Coordenador');
    expect(root.getAttribute('data-team-role')).toBe('coordinator');
    expect(root.className).toContain('border-2');
    expect(node('a-exp').className).not.toContain('border-2');
    // A normal session carries no role, effort or scope.
    expect(within(node('plain')).queryByTestId('agent-team-node-role')).toBeNull();
    expect(within(node('plain')).queryByTestId('agent-team-node-scope')).toBeNull();
  });

  it('groups exactly the sessions the sidebar groups', () => {
    renderView();
    const sidebar = buildDelegationGroups(SESSIONS, { metaAgentEnabled: false });
    for (const group of sidebar.groups) {
      const block = within(screen.getByTestId(`agent-team-tree-${group.root.id}`));
      for (const member of group.members) {
        expect(block.getByTestId(`agent-team-node-${member.id}`)).toBeTruthy();
      }
      expect(block.getAllByTestId(/^agent-team-node-(?!role|effort|scope|mission)/)).toHaveLength(group.members.length + 1);
    }
  });
});
