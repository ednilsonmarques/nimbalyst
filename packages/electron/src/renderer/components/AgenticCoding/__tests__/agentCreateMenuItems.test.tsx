/**
 * "Prepare with ECC Architect" lives in the "New" menu of Agent mode, with the
 * Team mode presets and behind the same alpha flag. It starts a Team mode root
 * through the existing create action, on the standard preset, with a
 * creation-only directive that tells the coordinator to begin with the
 * architect. The renderer creates no architect itself.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ECC_ARCHITECT_FIRST_DIRECTIVE, TEAM_ROOT_PRESETS, type TeamRootPreset } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { setLanguage, t as translate } from '@nimbalyst/runtime/i18n';
import { WindowTopBar } from '../../WindowTopBar/WindowTopBar';
import { buildAgentCreateMenuItems, type AgentCreateMenuFlags, type AgentCreateMenuHandlers } from '../agentCreateMenuItems';
import { ECC_ARCHITECT_MENU_TEST_ID, ECC_ARCHITECT_ROOT_PRESET, eccArchitectCreateOptions } from '../eccArchitectAction';

const tAgent = (key: string) => translate(`agent:${key}`);

const allOff: AgentCreateMenuFlags = {
  hasWorktreeOption: false,
  hasBlitzOption: false,
  hasTerminalOption: false,
  isSuperLoopsAvailable: false,
  isMetaAgentEnabled: false,
  isAgentTeamViewEnabled: false,
  isNotGitRepo: false,
};
const allOn: AgentCreateMenuFlags = {
  hasWorktreeOption: true,
  hasBlitzOption: true,
  hasTerminalOption: true,
  isSuperLoopsAvailable: true,
  isMetaAgentEnabled: true,
  isAgentTeamViewEnabled: true,
  isNotGitRepo: false,
};

interface MockHandlers extends AgentCreateMenuHandlers {
  openWorktreeBaseBranchPicker: Mock<() => void>;
  onNewBlitz: Mock<() => void>;
  onNewTerminal: Mock<() => void>;
  openSuperLoopDialog: Mock<() => void>;
  handleNewMetaAgent: Mock<() => void>;
  handleNewTeamSession: Mock<(preset: TeamRootPreset) => void>;
  handleNewTeamMission: Mock<() => void>;
  handleNewEccArchitectSession: Mock<() => void>;
}

function handlers(): MockHandlers {
  return {
    openWorktreeBaseBranchPicker: vi.fn<() => void>(),
    onNewBlitz: vi.fn<() => void>(),
    onNewTerminal: vi.fn<() => void>(),
    openSuperLoopDialog: vi.fn<() => void>(),
    handleNewMetaAgent: vi.fn<() => void>(),
    handleNewTeamSession: vi.fn<(preset: TeamRootPreset) => void>(),
    handleNewTeamMission: vi.fn<() => void>(),
    handleNewEccArchitectSession: vi.fn<() => void>(),
  };
}

afterEach(async () => {
  cleanup();
  await setLanguage('en');
});

describe('where the action is', () => {
  it('is the last item of the Team mode group, set apart by a divider, behind the Team view flag', () => {
    const items = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, handlers);
    expect(items.map((item) => item.id)).toEqual(['team-session-standard', 'team-session-large', 'team-session-critical', 'team-mission', 'ecc-architect']);
    const action = items[items.length - 1];
    expect(action.testId).toBe(ECC_ARCHITECT_MENU_TEST_ID);
    expect(action.icon).toBe('architecture');
    expect(action.separatorBefore).toBe(true);
    expect(action.disabled).toBeUndefined();
    expect(items.slice(0, 3).every((item) => !item.separatorBefore)).toBe(true);
  });

  it('is absent without the flag, and the rest of the menu is what it was', () => {
    const withoutFlag = buildAgentCreateMenuItems({ ...allOn, isAgentTeamViewEnabled: false }, tAgent, handlers);
    expect(withoutFlag.map((item) => item.id)).toEqual(['worktree', 'blitz', 'terminal', 'super-loop', 'meta-agent']);
    expect(withoutFlag.some((item) => item.id === 'ecc-architect' || item.separatorBefore)).toBe(false);
    expect(buildAgentCreateMenuItems(allOff, tAgent, handlers)).toEqual([]);

    const withFlag = buildAgentCreateMenuItems(allOn, tAgent, handlers);
    expect(withFlag.map((item) => item.id)).toEqual([...withoutFlag.map((item) => item.id), 'team-session-standard', 'team-session-large', 'team-session-critical', 'team-mission', 'ecc-architect']);
  });

  it('is labelled "Preparar com ECC Architect" in pt-BR and "Prepare with ECC Architect" in English', async () => {
    await setLanguage('pt-BR');
    let items = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, handlers);
    expect(items.find((item) => item.id === 'ecc-architect')!.label).toBe('Preparar com ECC Architect');
    expect(items[0].label).toBe('Nova sessão em Modo Equipe: Padrão (Opus, high)');
    await setLanguage('en');
    items = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, handlers);
    expect(items.find((item) => item.id === 'ecc-architect')!.label).toBe('Prepare with ECC Architect');
    expect(items[0].label).toBe('New Team mode session: Standard (Opus, high)');
  });

  it('shows up in the "New" menu as the user sees it, after a divider, and selecting it runs the handler', async () => {
    await setLanguage('pt-BR');
    const current = handlers();
    const items = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, () => current);
    render(
      <WindowTopBar
        workspaceName="Repo"
        activeModeLabel="Agent"
        gitStatus={null}
        gitActions={{ onPull: () => {}, onPush: () => {}, onOpenLog: () => {} }}
        newInTreeControl={{ label: 'New session', onCreate: () => {}, menuTestId: 'new-dropdown-button', menuItems: items }}
      />,
    );
    fireEvent.click(screen.getByTestId('new-dropdown-button'));
    const action = screen.getByTestId(ECC_ARCHITECT_MENU_TEST_ID);
    expect(action.getAttribute('role')).toBe('menuitem');
    expect(action.textContent).toContain('Preparar com ECC Architect');
    expect((action as HTMLButtonElement).disabled).toBe(false);
    const menu = screen.getByTestId('window-top-bar-create-left-menu');
    const entries = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    expect(entries[entries.length - 1]).toBe(action);
    const dividers = menu.querySelectorAll('.window-top-bar__create-menu-divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0].compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(action);
    expect(current.handleNewEccArchitectSession).toHaveBeenCalledTimes(1);
    expect(current.handleNewTeamSession).not.toHaveBeenCalled();
  });
});

describe('what the action does', () => {
  it('starts a Team mode root through the existing create action: the standard preset plus the directive and a draft', () => {
    const options = eccArchitectCreateOptions(tAgent);
    expect(ECC_ARCHITECT_ROOT_PRESET).toEqual(TEAM_ROOT_PRESETS.find((preset) => preset.id === 'standard'));
    expect(options).toEqual({
      launchSource: 'session_history',
      model: 'claude-code:opus',
      title: 'ECC Architect',
      initialDraft: 'Prepare this task with ECC Architect before implementation:\n\n',
      metadata: { teamMode: true, effortLevel: 'high', sessionDirective: ECC_ARCHITECT_FIRST_DIRECTIVE },
    });
    // What "New Team mode session: Standard" sends, plus the directive and the draft.
    const standardRoot = { launchSource: 'session_history', model: ECC_ARCHITECT_ROOT_PRESET.model, metadata: { teamMode: true, effortLevel: ECC_ARCHITECT_ROOT_PRESET.effortLevel } };
    expect(options.model).toBe(standardRoot.model);
    expect(options.metadata).toMatchObject(standardRoot.metadata);
  });

  it('asks for the architect first, in the draft the user completes and in the directive the coordinator reads', async () => {
    await setLanguage('pt-BR');
    expect(eccArchitectCreateOptions(tAgent).initialDraft).toBe('Prepare esta tarefa com ECC Architect antes da implementação:\n\n');
    expect(eccArchitectCreateOptions(tAgent).title).toBe('ECC Architect');
    expect(ECC_ARCHITECT_FIRST_DIRECTIVE).toMatch(/create the architect \(role `architect`[^)]*\) as the first member/);
  });

  it('creates no architect and grants nothing itself: a root, with team metadata only', () => {
    const options = eccArchitectCreateOptions(tAgent);
    expect(Object.keys(options.metadata ?? {}).sort()).toEqual(['effortLevel', 'sessionDirective', 'teamMode']);
    expect(options.metadata).not.toHaveProperty('teamChild');
    expect(options.metadata).not.toHaveProperty('toolScope');
    expect(options.metadata).not.toHaveProperty('teamBudget');
    expect(options.metadata).not.toHaveProperty('toolManifestRef');
    expect(options.sessionId).toBeUndefined();
    expect(options.mode).toBeUndefined();
    expect(JSON.stringify(options)).not.toMatch(/"role"|create_session|teamChild/);
  });

  it('leaves the Team mode presets exactly as they were', () => {
    const current = handlers();
    const items = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, () => current);
    items[0].onSelect();
    items[2].onSelect();
    expect(current.handleNewTeamSession.mock.calls).toEqual([[TEAM_ROOT_PRESETS[0]], [TEAM_ROOT_PRESETS[2]]]);
    expect(current.handleNewEccArchitectSession).not.toHaveBeenCalled();
    expect(items.slice(0, 3).map((item) => item.testId)).toEqual(['new-team-session-standard-button', 'new-team-session-large-button', 'new-team-session-critical-button']);
  });

  it('reads the handlers through the getter, so the latest closures run', () => {
    let current = handlers();
    const items = buildAgentCreateMenuItems({ ...allOn, isNotGitRepo: true }, tAgent, () => current);
    const first = current;
    current = handlers();
    items.find((item) => item.id === 'ecc-architect')!.onSelect();
    items.find((item) => item.id === 'meta-agent')!.onSelect();
    expect(first.handleNewEccArchitectSession).not.toHaveBeenCalled();
    expect(current.handleNewEccArchitectSession).toHaveBeenCalledTimes(1);
    expect(current.handleNewMetaAgent).toHaveBeenCalledTimes(1);
    // Items that need a git repository stay disabled as before; the action does not depend on one.
    expect(items.find((item) => item.id === 'worktree')!.disabled).toBe(true);
    expect(items.find((item) => item.id === 'ecc-architect')!.disabled).toBeUndefined();
  });
});

describe('the "new mission" item', () => {
  it('sits after the presets and before the ECC divider, behind the same flag, and only opens the dialog', () => {
    const current = handlers();
    const items = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, () => current);
    const mission = items.find((item) => item.id === 'team-mission')!;
    expect(items.indexOf(mission)).toBe(3);
    expect(items[4].id).toBe('ecc-architect');
    expect(mission.testId).toBe('new-team-mission-button');
    expect(mission.separatorBefore).toBeUndefined();
    expect(mission.disabled).toBeUndefined();

    mission.onSelect();
    expect(current.handleNewTeamMission).toHaveBeenCalledTimes(1);
    // It creates nothing itself: no preset session, no ECC architect.
    expect(current.handleNewTeamSession).not.toHaveBeenCalled();
    expect(current.handleNewEccArchitectSession).not.toHaveBeenCalled();
  });

  it('is absent without the flag', () => {
    const items = buildAgentCreateMenuItems({ ...allOn, isAgentTeamViewEnabled: false }, tAgent, handlers);
    expect(items.some((item) => item.id === 'team-mission')).toBe(false);
  });

  it('has a label in English and in Brazilian Portuguese', async () => {
    const english = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, handlers).find((item) => item.id === 'team-mission')!;
    expect(english.label).toBe('New Team mode mission…');
    await setLanguage('pt-BR');
    const portuguese = buildAgentCreateMenuItems({ ...allOff, isAgentTeamViewEnabled: true }, tAgent, handlers).find((item) => item.id === 'team-mission')!;
    expect(portuguese.label).toBe('Nova missão em Modo Equipe…');
  });
});
