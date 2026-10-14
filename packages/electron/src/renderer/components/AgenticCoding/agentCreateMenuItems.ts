/**
 * Items of the "New" menu in Agent mode, in the order Session history shows
 * them. A pure builder: Session history computes the flags from its atoms and
 * props, passes a getter for its latest handlers (so closures stay current
 * without rebuilding the menu) and publishes the result through the title bar
 * atom. Keeping the list here lets a test see exactly what the menu offers.
 */

import { TEAM_ROOT_PRESETS, type TeamRootPreset } from '@nimbalyst/runtime/ai/server/providers/teamContext';
import { KeyboardShortcuts, getShortcutDisplay } from '../../../shared/KeyboardShortcuts';
import type { TitleBarCreateMenuItem } from '../../store/atoms/titleBarCreate';
import { buildEccArchitectMenuItem } from './eccArchitectAction';

export interface AgentCreateMenuFlags {
  hasWorktreeOption: boolean;
  hasBlitzOption: boolean;
  hasTerminalOption: boolean;
  isSuperLoopsAvailable: boolean;
  isMetaAgentEnabled: boolean;
  isAgentTeamViewEnabled: boolean;
  isNotGitRepo: boolean;
}

export interface AgentCreateMenuHandlers {
  openWorktreeBaseBranchPicker: () => void;
  onNewBlitz?: () => void;
  onNewTerminal?: () => void;
  openSuperLoopDialog: () => void;
  handleNewMetaAgent: () => void | Promise<void>;
  handleNewTeamSession: (preset: TeamRootPreset) => void;
  handleNewEccArchitectSession: () => void;
}

export type AgentCreateMenuTranslate = (key: string) => string;

export function buildAgentCreateMenuItems(
  flags: AgentCreateMenuFlags,
  t: AgentCreateMenuTranslate,
  handlers: () => AgentCreateMenuHandlers,
): TitleBarCreateMenuItem[] {
  const items: TitleBarCreateMenuItem[] = [];
  if (flags.hasWorktreeOption) {
    items.push({
      id: 'worktree',
      label: t('sessionList.create.newWorktree'),
      icon: 'account_tree',
      testId: 'new-worktree-session-button',
      trailing: getShortcutDisplay(KeyboardShortcuts.window.newWorktree),
      disabled: flags.isNotGitRepo,
      disabledReason: t('sessionList.create.worktreeRequiresGit'),
      onSelect: () => handlers().openWorktreeBaseBranchPicker(),
    });
  }
  if (flags.hasBlitzOption) {
    items.push({
      id: 'blitz',
      label: t('sessionList.create.newBlitz'),
      icon: 'bolt',
      testId: 'new-blitz-button',
      disabled: flags.isNotGitRepo,
      disabledReason: t('sessionList.create.blitzRequiresGit'),
      onSelect: () => handlers().onNewBlitz?.(),
    });
  }
  if (flags.hasTerminalOption) {
    items.push({
      id: 'terminal',
      label: t('sessionList.create.newTerminal'),
      icon: 'terminal',
      testId: 'new-terminal-button',
      onSelect: () => handlers().onNewTerminal?.(),
    });
  }
  if (flags.isSuperLoopsAvailable) {
    items.push({
      id: 'super-loop',
      label: t('sessionList.create.newSuperLoop'),
      icon: 'all_inclusive',
      testId: 'new-super-loop-button',
      disabled: flags.isNotGitRepo,
      disabledReason: t('sessionList.create.superLoopRequiresGit'),
      onSelect: () => handlers().openSuperLoopDialog(),
    });
  }
  if (flags.isMetaAgentEnabled) {
    items.push({
      id: 'meta-agent',
      label: t('sessionList.create.newMetaAgent'),
      icon: 'hub',
      testId: 'new-meta-agent-button',
      onSelect: () => { void handlers().handleNewMetaAgent(); },
    });
  }
  if (flags.isAgentTeamViewEnabled) {
    for (const preset of TEAM_ROOT_PRESETS) {
      items.push({
        id: `team-session-${preset.id}`,
        label: t(`sessionList.create.newTeamSession.${preset.id}`),
        icon: 'account_tree',
        testId: `new-team-session-${preset.id}-button`,
        onSelect: () => handlers().handleNewTeamSession(preset),
      });
    }
    // "Prepare with ECC Architect": a Team mode root whose coordinator begins
    // with the architect. Offered with the Team presets, behind the same flag,
    // set apart by a divider because it is a way of starting, not a size.
    items.push(buildEccArchitectMenuItem(t, () => handlers().handleNewEccArchitectSession()));
  }
  return items;
}
