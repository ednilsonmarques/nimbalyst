/**
 * Voice Mode Settings Panel
 *
 * Self-contained component that subscribes directly to Jotai atoms.
 * No props needed - settings are read from and written to atoms.
 */

import React from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import {
  voiceModeSettingsAtom,
  setVoiceModeSettingsAtom,
  apiKeysAtom,
  setApiKeyAtom,
  defaultAgentModelAtom,
  type VoiceModeSettings,
  type VoiceId,
  type RealtimeModel,
  type RealtimeReasoningEffort,
  type TurnDetectionConfig,
  type SystemPromptConfig,
  type VoiceEngineSetting,
} from '../../store/atoms/appSettings';
import { liveVoicePreviews } from './liveVoicePreviews';
import { useVoicePreview } from './useVoicePreview';
import { previewEligibility, resolveVoiceForEngine, voiceGroupsForEngine } from './voiceEngineOptions';
import { useRemoteVoicePreview } from './useRemoteVoicePreview';
import { addSessionFullAtom, setSelectedWorkstreamAtom, setWindowModeAtom, navigateToSettingsAtom } from '../../store';
import { useDialog } from '../../contexts/DialogContext';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../common/AlphaBadge';
import { buildVoiceProjectSummaryPrompt, VOICE_PROJECT_SUMMARY_PATH } from './voiceModeSummaryPrompt';
import type { SessionCreateResult } from '../../../shared/ipc/types';

interface VoiceModePanelProps {
  /** Optional workspace path for project-specific features like summary generation */
  workspacePath?: string;
}

// Default turn detection config
const DEFAULT_TURN_DETECTION: TurnDetectionConfig = {
  mode: 'server_vad',
  vadThreshold: 0.5,
  silenceDuration: 500,
  interruptible: true,
};

type MicAccessStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown';

export const VoiceModePanel: React.FC<VoiceModePanelProps> = ({
  workspacePath,
}) => {
  const { t, i18n } = useTranslation('settings');
  // Subscribe to atoms directly - no props needed
  const [voiceModeSettings] = useAtom(voiceModeSettingsAtom);
  const [, updateVoiceModeSettings] = useAtom(setVoiceModeSettingsAtom);
  const apiKeys = useAtomValue(apiKeysAtom);
  const [, setApiKey] = useAtom(setApiKeyAtom);
  const defaultAgentModel = useAtomValue(defaultAgentModelAtom);
  const addSession = useSetAtom(addSessionFullAtom);
  const setSelectedWorkstream = useSetAtom(setSelectedWorkstreamAtom);
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const navigateToSettings = useSetAtom(navigateToSettingsAtom);
  const dialog = useDialog();
  const hasAgentConfigured = !!defaultAgentModel?.trim();

  // Extract values from atom
  const {
    enabled,
    engine,
    voice,
    model,
    reasoningEffort,
    turnDetection,
    voiceAgentPrompt,
    codingAgentPrompt,
    submitDelayMs,
    listenWindowMs,
  } = voiceModeSettings;

  // Check if OpenAI key is configured
  const hasOpenAIKey = !!apiKeys.openai;

  const activeEngine: VoiceEngineSetting = engine ?? 'live';
  const voiceGroups = React.useMemo(() => voiceGroupsForEngine(activeEngine), [activeEngine, i18n.language]);
  const effectiveVoice = resolveVoiceForEngine(activeEngine, voice);
  const preview = previewEligibility(activeEngine, effectiveVoice);

  // Handler to update any voice mode setting
  const handleSettingChange = React.useCallback((updates: Partial<VoiceModeSettings>) => {
    updateVoiceModeSettings(updates);
  }, [updateVoiceModeSettings]);

  const [showVoiceAgentPrompt, setShowVoiceAgentPrompt] = React.useState(false);
  const [showCodingAgentPrompt, setShowCodingAgentPrompt] = React.useState(false);
  const localPreview = useVoicePreview(activeEngine === 'live' ? liveVoicePreviews[effectiveVoice] : undefined);
  const remotePreview = useRemoteVoicePreview(activeEngine !== 'live', effectiveVoice);
  const isPreviewPlaying = activeEngine === 'live' ? localPreview.isPlaying : remotePreview.isPlaying;

  // Project summary state. Generation now happens inside an agent session, so
  // there's no in-panel spinner -- we only track whether the file exists on
  // disk and surface failure messages from the launch path.
  const [projectSummaryExists, setProjectSummaryExists] = React.useState<boolean | null>(null);
  const [summaryError, setSummaryError] = React.useState<string | null>(null);
  const [summaryPath, setSummaryPath] = React.useState<string | null>(null);

  // Microphone access state. Only populated while voice mode is enabled --
  // we don't probe the OS at all when voice is off, so a user who never opts
  // in never has the mic permission concept surfaced.
  const [micStatus, setMicStatus] = React.useState<MicAccessStatus | null>(null);
  const [micPlatform, setMicPlatform] = React.useState<NodeJS.Platform | null>(null);

  const checkMicStatus = React.useCallback(async () => {
    try {
      const result = await window.electronAPI?.invoke('voice-mode:get-mic-status') as
        | { status: MicAccessStatus; platform: NodeJS.Platform }
        | undefined;
      if (result) {
        setMicStatus(result.status);
        setMicPlatform(result.platform);
      }
    } catch {
      setMicStatus(null);
    }
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      setMicStatus(null);
      return;
    }
    checkMicStatus();
  }, [enabled, checkMicStatus]);

  const handleOpenMicSettings = async () => {
    await window.electronAPI?.invoke('voice-mode:open-mic-settings');
  };

  // Check if project summary exists
  React.useEffect(() => {
    if (!workspacePath) {
      setProjectSummaryExists(null);
      return;
    }

    const checkSummary = async () => {
      try {
        const path = `${workspacePath}/${VOICE_PROJECT_SUMMARY_PATH}`;
        const exists = await window.electronAPI?.invoke('file:exists', path);
        setProjectSummaryExists(exists);
        if (exists) {
          setSummaryPath(path);
        }
      } catch {
        setProjectSummaryExists(false);
      }
    };

    checkSummary();
  }, [workspacePath]);

  // Launch an agent session that generates the voice-mode project summary.
  // The agent reads project files itself and writes the summary to
  // nimbalyst-local/voice-project-summary.md via its Write tool. Voice mode
  // picks up the file on next session start (see VoiceModeService.ts loadSessionContext).
  const handleGenerateSummary = async () => {
    if (!workspacePath || !window.electronAPI) return;
    if (!hasAgentConfigured) return;

    setSummaryError(null);

    const parsed = ModelIdentifier.tryParse(defaultAgentModel);
    const provider = parsed?.provider || 'claude-code';

    const confirmed = await dialog.confirm({
      title: t('voiceMode.summary.confirmTitle'),
      message: t('voiceMode.summary.confirmMessage', { model: defaultAgentModel, path: VOICE_PROJECT_SUMMARY_PATH }),
      confirmLabel: t('voiceMode.summary.confirmLabel'),
      cancelLabel: t('common:cancel'),
    });
    if (!confirmed) return;

    try {
      const sessionId = crypto.randomUUID();
      const title = t('voiceMode.summary.sessionTitle');
      const result: SessionCreateResult = await window.electronAPI.invoke('sessions:create', {
        session: {
          id: sessionId,
          provider,
          model: defaultAgentModel,
          title,
        },
        workspaceId: workspacePath,
      });

      if (!result?.success || !result.id) {
        setSummaryError(result?.error || t('voiceMode.summary.createFailed'));
        return;
      }

      addSession({
        id: result.id,
        title,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        provider,
        model: defaultAgentModel,
        sessionType: 'session',
        messageCount: 0,
        workspaceId: workspacePath,
        isArchived: false,
        isPinned: false,
        parentSessionId: null,
        worktreeId: null,
        childCount: 0,
        uncommittedCount: 0,
      });

      // Send the first message -- this kicks off agent execution.
      await window.electronAPI.invoke(
        'ai:sendMessage',
        buildVoiceProjectSummaryPrompt(),
        undefined,
        result.id,
        workspacePath,
      );

      // Switch to Agent mode and select the new session so the user can watch it run.
      // Switching modes implicitly unmounts the Settings view -- no explicit close needed.
      setWindowMode('agent');
      setSelectedWorkstream({
        workspacePath,
        selection: { type: 'session', id: result.id },
      });
    } catch (error) {
      console.error('[VoiceModePanel] Failed to launch summary session:', error);
      setSummaryError(error instanceof Error ? error.message : t('voiceMode.summary.launchFailed'));
    }
  };

  // Open summary file in editor
  const handleOpenSummary = async () => {
    if (summaryPath && workspacePath) {
      await window.electronAPI?.invoke('workspace:open-file', { workspacePath, filePath: summaryPath });
    }
  };

  // Toggle voice mode. We no longer auto-launch a summary session here --
  // generating the summary spawns a visible agent session that costs tokens,
  // so it must be an explicit user action.
  const handleEnabledChange = (newEnabled: boolean) => {
    handleSettingChange({ enabled: newEnabled });
  };

  // Use defaults for turn detection
  const currentTurnDetection = { ...DEFAULT_TURN_DETECTION, ...turnDetection };

  const handleTurnDetectionChange = (updates: Partial<TurnDetectionConfig>) => {
    handleSettingChange({ turnDetection: { ...currentTurnDetection, ...updates } });
  };

  // Switching engines carries the voice over only if the target engine accepts
  // it; otherwise the stored voice is corrected now rather than failing at
  // connect time.
  const handleModelChange = (nextModel: 'gpt-live-1' | RealtimeModel) => {
    const nextEngine: VoiceEngineSetting = nextModel === 'gpt-live-1' ? 'live' : 'realtime';
    const nextVoice = resolveVoiceForEngine(nextEngine, voice);
    handleSettingChange({
      engine: nextEngine,
      ...(nextModel === 'gpt-live-1' ? {} : { model: nextModel }),
      ...(nextVoice === voice ? {} : { voice: nextVoice as VoiceId }),
    });
  };

  const handlePreviewVoice = activeEngine === 'live' ? localPreview.toggle : remotePreview.toggle;
  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          {t('voiceMode.title')}
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          {t('voiceMode.description')}
        </p>
      </div>

      <div className="provider-panel-section mb-6">
        <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.enableSection')}</h4>

        <div className="setting-item py-3 mb-3">
          <div className="setting-text flex flex-col gap-0.5">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.apiKeyLabel')}</span>
            <span className="setting-description text-xs text-[var(--nim-text-muted)]">
              {t('voiceMode.apiKeyDescription')}
            </span>
          </div>
          <input
            type="password"
            value={apiKeys.openai || ''}
            onChange={(e) => setApiKey({ keyName: 'openai', value: e.target.value })}
            onFocus={(e) => e.target.select()}
            placeholder="sk-..."
            className="mt-2 w-full py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none font-mono focus:border-[var(--nim-primary)]"
          />
        </div>

        <div className="setting-item py-3">
          <label className="setting-label flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => handleEnabledChange(e.target.checked)}
              className="setting-checkbox mt-1 w-4 h-4 rounded border-[var(--nim-border)] accent-[var(--nim-primary)]"
              disabled={!hasOpenAIKey}
            />
            <div className="setting-text flex flex-col gap-0.5">
              <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.showButtonLabel')}</span>
              <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                {t('voiceMode.showButtonDescription')}
              </span>
            </div>
          </label>
        </div>
      </div>

      {enabled && hasOpenAIKey && micStatus && micStatus !== 'granted' && (
        <div
          className="voice-mode-mic-permission-warning provider-panel-section mb-6 p-4 rounded border border-[var(--nim-warning)] bg-[var(--nim-bg-secondary)]"
          data-testid="voice-mode-mic-permission-warning"
        >
          <div className="flex items-start gap-3">
            <MaterialSymbol icon="mic_off" size={20} className="mt-0.5 text-[var(--nim-warning)]" />
            <div className="flex-1">
              <h4 className="text-sm font-medium text-[var(--nim-text)] mb-1">{t('voiceMode.mic.title')}</h4>
              <p className="text-xs text-[var(--nim-text-muted)] mb-3">
                {micStatus === 'denied'
                  ? t('voiceMode.mic.deniedMessage', { settingsApp: micPlatform === 'win32' ? t('voiceMode.mic.windowsSettings') : t('voiceMode.mic.systemSettings') })
                  : micStatus === 'restricted'
                  ? t('voiceMode.mic.restrictedMessage')
                  : t('voiceMode.mic.grantMessage', { settingsApp: micPlatform === 'win32' ? t('voiceMode.mic.windowsSettings') : t('voiceMode.mic.systemSettings') })}
              </p>
              <div className="flex items-center gap-2">
                {(micPlatform === 'darwin' || micPlatform === 'win32') && (
                  <button
                    onClick={handleOpenMicSettings}
                    className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-primary)] text-white cursor-pointer text-sm flex items-center gap-1.5"
                    data-testid="voice-mode-open-mic-settings"
                  >
                    <MaterialSymbol icon="open_in_new" size={14} />
                    {micPlatform === 'win32' ? t('voiceMode.mic.openWindowsSettings') : t('voiceMode.mic.openSystemSettings')}
                  </button>
                )}
                <button
                  onClick={checkMicStatus}
                  className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-sm flex items-center gap-1.5"
                  data-testid="voice-mode-recheck-mic"
                >
                  <MaterialSymbol icon="refresh" size={14} />
                  {t('voiceMode.mic.recheck')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {enabled && hasOpenAIKey && (
        <>
          <div className="provider-panel-section mb-6">
            <div className="setting-item py-3">
              <label htmlFor="voice-model" className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.model.label')}</label>
              <p className="setting-description text-xs text-[var(--nim-text-muted)] mt-1">
                {t('voiceMode.model.description')}
              </p>
              <select
                id="voice-model"
                value={activeEngine === 'live' ? 'gpt-live-1' : (model ?? 'gpt-realtime-2')}
                onChange={(e) => handleModelChange(e.target.value as 'gpt-live-1' | RealtimeModel)}
                className="mt-2 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
                data-testid="voice-mode-model-select"
              >
                <option value="gpt-live-1">{t('voiceMode.model.liveDefault')}</option>
                <option value="gpt-realtime-2">gpt-realtime-2</option>
                <option value="gpt-realtime">gpt-realtime</option>
              </select>
              <p className="setting-description text-xs text-[var(--nim-text-muted)] mt-2">
                {t('voiceMode.model.changesApply')}
              </p>
            </div>

            {activeEngine === 'realtime' && model !== 'gpt-realtime' && (
              <div className="setting-item py-3">
                <div className="setting-text flex flex-col gap-0.5">
                  <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.reasoning.label')}</span>
                  <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                    {t('voiceMode.reasoning.description')}
                  </span>
                </div>
                <select
                  value={reasoningEffort ?? 'low'}
                  onChange={(e) => handleSettingChange({ reasoningEffort: e.target.value as RealtimeReasoningEffort })}
                  className="mt-2 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
                  data-testid="voice-mode-reasoning-effort-select"
                >
                  <option value="minimal">{t('voiceMode.reasoning.minimal')}</option>
                  <option value="low">{t('voiceMode.reasoning.low')}</option>
                  <option value="medium">{t('voiceMode.reasoning.medium')}</option>
                  <option value="high">{t('voiceMode.reasoning.high')}</option>
                  <option value="xhigh">{t('voiceMode.reasoning.xhigh')}</option>
                </select>
              </div>

            )}
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.voiceSettings.title')}</h4>

            <div className="setting-item py-3">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.voiceSettings.voiceLabel')}</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  {t('voiceMode.voiceSettings.voiceDescription')}
                </span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <select
                  value={effectiveVoice}
                  onChange={(e) => handleSettingChange({ voice: e.target.value as VoiceId })}
                  className="flex-1 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
                  data-testid="voice-mode-voice-select"
                >
                  {voiceGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.voices.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name} - {t(`voiceEngine.voiceDescriptions.${v.id}`, { defaultValue: v.description })}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button
                  onClick={handlePreviewVoice}
                  disabled={!preview.canPreview || (activeEngine !== 'live' && remotePreview.isLoading)}
                  className={`px-3 py-1.5 rounded border border-[var(--nim-border)] cursor-pointer flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed ${
                    isPreviewPlaying
                      ? 'bg-[var(--nim-primary)] text-white'
                      : 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]'
                  }`}
                  title={
                    !preview.canPreview
                      ? preview.note
                      : isPreviewPlaying
                        ? t('voiceMode.voiceSettings.stopPreview')
                        : t('voiceMode.voiceSettings.previewVoice')
                  }
                  data-testid="voice-mode-preview-voice"
                >
                  <MaterialSymbol icon={isPreviewPlaying ? 'stop' : 'play_arrow'} size={16} />
                  {isPreviewPlaying ? t('voiceMode.voiceSettings.stop') : t('voiceMode.voiceSettings.preview')}
                </button>
              </div>
              <p className="provider-panel-hint mt-2 text-xs text-[var(--nim-text-muted)]">
                {preview.canPreview
                  ? activeEngine === 'live'
                    ? t('voiceMode.voiceSettings.liveHint')
                    : t('voiceMode.voiceSettings.realtimeHint')
                  : preview.note}
                {preview.canPreview && preview.note && <span> {preview.note}</span>}
                {activeEngine === 'live' && localPreview.error && <span role="alert"> {localPreview.error}</span>}
              </p>
            </div>
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.turnDetection.title')}</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-4">
              {t('voiceMode.turnDetection.description')}
            </p>

            {/* Mode Selection */}
            <div className="setting-item py-3 mb-4">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.turnDetection.inputMode')}</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  {t('voiceMode.turnDetection.inputModeDescription')}
                </span>
              </div>
              <select
                value={currentTurnDetection.mode}
                onChange={(e) => handleTurnDetectionChange({ mode: e.target.value as 'server_vad' | 'push_to_talk' })}
                className="mt-2 px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)]"
              >
                <option value="server_vad">{t('voiceMode.turnDetection.vad')}</option>
                <option value="push_to_talk">{t('voiceMode.turnDetection.pushToTalk')}</option>
              </select>
            </div>

            {/* VAD-specific settings */}
            {currentTurnDetection.mode === 'server_vad' && (
              <>
                {/* VAD Threshold */}
                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.turnDetection.sensitivity')}</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      {t('voiceMode.turnDetection.sensitivityDescription')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-[var(--nim-text-muted)]">{t('voiceMode.turnDetection.sensitive')}</span>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={(currentTurnDetection.vadThreshold || 0.5) * 100}
                      onChange={(e) => handleTurnDetectionChange({ vadThreshold: parseInt(e.target.value) / 100 })}
                      className="flex-1"
                    />
                    <span className="text-xs text-[var(--nim-text-muted)]">{t('voiceMode.turnDetection.lessSensitive')}</span>
                    <span className="text-xs text-[var(--nim-text)] min-w-[36px]">
                      {Math.round((currentTurnDetection.vadThreshold || 0.5) * 100)}%
                    </span>
                  </div>
                </div>

                {/* Silence Duration */}
                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.turnDetection.pause')}</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      {t('voiceMode.turnDetection.pauseDescription')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-2">
                    <span className="text-xs text-[var(--nim-text-muted)]">{t('voiceMode.turnDetection.faster')}</span>
                    <input
                      type="range"
                      min="200"
                      max="1500"
                      step="100"
                      value={currentTurnDetection.silenceDuration || 500}
                      onChange={(e) => handleTurnDetectionChange({ silenceDuration: parseInt(e.target.value) })}
                      className="flex-1"
                    />
                    <span className="text-xs text-[var(--nim-text-muted)]">{t('voiceMode.turnDetection.slower')}</span>
                    <span className="text-xs text-[var(--nim-text)] min-w-[50px]">
                      {((currentTurnDetection.silenceDuration || 500) / 1000).toFixed(1)}s
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Interruptible setting */}
            <div className="setting-item py-3">
              <label className="setting-label flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={currentTurnDetection.interruptible !== false}
                  onChange={(e) => handleTurnDetectionChange({ interruptible: e.target.checked })}
                  className="setting-checkbox mt-1 w-4 h-4 rounded border-[var(--nim-border)] accent-[var(--nim-primary)]"
                />
                <div className="setting-text flex flex-col gap-0.5">
                  <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.turnDetection.interruptions')}</span>
                  <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                    {t('voiceMode.turnDetection.interruptionsDescription')}
                  </span>
                </div>
              </label>
            </div>

            {/* Listen Window Duration */}
            <div className="setting-item py-3">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.turnDetection.listenWindow')}</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  {t('voiceMode.turnDetection.listenWindowDescription')}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-xs text-[var(--nim-text-muted)]">5s</span>
                <input
                  type="range"
                  min="5000"
                  max="30000"
                  step="1000"
                  value={listenWindowMs ?? 15000}
                  onChange={(e) => handleSettingChange({ listenWindowMs: parseInt(e.target.value) })}
                  className="flex-1"
                />
                <span className="text-xs text-[var(--nim-text-muted)]">30s</span>
                <span className="text-xs text-[var(--nim-text)] min-w-[36px]">
                  {Math.round((listenWindowMs ?? 15000) / 1000)}s
                </span>
              </div>
            </div>
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.submission.title')}</h4>

            {/* Submit Delay */}
            <div className="setting-item py-3 mb-4">
              <div className="setting-text flex flex-col gap-0.5">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.submission.reviewDelay')}</span>
                <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                  {t('voiceMode.submission.reviewDelayDescription')}
                </span>
              </div>
              <div className="flex items-center gap-3 mt-2">
                <span className="text-xs text-[var(--nim-text-muted)]">{t('voiceMode.submission.immediate')}</span>
                <input
                  type="range"
                  min="0"
                  max="10000"
                  step="500"
                  value={submitDelayMs ?? 3000}
                  onChange={(e) => handleSettingChange({ submitDelayMs: parseInt(e.target.value) })}
                  className="flex-1"
                />
                <span className="text-xs text-[var(--nim-text-muted)]">{t('voiceMode.submission.tenSeconds')}</span>
                <span className="text-xs text-[var(--nim-text)] min-w-[50px]">
                  {((submitDelayMs ?? 3000) / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
          </div>

          {/* Project Summary Section */}
          {workspacePath && (
            <div className="voice-mode-project-summary provider-panel-section mb-6">
              <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.summary.title')}</h4>
              <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
                <Trans
                  t={t}
                  i18nKey="voiceMode.summary.description"
                  values={{ path: VOICE_PROJECT_SUMMARY_PATH }}
                  components={{ code: <code className="text-xs bg-[var(--nim-bg-secondary)] px-1 py-0.5 rounded" /> }}
                />
              </p>

              {projectSummaryExists ? (
                <div className="flex items-center gap-2">
                  <MaterialSymbol icon="check_circle" size={16} className="text-[var(--nim-success)]" />
                  <span className="text-[var(--nim-text-muted)]">{t('voiceMode.summary.exists')}</span>
                  <button
                    onClick={handleOpenSummary}
                    className="px-2 py-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-xs flex items-center gap-1"
                    title={t('voiceMode.summary.openFile')}
                    data-testid="voice-mode-summary-view"
                  >
                    <MaterialSymbol icon="open_in_new" size={14} />
                    {t('voiceMode.summary.view')}
                  </button>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={!hasAgentConfigured}
                    className="px-2 py-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] cursor-pointer text-xs flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    title={hasAgentConfigured ? t('voiceMode.summary.regenerateTitle') : t('voiceMode.summary.regenerateDisabledTitle')}
                    data-testid="voice-mode-summary-regenerate"
                  >
                    <MaterialSymbol icon="refresh" size={14} />
                    {t('voiceMode.summary.regenerate')}
                  </button>
                </div>
              ) : (
                <div>
                  <button
                    onClick={handleGenerateSummary}
                    disabled={!hasAgentConfigured}
                    className="px-3 py-1.5 rounded border border-[var(--nim-border)] bg-[var(--nim-primary)] text-white cursor-pointer text-sm flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="voice-mode-summary-generate"
                  >
                    <MaterialSymbol icon="auto_awesome" size={16} />
                    {t('voiceMode.summary.generate')}
                  </button>
                  <p className="provider-panel-hint mt-2 text-xs text-[var(--nim-text-muted)]">
                    {t('voiceMode.summary.generateHint')}
                  </p>
                </div>
              )}

              {!hasAgentConfigured && (
                <p className="mt-3 text-xs text-[var(--nim-text-muted)]" data-testid="voice-mode-summary-no-agent">
                  <Trans
                    t={t}
                    i18nKey="voiceMode.summary.noAgent"
                    components={{
                      link: (
                        <button
                          type="button"
                          onClick={() => navigateToSettings({ category: 'claude-code' })}
                          className="bg-transparent border-none p-0 cursor-pointer text-[var(--nim-primary)] underline"
                        />
                      ),
                    }}
                  />
                </p>
              )}

              {summaryError && (
                <p className="mt-2 text-xs text-[var(--nim-error)]" data-testid="voice-mode-summary-error">
                  {summaryError}
                </p>
              )}
            </div>
          )}

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.pricing.title')}</h4>
            {activeEngine === 'live' ? (
              <>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  {t('voiceMode.pricing.liveIntro')}
                </p>
                <ul className="ml-5 mt-2 mb-2 text-sm text-[var(--nim-text-muted)] list-disc">
                  <li>{t('voiceMode.pricing.liveSession')}</li>
                  <li>{t('voiceMode.pricing.liveBilling')}</li>
                  <li>{t('voiceMode.pricing.liveController')}</li>
                </ul>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  {t('voiceMode.pricing.liveExample')}
                </p>
              </>
            ) : (
              <>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  {t('voiceMode.pricing.realtimeIntro')}
                </p>
                <ul className="ml-5 mt-2 mb-2 text-sm text-[var(--nim-text-muted)] list-disc">
                  <li>{t('voiceMode.pricing.realtimeInput')}</li>
                  <li>{t('voiceMode.pricing.realtimeOutput')}</li>
                  <li>{t('voiceMode.pricing.realtimeExtra')}</li>
                </ul>
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
                  {t('voiceMode.pricing.realtimeExample')}
                </p>
              </>
            )}
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.howItWorks.title')}</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)]">
              {t('voiceMode.howItWorks.body', { engine: activeEngine === 'live' ? 'GPT-Live' : 'GPT Realtime' })}
            </p>
            <p className="provider-panel-hint mt-2 text-sm text-[var(--nim-text-muted)]">
              {t('voiceMode.howItWorks.summary')}
            </p>
          </div>

          <div className="provider-panel-section mb-6">
            <h4 className="provider-panel-section-title text-base font-medium mb-4 text-[var(--nim-text)]">{t('voiceMode.prompts.title')}</h4>
            <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-4">
              {t('voiceMode.prompts.description')}
            </p>

            {/* Voice Agent Prompt Section */}
            <button
              onClick={() => setShowVoiceAgentPrompt(!showVoiceAgentPrompt)}
              className={`flex items-center gap-2 bg-transparent border-none p-0 cursor-pointer text-[var(--nim-text)] text-sm font-medium ${showVoiceAgentPrompt ? 'mb-3' : 'mb-4'}`}
            >
              <MaterialSymbol icon={showVoiceAgentPrompt ? 'expand_less' : 'expand_more'} size={20} />
              {t('voiceMode.prompts.voiceAgent')}
            </button>

            {showVoiceAgentPrompt && (
              <div className="mb-6 pl-7">
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
                  {t('voiceMode.prompts.voiceAgentDescription')}
                </p>

                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.prompts.prepend')}</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      {t('voiceMode.prompts.voicePrependDescription')}
                    </span>
                  </div>
                  <textarea
                    value={voiceAgentPrompt?.prepend || ''}
                    onChange={(e) => handleSettingChange({
                      voiceAgentPrompt: {
                        ...voiceAgentPrompt,
                        prepend: e.target.value,
                      },
                    })}
                    placeholder={t('voiceMode.prompts.voicePrependPlaceholder')}
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>

                <div className="setting-item py-3">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.prompts.append')}</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      {t('voiceMode.prompts.voiceAppendDescription')}
                    </span>
                  </div>
                  <textarea
                    value={voiceAgentPrompt?.append || ''}
                    onChange={(e) => handleSettingChange({
                      voiceAgentPrompt: {
                        ...voiceAgentPrompt,
                        append: e.target.value,
                      },
                    })}
                    placeholder={t('voiceMode.prompts.voiceAppendPlaceholder')}
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>
              </div>
            )}

            {/* Coding Agent Prompt Section */}
            <button
              onClick={() => setShowCodingAgentPrompt(!showCodingAgentPrompt)}
              className={`flex items-center gap-2 bg-transparent border-none p-0 cursor-pointer text-[var(--nim-text)] text-sm font-medium ${showCodingAgentPrompt ? 'mb-3' : ''}`}
            >
              <MaterialSymbol icon={showCodingAgentPrompt ? 'expand_less' : 'expand_more'} size={20} />
              {t('voiceMode.prompts.codingAgent')}
            </button>

            {showCodingAgentPrompt && (
              <div className="pl-7">
                <p className="provider-panel-hint text-sm text-[var(--nim-text-muted)] mb-3">
                  {t('voiceMode.prompts.codingAgentDescription')}
                </p>

                <div className="setting-item py-3 mb-4">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.prompts.prepend')}</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      {t('voiceMode.prompts.codingPrependDescription')}
                    </span>
                  </div>
                  <textarea
                    value={codingAgentPrompt?.prepend || ''}
                    onChange={(e) => handleSettingChange({
                      codingAgentPrompt: {
                        ...codingAgentPrompt,
                        prepend: e.target.value,
                      },
                    })}
                    placeholder={t('voiceMode.prompts.codingPrependPlaceholder')}
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>

                <div className="setting-item py-3">
                  <div className="setting-text flex flex-col gap-0.5">
                    <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('voiceMode.prompts.append')}</span>
                    <span className="setting-description text-xs text-[var(--nim-text-muted)]">
                      {t('voiceMode.prompts.codingAppendDescription')}
                    </span>
                  </div>
                  <textarea
                    value={codingAgentPrompt?.append || ''}
                    onChange={(e) => handleSettingChange({
                      codingAgentPrompt: {
                        ...codingAgentPrompt,
                        append: e.target.value,
                      },
                    })}
                    placeholder={t('voiceMode.prompts.codingAppendPlaceholder')}
                    className="mt-2 w-full min-h-[80px] px-3 py-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] font-inherit text-sm resize-y"
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};
