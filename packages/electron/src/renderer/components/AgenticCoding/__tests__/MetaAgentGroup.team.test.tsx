// @vitest-environment jsdom
/**
 * A Team mode root in the session sidebar: the existing delegation group, with
 * the team identity in its header and the role on each member row.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createStore, Provider } from 'jotai';
import type { SessionMeta } from '@nimbalyst/runtime';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon }: { icon: string }) => <i data-icon={icon} />,
}));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null }));
vi.mock('../SessionRelativeTime', () => ({ SessionRelativeTime: () => null }));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));

import { sessionProcessingAtom } from '../../../store/atoms/sessions';
import { MetaAgentGroup } from '../MetaAgentGroup';

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

const ROOT = session('root', { title: 'Sistema Construtivo 2.0 retomada', teamMode: true, model: 'claude-code:opus', effortLevel: 'high' });
const MEMBERS = [
  session('exp', { title: 'auditoria estrutura', createdBySessionId: 'root', teamRole: 'explorer' }),
  session('impl', { title: 'harness', createdBySessionId: 'root', teamRole: 'implementer' }),
  session('rev', { title: 'revisão final', createdBySessionId: 'root', teamRole: 'reviewer' }),
];

let store: ReturnType<typeof createStore>;

function renderGroup(props: Partial<React.ComponentProps<typeof MetaAgentGroup>> = {}) {
  const onSessionSelect = vi.fn();
  const onToggle = vi.fn();
  render(
    <Provider store={store}>
      <I18nProvider>
        <MetaAgentGroup
          metaSession={ROOT}
          childSessions={MEMBERS}
          isExpanded
          isActive={false}
          onToggle={onToggle}
          activeSessionId={null}
          onSessionSelect={onSessionSelect}
          {...props}
        />
      </I18nProvider>
    </Provider>,
  );
  return { onSessionSelect, onToggle };
}

beforeEach(async () => {
  store = createStore();
  await act(async () => {
    await setLanguage('pt-BR');
  });
});

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('MetaAgentGroup for a Team mode root', () => {
  it('names the team by its root and states members and active members', () => {
    store.set(sessionProcessingAtom('exp'), true);
    store.set(sessionProcessingAtom('impl'), true);
    renderGroup();
    const header = screen.getByTestId('meta-agent-group-header');
    expect(within(header).getByText('Sistema Construtivo 2.0 retomada')).toBeTruthy();
    expect(within(header).getByTestId('team-summary-line').textContent).toBe('Equipe • 3 membros • 2 ativos');
    expect(screen.getByTestId('meta-agent-group').getAttribute('data-group-kind')).toBe('team');
  });

  it('shows each member as a real row with its role', () => {
    renderGroup();
    const rows = within(screen.getByTestId('meta-agent-children'));
    expect(rows.getAllByTestId('team-member-role').map((el) => el.textContent)).toEqual(['Explorer', 'Implementer', 'Reviewer']);
    expect(rows.getByText('auditoria estrutura')).toBeTruthy();
    expect(rows.getByText('revisão final')).toBeTruthy();
  });

  it('a root without members reads "Equipe • Solo"', () => {
    renderGroup({ childSessions: [] });
    const line = screen.getByTestId('team-summary-line');
    expect(line.textContent).toBe('Equipe • Solo');
    expect(line.getAttribute('data-team-kind')).toBe('solo');
    expect(screen.queryByTestId('meta-agent-children')).toBeNull();
  });

  it('clicking the root opens the root; clicking a member opens that member', () => {
    const { onSessionSelect } = renderGroup();
    fireEvent.click(screen.getByText('Sistema Construtivo 2.0 retomada'));
    expect(onSessionSelect.mock.calls.at(-1)![0]).toBe('root');
    fireEvent.click(screen.getByText('harness'));
    expect(onSessionSelect.mock.calls.at(-1)![0]).toBe('impl');
  });

  it('collapses and expands through the chevron without selecting anything', () => {
    const { onSessionSelect, onToggle } = renderGroup({ isExpanded: false });
    expect(screen.queryByTestId('meta-agent-children')).toBeNull();
    // Still says how many members are inside while collapsed.
    expect(screen.getByTestId('team-summary-line').textContent).toBe('Equipe • 3 membros');
    fireEvent.click(screen.getByLabelText('Expandir'));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSessionSelect).not.toHaveBeenCalled();
  });

  it('a meta-agent group is unchanged: no team line, no role labels', () => {
    renderGroup({
      metaSession: session('meta', { title: 'Meta', agentRole: 'meta-agent' }),
      childSessions: [session('child', { createdBySessionId: 'meta' })],
    });
    expect(screen.queryByTestId('team-summary-line')).toBeNull();
    expect(screen.queryByTestId('team-member-role')).toBeNull();
    expect(screen.getByTestId('meta-agent-group').getAttribute('data-group-kind')).toBe('metaAgent');
  });

  it('while a search narrows the rows, the summary still counts the whole team', () => {
    renderGroup({ childSessions: [MEMBERS[2]], summaryMembers: MEMBERS });
    expect(screen.getByTestId('team-summary-line').textContent).toBe('Equipe • 3 membros');
    expect(screen.getAllByTestId('team-member-role').map((el) => el.textContent)).toEqual(['Reviewer']);
  });

  it('a Solo root has no visible chevron, since there is nothing to expand', () => {
    renderGroup({ childSessions: [] });
    expect(screen.getByLabelText('Recolher').className).toContain('invisible');
    cleanup();
    renderGroup();
    expect(screen.getByLabelText('Recolher').className).not.toContain('invisible');
  });

  it('reads in English too', async () => {
    await act(async () => {
      await setLanguage('en');
    });
    renderGroup();
    expect(screen.getByTestId('team-summary-line').textContent).toBe('Team • 3 members');
  });
});

describe('MetaAgentGroup member row tooltip (NIB.102)', () => {
  const row = (role: string) => document.querySelector(`[data-team-role="${role}"]`) as HTMLElement;

  it('the native title is the full title plus the mission line when the member has a mission', () => {
    const long = 'Corrigir a validação do fluxo de supersedes no Tool Manifest e cobrir os casos de borda';
    renderGroup({
      childSessions: [session('impl', { title: long, createdBySessionId: 'root', teamRole: 'implementer', teamMission: 'Fix only the validation of the supersedes relationship.' })],
    });
    expect(row('implementer').getAttribute('title')).toBe(`${long}\nMissão: Fix only the validation of the supersedes relationship.`);
  });

  it('a member without a mission gets the title alone', () => {
    renderGroup();
    expect(row('explorer').getAttribute('title')).toBe('auditoria estrutura');
  });

  it('follows the title live when the member is retitled', () => {
    const member = (title: string) => session('impl', { title, createdBySessionId: 'root', teamRole: 'implementer', teamMission: 'Mission text.' });
    const tree = (title: string) => (
      <Provider store={store}>
        <I18nProvider>
          <MetaAgentGroup metaSession={ROOT} childSessions={[member(title)]} isExpanded isActive={false} onToggle={vi.fn()} activeSessionId={null} onSessionSelect={vi.fn()} />
        </I18nProvider>
      </Provider>
    );
    const { rerender } = render(tree('Primeira tarefa'));
    expect(row('implementer').getAttribute('title')).toBe('Primeira tarefa\nMissão: Mission text.');
    rerender(tree('Segunda tarefa'));
    expect(row('implementer').getAttribute('title')).toBe('Segunda tarefa\nMissão: Mission text.');
  });
});
