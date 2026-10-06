import React, { useState, useEffect } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { usePostHog } from 'posthog-js/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation, Trans } from '@nimbalyst/runtime/i18n/react';
import { SettingsToggle } from '../SettingsToggle';
import { HelpTooltip } from '../../../help';
import { requestConfirmation } from '../../../dialogs/requestConfirmation';
import {
  advancedSettingsAtom,
  setAdvancedSettingsAtom,
  resetWalkthroughsAtom,
  developerFeatureSettingsAtom,
  setDeveloperFeatureSettingsAtom,
  customPathDirsAtom,
  externalEditorSettingsAtom,
  setExternalEditorSettingsAtom,
  EXTERNAL_EDITOR_NAMES,
  DEVELOPER_FEATURES,
  areAllDeveloperFeaturesEnabled,
  enableAllDeveloperFeatures,
  disableAllDeveloperFeatures,
  type ReleaseChannel,
  type ExternalEditorType,
  type PreferredTerminalShell,
} from '../../../store/atoms/appSettings';
import {
  trackerAutomationAtom,
  setTrackerAutomationAtom,
} from '../../../store/atoms/trackerAutomationAtoms';
import {
  multiProjectModeAtom,
  openProjectsAtom,
  activeWorkspacePathAtom,
  restorePreviousProjectsAtom,
  allowUnlimitedProjectsAtom,
} from '../../../store/atoms/openProjects';
import { settingAtom } from '../../../store/atoms/settingAtomFamily';

/** Reusable compact dropdown row */
function DropdownRow({
  value,
  onChange,
  name,
  description,
  options,
}: {
  value: string | number;
  onChange: (value: string) => void;
  name: string;
  description: string;
  options: { value: string | number; label: string }[];
}) {
  return (
    <div className="setting-item py-2">
      <div className="flex items-center justify-between gap-4">
        <div className="setting-text flex flex-col gap-0 min-w-0">
          <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{name}</span>
          <span className="setting-description text-xs leading-snug text-[var(--nim-text-muted)]">
            {description}
          </span>
        </div>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="setting-select shrink-0 py-1.5 px-2 pr-7 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none appearance-none bg-[url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%236b7280%22%20d%3D%22M3%204.5L6%207.5L9%204.5%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_8px_center] focus:border-[var(--nim-primary)]"
        >
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

/**
 * AdvancedPanel - Self-contained settings panel for advanced options.
 *
 * All settings subscribe directly to Jotai atoms or load via IPC.
 * Developer mode is a global app setting.
 */
export function AdvancedPanel() {
  const posthog = usePostHog();
  const { t } = useTranslation('settings');
  // App-level advanced settings from Jotai atoms
  const [settings] = useAtom(advancedSettingsAtom);
  const [, updateSettings] = useAtom(setAdvancedSettingsAtom);
  const [, resetWalkthroughs] = useAtom(resetWalkthroughsAtom);

  // Current enhanced PATH (fetched from main process)
  const [enhancedPath, setEnhancedPath] = useState<string>('');
  const [showEnhancedPath, setShowEnhancedPath] = useState(false);
  const [availableTerminalShells, setAvailableTerminalShells] = useState<Array<{
    name: string;
    path: string;
    provider?: string;
    bootstrapMode?: 'zsh' | 'bash' | 'powershell' | 'none';
    cwdMode?: 'native' | 'wsl';
  }>>([]);

  // Developer feature settings from Jotai atoms
  const [developerSettings] = useAtom(developerFeatureSettingsAtom);
  const [, updateDeveloperSettings] = useAtom(setDeveloperFeatureSettingsAtom);
  const { developerMode, developerFeatures } = developerSettings;

  // Tracker automation settings
  const trackerAutomation = useAtomValue(trackerAutomationAtom);
  const setTrackerAutomation = useSetAtom(setTrackerAutomationAtom);

  // External editor settings from Jotai atoms
  const [externalEditorSettings] = useAtom(externalEditorSettingsAtom);
  const [, updateExternalEditorSettings] = useAtom(setExternalEditorSettingsAtom);
  const { editorType: externalEditorType, customPath: externalEditorCustomPath } = externalEditorSettings;

  // Handle developer mode change
  const handleDeveloperModeChange = async (enabled: boolean) => {
    updateDeveloperSettings({ developerMode: enabled });

    // Track mode change in PostHog
    if (posthog) {
      posthog.capture('developer_mode_changed', {
        developer_mode: enabled,
        source: 'settings',
        is_initial: false,
      });

      // Update person property
      posthog.people.set({ developer_mode: enabled });
    }
  };

  const {
    releaseChannel,
    analyticsEnabled,
    extensionDevToolsEnabled,
    walkthroughsEnabled,
    walkthroughsViewedCount,
    walkthroughsTotalCount,
    maxHeapSizeMB,
    customPathDirs,
    spellcheckEnabled,
    showDirectChatProviders,
    historyMaxAgeDays,
    historyMaxSnapshots,
    preferredTerminalShell,
  } = settings;
  const [showFeaturesMenu, setShowFeaturesMenu] = useState(false);

  // Fetch enhanced PATH when user clicks to show it
  useEffect(() => {
    if (showEnhancedPath && !enhancedPath) {
      window.electronAPI.environment.getEnhancedPath().then(setEnhancedPath);
    }
  }, [showEnhancedPath, enhancedPath]);

  // Refresh enhanced PATH when custom paths change
  useEffect(() => {
    if (showEnhancedPath) {
      window.electronAPI.environment.getEnhancedPath().then(setEnhancedPath);
    }
  }, [customPathDirs, showEnhancedPath]);

  useEffect(() => {
    if (process.platform !== 'win32') {
      return;
    }

    window.electronAPI.terminal.getAvailableShells()
      .then((shells) => setAvailableTerminalShells(shells ?? []))
      .catch((error) => {
        console.error('[AdvancedPanel] Failed to load terminal shells:', error);
        setAvailableTerminalShells([]);
      });
  }, []);

  const terminalShellOptions: Array<{ value: PreferredTerminalShell; label: string }> = [
    { value: 'auto', label: t('advanced.terminalShell.auto') },
  ];
  const seenShellProviders = new Set<PreferredTerminalShell>();
  for (const shell of availableTerminalShells) {
    const provider = shell.provider as PreferredTerminalShell | undefined;
    if (!provider || provider === 'auto' || seenShellProviders.has(provider)) {
      continue;
    }
    seenShellProviders.add(provider);
    const label = shell.name === provider
      ? `${shell.name} (${shell.path})`
      : `${shell.name} [${provider}] (${shell.path})`;
    terminalShellOptions.push({ value: provider, label });
  }

  const handleModeClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      setShowFeaturesMenu(prev => !prev);
    }
  };

  return (
    <div className="provider-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)]">
          {t('advanced.title')}
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          {t('advanced.description')}
        </p>
      </div>

      {/* Application Mode - Always shown at the top */}
      <div className="provider-panel-section">
          <h4 className="provider-panel-section-title" onClick={handleModeClick}>{t('advanced.applicationMode.title')}</h4>
          <p className="provider-panel-hint">
            {t('advanced.applicationMode.description')}
          </p>

          <div className="mode-selection flex flex-row gap-4 mt-3">
            <label
              className={`mode-option flex flex-1 items-start p-0 rounded-xl cursor-pointer transition-all relative border-2 ${
                !developerMode
                  ? 'selected bg-nim-hover border-nim-primary shadow-[0_0_0_3px_rgba(88,166,255,0.15)]'
                  : 'bg-nim-secondary border-nim'
              }`}
              onClick={() => handleDeveloperModeChange(false)}
            >
              <input
                type="radio"
                name="mode"
                checked={!developerMode}
                onChange={() => handleDeveloperModeChange(false)}
                className="absolute top-3 right-3 m-0 cursor-pointer w-[18px] h-[18px] accent-[var(--nim-primary)]"
              />
              <div className="p-4 w-full flex flex-col items-center text-center">
                <div className="flex flex-col items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-nim-primary text-[32px]">
                    edit_note
                  </span>
                  <span className="text-base font-semibold text-nim">{t('advanced.standardMode.title')}</span>
                </div>
                <p className="m-0 text-[13px] leading-snug text-nim-muted">
                  {t('advanced.standardMode.description')}
                </p>
              </div>
            </label>

            <label
              className={`mode-option flex flex-1 items-start p-0 rounded-xl cursor-pointer transition-all relative border-2 ${
                developerMode
                  ? 'selected bg-nim-hover border-nim-primary shadow-[0_0_0_3px_rgba(88,166,255,0.15)]'
                  : 'bg-nim-secondary border-nim'
              }`}
              onClick={() => handleDeveloperModeChange(true)}
            >
              <input
                type="radio"
                name="mode"
                checked={developerMode}
                onChange={() => handleDeveloperModeChange(true)}
                className="absolute top-3 right-3 m-0 cursor-pointer w-[18px] h-[18px] accent-[var(--nim-primary)]"
              />
              <div className="p-4 w-full flex flex-col items-center text-center">
                <div className="flex flex-col items-center gap-2 mb-2">
                  <span className="material-symbols-outlined text-nim-primary text-[32px]">
                    terminal
                  </span>
                  <span className="text-base font-semibold text-nim">{t('advanced.developerMode.title')}</span>
                </div>
                <p className="m-0 text-[13px] leading-snug text-nim-muted">
                  {t('advanced.developerMode.description')}
                </p>
              </div>
            </label>
          </div>
        </div>

      {/* Secret Features Menu - Cmd+Click on "Application Mode" title to show */}
      {showFeaturesMenu && (
        <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
          <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">
            {t('advanced.featureAvailability.title')}
          </h4>
          <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-4">
            {t('advanced.featureAvailability.description')}
          </p>

          {/* Developer Features */}
          <div className="mt-4 p-3 bg-nim-secondary rounded-md border border-nim">
            {/* "All Developer Features" master toggle */}
            <div className="setting-item mb-3 pb-3 border-b border-nim">
              <label className="setting-label">
                <input
                  type="checkbox"
                  checked={areAllDeveloperFeaturesEnabled(developerFeatures)}
                  onChange={(e) => {
                    const newFeatures = e.target.checked ? enableAllDeveloperFeatures() : disableAllDeveloperFeatures();
                    updateDeveloperSettings({ developerFeatures: newFeatures });
                  }}
                  disabled={!developerMode}
                  className="setting-checkbox"
                />
                <div className="setting-text">
                  <span className="setting-name">{t('advanced.featureAvailability.allFeatures')}</span>
                  <span className="setting-description">
                    {t('advanced.featureAvailability.allFeaturesDescription')}
                  </span>
                </div>
              </label>
            </div>

            {/* Individual developer feature toggles */}
            {DEVELOPER_FEATURES.map((feature) => {
              const isAvailable = developerMode && developerFeatures[feature.tag];
              return (
                <div key={feature.tag} className="setting-item py-2">
                  <label className="setting-label">
                    <input
                      type="checkbox"
                      checked={developerFeatures[feature.tag]}
                      onChange={(e) => {
                        updateDeveloperSettings({
                          developerFeatures: {
                            ...developerFeatures,
                            [feature.tag]: e.target.checked,
                          },
                        });
                      }}
                      disabled={!developerMode}
                      className="setting-checkbox"
                    />
                    <div className="setting-text">
                      <span className="setting-name flex items-center gap-2">
                        {feature.icon && (
                          <span className="material-symbols-outlined text-sm">{feature.icon}</span>
                        )}
                        {feature.name}
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            isAvailable
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-red-500/20 text-red-400'
                          }`}
                        >
                          {isAvailable ? t('advanced.featureAvailability.available') : t('advanced.featureAvailability.hidden')}
                        </span>
                      </span>
                      <span className="setting-description">{feature.description}</span>
                    </div>
                  </label>
                </div>
              );
            })}
          </div>

          <p className="text-xs text-[var(--nim-text-faint)] mt-3">
            {developerMode ? t('advanced.featureAvailability.developerModeOn') : t('advanced.featureAvailability.developerModeOff')}
          </p>
        </div>
      )}

      {/* ── Release Channel ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">{t('advanced.releaseChannel.title')}</h4>
        <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-4">
          {t('advanced.releaseChannel.description')}
        </p>

        <div className="setting-item py-3">
          <div className="setting-text flex flex-col gap-0.5">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('advanced.releaseChannel.updateChannel')}</span>
            <span className="setting-description text-xs leading-relaxed text-[var(--nim-text-muted)]">
              <Trans t={t} i18nKey="advanced.releaseChannel.channelsHint" components={{ bold: <strong />, br: <br /> }} />
            </span>
          </div>
          <select
            value={releaseChannel}
            onChange={(e) => {
              const newChannel = e.target.value as ReleaseChannel;
              updateSettings({ releaseChannel: newChannel });
              posthog?.capture('release_channel_changed', {
                channel: newChannel,
              });
            }}
            className="setting-select mt-2 w-full py-2 px-3 pr-9 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none appearance-none bg-[url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%236b7280%22%20d%3D%22M3%204.5L6%207.5L9%204.5%22%2F%3E%3C%2Fsvg%3E')] bg-no-repeat bg-[right_12px_center] focus:border-[var(--nim-primary)]"
          >
            <option value="stable">{t('advanced.releaseChannel.stable')}</option>
            <option value="alpha">{t('advanced.releaseChannel.alpha')}</option>
          </select>
        </div>

        {releaseChannel === 'alpha' && (
          <div className="mt-3 flex items-start gap-2 p-3 rounded border border-[var(--nim-warning)]/30 bg-[var(--nim-warning)]/10">
            <MaterialSymbol icon="warning" size={16} className="text-[var(--nim-warning)] shrink-0 mt-0.5" />
            <p className="m-0 text-[13px] text-[var(--nim-text)] leading-snug">
              {t('advanced.releaseChannel.alphaWarning')}
            </p>
          </div>
        )}
      </div>

      {/* ── General ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">{t('general.title')}</h4>

        <UiLanguageSelect />

        <MultiProjectModeToggle />

        <UnlimitedProjectsToggle />

        <RestorePreviousProjectsToggle />

        <SettingsToggle
          checked={analyticsEnabled}
          onChange={(checked) => updateSettings({ analyticsEnabled: checked })}
          name={t('advanced.analytics.name')}
          description={t('advanced.analytics.description')}
        />

        <SettingsToggle
          checked={spellcheckEnabled}
          onChange={(checked) => updateSettings({ spellcheckEnabled: checked })}
          name={t('spellcheck.title')}
          description={t('spellcheck.description')}
        />

        <SettingsToggle
          checked={showDirectChatProviders}
          onChange={(checked) => updateSettings({ showDirectChatProviders: checked })}
          name={t('advanced.chatProviders.name')}
          description={t('advanced.chatProviders.description')}
        />

        <SettingsToggle
          checked={walkthroughsEnabled}
          onChange={(checked) => updateSettings({ walkthroughsEnabled: checked })}
          name={t('advanced.featureGuides.name')}
          description={walkthroughsTotalCount > 0 ? t('advanced.featureGuides.descriptionWithCount', { viewed: walkthroughsViewedCount, total: walkthroughsTotalCount }) : t('advanced.featureGuides.description')}
        />

        {walkthroughsViewedCount > 0 && (
          <div className="py-1 pl-7">
            <button onClick={() => resetWalkthroughs()} className="nim-btn-secondary text-xs">
              {t('advanced.featureGuides.resetAll')}
            </button>
          </div>
        )}
      </div>

      {/* ── Tracker Automation ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0" data-testid="tracker-automation-section">
        <HelpTooltip testId="tracker-automation-section">
          <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)] inline-block">{t('advanced.trackerAutomation.title')}</h4>
        </HelpTooltip>

        <SettingsToggle
          checked={trackerAutomation.enabled}
          onChange={(checked) => setTrackerAutomation({ enabled: checked })}
          name={t('advanced.trackerAutomation.linkCommits')}
          description={t('advanced.trackerAutomation.linkCommitsDescription')}
        />

        {trackerAutomation.enabled && (
          <SettingsToggle
            checked={trackerAutomation.autoCloseOnCommit}
            onChange={(checked) => setTrackerAutomation({ autoCloseOnCommit: checked })}
            name={t('advanced.trackerAutomation.autoClose')}
            description={t('advanced.trackerAutomation.autoCloseDescription')}
          />
        )}
      </div>

      {/* ── Tools & Environment ── */}
      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-2 text-[var(--nim-text)]">{t('advanced.tools.title')}</h4>

        <DropdownRow
          value={externalEditorType}
          onChange={(val) => updateExternalEditorSettings({ editorType: val as ExternalEditorType })}
          name={t('advanced.externalEditor.name')}
          description={t('advanced.externalEditor.description')}
          options={[
            { value: 'none', label: t('advanced.externalEditor.none') },
            { value: 'vscode', label: 'VS Code' },
            { value: 'cursor', label: 'Cursor' },
            { value: 'webstorm', label: 'WebStorm' },
            { value: 'sublime', label: 'Sublime Text' },
            { value: 'vim', label: t('advanced.externalEditor.vimTerminal') },
            { value: 'nvim', label: t('advanced.externalEditor.neovimTerminal') },
            { value: 'custom', label: t('advanced.externalEditor.custom') },
          ]}
        />

        {externalEditorType === 'custom' && (
          <div className="py-2 pl-7">
            <input
              type="text"
              value={externalEditorCustomPath || ''}
              onChange={(e) => updateExternalEditorSettings({ customPath: e.target.value })}
              placeholder={process.platform === 'win32' ? 'C:\\Program Files\\Editor\\editor.exe' : '/usr/local/bin/myeditor'}
              className="w-full py-1.5 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] font-mono"
            />
          </div>
        )}

        <SettingsToggle
          checked={extensionDevToolsEnabled}
          onChange={(checked) => updateSettings({ extensionDevToolsEnabled: checked })}
          name={t('advanced.extensionDevTools.name')}
          description={t('advanced.extensionDevTools.description')}
        />

        <DropdownRow
          value={maxHeapSizeMB}
          onChange={(val) => updateSettings({ maxHeapSizeMB: parseInt(val, 10) })}
          name={t('advanced.maxHeap.name')}
          description={t('advanced.maxHeap.description')}
          options={[
            { value: 2048, label: '2 GB' },
            { value: 4096, label: t('advanced.defaultOption', { value: '4 GB' }) },
            { value: 6144, label: '6 GB' },
            { value: 8192, label: '8 GB' },
            { value: 12288, label: '12 GB' },
            { value: 16384, label: '16 GB' },
          ]}
        />

        {process.platform === 'win32' && (
          <>
            <DropdownRow
              value={preferredTerminalShell}
              onChange={(val) => updateSettings({ preferredTerminalShell: val as PreferredTerminalShell })}
              name={t('advanced.terminalShell.name')}
              description={t('advanced.terminalShell.description')}
              options={terminalShellOptions}
            />

            <div className="setting-item py-2">
              <div className="setting-text flex flex-col gap-0 mb-2">
                <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('advanced.terminalShell.detectedName')}</span>
                <span className="setting-description text-xs leading-snug text-[var(--nim-text-muted)]">
                  {t('advanced.terminalShell.detectedDescription')}
                </span>
              </div>

              <div className="select-text p-2 rounded-md text-xs bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] font-mono">
                {availableTerminalShells.length === 0 ? (
                  <div>{t('advanced.terminalShell.noneDetected')}</div>
                ) : (
                  availableTerminalShells.map((shell) => (
                    <div key={`${shell.provider || shell.name}-${shell.path}`} className="py-0.5 break-all">
                      {`${shell.provider || shell.name} | ${shell.path} | bootstrap=${shell.bootstrapMode || 'none'} | cwd=${shell.cwdMode || 'native'}`}
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}

        <DropdownRow
          value={historyMaxAgeDays}
          onChange={(val) => updateSettings({ historyMaxAgeDays: parseInt(val, 10) })}
          name={t('advanced.historyRetention.name')}
          description={t('advanced.historyRetention.description')}
          options={[
            { value: 7, label: t('advanced.historyRetention.days', { count: 7 }) },
            { value: 14, label: t('advanced.historyRetention.days', { count: 14 }) },
            { value: 30, label: t('advanced.defaultOption', { value: t('advanced.historyRetention.days', { count: 30 }) }) },
            { value: 60, label: t('advanced.historyRetention.days', { count: 60 }) },
            { value: 90, label: t('advanced.historyRetention.days', { count: 90 }) },
            { value: 180, label: t('advanced.historyRetention.days', { count: 180 }) },
            { value: 365, label: t('advanced.historyRetention.oneYear') },
          ]}
        />

        <DropdownRow
          value={historyMaxSnapshots}
          onChange={(val) => updateSettings({ historyMaxSnapshots: parseInt(val, 10) })}
          name={t('advanced.maxSnapshots.name')}
          description={t('advanced.maxSnapshots.description')}
          options={[
            { value: 50, label: '50' },
            { value: 100, label: '100' },
            { value: 250, label: t('advanced.defaultOption', { value: '250' }) },
            { value: 500, label: '500' },
            { value: 1000, label: '1,000' },
          ]}
        />

        {/* Custom PATH */}
        <div className="setting-item py-2">
          <div className="setting-text flex flex-col gap-0 mb-2">
            <span className="setting-name text-sm font-medium text-[var(--nim-text)]">{t('advanced.customPath.name')}</span>
            <span className="setting-description text-xs leading-snug text-[var(--nim-text-muted)]">
              {t('advanced.customPath.description')}
            </span>
          </div>
          <textarea
            value={customPathDirs}
            onChange={(e) => updateSettings({ customPathDirs: e.target.value })}
            placeholder={process.platform === 'win32'
              ? 'C:\\MyTools;C:\\Programs\\bin'
              : '/opt/mytools/bin:/usr/local/custom/bin'}
            rows={2}
            className="w-full py-1.5 px-3 rounded-md text-sm bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)] font-mono resize-none"
          />
          <div className="mt-1">
            <button
              onClick={() => setShowEnhancedPath(!showEnhancedPath)}
              className="text-xs text-[var(--nim-link)] hover:text-[var(--nim-link-hover)] cursor-pointer"
            >
              {showEnhancedPath ? t('advanced.customPath.hide') : t('advanced.customPath.show')}
            </button>

            {showEnhancedPath && enhancedPath && (
              <div className="mt-2">
                <div
                  className="p-2 rounded-md text-xs bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] font-mono overflow-x-auto"
                  style={{
                    maxHeight: '200px',
                    overflowY: 'auto',
                    wordBreak: 'break-all',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {enhancedPath.split(process.platform === 'win32' ? ';' : ':').map((p, index) => (
                    <div key={index} className="py-0.5">
                      {p}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}

/**
 * Toggle for the multi-project rail. When the user disables it with
 * inactive warm projects in the rail, those projects' main-process
 * services are released and the rail collapses to just the active
 * project so state stays consistent.
 */
function MultiProjectModeToggle() {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useAtom(multiProjectModeAtom);
  const [openProjects, setOpenProjects] = useAtom(openProjectsAtom);
  const activePath = useAtomValue(activeWorkspacePathAtom);

  const handleChange = async (next: boolean) => {
    if (!next && openProjects.length > 1) {
      const proceed = await requestConfirmation({
        title: t('advanced.multiProject.confirmTitle'),
        message: t('advanced.multiProject.confirmMessage', { projectCount: openProjects.length }),
        confirmLabel: t('advanced.multiProject.confirmLabel'),
      });
      if (!proceed) return;

      // Release services for every non-active path before collapsing the
      // rail. The main process refcounts services across windows, so this
      // only frees them when no other window references the path.
      const inactivePaths = openProjects
        .filter((p) => p.path !== activePath)
        .map((p) => p.path);
      await Promise.all(
        inactivePaths.map((path) =>
          window.electronAPI?.invoke?.('workspace:unregister-additional', { workspacePath: path })
            .catch((err: unknown) => {
              console.error('[AdvancedPanel] unregister-additional failed for', path, err);
            })
        )
      );

      const remaining = openProjects.filter((p) => p.path === activePath);
      setOpenProjects(remaining);
    }
    setEnabled(next);
  };

  return (
    <SettingsToggle
      checked={enabled}
      onChange={handleChange}
      name={t('advanced.multiProject.name')}
      description={t('advanced.multiProject.description')}
    />
  );
}

/**
 * Interface language. Writes `app.uiLanguage`; the main process persists it
 * and broadcasts `settings:changed`, which switches every window live.
 */
function UiLanguageSelect() {
  const { t } = useTranslation('settings');
  const [uiLanguage, setUiLanguage] = useAtom(settingAtom('app.uiLanguage'));

  return (
    <div data-testid="ui-language-setting">
      <DropdownRow
        value={uiLanguage}
        onChange={(value) => {
          void setUiLanguage(value as typeof uiLanguage);
        }}
        name={t('language.title')}
        description={t('language.description')}
        options={[
          { value: 'system', label: t('language.system') },
          { value: 'en', label: t('language.english') },
          { value: 'pt-BR', label: t('language.portugueseBrazil') },
        ]}
      />
    </div>
  );
}

function UnlimitedProjectsToggle() {
  const { t } = useTranslation('settings');
  const [allowUnlimited, setAllowUnlimited] = useAtom(allowUnlimitedProjectsAtom);
  const enabled = useAtomValue(multiProjectModeAtom);
  const [error, setError] = useState<string | null>(null);
  if (!enabled) return null;

  return (
    <div className="project-limit-setting" data-testid="project-limit-setting">
      <SettingsToggle
        name={t('advanced.unlimitedProjects.name')}
        checked={allowUnlimited}
        onChange={async checked => {
          setError(null);
          try {
            await setAllowUnlimited(checked);
          } catch {
            setError(t('advanced.unlimitedProjects.saveError'));
          }
        }}
        description={t('advanced.unlimitedProjects.description')}
      />
      {error && <p role="alert" className="text-sm text-[var(--nim-error)]">{error}</p>}
    </div>
  );
}

/**
 * Toggle for re-opening last session's rail projects on launch. Default
 * off so a normal launch from the project picker opens just the picked
 * project; warm rail projects must be added explicitly via the rail's
 * `+` button.
 */
function RestorePreviousProjectsToggle() {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useAtom(restorePreviousProjectsAtom);
  const isMultiProject = useAtomValue(multiProjectModeAtom);

  return (
    <SettingsToggle
      checked={enabled}
      onChange={setEnabled}
      name={t('advanced.restoreProjects.name')}
      description={
        isMultiProject
          ? t('advanced.restoreProjects.descriptionMulti')
          : t('advanced.restoreProjects.descriptionSingle')
      }
    />
  );
}
