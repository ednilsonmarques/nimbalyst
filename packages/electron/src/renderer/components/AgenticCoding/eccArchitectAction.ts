/**
 * "Prepare with ECC Architect" (Phase 1C of the ECC Architect).
 *
 * One entry of the "New" menu that starts a Team mode root on the standard
 * coordinator preset, with a creation-only directive telling the coordinator to
 * begin with the architect. That is all the renderer does: it creates no
 * architect, grants nothing and runs no Team Mode logic. The root is created by
 * the same action as "New Team mode session"; the coordinator decides the plan
 * and creates `role: architect` itself, under the Team Mode rules.
 */

import {
  ECC_ARCHITECT_FIRST_DIRECTIVE,
  TEAM_ROOT_PRESETS,
  type TeamRootPreset,
} from '@nimbalyst/runtime/ai/server/providers/teamContext';
import type { TitleBarCreateMenuItem } from '../../store/atoms/titleBarCreate';
import type { CreateNewSessionOptions } from '../../store/actions/sessionHistoryActions';

export const ECC_ARCHITECT_MENU_ITEM_ID = 'ecc-architect';
export const ECC_ARCHITECT_MENU_TEST_ID = 'new-ecc-architect-button';

/** The coordinator preset the action uses: the standard Team mode root (Opus, high). */
export const ECC_ARCHITECT_ROOT_PRESET: TeamRootPreset =
  TEAM_ROOT_PRESETS.find((preset) => preset.id === 'standard') ?? TEAM_ROOT_PRESETS[0];

export type EccArchitectTranslate = (key: string) => string;

/**
 * The create options of the Team root the action starts. Identical to a
 * "New Team mode session: Standard" root plus the directive (so the coordinator
 * begins with the architect even if the user rewrites the draft) and a visible
 * draft the user completes with the task.
 */
export function eccArchitectCreateOptions(t: EccArchitectTranslate): CreateNewSessionOptions {
  return {
    launchSource: 'session_history',
    model: ECC_ARCHITECT_ROOT_PRESET.model,
    title: t('sessionList.create.eccArchitect.sessionTitle'),
    initialDraft: t('sessionList.create.eccArchitect.initialDraft'),
    metadata: {
      teamMode: true,
      effortLevel: ECC_ARCHITECT_ROOT_PRESET.effortLevel,
      sessionDirective: ECC_ARCHITECT_FIRST_DIRECTIVE,
    },
  };
}

export function buildEccArchitectMenuItem(t: EccArchitectTranslate, onSelect: () => void): TitleBarCreateMenuItem {
  return {
    id: ECC_ARCHITECT_MENU_ITEM_ID,
    label: t('sessionList.create.eccArchitect.label'),
    icon: 'architecture',
    testId: ECC_ARCHITECT_MENU_TEST_ID,
    separatorBefore: true,
    onSelect,
  };
}
