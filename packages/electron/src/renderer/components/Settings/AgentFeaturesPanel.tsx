import React, { useCallback, useEffect, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  advancedSettingsAtom,
  setAdvancedSettingsAtom,
  aiDebugSettingsAtom,
  setAIDebugSettingsAtom,
} from '../../store/atoms/appSettings';
import { autoCommitEnabledAtom, setAutoCommitEnabledAtom } from '../../store/atoms/autoCommitAtoms';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { ALPHA_FEATURES, type AlphaFeatureTag } from '../../../shared/alphaFeatures';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../common/AlphaBadge';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';

const AGENT_FEATURE_TAGS: AlphaFeatureTag[] = [
  'super-loops',
  'blitz',
  'meta-agent',
];

interface WorkflowSourceSettings {
  workspaceClaudeCompatibilityEnabled: boolean;
  includeProjectClaudeSources: boolean;
  includeUserClaudeSources: boolean;
  extensionWorkflowsEnabled: boolean;
}

interface WorkflowExportSettings {
  codexEnabled: boolean;
  claudeGeneratedExtensionWorkflowsEnabled: boolean;
}

type AttachmentStagingMode = 'temp' | 'workspace' | 'custom';

export function AgentFeaturesPanel() {
  const { t } = useTranslation('settings');
  const posthog = usePostHog();
  const [externalSessionFollowEnabled, setExternalSessionFollowEnabled] = useAtom(settingAtom('app.externalSessionFollowEnabled'));
  const [settings] = useAtom(advancedSettingsAtom);
  const [, updateSettings] = useAtom(setAdvancedSettingsAtom);
  const { alphaFeatures } = settings;

  const autoCommitEnabled = useAtomValue(autoCommitEnabledAtom);
  const setAutoCommitEnabled = useSetAtom(setAutoCommitEnabledAtom);

  const [showMcpSessionStatus, setShowMcpSessionStatus] = useAtom(
    settingAtom('ai.showMcpSessionStatus'),
  ) as [boolean, (value: boolean) => void];

  const [aiDebugSettings] = useAtom(aiDebugSettingsAtom);
  const [, updateAIDebugSettings] = useAtom(setAIDebugSettingsAtom);
  const { showToolCalls, chatShowToolCalls, aiDebugLogging, showPromptAdditions } = aiDebugSettings;
  const [workflowSettingsLoading, setWorkflowSettingsLoading] = useState(false);
  const [preferredAgentLanguage, setPreferredAgentLanguage] = useState<string>('');
  const [apiUpstreamUrl, setApiUpstreamUrl] = useState<string>('');
  const [apiUpstreamError, setApiUpstreamError] = useState<string | null>(null);
  const [attachmentStagingMode, setAttachmentStagingMode] = useState<AttachmentStagingMode>('temp');
  const [persistedAttachmentStagingMode, setPersistedAttachmentStagingMode] = useState<AttachmentStagingMode>('temp');
  const [attachmentCustomPath, setAttachmentCustomPath] = useState('');
  const [attachmentStagingError, setAttachmentStagingError] = useState<string | null>(null);
  const [currentWorkspacePath, setCurrentWorkspacePath] = useState<string | null>(null);
  const [offerAttachmentGitignore, setOfferAttachmentGitignore] = useState(false);
  const [addAttachmentGitignore, setAddAttachmentGitignore] = useState(true);
  const [workflowSourceSettings, setWorkflowSourceSettings] = useState<WorkflowSourceSettings>({
    workspaceClaudeCompatibilityEnabled: false,
    includeProjectClaudeSources: false,
    includeUserClaudeSources: false,
    extensionWorkflowsEnabled: false,
  });
  const [workflowExportSettings, setWorkflowExportSettings] = useState<WorkflowExportSettings>({
    codexEnabled: false,
    claudeGeneratedExtensionWorkflowsEnabled: false,
  });

  const isDevelopment = import.meta.env.DEV;

  const handleAlphaToggle = (tag: AlphaFeatureTag, enabled: boolean) => {
    updateSettings({
      alphaFeatures: { ...alphaFeatures, [tag]: enabled },
    });
    posthog?.capture('alpha_feature_toggled', {
      feature_tag: tag,
      enabled,
      source: 'agent_features_panel',
    });
  };

  const features = AGENT_FEATURE_TAGS
    .map((tag) => ALPHA_FEATURES.find((f) => f.tag === tag))
    .filter((f): f is (typeof ALPHA_FEATURES)[number] => f != null);

  useEffect(() => {
    const loadAgentWorkflowSettings = async () => {
      try {
        const settings = await window.electronAPI.claudeCode.getSettings();
        const workflowSettings = await window.electronAPI.agentWorkflows.getSettings();
        setApiUpstreamUrl(settings.apiUpstreamUrl ?? '');
        setWorkflowSourceSettings({
          workspaceClaudeCompatibilityEnabled: workflowSettings.sourceSettings.workspaceClaudeCompatibilityEnabled,
          includeProjectClaudeSources: workflowSettings.sourceSettings.includeProjectClaudeSources ?? settings.projectCommandsEnabled,
          includeUserClaudeSources: workflowSettings.sourceSettings.includeUserClaudeSources ?? settings.userCommandsEnabled,
          extensionWorkflowsEnabled: workflowSettings.sourceSettings.extensionWorkflowsEnabled,
        });
        setWorkflowExportSettings(workflowSettings.exportSettings);
      } catch (err) {
        console.error('Failed to load agent workflow settings:', err);
      }
    };

    loadAgentWorkflowSettings();
  }, []);

  useEffect(() => {
    const loadAttachmentSettings = async () => {
      try {
        const [config, workspace] = await Promise.all([
          window.electronAPI.invoke('attachment-staging:get-settings'),
          window.electronAPI.invoke('workspace:get-current'),
        ]) as [
          { mode: AttachmentStagingMode; customPath?: string },
          { path?: string } | null,
        ];
        setAttachmentStagingMode(config.mode);
        setPersistedAttachmentStagingMode(config.mode);
        setAttachmentCustomPath(config.customPath ?? '');
        const workspacePath = workspace?.path ?? null;
        setCurrentWorkspacePath(workspacePath);
        if (workspacePath) {
          const status = await window.electronAPI.invoke(
            'attachment:workspace-staging-status',
            workspacePath,
          ) as { shouldOffer: boolean };
          setOfferAttachmentGitignore(status.shouldOffer);
        }
      } catch (err) {
        console.error('Failed to load attachment staging settings:', err);
      }
    };
    void loadAttachmentSettings();
  }, []);

  const saveAttachmentStaging = useCallback(async (
    mode: AttachmentStagingMode,
    customPath = attachmentCustomPath,
  ) => {
    setAttachmentStagingError(null);
    try {
      const saved = await window.electronAPI.invoke('attachment-staging:set-settings', {
        mode,
        ...(mode === 'custom' ? { customPath } : {}),
      }) as { mode: AttachmentStagingMode; customPath?: string };
      setAttachmentStagingMode(saved.mode);
      setPersistedAttachmentStagingMode(saved.mode);
      setAttachmentCustomPath(saved.customPath ?? customPath);
      if (mode === 'workspace' && addAttachmentGitignore && offerAttachmentGitignore && currentWorkspacePath) {
        await window.electronAPI.invoke('attachment:append-workspace-gitignore', currentWorkspacePath);
        setOfferAttachmentGitignore(false);
      }
    } catch (err) {
      setAttachmentStagingError(err instanceof Error ? err.message : String(err));
    }
  }, [addAttachmentGitignore, attachmentCustomPath, currentWorkspacePath, offerAttachmentGitignore]);

  useEffect(() => {
    const loadPreferredAgentLanguage = async () => {
      try {
        const language = await window.electronAPI.invoke('preferred-agent-language:get');
        setPreferredAgentLanguage(typeof language === 'string' ? language : '');
      } catch (err) {
        console.error('Failed to load preferred agent language:', err);
      }
    };
    loadPreferredAgentLanguage();
  }, []);

  const handlePreferredAgentLanguageChange = useCallback(async (value: string) => {
    setPreferredAgentLanguage(value);
    try {
      await window.electronAPI.invoke('preferred-agent-language:set', value);
    } catch (err) {
      console.error('Failed to save preferred agent language:', err);
    }
  }, []);

  // Persist on blur (not per-keystroke) so a half-typed URL doesn't flash a
  // validation error. The main process re-validates (loopback-only) and returns
  // the error to surface inline; a value it rejects is NOT saved.
  const handleApiUpstreamBlur = useCallback(async () => {
    try {
      const result = await window.electronAPI.claudeCode.setApiUpstreamUrl(apiUpstreamUrl);
      if (result.success) {
        setApiUpstreamError(null);
      } else {
        setApiUpstreamError(result.error);
      }
    } catch (err) {
      setApiUpstreamError(err instanceof Error ? err.message : t('agentFeatures.apiUpstream.saveFailed'));
    }
  }, [apiUpstreamUrl, t]);

  const handleWorkflowSourceToggle = useCallback(async (
    key: keyof WorkflowSourceSettings,
    enabled: boolean,
  ) => {
    setWorkflowSettingsLoading(true);
    try {
      const next = await window.electronAPI.agentWorkflows.setSourceSettings({ [key]: enabled });
      setWorkflowSourceSettings(next);
    } catch (err) {
      console.error('Failed to update workflow source settings:', err);
    } finally {
      setWorkflowSettingsLoading(false);
    }
  }, []);

  const handleWorkflowExportToggle = useCallback(async (
    key: keyof WorkflowExportSettings,
    enabled: boolean,
  ) => {
    setWorkflowSettingsLoading(true);
    try {
      const next = await window.electronAPI.agentWorkflows.setExportSettings({ [key]: enabled });
      setWorkflowExportSettings(next);
    } catch (err) {
      console.error('Failed to update workflow export settings:', err);
    } finally {
      setWorkflowSettingsLoading(false);
    }
  }, []);

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          {t('agentFeatures.title')}
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          {t('agentFeatures.description')}
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <SettingsToggle
          checked={autoCommitEnabled}
          onChange={(checked) => {
            setAutoCommitEnabled(checked);
            posthog?.capture('auto_commit_toggled', { enabled: checked });
          }}
          name={t('agentFeatures.autoCommit.name')}
          description={t('agentFeatures.autoCommit.description')}
        />

        <SettingsToggle
          checked={externalSessionFollowEnabled}
          onChange={setExternalSessionFollowEnabled}
          name={t('agentFeatures.externalSessionFollow.name')}
          description={t('agentFeatures.externalSessionFollow.description')}
          testId="external-session-follow-setting"
        />

        <SettingsToggle
          checked={showMcpSessionStatus}
          onChange={(checked) => setShowMcpSessionStatus(checked)}
          name={t('agentFeatures.mcpSessionStatus.name')}
          description={t('agentFeatures.mcpSessionStatus.description')}
          testId="show-mcp-session-status-toggle"
        />

        <div className="agent-preferred-language flex items-start justify-between gap-4 py-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[var(--nim-text)] leading-tight">
              {t('agentFeatures.preferredAgentLanguage.name')}
            </div>
            <div className="text-xs text-[var(--nim-text-muted)] leading-snug mt-0.5">
              {t('agentFeatures.preferredAgentLanguage.description')}
            </div>
          </div>
          <input
            type="text"
            value={preferredAgentLanguage}
            onChange={(e) => handlePreferredAgentLanguageChange(e.target.value)}
            placeholder={t('agentFeatures.preferredAgentLanguage.placeholder')}
            className="w-40 py-1.5 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            data-testid="preferred-agent-language-input"
          />
        </div>

        <div
          className="attachment-staging-settings mt-3 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3"
          data-testid="attachment-staging-settings"
        >
          <div className="text-sm font-semibold text-[var(--nim-text)]">{t('agentFeatures.attachmentStaging.title')}</div>
          <p className="mb-3 mt-1 text-xs leading-relaxed text-[var(--nim-text-muted)]">
            {t('agentFeatures.attachmentStaging.description')}
          </p>
          <div className="flex flex-col gap-2">
            {([
              ['temp', t('agentFeatures.attachmentStaging.temp')],
              ['workspace', t('agentFeatures.attachmentStaging.workspace')],
              ['custom', t('agentFeatures.attachmentStaging.custom')],
            ] as Array<[AttachmentStagingMode, string]>).map(([mode, label]) => (
              <label key={mode} className="flex cursor-pointer items-center gap-2 text-sm text-[var(--nim-text)]">
                <input
                  type="radio"
                  name="attachment-staging-mode"
                  checked={attachmentStagingMode === mode}
                  onChange={() => {
                    setAttachmentStagingMode(mode);
                    if (mode === 'temp') {
                      void saveAttachmentStaging(mode);
                    } else if (mode === 'custom' && attachmentCustomPath.trim()) {
                      void saveAttachmentStaging(mode);
                    } else if (mode === 'workspace' && !offerAttachmentGitignore) {
                      void saveAttachmentStaging(mode);
                    }
                  }}
                />
                {label}
              </label>
            ))}
          </div>
          {attachmentStagingMode === 'custom' && (
            <input
              type="text"
              value={attachmentCustomPath}
              onChange={(event) => setAttachmentCustomPath(event.target.value)}
              onBlur={() => { if (attachmentCustomPath.trim()) void saveAttachmentStaging('custom', attachmentCustomPath); }}
              placeholder={t('agentFeatures.attachmentStaging.customPlaceholder')}
              spellCheck={false}
              className="mt-3 w-full rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-1.5 text-sm text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            />
          )}
          {attachmentStagingMode === 'workspace' && offerAttachmentGitignore && currentWorkspacePath && (
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-[var(--nim-text-muted)]">
              <input
                type="checkbox"
                checked={addAttachmentGitignore}
                onChange={(event) => setAddAttachmentGitignore(event.target.checked)}
              />
              {t('agentFeatures.attachmentStaging.addGitignore')}
            </label>
          )}
          {attachmentStagingMode === 'workspace' &&
            (persistedAttachmentStagingMode !== 'workspace' || offerAttachmentGitignore) && (
              <button
                type="button"
                className="nim-btn-primary mt-3"
                onClick={() => void saveAttachmentStaging('workspace')}
              >
                {t('agentFeatures.attachmentStaging.applyWorkspace')}
              </button>
            )}
          {attachmentStagingError && (
            <p className="select-text mb-0 mt-2 text-xs text-[var(--nim-error)]">{attachmentStagingError}</p>
          )}
        </div>
      </div>

      <div className="provider-panel-section">
        <div className="flex items-center gap-2 mb-2">
          <h4 className="provider-panel-section-title text-base font-semibold text-[var(--nim-text)] m-0">{t('agentFeatures.experimental.title')}</h4>
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </div>

        <div className="flex items-start gap-2 p-3 mb-3 rounded border border-[var(--nim-warning)]/30 bg-[var(--nim-warning)]/10">
          <MaterialSymbol icon="science" size={16} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
          <p className="m-0 text-[13px] text-[var(--nim-text)] leading-snug">
            {t('agentFeatures.experimental.warning')}
          </p>
        </div>

        <div className="claude-api-upstream mb-4 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
          <h5 className="text-sm font-semibold mb-1.5 text-[var(--nim-text)]">
            {t('agentFeatures.apiUpstream.title')}
          </h5>
          <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-2">
            <Trans t={t} i18nKey="agentFeatures.apiUpstream.description" components={{ code: <code /> }} />
          </p>
          <div className="flex items-start gap-2 p-2 mb-2 rounded border border-[var(--nim-warning)]/30 bg-[var(--nim-warning)]/10">
            <MaterialSymbol icon="lock" size={14} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
            <p className="m-0 text-[12px] text-[var(--nim-text)] leading-snug">
              <Trans t={t} i18nKey="agentFeatures.apiUpstream.loopbackWarning" components={{ code: <code /> }} />
            </p>
          </div>
          <input
            type="text"
            value={apiUpstreamUrl}
            onChange={(e) => {
              setApiUpstreamUrl(e.target.value);
              if (apiUpstreamError) setApiUpstreamError(null);
            }}
            onBlur={handleApiUpstreamBlur}
            placeholder="http://127.0.0.1:8787/anthropic"
            spellCheck={false}
            className="w-full py-1.5 px-3 rounded-md text-sm bg-[var(--nim-bg)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]"
            data-testid="claude-api-upstream-input"
          />
          {apiUpstreamError && (
            <p className="claude-api-upstream-error mt-1.5 text-xs text-[var(--nim-error)] leading-snug">
              {apiUpstreamError}
            </p>
          )}
        </div>

        <div className="mb-4 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3">
          <h5 className="text-sm font-semibold mb-1.5 text-[var(--nim-text)]">
            {t('agentFeatures.workflows.title')}
          </h5>
          <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-2">
            {t('agentFeatures.workflows.description')}
          </p>

          <div className="border-b border-[var(--nim-border)] mb-2">
            <SettingsToggle
              checked={workflowSourceSettings.workspaceClaudeCompatibilityEnabled}
              onChange={(checked) => handleWorkflowSourceToggle('workspaceClaudeCompatibilityEnabled', checked)}
              disabled={workflowSettingsLoading}
              name={t('agentFeatures.workflows.workspaceCompatibility.name')}
              description={t('agentFeatures.workflows.workspaceCompatibility.description')}
            />
            <SettingsToggle
              checked={workflowSourceSettings.includeProjectClaudeSources}
              onChange={(checked) => handleWorkflowSourceToggle('includeProjectClaudeSources', checked)}
              disabled={workflowSettingsLoading || !workflowSourceSettings.workspaceClaudeCompatibilityEnabled}
              name={t('agentFeatures.workflows.projectSources.name')}
              description={t('agentFeatures.workflows.projectSources.description')}
            />
            <SettingsToggle
              checked={workflowSourceSettings.includeUserClaudeSources}
              onChange={(checked) => handleWorkflowSourceToggle('includeUserClaudeSources', checked)}
              disabled={workflowSettingsLoading || !workflowSourceSettings.workspaceClaudeCompatibilityEnabled}
              name={t('agentFeatures.workflows.userSources.name')}
              description={t('agentFeatures.workflows.userSources.description')}
            />
            <SettingsToggle
              checked={workflowSourceSettings.extensionWorkflowsEnabled}
              onChange={(checked) => handleWorkflowSourceToggle('extensionWorkflowsEnabled', checked)}
              disabled={workflowSettingsLoading}
              name={t('agentFeatures.workflows.extensionWorkflows.name')}
              description={t('agentFeatures.workflows.extensionWorkflows.description')}
            />
          </div>

          <div>
            <SettingsToggle
              checked={workflowExportSettings.codexEnabled}
              onChange={(checked) => handleWorkflowExportToggle('codexEnabled', checked)}
              disabled={workflowSettingsLoading}
              name={t('agentFeatures.workflows.codexExport.name')}
              description={t('agentFeatures.workflows.codexExport.description')}
            />
            <SettingsToggle
              checked={workflowExportSettings.claudeGeneratedExtensionWorkflowsEnabled}
              onChange={(checked) => handleWorkflowExportToggle('claudeGeneratedExtensionWorkflowsEnabled', checked)}
              disabled={workflowSettingsLoading}
              name={t('agentFeatures.workflows.claudeExport.name')}
              description={t('agentFeatures.workflows.claudeExport.description')}
            />
          </div>
        </div>

        {features.map((feature) => (
          <SettingsToggle
            key={feature.tag}
            checked={alphaFeatures[feature.tag] ?? false}
            onChange={(checked) => handleAlphaToggle(feature.tag, checked)}
            name={feature.name}
            description={feature.description}
          />
        ))}

        <SettingsToggle
          checked={chatShowToolCalls}
          onChange={(checked) => updateAIDebugSettings({ chatShowToolCalls: checked })}
          name={t('agentFeatures.chatToolCalls.name')}
          description={t('agentFeatures.chatToolCalls.description')}
        />
      </div>

      {isDevelopment && (
        <div className="provider-panel-section py-4 mt-4 border-t border-[var(--nim-border)]">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">{t('agentFeatures.developer.title')}</h4>
          <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-2">
            {t('agentFeatures.developer.description')}
          </p>

          <SettingsToggle
            checked={showToolCalls}
            onChange={(checked) => updateAIDebugSettings({ showToolCalls: checked })}
            name={t('agentFeatures.developer.allToolCalls.name')}
            description={t('agentFeatures.developer.allToolCalls.description')}
          />

          <SettingsToggle
            checked={aiDebugLogging}
            onChange={(checked) => updateAIDebugSettings({ aiDebugLogging: checked })}
            name={t('agentFeatures.developer.debugLogging.name')}
            description={t('agentFeatures.developer.debugLogging.description')}
          />

          <SettingsToggle
            checked={showPromptAdditions}
            onChange={(checked) => updateAIDebugSettings({ showPromptAdditions: checked })}
            name={t('agentFeatures.developer.promptAdditions.name')}
            description={t('agentFeatures.developer.promptAdditions.description')}
          />
        </div>
      )}
    </div>
  );
}
