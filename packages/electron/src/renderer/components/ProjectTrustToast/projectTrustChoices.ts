import { t } from '@nimbalyst/runtime/i18n';

export type PermissionMode = 'ask' | 'allow-all' | 'bypass-all';

export type ProjectTrustChoice =
  | 'agent-verified'
  | 'allow-everything'
  | 'allow-edits-only'
  | 'ask-every-time';

export interface PersistedProjectTrustSettings {
  permissionMode: PermissionMode;
  allowAllUsesClassifier: boolean;
}

export type ProjectTrustSeverity = 'primary' | 'warning' | 'neutral';

export interface ProjectTrustPresentation {
  choice: ProjectTrustChoice;
  label: string;
  description: string;
  icon: string;
  severity: ProjectTrustSeverity;
}

export const DEFAULT_PROJECT_TRUST_CHOICE: ProjectTrustChoice =
  'agent-verified';

// Getters so every read resolves in the current UI language; the keys stay
// the persisted choice ids.
export const PROJECT_TRUST_CHOICE_LABELS: Record<ProjectTrustChoice, string> = {
  get 'agent-verified'() { return t('dialogs:projectTrust.choiceLabels.agentVerified'); },
  get 'allow-everything'() { return t('dialogs:projectTrust.choiceLabels.allowEverything'); },
  get 'allow-edits-only'() { return t('dialogs:projectTrust.choiceLabels.allowEditsOnly'); },
  get 'ask-every-time'() { return t('dialogs:projectTrust.choiceLabels.askEveryTime'); },
};

export const PROJECT_TRUST_CHOICE_DESCRIPTIONS: Record<
  ProjectTrustChoice,
  string
> = {
  get 'agent-verified'() { return t('general:projectTrust.agentVerifiedDescription'); },
  get 'allow-everything'() { return t('dialogs:projectTrust.choiceDescriptions.allowEverything'); },
  get 'allow-edits-only'() { return t('dialogs:projectTrust.choiceDescriptions.allowEditsOnly'); },
  get 'ask-every-time'() { return t('dialogs:projectTrust.choiceDescriptions.askEveryTime'); },
};

const PROJECT_TRUST_SETTINGS_BY_CHOICE: Record<
  ProjectTrustChoice,
  PersistedProjectTrustSettings
> = {
  'agent-verified': {
    permissionMode: 'bypass-all',
    allowAllUsesClassifier: true,
  },
  'allow-everything': {
    permissionMode: 'bypass-all',
    allowAllUsesClassifier: false,
  },
  'allow-edits-only': {
    permissionMode: 'allow-all',
    allowAllUsesClassifier: false,
  },
  'ask-every-time': {
    permissionMode: 'ask',
    allowAllUsesClassifier: false,
  },
};

const PROJECT_TRUST_INDICATORS: Record<
  ProjectTrustChoice,
  Pick<ProjectTrustPresentation, 'icon' | 'severity'>
> = {
  'agent-verified': {
    icon: 'verified_user',
    severity: 'primary',
  },
  'allow-everything': {
    icon: 'warning',
    severity: 'warning',
  },
  'allow-edits-only': {
    icon: 'edit_note',
    severity: 'neutral',
  },
  'ask-every-time': {
    icon: 'rule',
    severity: 'neutral',
  },
};

export function getProjectTrustSettings(
  choice: ProjectTrustChoice
): PersistedProjectTrustSettings {
  return PROJECT_TRUST_SETTINGS_BY_CHOICE[choice];
}

export function getProjectTrustChoice(
  permissionMode: PermissionMode,
  allowAllUsesClassifier: boolean
): ProjectTrustChoice {
  if (permissionMode === 'bypass-all') {
    return allowAllUsesClassifier ? 'agent-verified' : 'allow-everything';
  }

  return permissionMode === 'allow-all' ? 'allow-edits-only' : 'ask-every-time';
}

export function getProjectTrustPresentation(
  permissionMode: PermissionMode,
  allowAllUsesClassifier: boolean
): ProjectTrustPresentation {
  const choice = getProjectTrustChoice(permissionMode, allowAllUsesClassifier);

  return {
    choice,
    label: PROJECT_TRUST_CHOICE_LABELS[choice],
    description: PROJECT_TRUST_CHOICE_DESCRIPTIONS[choice],
    ...PROJECT_TRUST_INDICATORS[choice],
  };
}

type PermissionInvoke = (
  channel: string,
  workspacePath: string,
  value: PermissionMode | boolean
) => Promise<unknown>;

export async function persistProjectTrustChoice(
  invoke: PermissionInvoke,
  workspacePath: string,
  choice: ProjectTrustChoice
): Promise<PersistedProjectTrustSettings> {
  const settings = getProjectTrustSettings(choice);

  await invoke(
    'permissions:setPermissionMode',
    workspacePath,
    settings.permissionMode
  );
  await invoke(
    'permissions:setAllowAllUsesClassifier',
    workspacePath,
    settings.allowAllUsesClassifier
  );

  return settings;
}
