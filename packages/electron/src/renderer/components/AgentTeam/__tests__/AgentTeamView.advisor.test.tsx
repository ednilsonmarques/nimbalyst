// @vitest-environment jsdom
/**
 * Team view and the `advisor` member: the card reads "Consultor Independente ·
 * <model> · high · somente leitura" in pt-BR ("Independent Advisor" in en),
 * the mission line uses the existing mission infrastructure, and the team
 * summary counts the role. Mocks mirror AgentTeamView.identity.test.tsx.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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

import { sessionRegistryAtom } from '../../../store/atoms/sessions';
import { AgentTeamView } from '../AgentTeamView';
import { TEAM_MEMBER_ROLES, summarizeTeam, teamMemberRole } from '../teamMembership';

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

const ADVISOR_MISSION = 'Leia o manifesto, a implementação e o parecer do Revisor e tente provar que a conclusão está errada.';
const SESSIONS: SessionMeta[] = [
  session('root-a', { title: 'Persistência do Tracker', teamMode: true, model: 'claude-code:opus', effortLevel: 'high', updatedAt: 9_000 }),
  session('a-rev', { title: 'Revisão', createdBySessionId: 'root-a', teamRole: 'reviewer', effortLevel: 'high', toolScope: 'review', createdAt: 20 }),
  session('a-adv', { title: 'Segunda opinião', createdBySessionId: 'root-a', teamRole: 'advisor', model: 'claude-code:opus', effortLevel: 'high', toolScope: 'read', teamMission: ADVISOR_MISSION, createdAt: 30 }),
  session('a-adv2', { title: 'Consultor sem missão', createdBySessionId: 'root-a', teamRole: 'advisor', model: 'claude-code:opus', effortLevel: 'high', toolScope: 'read', createdAt: 40 }),
];

let store: ReturnType<typeof createStore>;

function renderView() {
  return render(
    <Provider store={store}>
      <I18nProvider>
        <AgentTeamView onSessionOpen={() => undefined} />
      </I18nProvider>
    </Provider>,
  );
}

const node = (id: string) => screen.getByTestId(`agent-team-node-${id}`);

beforeEach(async () => {
  await setLanguage('pt-BR');
  store = createStore();
  store.set(sessionRegistryAtom, new Map(SESSIONS.map((s) => [s.id, s])));
});

afterEach(() => {
  cleanup();
});

describe('Team view: the independent advisor', () => {
  it('reads "Consultor Independente · opus · high · somente leitura" with the mission flag line', () => {
    renderView();
    const advisor = within(node('a-adv'));
    expect(advisor.getByTestId('agent-team-node-role').textContent).toBe('Consultor Independente');
    expect(advisor.getByText('opus')).toBeTruthy();
    expect(advisor.getByTestId('agent-team-node-effort').textContent).toBe('high');
    expect(advisor.getByTestId('agent-team-node-scope').textContent).toBe('somente leitura');
    expect(advisor.getByTestId('agent-team-node-scope').getAttribute('title')).toBe('Escopo de ferramentas: somente leitura');
    expect(node('a-adv').getAttribute('data-team-role')).toBe('advisor');
    const mission = advisor.getByTestId('agent-team-node-mission');
    expect(mission.textContent).toBe(ADVISOR_MISSION);
    expect(mission.getAttribute('title')).toBe(`Missão: ${ADVISOR_MISSION}`);
    // A reviewer on the same team stays a reviewer, with its own label.
    expect(within(node('a-rev')).getByTestId('agent-team-node-role').textContent).toBe('Reviewer');
  });

  it('an advisor without a mission shows no mission line and is otherwise the same card', () => {
    renderView();
    const advisor = within(node('a-adv2'));
    expect(advisor.getByTestId('agent-team-node-role').textContent).toBe('Consultor Independente');
    expect(advisor.queryByTestId('agent-team-node-mission')).toBeNull();
    expect(advisor.getByTestId('agent-team-node-scope').textContent).toBe('somente leitura');
  });

  it('shows the provider only on a member whose provider differs from the coordinator\'s (provider diversity), never on a same-provider member or the root', async () => {
    const diverse: SessionMeta[] = [
      ...SESSIONS,
      session('root-b', { title: 'Migração', teamMode: true, model: 'claude-code:opus', effortLevel: 'high', updatedAt: 8_000 }),
      session('b-adv', { title: 'Segunda opinião em outro provider', createdBySessionId: 'root-b', teamRole: 'advisor', provider: 'openai-codex', model: 'openai-codex:gpt-5.5', effortLevel: 'high', toolScope: 'read', createdAt: 50 }),
    ];
    store.set(sessionRegistryAtom, new Map(diverse.map((s) => [s.id, s])));
    renderView();
    const advisor = within(node('b-adv'));
    expect(advisor.getByTestId('agent-team-node-role').textContent).toBe('Consultor Independente');
    const provider = advisor.getByTestId('agent-team-node-provider');
    expect(provider.textContent).toBe('OpenAI Codex');
    expect(provider.getAttribute('title')).toBe('Provedor diferente do Coordenador: OpenAI Codex');
    // The rest of the card is the same role, scope and effort: the provider changes nothing else.
    expect(advisor.getByTestId('agent-team-node-scope').textContent).toBe('somente leitura');
    expect(advisor.getByTestId('agent-team-node-effort').textContent).toBe('high');
    // Same provider as the root: no provider shown; the root never shows one.
    expect(within(node('a-adv')).queryByTestId('agent-team-node-provider')).toBeNull();
    expect(within(node('root-a')).queryByTestId('agent-team-node-provider')).toBeNull();
    expect(within(node('root-b')).queryByTestId('agent-team-node-provider')).toBeNull();

    await setLanguage('en');
    cleanup();
    renderView();
    expect(within(node('b-adv')).getByTestId('agent-team-node-provider').getAttribute('title')).toBe('Provider other than the coordinator\'s: OpenAI Codex');
  });

  it('the team header counts the advisors by role, in Portuguese', () => {
    renderView();
    const header = screen.getByTestId('agent-team-header-root-a');
    expect(header.textContent).toContain('2 Consultor Independente');
    expect(header.textContent).toContain('1 Reviewer');
  });

  it('is labelled "Independent Advisor" in English', async () => {
    await setLanguage('en');
    renderView();
    expect(within(node('a-adv')).getByTestId('agent-team-node-role').textContent).toBe('Independent Advisor');
    expect(within(node('a-adv')).getByTestId('agent-team-node-scope').textContent).toBe('read-only');
    expect(screen.getByTestId('agent-team-header-root-a').textContent).toContain('2 Independent Advisor');
  });
});

describe('team membership: the advisor is a counted role', () => {
  it('is a member role, parsed from the session data, and summarized in role order', () => {
    expect(TEAM_MEMBER_ROLES).toContain('advisor');
    expect(teamMemberRole({ teamRole: 'advisor' })).toBe('advisor');
    expect(summarizeTeam(SESSIONS.slice(1))).toEqual({
      memberCount: 3,
      isSolo: false,
      roles: [
        { role: 'reviewer', count: 1 },
        { role: 'advisor', count: 2 },
      ],
    });
  });
});
